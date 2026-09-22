// Item writes (slice 4, split from items.ts): create/update/delete/restore,
// type moves, and the recurrence-completion machinery that hangs off
// completing a task. Every function takes ownerId and scopes every query
// with it (CLAUDE.md working conventions). Deletes are soft (deleted_at),
// cascade to children, and round-trip through restore; hard deletes happen
// only in purgeExpiredTrash (the 30-day purge job).
//
// Imports from items.ts one-way only (getItem, itemColumns, ItemError) —
// items.ts never imports from here, so there's no cycle. Callers that need a
// write import it from here directly (not re-exported through items.ts).
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "@/db";
import { items, relations, revisions, types } from "@/db/schema";
import {
  bodyDigest,
  bodyMarkdown,
  isItemBody,
  isLargeBody,
  MARKDOWN_FORMAT,
  type ItemBody,
} from "@/lib/body";
import { extractBodyText, notesMarkdown } from "@/lib/body-text";
import { canonicalFormatForType } from "@/lib/modules";
// Type-only (erased at runtime): types.ts imports ItemError from items.ts, so
// a value import of getType would form a circular dependency. getType is
// loaded dynamically inside moveItemType instead.
import type { PropertyDef } from "@/lib/types";
import { getItem, itemColumns, ItemError, type ItemStatus, type Urgency } from "@/lib/items";
import { routeFor } from "@/lib/inbox-sources";
import { syncMentionRelations } from "@/lib/mentions";
import { syncPassageRefs } from "@/lib/passages/refs";
import { relateItems } from "@/lib/relations";
import { getSettings } from "@/lib/settings";
import { parseRecurrence } from "@/lib/recurrence";
import { shiftChildDates, type ShiftedChild } from "@/lib/relative-subtask-service";
import { dayDelta, isDuePinned, shiftDay } from "@/lib/date-anchor";
import { mirrorTaskDates } from "@/lib/one-date";
import { autoLinkTaskToProject } from "@/lib/project-autolink";
import {
  appTodayYmd,
  completeMaterializedOccurrence,
  completeVirtualSeries,
  ensureFirstOccurrence,
  occurrenceSeriesId,
} from "@/lib/recurrence-service";
import {
  categoryOfStatus,
  defaultStatusKey,
  initialStatusKey,
  resolveStatusKey,
  type StatusCategory,
  type StatusDef,
} from "@/lib/status";
import { statusSchemaForType } from "@/lib/status-schema";
import { getStorage } from "@/lib/storage";
import { emitActivity, homeParentOf, isTrackedSubjectType } from "@/lib/activity";
import { jobRunVerdict } from "@/lib/job-owners-store";
import { captureError } from "@/lib/log";

// A new revision is skipped when the latest one is younger than this; the
// editor autosaves often (slice 5) and one snapshot per burst is enough
// (PRD §4.6 "debounced").
const REVISION_DEBOUNCE_MS = 5 * 60 * 1000;
const REVISION_CAP = 50;
// Large bodies (ADR-125) snapshot far less and keep fewer copies: a multi-MB
// document edited at the normal cap could pile up 50× its size in history and
// pressure Neon's storage. A longer debounce + smaller cap bound that to a
// sane fraction while still leaving real restore points. Small bodies are
// unaffected (the common case keeps the original behavior exactly).
const LARGE_REVISION_DEBOUNCE_MS = 60 * 60 * 1000;
const LARGE_REVISION_CAP = 10;
const TRASH_RETENTION_DAYS = 30;

export type ItemInput = {
  type: string;
  title?: string;
  body?: unknown;
  status?: ItemStatus;
  dueDate?: Date | null;
  // The planned date, distinct from the due-date deadline (native tasks,
  // ADR-073/076). Stored UTC-midnight like dueDate; auto-advances on completion
  // for a recurring task (see recurrence.ts / recurrence-service.ts).
  scheduledDate?: Date | null;
  urgency?: Urgency | null;
  meetingAt?: Date | null;
  // The end of a timed item, pairing with meetingAt as its start (the range
  // rule, ADR-timeline). A real instant; null = single-anchor. Set/cleared by
  // the Planner's event resize and the event canvas End field.
  endAt?: Date | null;
  // The date a note was actually taken (ADR-110), distinct from created_at /
  // updated_at. Stored UTC-midnight like dueDate. createItem defaults it to the
  // creation day for notes; user-editable thereafter.
  noteDate?: Date | null;
  url?: string | null;
  parentId?: string | null;
  properties?: Record<string, unknown> | null;
  // Next Action (ADR-111/PJ2): a pinned task pointer and/or free text. Edited
  // by the Next Action widget (PJ6); auto-advances on completion of the pinned
  // task. nextActionTaskId is an item id (a task) or null.
  nextActionTaskId?: string | null;
  nextActionText?: string | null;
  // Per-record widget composition override (Layer 3, ADR-111/PJ2). Raw jsonb at
  // this layer; validated/used by the widget canvas (PJ3/PJ4). null = inherit
  // the type default.
  composition?: Record<string, unknown> | null;
  // Untriaged flag (PRD §4.2 Inbox): arrival paths set it, triage clears it.
  // An explicit value always wins over the per-source route below.
  inbox?: boolean;
  // Which arrival path made this item (ADR-249): one of INBOX_SOURCES' keys.
  // Read only when `inbox` is absent, and only to look up where the owner told
  // that path to file things. Not persisted on the row (deferred, cut 1).
  source?: string;
  // Mark this item as template content (ADR-093). Set true to mint a template
  // prototype; children created under a template parent inherit it automatically
  // (see createItem), so callers only ever set it on the root prototype.
  isTemplate?: boolean;
};

export type ItemPatch = Partial<ItemInput> & {
  // Merge these keys into items.properties without touching the rest — an atomic
  // jsonb `||` in updateItem. Used by the per-property canvas cards (ADR-069),
  // where each card owns one property key and must not clobber its siblings.
  // Distinct from `properties`, which replaces the whole object wholesale.
  propertyPatch?: Record<string, unknown>;
  // Cross-device edit guard (ADR-134): the bodyDigest of the body this client
  // last synced with. When present alongside a `body` write, updateItem refuses
  // the write (409 conflict) if the stored body no longer matches — i.e. another
  // device changed the body since this client loaded it, so this stale full-body
  // PATCH would silently clobber it. Optional: a caller that omits it keeps the
  // old last-write-wins behavior (MCP, batch ops, the field-only writers).
  expectedBodyDigest?: string;
};

