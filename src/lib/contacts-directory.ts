// Outlook contacts directory (2026-09-22, John: "connect [new person] to my
// contacts in Outlook and make it a lookup window").
//
// Ledgr runs on Vercel and has no route into his Exchange mailbox (no Graph
// consent on the WOL tenant), so the PC-side bridge exports the Contacts folder
// as one JSON document into a hidden `contact_directory` item, refreshed on its
// schedule. This module reads that document and searches it. Nothing here
// touches Outlook; if the bridge has never run, the directory is simply empty.
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { bodyMarkdown } from "@/lib/body";

export const CONTACT_DIRECTORY_TYPE = "contact_directory";

export type DirectoryContact = {
  id: string; // Outlook EntryID
  name: string;
  first?: string;
  last?: string;
  emails: string[];
  mobile?: string;
  business?: string;
  home?: string;
  company?: string;
  title?: string;
  city?: string;
};

type Cached = { key: string; at: number; contacts: DirectoryContact[]; exportedAt: string | null };
const cache = new Map<string, Cached>();
const TTL_MS = 60_000;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function normalize(raw: unknown): DirectoryContact[] {
  if (!Array.isArray(raw)) return [];
  const out: DirectoryContact[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const name = str(o.name);
    const id = str(o.id);
    if (!name || !id) continue;
    const emails = Array.isArray(o.emails) ? o.emails.map(str).filter((e): e is string => !!e) : [];
    out.push({
      id,
      name,
      first: str(o.first),
      last: str(o.last),
      emails,
      mobile: str(o.mobile),
      business: str(o.business),
      home: str(o.home),
      company: str(o.company),
      title: str(o.title),
      city: str(o.city),
    });
  }
  return out;
}

export async function loadDirectory(ownerId: string): Promise<{ contacts: DirectoryContact[]; exportedAt: string | null }> {
  const rows = await getDb()
    .select({ id: items.id, body: items.body, updatedAt: items.updatedAt, properties: items.properties })
    .from(items)
    .where(and(eq(items.ownerId, ownerId), eq(items.type, CONTACT_DIRECTORY_TYPE), isNull(items.deletedAt)))
    .orderBy(desc(items.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return { contacts: [], exportedAt: null };
  const key = `${row.id}:${row.updatedAt?.toISOString() ?? ""}`;
  const hit = cache.get(ownerId);
  if (hit && hit.key === key && Date.now() - hit.at < TTL_MS) return { contacts: hit.contacts, exportedAt: hit.exportedAt };
  let parsed: unknown = [];
  try {
    const text = bodyMarkdown(row.body).trim();
    // The bridge may wrap the JSON in a code fence for the editor's sake.
    const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    parsed = JSON.parse(m ? m[1] : text);
  } catch {
    parsed = [];
  }
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const exportedAt = str(props.exportedat) ?? null;
  const contacts = normalize(parsed);
  cache.set(ownerId, { key, at: Date.now(), contacts, exportedAt });
  return { contacts, exportedAt };
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Rank contacts against a free-text query: name-prefix matches first, then any word prefix, then substring in email/company. */
export function searchContacts(contacts: DirectoryContact[], query: string, limit = 12): DirectoryContact[] {
  const q = fold(query.trim());
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: { c: DirectoryContact; score: number }[] = [];
  for (const c of contacts) {
    const name = fold(c.name);
    const words = name.split(/[\s,]+/).filter(Boolean);
    const hay = fold([c.name, ...c.emails, c.company ?? "", c.title ?? "", c.city ?? ""].join(" | "));
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (name.startsWith(t)) score += 30;
      else if (words.some((w) => w.startsWith(t))) score += 20;
      else if (name.includes(t)) score += 10;
      else if (hay.includes(t)) score += 4;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((s) => s.c);
}

export function bestPhone(c: DirectoryContact): string | undefined {
  return c.mobile ?? c.business ?? c.home;
}
