// OneDrive export engine (slice 17, PRD §5.4). One-way, DB -> files:
// /Export/{type}/{year}/{slug}-{id8}.md with YAML frontmatter and the
// markdown body (the DB stays canonical; this is the disaster-recovery and
// pulpit fallback). Incremental: an item is re-exported when updated_at has
// passed exported_at (soft delete, restore, and status changes all bump
// updated_at, so the one comparison covers content, renames, and moves to
// /_archive/). Deterministic plumbing, no model in the loop.
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { attachments, items, jobState } from "@/db/schema";
import { bodyMarkdown } from "@/lib/body";
import { resolveItemBodyTokens } from "@/lib/item-tokens-service";
import { normalizeListIndent } from "@/lib/markdown-render";
import { spaceEmptyListItems } from "@/lib/editor/list-markdown";
import { getStorage } from "@/lib/storage";
import { getAppTimezone } from "@/lib/today";
import type { ExportTarget } from "./target";

// Per-run cap: the nightly cron runs in a 60s lambda (the Vercel Hobby
// ceiling) and each item is a sequential OneDrive PUT over Graph, so ~100
// items/run overran 60s once a backlog built up and every run timed out
// before recording progress (2026-07-13). 30 keeps a run comfortably under
// budget; whatever it can't reach is counted in `remaining` (logged, not
// silent) and the next run picks it up.
// ponytail: fixed per-run cap; parallelize the PUTs with a concurrency pool
// if daily throughput ever falls behind the edit rate.
const DEFAULT_BATCH = 30;

// Wall-clock guard (2026-08-14). The item cap alone can't bound a run: an
// attachment-heavy stretch of the queue makes each item far more expensive
// than a plain .md PUT, so 30 items overran the 60s lambda and EVERY caller
// 504'd (nightly cron, the export-drain loop, and Save Offline). A killed run
// never writes job_state, so `remaining` froze and the drain loop bailed on
// its 8-consecutive-failure guard even though per-item progress was real.
// Stopping at the budget turns that timeout into a clean 200 with an honest
// `remaining`, which every caller already knows how to resume from.
// ponytail: the check is between items, so one pathological item (a huge
// attachment) can still overrun on its own; that's the export-drain
// workflow's "8 in a row" case. Add a per-item timeout if it ever shows up.
const RUN_BUDGET_MS = 45_000;

export const EXPORT_JOB_KEY = "onedrive_export";

export type ExportRunResult = {
  exported: number;
  archived: number;
  attachmentsCopied: number;
  // Attachments whose bytes couldn't be fetched (e.g. missing in R2). Skipped,
  // not fatal: the item still exports. Surfaced, never silent (rule 9), but
  // deliberately NOT counted in `errors` so one orphaned image can't block a
  // clean run forever.
  attachmentsFailed: number;
  errors: number;
  remaining: number;
};

export type ExportJobState = {
  lastRunAt: string;
  // The /health canary: set only by a run that finished with zero item
  // errors and nothing remaining.
  lastSuccessAt: string | null;
  lastResult: ExportRunResult;
};

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics after NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "untitled";
}

// {year} comes from created_at in the owner's timezone: stable for the item's
// life (due/meeting dates are often null and titles change).
function yearInZone(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
  }).format(instant);
}

// Double-quoted JSON strings are valid YAML scalars, so JSON.stringify is
// the whole escaping story.
function yamlValue(v: string | string[] | boolean): string {
  return Array.isArray(v)
    ? `[${v.map((s) => JSON.stringify(s)).join(", ")}]`
    : typeof v === "boolean"
      ? String(v)
      : JSON.stringify(v);
}

type ItemRow = typeof items.$inferSelect;

function buildFrontmatter(
  item: ItemRow,
  people: string[],
  attachmentPaths: string[]
): string {
  const lines: string[] = ["---"];
  const add = (key: string, v: string | string[] | boolean | null | undefined) => {
    if (v == null || (Array.isArray(v) && v.length === 0)) return;
    lines.push(`${key}: ${yamlValue(v)}`);
  };
  add("id", item.id);
  add("type", item.type);
  add("title", item.title);
  // Status is a task field (ADR-018); "status: open" on every note would be
  // frontmatter noise. Archived non-tasks still land under /_archive/.
  if (item.type === "task") add("status", item.status);
  add("url", item.url);
  add("due", item.dueDate?.toISOString());
  add("meeting_at", item.meetingAt?.toISOString());
  add("created", item.createdAt.toISOString());
  add("updated", item.updatedAt.toISOString());
  add("people", people);
  add("attachments", attachmentPaths);
  if (item.deletedAt) add("deleted", true);
  lines.push("---");
  return lines.join("\n");
}

// Confirmed related-person edges in both directions (suggested edges stay out
// of trusted reads, PRD §3.3); titles only, for the frontmatter.
async function listPersonTitles(
  ownerId: string,
  itemId: string
): Promise<string[]> {
  const rows = await getDb().execute(sql`
    select distinct e.title
    from relations r
    join items e
      on e.id = case when r.source_id = ${itemId} then r.target_id else r.source_id end
    where (r.source_id = ${itemId} or r.target_id = ${itemId})
      and r.match_state = 'confirmed'
      and e.type = 'person'
      and e.owner_id = ${ownerId}
      and e.deleted_at is null
    order by e.title
  `);
  return rows.rows.map((r) => (r as { title: string }).title);
}