async function assertTypeExists(type: string): Promise<string | null> {
  // A soft-deleted type (ADR-058) is excluded: you can't create or retype an
  // item into a type that's sitting in Trash.
  //
  // Returns the type's attached bespoke-tool `capability`, because the caller
  // needs it to resolve the canonical body format (ADR-260) and this row is
  // already being read — one column, no extra query.
  const rows = await getDb()
    .select({ key: types.key, capability: types.capability })
    .from(types)
    .where(and(eq(types.key, type), isNull(types.deletedAt)));
  if (rows.length === 0) {
    throw new ItemError("bad_request", `unknown type '${type}'`);
  }
  return rows[0].capability ?? null;
}

// Stamp a written body with the type's CANONICAL format (ADR-260).
//
// The body contract is { format, text } and the format is a property of the TYPE
// (`canonicalFormatForType`) — a song's body is ChordPro, not markdown. Every
// writer that composed a body from a plain markdown string, though, hardcoded
// `{ format: "markdown" }`: all six MCP write paths did, and so did anything
// POSTing `bodyMarkdown` to the REST API. On a song that silently broke three
// things downstream, none of which raise an error: the chord chart stopped
// rendering (print-html gates on the format), search indexed the chords and
// directives instead of the lyrics (body-text routes chordpro through
// chordProToText), and {{item.*}} token resolution started running over a chart
// (item-tokens-service only resolves markdown).
//
// Fixing it here rather than in each caller makes it structural: the format can
// no longer depend on which door a write came through. A body that already
// carries the right format passes through untouched, and a type whose canonical
// format IS markdown is a no-op, so this changes nothing for ordinary items.
// `body` is `unknown` on ItemInput/ItemPatch (callers hand in whatever they
// composed), so narrow before touching it: anything that isn't a well-formed
// { format, text } passes through untouched for the existing validation to
// reject, exactly as it did before.
function stampCanonicalFormat(
  body: unknown,
  type: string,
  capability: string | null
): unknown {
  if (!isItemBody(body)) return body;
  const canonical = canonicalFormatForType(type, undefined, capability);
  if (body.format === canonical) return body;
  return { ...body, format: canonical };
}

// Parent must be the owner's own live item, and (on update) not the item
// itself or one of its descendants; a parent cycle would hang every
// recursive tree read, so it can never be writable.
// Returns the parent's is_template flag so createItem can propagate it to the
// child (a child of a template prototype is itself template content, ADR-093).
async function assertValidParent(
  ownerId: string,
  parentId: string,
  selfId?: string
): Promise<boolean> {
  if (parentId === selfId) {
    throw new ItemError("bad_request", "an item cannot be its own parent");
  }
  const parent = await getDb()
    .select({ id: items.id, isTemplate: items.isTemplate })
    .from(items)
    .where(
      and(
        eq(items.id, parentId),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt)
      )
    );
  if (parent.length === 0) {
    throw new ItemError("bad_request", "parent item not found");
  }
  if (selfId) {
    // UNION (not UNION ALL) so existing bad data can't recurse forever.
    const res = await getDb().execute(sql`
      with recursive subtree as (
        select id from items where id = ${selfId} and owner_id = ${ownerId}
        union
        select i.id from items i join subtree s on i.parent_id = s.id
      )
      select 1 as hit from subtree where id = ${parentId}
    `);
    if (res.rows.length > 0) {
      throw new ItemError(
        "bad_request",
        "parent cannot be a descendant of the item"
      );
    }
  }
  return parent[0].isTemplate;
}

// Debounced snapshot + prune (PRD §4.6). force bypasses the debounce for
// moments that must be restorable no matter how recent the last snapshot is
// (e.g. the pre-restore body).
async function snapshotRevision(
  itemId: string,
  body: unknown,
  opts: { force?: boolean } = {}
) {
  const db = getDb();
  // A large body throttles harder and keeps fewer snapshots (ADR-125), so a
  // multi-MB document's history can't balloon storage; small bodies keep the
  // original 5-minute / 50-snapshot behavior unchanged.
  const large = isLargeBody(bodyMarkdown(body));
  const debounceMs = large ? LARGE_REVISION_DEBOUNCE_MS : REVISION_DEBOUNCE_MS;
  const cap = large ? LARGE_REVISION_CAP : REVISION_CAP;
  if (!opts.force) {
    const latest = await db
      .select({ createdAt: revisions.createdAt })
      .from(revisions)
      .where(eq(revisions.itemId, itemId))
      .orderBy(desc(revisions.createdAt))
      .limit(1);
    if (
      latest.length > 0 &&
      Date.now() - latest[0].createdAt.getTime() < debounceMs
    ) {
      return;
    }
  }
  await db.insert(revisions).values({ itemId, body });
  await db.execute(sql`
    delete from revisions
    where item_id = ${itemId}
      and id not in (
        select id from revisions
        where item_id = ${itemId}
        order by created_at desc
        limit ${cap}
      )
  `);
}

// The write-path status guard (ADR-243). Statuses are user-defined per type, and
// items.status is plain text, so nothing below this line stops a caller from
// storing a key the type never had — it renders as nothing on the canvas and
// buckets as not_started, which is how "set this goal to Active" used to fail
// silently. Every writer (canvas, board drag, REST, machine API, MCP) routes
// through createItem/updateItem, so one guard here covers all of them: resolve
// the key or the label, else refuse and name the type's real statuses so the
// caller can retry without a second round trip.
function requireStatusKey(
  schema: StatusDef[],
  raw: string,
  typeKey: string
): string {
  const key = resolveStatusKey(schema, raw);
  if (key) return key;
  throw new ItemError(
    "bad_request",
    `'${raw}' is not a status on type '${typeKey}'. Its statuses are: ` +
      schema.map((st) => `${st.key} ("${st.label}")`).join(", ")
  );
}

