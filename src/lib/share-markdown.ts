// Share / import as portable Markdown (2026-09-22, John: "a simple share button
// on any note … something other Ledgr users can just import, and if they are
// not in Ledgr I can share it any other normal way").
//
// The interchange format is a plain .md file with a small front-matter block:
//
//   ---
//   ledgr: 1
//   type: note
//   title: Pastor Roger — Edgewood Community Church
//   tags: ["Sermon Notes"]
//   properties: {"speaker":"Pastor Roger","sermondate":"2026-09-13"}
//   created: 2026-09-13T15:02:00.000Z
//   ---
//   …the body markdown…
//
// Anyone can read it as text; Ledgr's importer (Build → Import & Migration, or
// POST /api/import/ledgr) recreates the item, its custom properties and its tags.
// A file with no front matter still imports as a note titled from its first
// heading. Values are JSON on one line each — no YAML parser needed on either end.
import { createItem, updateItem } from "@/lib/item-mutations";
import { getItem, listItems } from "@/lib/items";
import { listRelatedItems, relateItems } from "@/lib/relations";
import { bodyMarkdown, makeMarkdownBody } from "@/lib/body";
import { getType } from "@/lib/types";

export type ShareBundle = { filename: string; markdown: string; title: string };

// Properties that are this instance's plumbing, not the note's content.
const PRIVATE_PROPS = new Set(["outlookid", "focus", "dayorder", "callorder", "projorder", "completed_at", "recurrence"]);

function safeFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  return (base || "Untitled") + ".md";
}

export async function exportItemMarkdown(ownerId: string, id: string): Promise<ShareBundle> {
  const item = await getItem(ownerId, id);
  const related = await listRelatedItems(ownerId, id);
  const tags = related
    .filter((r) => r.type === "tag")
    .map((r) => r.title)
    .filter((t): t is string => !!t);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((item.properties ?? {}) as Record<string, unknown>)) {
    if (PRIVATE_PROPS.has(k) || v == null || v === "") continue;
    props[k] = v;
  }
  const title = item.title?.trim() || "Untitled";
  const lines = [
    "---",
    "ledgr: 1",
    `type: ${item.type}`,
    `title: ${JSON.stringify(title)}`,
  ];
  if (tags.length) lines.push(`tags: ${JSON.stringify(tags)}`);
  if (Object.keys(props).length) lines.push(`properties: ${JSON.stringify(props)}`);
  if (item.url) lines.push(`url: ${JSON.stringify(item.url)}`);
  lines.push(`created: ${item.createdAt.toISOString()}`);
  lines.push("---", "");
  const body = bodyMarkdown(item.body).trimEnd();
  const markdown = lines.join("\n") + `# ${title}\n\n` + body + "\n";
  return { filename: safeFilename(title), markdown, title };
}

type Parsed = {
  type: string;
  title: string;
  tags: string[];
  properties: Record<string, unknown>;
  url: string | null;
  body: string;
};

function parseJsonish(v: string): unknown {
  const s = v.trim();
  if (!s) return "";
  try {
    return JSON.parse(s);
  } catch {
    return s.replace(/^["']|["']$/g, "");
  }
}

export function parseLedgrMarkdown(text: string): Parsed {
  const src = text.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  const out: Parsed = { type: "note", title: "", tags: [], properties: {}, url: null, body: src };
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (fm) {
    out.body = src.slice(fm[0].length);
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = parseJsonish(m[2]);
      if (key === "type" && typeof val === "string" && val) out.type = val;
      else if (key === "title" && typeof val === "string") out.title = val;
      else if (key === "url" && typeof val === "string") out.url = val || null;
      else if (key === "tags") {
        if (Array.isArray(val)) out.tags = val.map(String).filter(Boolean);
        else if (typeof val === "string" && val) out.tags = val.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (key === "properties" && val && typeof val === "object" && !Array.isArray(val)) {
        out.properties = val as Record<string, unknown>;
      }
    }
  }
  // Title from the leading "# Heading" when the header didn't say (and drop the
  // heading from the body when it just repeats the title).
  const h = /^\s*#\s+(.+?)\s*\n/.exec(out.body);
  if (h) {
    if (!out.title) out.title = h[1].trim();
    if (h[1].trim() === out.title) out.body = out.body.slice(h[0].length);
  }
  out.body = out.body.replace(/^\n+/, "").trimEnd() + "\n";
  if (!out.title) out.title = "Imported note";
  return out;
}

async function tagIdByName(ownerId: string, name: string): Promise<string> {
  const rows = await listItems(ownerId, { type: "tag", limit: 200 });
  const hit = rows.find((r) => (r.title ?? "").trim().toLowerCase() === name.trim().toLowerCase());
  if (hit) return hit.id;
  const made = await createItem(ownerId, { type: "tag", title: name.trim() });
  return made.id;
}

export async function importLedgrMarkdown(ownerId: string, text: string) {
  const p = parseLedgrMarkdown(text);
  // Unknown type on this instance → note, keeping the declared type as a property.
  let type = p.type;
  const known = await getType(type).catch(() => null);
  if (!known) {
    p.properties.importedtype = type;
    type = "note";
  }
  const created = await createItem(ownerId, {
    type,
    title: p.title,
    body: makeMarkdownBody(p.body),
    url: p.url,
  });
  // Properties go through the normal update path so unknown keys are handled
  // the way the type editor would handle them.
  if (Object.keys(p.properties).length) {
    await updateItem(ownerId, created.id, { properties: p.properties }).catch(() => {});
  }
  const tagged: string[] = [];
  for (const t of p.tags) {
    try {
      const tid = await tagIdByName(ownerId, t);
      await relateItems(ownerId, created.id, tid, "tags");
      tagged.push(t);
    } catch {
      // best-effort
    }
  }
  return { id: created.id, title: p.title, type, tags: tagged };
}