// Copies this item's not-yet-exported attachment bytes (R2 -> target) and
// returns the export paths of every attachment row, copied now or earlier.
// Bytes come off the public CDN URL (the same URL the editor renders), so
// no new storage-provider method is needed. Attachment bytes are immutable
// once uploaded: one copy is done forever.
type AttachmentFailure = { storageKey: string; status: number };

// Rewrites the stable /files/<id> addresses in an exported body to the RELATIVE
// path of the attachment copy sitting beside it in the export tree (ADR-228).
//
// This is what keeps the export Sunday-proof (principle 4). A body stores
// /files/<id>, which resolves against the app — meaningless in a markdown file
// on OneDrive. Rewriting to `../../_attachments/…` makes the exported tree
// fully self-contained, so images render offline in Obsidian or any reader with
// the app down and no internet. That is strictly better than the provider URLs
// this replaced, which always needed the network.
//
// `desired` is the item's path under the export root; each `/` in it is one
// level to climb back out of.
// Exported for scripts/verify-attachment-urls.mts (pure glue stays node-testable,
// the discipline image-markdown.ts follows).
export function rewriteAttachmentPaths(
  body: string,
  desired: string,
  attachmentPaths: string[]
): string {
  if (attachmentPaths.length === 0) return body;
  const up = "../".repeat((desired.match(/\//g) ?? []).length);
  let out = body;
  for (const path of attachmentPaths) {
    // exportAttachments builds `_attachments/{itemId}/{id8}-{filename}`, so the
    // 8-char id prefix is what ties a path back to its /files/<id> address.
    const id8 = path.split("/").pop()?.slice(0, 8);
    if (!id8) continue;
    out = out.replaceAll(
      new RegExp(`/files/${id8}[0-9a-f-]{28}`, "gi"),
      `${up}${path}`
    );
  }
  return out;
}

async function exportAttachments(
  item: ItemRow,
  target: ExportTarget
): Promise<{ paths: string[]; copied: number; failed: AttachmentFailure[] }> {
  const db = getDb();
  const rows = await db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      storageKey: attachments.storageKey,
      exportedAt: attachments.exportedAt,
    })
    .from(attachments)
    .where(eq(attachments.parentItemId, item.id));
  if (rows.length === 0) return { paths: [], copied: 0, failed: [] };

  const storage = getStorage();
  const paths: string[] = [];
  const failed: AttachmentFailure[] = [];
  let copied = 0;
  for (const att of rows) {
    // id prefix: filenames repeat freely within an item (paste.png).
    const path = `_attachments/${item.id}/${att.id.slice(0, 8)}-${att.filename}`;
    if (att.exportedAt) {
      // Already on OneDrive: list it, nothing to copy.
      paths.push(path);
      continue;
    }
    if (!storage) {
      // Not an error: local/dev runs have no R2. The stamp stays null so a
      // configured run copies it later. Don't list a file we didn't write.
      continue;
    }
    const res = await fetch(await storage.presignDownload(att.storageKey));
    if (!res.ok) {
      // A missing/unreadable object (e.g. bytes that never finished uploading)
      // must NOT block the item's body from exporting: the markdown is the
      // Sunday-proof fallback, an image is not. Surface it (the caller logs to
      // error_log), skip the byte copy, leave exportedAt null so a later run
      // retries if it reappears, and omit the path so the frontmatter never
      // lists a file that isn't there.
      failed.push({ storageKey: att.storageKey, status: res.status });
      continue;
    }
    // The write is guarded for the same reason as the read above: a Graph
    // failure here (409s show up on attachment paths) used to escape this
    // function and land in the item's catch, failing the WHOLE item, so the
    // markdown never reached OneDrive over one image. That is exactly what the
    // comment above forbids, and the item then failed every run forever since
    // nothing about it changed. Record it and move on.
    // status 0 = the upload leg failed, as opposed to a real HTTP status from
    // the R2 read above.
    try {
      await target.putFile(path, new Uint8Array(await res.arrayBuffer()));
    } catch {
      failed.push({ storageKey: att.storageKey, status: 0 });
      continue;
    }
    await db
      .update(attachments)
      .set({ exportedAt: new Date() })
      .where(eq(attachments.id, att.id));
    paths.push(path);
    copied++;
  }
  return { paths, copied, failed };
}

function needsExportWhere(ownerId: string) {
  return and(
    eq(items.ownerId, ownerId),
    // Template prototypes never export to OneDrive (ADR-093): they're not real
    // content and must not reach the Sunday-proof fallback tree.
    eq(items.isTemplate, false),
    or(
      // Never exported: live items only (an item created and trashed
      // between runs has no file to archive).
      and(isNull(items.exportedAt), isNull(items.deletedAt)),
      // Exported before and touched since (edits, soft delete, restore,
      // archive: they all bump updated_at).
      sql`${items.exportedAt} is not null and ${items.updatedAt} > ${items.exportedAt}`
    )
  );
}

// Runs one export pass for one owner. Item-level failures land in the
// returned error count (callers log them); the item keeps its old stamp and
// is retried next run.
export async function runExport(
  ownerId: string,
  target: ExportTarget,
  opts: {
    batch?: number;
    // Overridable so the verify script can trip the guard without burning the
    // real budget; callers in the app leave it at the default.
    budgetMs?: number;
    onError?: (itemId: string, err: unknown) => void;
    onAttachmentError?: (itemId: string, failures: AttachmentFailure[]) => void;
  } = {}
): Promise<ExportRunResult> {
  const db = getDb();
  const batch = Math.min(Math.max(opts.batch ?? DEFAULT_BATCH, 1), 500);

  const candidates = await db
    .select()
    .from(items)
    .where(needsExportWhere(ownerId))
    .orderBy(items.updatedAt)
    .limit(batch);
  const tz = await getAppTimezone(ownerId);

  const result: ExportRunResult = {
    exported: 0,
    archived: 0,
    attachmentsCopied: 0,
    attachmentsFailed: 0,
    errors: 0,
    remaining: 0,
  };

  const deadline = Date.now() + (opts.budgetMs ?? RUN_BUDGET_MS);
  for (const item of candidates) {
    // Stop cleanly rather than being killed mid-PUT: the items not reached
    // are still unexported, so the recount below rolls them into `remaining`.
    if (Date.now() > deadline) break;
    try {
      const inArchive = item.deletedAt !== null || item.statusCategory === "archived";
      const year = yearInZone(item.createdAt, tz);
      // Resolve live {{item.*}} tokens against the item's current state (LT3):
      // an exported .md is a derived output, so it bakes the resolved values (the
      // DB keeps the tokens — ADR-037). Only items that actually contain tokens
      // pay for the context build (resolveItemBodyTokens short-circuits).
      const resolved = await resolveItemBodyTokens(ownerId, {
        id: item.id,
        title: item.title,
        body: item.body,
      });
      const exportItem = { ...item, title: resolved.title, body: resolved.body };
      const name = `${slugify(exportItem.title)}-${item.id.slice(0, 8)}.md`;
      const desired = `${inArchive ? "_archive/" : ""}${item.type}/${year}/${name}`;

      const [people, atts] = [
        await listPersonTitles(ownerId, item.id),
        await exportAttachments(item, target),
      ];
      result.attachmentsCopied += atts.copied;
      if (atts.failed.length > 0) {
        result.attachmentsFailed += atts.failed.length;
        opts.onAttachmentError?.(item.id, atts.failed);
      }

      // normalizeListIndent: re-indent nested lists to CommonMark widths so the
      // exported .md nests correctly in any reader (Obsidian, GitHub, pandoc),
      // matching the in-app editor and print/share render. Legacy import content
      // nested at 2 spaces would otherwise flatten. spaceEmptyListItems: an empty
      // bullet flush under a paragraph is a setext heading to those same readers
      // (see list-markdown.ts). (Both passes markdown-render applies; see there.)
      const content = `${buildFrontmatter(exportItem, people, atts.paths)}\n\n${rewriteAttachmentPaths(normalizeListIndent(spaceEmptyListItems(bodyMarkdown(exportItem.body))), desired, atts.paths)}\n`;
      await target.putFile(desired, content);
      // A rename, retype, or live<->archive move leaves a stale file at the
      // old path; the put above already wrote the replacement.
      if (item.exportPath && item.exportPath !== desired) {
        await target.deleteFile(item.exportPath);
      }
      // Pin exportedAt and updatedAt to the same instant. updatedAt carries a
      // $onUpdate (schema.ts); without setting it explicitly it would land a
      // hair after exportedAt, so needsExportWhere's `updatedAt > exportedAt`
      // would re-select the item on the very next run (a spurious re-export).
      // The export write is bookkeeping, not a content edit.
      const exportedAt = new Date();
      await db
        .update(items)
        .set({ exportedAt, updatedAt: exportedAt, exportPath: desired })
        .where(and(eq(items.id, item.id), eq(items.ownerId, ownerId)));
      result.exported++;
      if (inArchive) result.archived++;
    } catch (err) {
      result.errors++;
      opts.onError?.(item.id, err);
    }
  }

  const left = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(needsExportWhere(ownerId));
  result.remaining = left[0].count;

  const now = new Date().toISOString();
  const clean = result.errors === 0 && result.remaining === 0;
  const prior = await db
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, EXPORT_JOB_KEY));
  const priorState = (prior[0]?.value ?? null) as ExportJobState | null;
  const state: ExportJobState = {
    lastRunAt: now,
    lastSuccessAt: clean ? now : (priorState?.lastSuccessAt ?? null),
    lastResult: result,
  };
  await db
    .insert(jobState)
    .values({ key: EXPORT_JOB_KEY, value: state })
    .onConflictDoUpdate({ target: jobState.key, set: { value: state } });

  return result;
}

export async function getExportState(): Promise<ExportJobState | null> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, EXPORT_JOB_KEY));
  return (rows[0]?.value as ExportJobState) ?? null;
}