export async function createItem(ownerId: string, rawInput: ItemInput) {
  // One date per task (John, 2026-09-21): a task created with only a due or only
  // a scheduled day gets the other set to match.
  const input = mirrorTaskDates(rawInput, rawInput.type === "task");
  const capability = await assertTypeExists(input.type);
  // is_template is set explicitly on a prototype root, else inherited from a
  // template parent (ADR-093), so a subtask under a prototype is template
  // content too without any caller doing anything special.
  const parentIsTemplate = input.parentId
    ? await assertValidParent(ownerId, input.parentId)
    : false;
  const isTemplate = input.isTemplate ?? parentIsTemplate;

  // Status is a key from the type's schema (S2). Default to the type's "not
  // started" status, and store its category alongside so the hot queries / the
  // done-checkbox / recurrence key off the indexed bucket.
  const schema = await statusSchemaForType(input.type);
  const statusKey =
    input.status !== undefined
      ? requireStatusKey(schema, input.status, input.type)
      : initialStatusKey(schema);
  const statusCat = categoryOfStatus(schema, statusKey);

  const { inbox, destinationId } = await resolveRoute(ownerId, input);

  // The type's canonical format wins over whatever the caller composed (ADR-260):
  // a song's body is ChordPro even when it arrived as a plain markdown string.
  const body = stampCanonicalFormat(input.body ?? null, input.type, capability);
  // A new top-level task with no day lands on TODAY (John, 2026-09-22: "when I
  // add a new task it does not show up on today's list"). His model is Outlook —
  // every task sits on a day — so an undated task would otherwise fall to the
  // agenda's "No date" bucket at the bottom. Subtasks and templates are left
  // alone (a batch of subtasks should not all pile onto today).
  const defaultDay =
    input.type === "task" &&
    !isTemplate &&
    !input.parentId &&
    input.dueDate == null &&
    input.scheduledDate == null
      ? new Date(`${appTodayYmd()}T00:00:00.000Z`)
      : null;
  const rows = await getDb()
    .insert(items)
    .values({
      ownerId,
      type: input.type,
      title: input.title ?? "",
      body,
      bodyText: extractBodyText(body, input.properties),
      status: statusKey,
      statusCategory: statusCat,
      dueDate: input.dueDate ?? defaultDay,
      scheduledDate: input.scheduledDate ?? defaultDay,
      urgency: input.urgency ?? null,
      meetingAt: input.meetingAt ?? null,
      // A note's "date taken" defaults to the creation calendar day (in the app
      // timezone), stored UTC-midnight like scheduled/due (ADR-008/ADR-110).
      // User-editable afterward. Other types leave it null.
      noteDate:
        input.noteDate ??
        (input.type === "note"
          ? new Date(`${appTodayYmd()}T00:00:00.000Z`)
          : null),
      url: input.url ?? null,
      parentId: input.parentId ?? null,
      properties: input.properties ?? null,
      inbox,
      isTemplate,
    })
    .returning(itemColumns);
  const created = rows[0];
  if (created.body != null) {
    await snapshotRevision(created.id, created.body);
    await syncMentionRelations(ownerId, created.id, created.body);
    await syncPassageRefs(ownerId, created.id, created.body);
  }
  // Activity log (ADR-111): a tracked record (a project) being born is the first
  // line of its own timeline. Best-effort — a failed log line never breaks the
  // create.
  if (!isTemplate && isTrackedSubjectType(created.type)) {
    await emitActivity({
      ownerId,
      subjectId: created.id,
      kind: "record_created",
      summary: `Created ${created.title || "untitled"}`,
      payload: { type: created.type },
    }).catch(() => {});
  }
  // The destination edge (ADR-249) is written here, not at the API route's
  // relateTo: four of the seven arrival paths call createItem directly and
  // would silently drop their destination. Best-effort like the activity log
  // above, so a failed edge never undoes a capture.
  if (destinationId) {
    await relateItems(ownerId, created.id, destinationId, "project").catch(() => {});
  } else if (created.type === "task" && !isTemplate) {
    // A task that names a project in its title files under it (2026-09-22).
    await autoLinkTaskToProject(ownerId, created.id, created.title).catch(() => {});
  }
  kickYoutubeTranscript(ownerId, created.type, created.url);
  return created;
}

/**
 * Where this capture lands: the Inbox, filed away, or filed into a project.
 *
 * AN EXPLICIT `inbox` ALWAYS WINS. The per-source setting supplies a default
 * when the caller is silent, never an override, so every MCP and API caller
 * written before ADR-249 behaves exactly as it did. Settings are read only when
 * a source names itself and the caller said nothing, so the ordinary create
 * path adds no query (and getSettings is React-cached per request anyway).
 *
 * A destination that has been moved to Trash falls back to the Inbox rather
 * than filing invisibly, and the setting is left alone so restoring the project
 * restores the routing.
 */
export async function resolveRoute(
  ownerId: string,
  input: Pick<ItemInput, "inbox" | "source">
): Promise<{ inbox: boolean; destinationId: string | null }> {
  if (input.inbox !== undefined || !input.source) {
    return { inbox: input.inbox ?? false, destinationId: null };
  }
  const { inboxRoutes } = await getSettings(ownerId);
  const route = routeFor(inboxRoutes, input.source);
  if (!route.destinationId) return route;
  const live = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.id, route.destinationId),
        eq(items.ownerId, ownerId),
        isNull(items.deletedAt)
      )
    );
  return live.length > 0 ? route : { inbox: true, destinationId: null };
}

/**
 * Start transcribing a video the moment it is saved, instead of leaving it to
 * the ten-minute timer.
 *
 * ONE GUARD, IN THE ONE FUNCTION EVERY SAVE ALREADY GOES THROUGH: the phone
 * share sheet, the desktop bookmarklet, quick capture in the app, and anything
 * Claude files over the assistant connection all create their link here. That
 * is why no capture route carries its own copy of this, and why a capture path
 * added next year gets it without anyone remembering to wire it up.
 *
 * The timer stays as the backstop, and it is not redundant: it is what picks up
 * a video saved while this copy was closed, or saved on another copy entirely
 * (a video saved in the cloud arrives here on the next sync and waits for the
 * next tick).
 *
 * FIRE AND FORGET, deliberately. The caller's reply goes back at once and the
 * transcript finishes behind it, so sharing a video from a phone never waits on
 * Whisper. Nothing here may delay or fail the create, so the promise is
 * swallowed into captureError rather than returned: an unhandled rejection out
 * of a background task takes the whole process down.
 */
function kickYoutubeTranscript(ownerId: string, type: string, url: string | null) {
  // The cheap half first, in memory, so creating a task or a note pays one
  // string comparison and nothing else.
  if (type !== "link" || !url) return;
  void (async () => {
    // Loaded on demand, never at the top of this file: the transcript module
    // reaches for yt-dlp and Whisper as child processes, and item creation is
    // in practically every bundle on the server.
    const { isYoutubeVideoUrl, runYoutubeTranscripts } = await import("@/lib/youtube/transcripts");
    if (!isYoutubeVideoUrl(url)) return;
    // Only the machine named under Scheduled work does this, exactly as the
    // timer path checks. Whether the feature is switched on at all is the
    // owner's separate setting, which the job reads for itself: asking it here
    // too is how two answers to one question start disagreeing.
    const { run } = await jobRunVerdict(ownerId, "youtube-transcript");
    if (!run) return;
    // Detached for the same reason the scheduled endpoint is: the save that
    // started this is an HTTP request too, and it must not be held open while a
    // video is transcribed.
    await runYoutubeTranscripts(ownerId, { detach: true });
  })().catch((err) =>
    captureError("youtube-transcript", err, {
      detail: { trigger: "a video was saved, so the transcript started at once" },
    })
  );
}

export async function updateItem(
  ownerId: string,
  id: string,
  patch: ItemPatch
) {
  const db = getDb();
  const existing = await db
    .select({
      id: items.id,
      status: items.status,
      statusCategory: items.statusCategory,
      type: items.type,
      body: items.body,
      // The PRIOR dates + pins: date anchoring (ADR-253) shifts this item's
      // deadline and its children by however far its scheduled date just moved,
      // so the write needs the before-value. Free — this row is already read.
      scheduledDate: items.scheduledDate,
      dueDate: items.dueDate,
      properties: items.properties,
    })
    .from(items)
    .where(
      and(eq(items.id, id), eq(items.ownerId, ownerId), isNull(items.deletedAt))
    );
  if (existing.length === 0) throw new ItemError("not_found", "item not found");

  let typeCapability: string | null | undefined;
  if (patch.type !== undefined) typeCapability = await assertTypeExists(patch.type);
  if (patch.parentId != null) {
    await assertValidParent(ownerId, patch.parentId, id);
  }

  // Re-stamp a written body with the type's canonical format (ADR-260), before
  // the no-op comparison below so it compares the format that will actually be
  // stored. The extra type lookup is paid ONLY when a body is being written and
  // the patch didn't already resolve the capability by changing the type, so an
  // ordinary status/date update costs nothing. Retyping an item (note → song)
  // re-stamps too, which is what makes `move_item_type` land a valid ChordPro
  // body instead of one still labelled markdown.
  if (patch.body !== undefined) {
    const effectiveType = patch.type ?? existing[0].type;
    if (typeCapability === undefined) {
      typeCapability = await assertTypeExists(effectiveType);
    }
    patch = {
      ...patch,
      body: stampCanonicalFormat(patch.body, effectiveType, typeCapability),
    };
  }

  // The category this status change moves into (if the patch changes status).
  // Statuses are user-defined (S2), so "completing" means moving INTO the done
  // category, not a literal "done" — resolved through the type's schema. Also
  // the value written to status_category alongside the status key.
  let nextCategory: StatusCategory | undefined;
  // The resolved status key to write (ADR-243): a caller may name a status by its
  // label, and a name the type doesn't have is refused rather than stored.
  let nextStatus: string | undefined;
  if (patch.status !== undefined) {
    const typeKey = patch.type ?? existing[0].type;
    const schema = await statusSchemaForType(typeKey);
    nextStatus = requireStatusKey(schema, patch.status, typeKey);
    nextCategory = categoryOfStatus(schema, nextStatus);
  }

  // Recurrence-aware completion (ADR-076). Completing a recurring task is not a
  // plain status flip, so intercept the completing gesture before the normal
  // update. Runs for every caller (checkbox / MCP / REST) since they all land
  // here. Only fires when this patch moves the item into the done category.
  let materializedOccurrencePost = false;
  if (nextCategory === "done" && existing[0].statusCategory !== "done") {
    const current = await getItem(ownerId, id);
    const props = current.properties as Record<string, unknown> | null;
    const rule = parseRecurrence(props?.recurrence);
    if (rule) {
      // A recurring SERIES: advance to the next occurrence, don't mark it done.
      // Apply any other fields in the same patch first (completion is normally
      // status-only, but MCP/REST could send more), then advance from the
      // re-read row so the advance sees those edits.
      const { status: _done, ...rest } = patch;
      if (Object.keys(rest).length > 0) await updateItem(ownerId, id, rest);
      const fresh = await getItem(ownerId, id);
      const advanced = await completeVirtualSeries(ownerId, fresh);
      if (rule.occurrenceMode === "materialized") {
        await ensureFirstOccurrence(ownerId, id); // keep one live occurrence
      }
      return advanced;
    }
    if (occurrenceSeriesId(current)) {
      // A materialized occurrence child: complete it normally below, then
      // advance its parent series + clone the next occurrence.
      materializedOccurrencePost = true;
    }
  }

  // The body editor re-emits the loaded body once when it mounts (a programmatic
  // editor transaction, not a user edit), so merely opening an item PATCHes a
  // body byte-identical to what's stored. Detect that no-op: a body whose text
  // (and format, when both are well-formed bodies) matches the stored one isn't
  // written, so it can't move updated_at — the `$onUpdate` column bumps on every
  // UPDATE — or snapshot a redundant revision. This is the "viewing an item
  // changes its edit date" bug; the guard lives here so every caller (editor,
  // MCP, REST) is covered, not just the one client. A real format switch with
  // identical text still counts as a change.
  const prevBody = existing[0].body;
  const writeBody =
    patch.body !== undefined &&
    !(
      bodyMarkdown(patch.body) === bodyMarkdown(prevBody) &&
      (!isItemBody(prevBody) ||
        !isItemBody(patch.body) ||
        patch.body.format === prevBody.format)
    );

  // Cross-device edit guard (ADR-134): a real body write that carries an
  // expectedBodyDigest must match the body it's overwriting. If the stored body
  // has moved on (another device saved since this client loaded), this is a
  // stale full-body PATCH that would silently clobber that edit — refuse it so
  // the client can surface the conflict and let the user choose. Content-based
  // (the body, not items.updated_at) on purpose: it ignores sibling writes to
  // status/properties/etc. on the same item, so editing a field on one device
  // never trips a false body conflict on another. The phantom on-open save is a
  // no-op (writeBody false) and never reaches here, so opening an item can't
  // conflict; only a genuine body change does.
  if (
    writeBody &&
    patch.expectedBodyDigest !== undefined &&
    patch.expectedBodyDigest !== bodyDigest(prevBody)
  ) {
    throw new ItemError(
      "conflict",
      "this item's body changed on another device since you opened it"
    );
  }

  const set: Record<string, unknown> = {};
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.status !== undefined) {
    set.status = nextStatus;
    set.statusCategory = nextCategory;
    // Completing an item triages it out of the Inbox (PRD §4.2): a finished task
    // is no longer "awaiting triage", so completion IS triage. Only on the
    // transition into done; an explicit `patch.inbox` below still wins. The
    // recurring-series case returns earlier (it advances, never completes), so
    // it never reaches here — correct, the series isn't done.
    if (nextCategory === "done" && existing[0].statusCategory !== "done") {
      set.inbox = false;
    }
  }
  // One date per task (John, 2026-09-21): editing either day on a task sets both.
  // Done before anchoring, which then sees "both dates stated" and stands down.
  patch = mirrorTaskDates(patch, (patch.type ?? existing[0].type) === "task");
  if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
  if (patch.scheduledDate !== undefined) set.scheduledDate = patch.scheduledDate;
  // Date anchoring (ADR-253): the deadline hangs off the plan date, so moving the
  // plan carries the deadline along by the same number of days, preserving the gap
  // the owner already set. Skipped when the caller set BOTH dates in one patch
  // (it is stating them deliberately) and when the deadline is pinned (a hard
  // external date that ignores the plan). This is what stops a completed recurring
  // task from leaving a fossil deadline behind — the ADR-076 `maintainDueOffset`
  // flag did this, but default-off and reachable only over MCP, so nobody had it.
  const scheduledDelta =
    patch.scheduledDate !== undefined
      ? dayDelta(existing[0].scheduledDate, patch.scheduledDate)
      : null;
  if (
    scheduledDelta !== null &&
    patch.dueDate === undefined &&
    existing[0].dueDate &&
    !isDuePinned(existing[0].properties as Record<string, unknown> | null)
  ) {
    set.dueDate = shiftDay(existing[0].dueDate, scheduledDelta);
  }
  if (patch.urgency !== undefined) set.urgency = patch.urgency;
  if (patch.meetingAt !== undefined) set.meetingAt = patch.meetingAt;
  if (patch.endAt !== undefined) set.endAt = patch.endAt;
  if (patch.noteDate !== undefined) set.noteDate = patch.noteDate;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.parentId !== undefined) set.parentId = patch.parentId;
  if (patch.nextActionTaskId !== undefined)
    set.nextActionTaskId = patch.nextActionTaskId;
  if (patch.nextActionText !== undefined)
    set.nextActionText = patch.nextActionText;
  if (patch.composition !== undefined) set.composition = patch.composition;
  if (patch.properties !== undefined) set.properties = patch.properties;
  // Per-key merge (ADR-069): overwrite only these keys, keep the rest. Atomic at
  // the DB level (no read-modify-write race), and the generated search tsvector
  // recomputes from the merged jsonb automatically. Applied after `properties`
  // so a caller sending both lands on the merge (they're mutually exclusive in
  // practice — the canvas sends one or the other).
  if (patch.propertyPatch !== undefined) {
    set.properties = sql`coalesce(${items.properties}, '{}'::jsonb) || ${JSON.stringify(
      patch.propertyPatch
    )}::jsonb`;
  }
  // Completion stamp (ADR-196; widened to tasks in ADR-197): entering the done
  // category writes properties.completed_at — the Timeline places a finished
  // undated milestone at this date, and the project markdown document reports
  // when each task finished — leaving done clears it. Composed on top of
  // whatever properties write this patch already carries, so a status flip with
  // a sibling property edit stays one atomic UPDATE. Recurring task series
  // never reach here on completion (intercepted above — they advance instead of
  // finishing), so only genuinely-completed items are stamped.
  const stampType = patch.type ?? existing[0].type;
  if ((stampType === "milestone" || stampType === "task") && nextCategory !== undefined) {
    const wasDone = existing[0].statusCategory === "done";
    const entering = nextCategory === "done" && !wasDone;
    const leaving = nextCategory !== "done" && wasDone;
    if (entering || leaving) {
      const stamp = { completed_at: new Date().toISOString() };
      if (patch.properties !== undefined) {
        // Wholesale replace: fold the stamp into (or out of) the new object.
        const base = { ...((patch.properties ?? {}) as Record<string, unknown>) };
        if (entering) base.completed_at = stamp.completed_at;
        else delete base.completed_at;
        set.properties = base;
      } else if (patch.propertyPatch !== undefined) {
        // Per-key merge: re-derive with the stamp folded in, then strip on reopen.
        const merged = entering
          ? { ...patch.propertyPatch, ...stamp }
          : patch.propertyPatch;
        const mergeSql = sql`coalesce(${items.properties}, '{}'::jsonb) || ${JSON.stringify(merged)}::jsonb`;
        set.properties = entering ? mergeSql : sql`(${mergeSql}) - 'completed_at'`;
      } else {
        set.properties = entering
          ? sql`coalesce(${items.properties}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb`
          : sql`coalesce(${items.properties}, '{}'::jsonb) - 'completed_at'`;
      }
    }
  }
  if (patch.inbox !== undefined) set.inbox = patch.inbox;
  // body_text carries the canvas Notes tab's markdown alongside the body
  // (body-text.ts), so a notes-only save has to recompute it too — otherwise
  // notes written on a paper or a song would never reach search. The notes this
  // write lands on are resolved here in JS because the propertyPatch branch
  // merges in SQL, so `set.properties` can't be read back; an untouched write
  // falls through to the stored object and recomputes nothing.
  const nextProperties =
    patch.properties !== undefined
      ? patch.properties
      : patch.propertyPatch !== undefined
        ? {
            ...((existing[0].properties as Record<string, unknown> | null) ?? {}),
            ...patch.propertyPatch,
          }
        : existing[0].properties;
  const notesChanged =
    notesMarkdown(nextProperties) !== notesMarkdown(existing[0].properties);
  if (writeBody) {
    set.body = patch.body;
    set.bodyText = extractBodyText(patch.body, nextProperties);
  } else if (notesChanged) {
    set.bodyText = extractBodyText(existing[0].body, nextProperties);
  }
  if (Object.keys(set).length === 0) {
    // A patch that carried only a no-op body (the editor's on-open phantom
    // save) leaves nothing to write: return the item untouched rather than
    // bumping updated_at. A patch with no recognized fields at all is still
    // a client error.
    if (patch.body !== undefined) return await getItem(ownerId, id);
    throw new ItemError("bad_request", "no fields to update");
  }

  const rows = await db
    .update(items)
    .set(set)
    .where(and(eq(items.id, id), eq(items.ownerId, ownerId)))
    .returning(itemColumns);
  const updated = rows[0];
  // Descendants moved by this write, captured as they were BEFORE it so the
  // caller can offer an undo (ADR-253 / ADR-142). Empty on every write that
  // didn't move a date.
  let shiftedChildren: ShiftedChild[] = [];
  if (writeBody) {
    if (updated.body != null) await snapshotRevision(id, updated.body);
    // Runs on null bodies too: clearing a body clears its mention edges.
    await syncMentionRelations(ownerId, id, updated.body);
    // Same contract for passage @/refs — the passage_refs sibling of mentions.
    await syncPassageRefs(ownerId, id, updated.body);
  }
  // A scheduled-date move carries the whole subtask tree with it (ADR-253):
  // every unpinned dated descendant shifts by the same number of days, so a
  // parent bumped to next Monday takes its checklist along. Only when the date
  // actually moved (a no-op re-save shifts nothing), and never when it was
  // cleared or first set — there is no delta to apply then, and the children
  // keep the dates they have.
  if (scheduledDelta !== null) {
    shiftedChildren = await shiftChildDates(ownerId, id, scheduledDelta);
  }
  // A materialized occurrence was just completed: advance its parent series and
  // clone the next occurrence (create-next-after-completion). Done after the
  // child's own update so the child is firmly `done` history first.
  if (materializedOccurrencePost) {
    await completeMaterializedOccurrence(ownerId, updated);
  }
  // Setting a materialized recurrence rule creates the first live occurrence
  // (idempotent — a no-op if not materialized or one already exists).
  const touchedRecurrence =
    (patch.propertyPatch && "recurrence" in patch.propertyPatch) ||
    (patch.properties != null && "recurrence" in patch.properties);
  if (touchedRecurrence) {
    await ensureFirstOccurrence(ownerId, id).catch(() => {});
  }
  // Activity log (ADR-111). Two independent lines, both best-effort:
  // (1) a tracked record's OWN status change narrates itself;
  // (2) a contained item moving into the done category narrates its home parent
  //     (a task finishing shows on its project's timeline). Inbox items with no
  //     tracked home parent log nothing — keeps the log a project narrative.
  const statusChanged =
    set.status !== undefined && existing[0].status !== patch.status;
  if (statusChanged && isTrackedSubjectType(updated.type)) {
    await emitActivity({
      ownerId,
      subjectId: updated.id,
      kind: "status_changed",
      summary: `Status → ${updated.status}`,
      payload: { from: existing[0].status, to: updated.status },
    }).catch(() => {});
  }
  if (nextCategory === "done" && existing[0].statusCategory !== "done") {
    const parent = await homeParentOf(ownerId, updated.id).catch(() => null);
    if (parent && isTrackedSubjectType(parent.type)) {
      await emitActivity({
        ownerId,
        subjectId: parent.id,
        actorId: updated.id,
        kind: "task_completed",
        summary: `Completed “${updated.title || "untitled"}”`,
        payload: { childType: updated.type },
      }).catch(() => {});
      // Next Action auto-advance (ADR-111/PJ5): if the completed task is the
      // home parent's pinned Next Action, advance to the next open contained
      // task (ordered by creation), else clear it. Direct write — not through
      // updateItem — to avoid re-entrancy and an extra status_changed line.
      await advanceNextActionIfPinned(ownerId, parent.id, updated.id).catch(() => {});
    }
  }
  // Additive (ADR-183 carve-out): callers that ignore the key are unaffected; the
  // item PATCH route passes it through so the client can raise "Moved N subtasks ·
  // Undo" instead of moving the owner's dates silently.
  // Renamed task that now names a project → file it there (2026-09-22). No-op
  // when it already has a project edge.
  if (patch.title !== undefined && updated.type === "task" && !updated.isTemplate) {
    await autoLinkTaskToProject(ownerId, updated.id, updated.title).catch(() => {});
  }
  return shiftedChildren.length > 0
    ? { ...updated, datesShifted: shiftedChildren }
    : updated;
}

// The reconciliation summary for a type move (ADR-132). `carried` properties
// exist on both the source and target type and keep rendering as fields;
// `surfaced` properties are declared on the source type but not the target, so
// their values are written into the body as a YAML block (and retained in
// items.properties as a recoverable backup). `relationCount` is the user's
// intentional relations (mention edges excluded) — all kept, untouched.
export type MoveTypeSummary = {
  from: string; // source type label
  to: string; // target type label
  carried: string[]; // property labels that carry over
  surfaced: string[]; // property labels written into the body
  relationCount: number;
};

// A YAML scalar for a property value — human-readable and editable, not a strict
// serializer. Strings/numbers/booleans render bare; arrays/objects fall back to
// compact JSON so nothing is silently dropped.
function yamlScalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// The fenced YAML block prepended to a body when a move orphans properties. Keyed
// by property key (machine-stable), captioned with the former type so the reader
// knows where it came from.
function propertiesYamlBlock(
  fromLabel: string,
  defs: PropertyDef[],
  props: Record<string, unknown>
): string {
  const lines = defs.map((d) => `${d.key}: ${yamlScalar(props[d.key])}`);
  return ["```yaml", `# carried over from ${fromLabel}`, ...lines, "```"].join("\n");
}

// Move an item to another type (ADR-132). The data layer already lets updateItem
// change `type`; this adds the property reconciliation around it so nothing is
// lost. Only the SOURCE type's own declared properties are reconciled: keys it
// shares with the target carry over untouched; keys the target lacks are surfaced
// into the body as a YAML block. System keys (locked, recurrence, sync ids) and
// anything not on the type schema stay in items.properties untouched and are
// never surfaced. Relation-kind properties hold no jsonb value (their value is
// the relation edges, which always survive), so they're skipped. Values are
// RETAINED in jsonb, so a move back re-renders the original fields.
//
// `dryRun` computes and returns the summary without writing — the same code path
// that powers the dialog's preview, so the preview can never drift from the
// commit. Owner-scoped throughout.
export async function moveItemType(
  ownerId: string,
  id: string,
  targetType: string,
  opts: { dryRun?: boolean } = {}
): Promise<{ summary: MoveTypeSummary; item?: Awaited<ReturnType<typeof getItem>> }> {
  const item = await getItem(ownerId, id); // owner-scoped; throws not_found
  if (item.type === targetType) {
    throw new ItemError("bad_request", "item is already that type");
  }
  await assertTypeExists(targetType); // bad_request for a missing/trashed type

  // Dynamic import breaks the items.ts <-> types.ts value cycle (types.ts imports
  // ItemError from there). Both type defs are best-effort: an unregistered type
  // simply contributes no property schema.
  const { getType } = await import("@/lib/types");
  const fromDef = await getType(item.type).catch(() => null);
  const toDef = await getType(targetType).catch(() => null);
  const toKeys = new Set((toDef?.propertySchema ?? []).map((p) => p.key));
  const props = (item.properties as Record<string, unknown> | null) ?? {};

  const carriedDefs: PropertyDef[] = [];
  const surfacedDefs: PropertyDef[] = [];
  for (const pdef of fromDef?.propertySchema ?? []) {
    const v = props[pdef.key];
    if (v == null || v === "") continue; // unset on this item — nothing to move
    if (pdef.kind === "relation") continue; // value is edges, not jsonb; edges stay
    (toKeys.has(pdef.key) ? carriedDefs : surfacedDefs).push(pdef);
  }

  // Intentional relations only (mention edges are body-owned and re-sync from the
  // body), counted across both directions.
  const relRows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(relations)
    .where(
      and(
        or(eq(relations.sourceId, id), eq(relations.targetId, id)),
        ne(relations.role, "mention")
      )
    );

  const summary: MoveTypeSummary = {
    from: fromDef?.label ?? item.type,
    to: toDef?.label ?? targetType,
    carried: carriedDefs.map((p) => p.label),
    surfaced: surfacedDefs.map((p) => p.label),
    relationCount: relRows[0]?.n ?? 0,
  };
  if (opts.dryRun) return { summary };

  // Surface orphaned properties at the top of the body (decided: visible +
  // copyable). updateItem snapshots a revision when the body changes, so the
  // pre-move state stays restorable; values are also retained in jsonb.
  let bodyPatch: ItemBody | undefined;
  if (surfacedDefs.length > 0) {
    const block = propertiesYamlBlock(summary.from, surfacedDefs, props);
    const current = bodyMarkdown(item.body);
    const format = isItemBody(item.body) ? item.body.format : MARKDOWN_FORMAT;
    bodyPatch = { format, text: current ? `${block}\n\n${current}` : block };
  }

  const updated = await updateItem(ownerId, id, {
    type: targetType,
    ...(bodyPatch ? { body: bodyPatch } : {}),
  });
  return { summary, item: updated };
}

// Toggle a task's completion from a checkbox (S2). Statuses are user-defined, so
// a checkbox can't hardcode "done"/"open": resolve the item's type schema and
// flip between its default done and not-started status. Routes through updateItem
// so recurrence-complete fires when moving into the done category.
export async function toggleItemDone(ownerId: string, id: string) {
  const item = await getItem(ownerId, id);
  const schema = await statusSchemaForType(item.type);
  const next =
    item.statusCategory === "done"
      ? defaultStatusKey(schema, "not_started") ?? "open"
      : defaultStatusKey(schema, "done") ?? "done";
  return updateItem(ownerId, id, { status: next });
}

// If `taskId` is the pinned Next Action on `parentId`, advance the pin to the
// next open contained (home) task ordered by creation, else clear it (ADR-111).
// A direct, owner-scoped write so it can run inside updateItem without recursion.
async function advanceNextActionIfPinned(
  ownerId: string,
  parentId: string,
  taskId: string
) {
  const db = getDb();
  const parent = await db
    .select({ next: items.nextActionTaskId })
    .from(items)
    .where(and(eq(items.id, parentId), eq(items.ownerId, ownerId)));
  if (parent.length === 0 || parent[0].next !== taskId) return;
  const nextRows = await db
    .select({ id: items.id })
    .from(items)
    .innerJoin(
      relations,
      and(
        eq(relations.sourceId, items.id),
        eq(relations.targetId, parentId),
        eq(relations.home, true),
        eq(relations.matchState, "confirmed")
      )
    )
    .where(
      and(
        eq(items.ownerId, ownerId),
        eq(items.type, "task"),
        isNull(items.deletedAt),
        eq(items.isTemplate, false),
        inArray(items.statusCategory, ["not_started", "in_progress"]),
        ne(items.id, taskId)
      )
    )
    .orderBy(items.createdAt)
    .limit(1);
  await db
    .update(items)
    .set({ nextActionTaskId: nextRows[0]?.id ?? null })
    .where(and(eq(items.id, parentId), eq(items.ownerId, ownerId)));
}

// Soft-deletes the item and every live descendant in one statement, all with
// the same deleted_at, so the unit restores together (PRD §4.6) and restore
// can match on the shared timestamp. UNION (not ALL) caps any pre-existing
// cycle.
export async function softDeleteItem(ownerId: string, id: string) {
  const res = await getDb().execute(sql`
    with recursive doomed as (
      select id from items
      where id = ${id} and owner_id = ${ownerId} and deleted_at is null
      union
      select i.id from items i join doomed d on i.parent_id = d.id
      where i.deleted_at is null
    )
    update items set deleted_at = now(), updated_at = now()
    where id in (select id from doomed)
    returning id
  `);
  if (res.rows.length === 0) throw new ItemError("not_found", "item not found");
  return { deleted: res.rows.length };
}

// Restores the deletion unit: the item plus descendants that went to Trash
// in the same soft-delete (matched on the shared deleted_at). A child that
// was already in Trash from an earlier, separate delete keeps its own
// timestamp and stays put.
export async function restoreItem(ownerId: string, id: string) {
  const res = await getDb().execute(sql`
    with recursive unit as (
      select id, deleted_at from items
      where id = ${id} and owner_id = ${ownerId} and deleted_at is not null
      union
      select i.id, i.deleted_at from items i join unit u on i.parent_id = u.id
      where i.deleted_at = u.deleted_at
    )
    update items set deleted_at = null, updated_at = now()
    where id in (select id from unit)
    returning id, type
  `);
  if (res.rows.length === 0) {
    throw new ItemError("not_found", "item not found in trash");
  }
  // An active item can't reference a soft-deleted type (ADR-058): if restoring
  // these items revived something whose type is in Trash, revive the type too.
  const restoredTypes = Array.from(
    new Set(res.rows.map((r) => (r as { type: string }).type))
  );
  if (restoredTypes.length > 0) {
    await getDb()
      .update(types)
      .set({ deletedAt: null })
      .where(and(inArray(types.key, restoredTypes), isNotNull(types.deletedAt)));
  }
  return { restored: res.rows.length };
}

export async function restoreRevision(
  ownerId: string,
  itemId: string,
  revisionId: string
) {
  const db = getDb();
  const current = await getItem(ownerId, itemId);
  const rev = await db
    .select({ body: revisions.body })
    .from(revisions)
    .where(and(eq(revisions.id, revisionId), eq(revisions.itemId, itemId)));
  if (rev.length === 0) throw new ItemError("not_found", "revision not found");

  // The latest edits may have been debounced away; snapshot the pre-restore
  // body unconditionally so the restore itself is undoable.
  if (current.body != null) {
    await snapshotRevision(itemId, current.body, { force: true });
  }
  const body = rev[0].body;
  const rows = await db
    .update(items)
    .set({ body, bodyText: extractBodyText(body, current.properties) })
    .where(and(eq(items.id, itemId), eq(items.ownerId, ownerId)))
    .returning(itemColumns);
  // The restored body's mentions + passage refs are the live ones now.
  await syncMentionRelations(ownerId, itemId, body);
  await syncPassageRefs(ownerId, itemId, body);
  return rows[0];
}

// The daily purge (machine job, not user-facing, so it intentionally runs
// across all owners). Children purge with their unit because cascade
// soft-delete stamped them with the same deleted_at; the detach UPDATE
// covers the one stray case, an item restored out of a unit whose parent
// then ages out, so the parent's hard delete can't hit an FK. Two
// statements without a transaction is acceptable: a detach that lands
// without its delete is retried by the next day's run.
export async function purgeExpiredTrash() {
  const db = getDb();
  const cutoff = sql`now() - make_interval(days => ${TRASH_RETENTION_DAYS})`;
  const detached = await db.execute(sql`
    update items set parent_id = null
    where parent_id in (select id from items where deleted_at < ${cutoff})
      and (deleted_at is null or deleted_at >= ${cutoff})
    returning id
  `);
  // relations/attachments/revisions rows go via ON DELETE CASCADE. The R2
  // bytes behind those attachment rows are deleted HERE, before the cascade
  // (ADR-237 — the debt this comment used to defer). Best-effort per object: a
  // failed delete leaves an orphan the Data Hygiene sweep reconciles, never a
  // blocked purge. Peers replicating this purge (sync/apply) deliberately do
  // NOT repeat it — two installs can share one bucket, and the origin's purge
  // deletes the bytes exactly once.
  const doomedFiles = await db.execute(sql`
    select a.storage_key from attachments a
    join items i on i.id = a.parent_item_id
    where i.deleted_at < ${cutoff}
  `);
  const storage = getStorage();
  let purgedFiles = 0;
  let orphanedFiles = 0;
  for (const row of doomedFiles.rows) {
    if (!storage) {
      orphanedFiles += 1;
      continue;
    }
    try {
      await storage.deleteObject(String((row as Record<string, unknown>).storage_key));
      purgedFiles += 1;
    } catch {
      orphanedFiles += 1;
    }
  }
  const purged = await db.execute(sql`
    delete from items where deleted_at < ${cutoff} returning id
  `);
  // Soft-deleted types past the window are hard-purged too (ADR-058). Their
  // items were trashed in the same operation, so they've just been purged above
  // — the FK is now clear. The type's templates cascade with the row.
  const purgedTypes = await db.execute(sql`
    delete from types where deleted_at < ${cutoff} returning key
  `);
  return {
    purged: purged.rows.length,
    detached: detached.rows.length,
    purgedTypes: purgedTypes.rows.length,
    purgedFiles,
    orphanedFiles,
  };
}
