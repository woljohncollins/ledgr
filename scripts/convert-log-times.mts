// One-off: turn a Log Entry's text Start/End ("9:06 PM") into a timed range on
// its Date field (ADR-254): properties.logdate = start instant, logdate__end =
// end instant, both ISO in UTC composed from the entry's day in the owner's
// zone. "All day" (or unparseable) entries keep their day-only date and get no
// end. Idempotent: an entry whose logdate already carries a time is skipped.
//
// Talks to the running app over the machine API (Basic auth, /build/api), so it
// works against any install without a DB string. Dry run by default.
//
//   LEDGR_URL=https://your.app LEDGR_API_KEY_ID=… LEDGR_API_SECRET=… \
//     npx tsx scripts/convert-log-times.mts            # report only
//     npx tsx scripts/convert-log-times.mts --apply    # write (backup JSON first)
//     npx tsx scripts/convert-log-times.mts --rollback backups/log-times-<stamp>.json
//   Optional: --tz America/Chicago (default), --type log_entry, --date logdate,
//   --start starttime, --end endtime.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { zonedInstant } from "../src/lib/zone";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const APPLY = args.includes("--apply");
const ROLLBACK = flag("rollback", "");
const TZ = flag("tz", "America/Chicago");
const TYPE = flag("type", "log_entry");
const DATE = flag("date", "logdate");
const START = flag("start", "starttime");
const END = flag("end", "endtime");
const END_KEY = `${DATE}__end`;

const URL_ = process.env.LEDGR_URL?.replace(/\/$/, "");
const KEY = process.env.LEDGR_API_KEY_ID;
const SECRET = process.env.LEDGR_API_SECRET;
if (!URL_ || !KEY || !SECRET) {
  console.error("Set LEDGR_URL, LEDGR_API_KEY_ID and LEDGR_API_SECRET (mint a key at /build/api).");
  process.exit(2);
}
const AUTH = `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`;

type Item = { id: string; title: string; properties: Record<string, unknown> | null };

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${URL_}${path}`, {
    ...init,
    headers: { Authorization: AUTH, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function listAll(): Promise<Item[]> {
  const out: Item[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = (await api(`/api/machine/items?type=${TYPE}&limit=200&offset=${offset}`)) as { items: Item[] };
    out.push(...page.items);
    if (page.items.length < 200) return out;
  }
}

async function patchAll(items: { id: string; propertyPatch: Record<string, unknown> }[]) {
  for (let i = 0; i < items.length; i += 100) {
    const r = (await api("/api/machine/items", {
      method: "PATCH",
      body: JSON.stringify({ items: items.slice(i, i + 100) }),
    })) as { count: number; errors: unknown[] };
    console.log(`  wrote ${r.count}${r.errors.length ? `, ${r.errors.length} errors: ${JSON.stringify(r.errors)}` : ""}`);
  }
}

// "9:06 PM" | "12:30 am" | "14:30" → minutes since midnight; null when not a clock.
export function parseClock(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 23) return null;
  const ap = m[3]?.toUpperCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
  }
  return h * 60 + min;
}

const ymdRec = (ymd: string) => ({ y: Number(ymd.slice(0, 4)), m: Number(ymd.slice(5, 7)), d: Number(ymd.slice(8, 10)) });

// The patch for one entry, or a reason it is skipped.
export function convert(p: Record<string, unknown>): { patch: Record<string, string> } | { skip: string } {
  const day = typeof p[DATE] === "string" ? (p[DATE] as string) : "";
  if (day.length < 10) return { skip: "no date" };
  if (day.length > 10) return { skip: "already timed" };
  const s = parseClock(p[START]);
  const e = parseClock(p[END]);
  if (s == null) return { skip: `start not a clock (${JSON.stringify(p[START] ?? null)})` };
  const start = zonedInstant(ymdRec(day), s, TZ);
  const patch: Record<string, string> = { [DATE]: start.toISOString() };
  if (e != null) {
    // An end at or before the start crossed midnight ("11:30 PM" → "12:15 AM").
    const end = zonedInstant(ymdRec(day), e <= s ? e + 24 * 60 : e, TZ);
    patch[END_KEY] = end.toISOString();
  }
  return { patch };
}

async function main() {
  if (ROLLBACK) {
    const rows = JSON.parse(readFileSync(ROLLBACK, "utf8")) as { id: string; before: Record<string, unknown> }[];
    console.log(`Rolling back ${rows.length} entries from ${ROLLBACK}`);
    await patchAll(rows.map((r) => ({ id: r.id, propertyPatch: r.before })));
    return;
  }
  const items = await listAll();
  console.log(`${items.length} ${TYPE} items; zone ${TZ}`);
  const todo: { id: string; title: string; before: Record<string, unknown>; patch: Record<string, string> }[] = [];
  const skipped: Record<string, number> = {};
  for (const it of items) {
    const p = it.properties ?? {};
    const r = convert(p);
    if ("skip" in r) {
      skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
      continue;
    }
    todo.push({ id: it.id, title: it.title, before: { [DATE]: p[DATE] ?? null, [END_KEY]: p[END_KEY] ?? null }, patch: r.patch });
  }
  console.log(`to convert: ${todo.length}; skipped: ${JSON.stringify(skipped)}`);
  for (const t of todo.slice(0, 5)) console.log(`  ${t.title.slice(0, 50).padEnd(50)} ${t.patch[DATE]} → ${t.patch[END_KEY] ?? "(no end)"}`);
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }
  mkdirSync("backups", { recursive: true });
  const file = `backups/log-times-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(todo.map(({ id, before }) => ({ id, before })), null, 2));
  console.log(`backup → ${file}`);
  await patchAll(todo.map((t) => ({ id: t.id, propertyPatch: t.patch })));
}

// Self-check when run with --check: the parser and the midnight rule.
if (args.includes("--check")) {
  const eq = (a: unknown, b: unknown, n: string) => {
    if (a !== b) { console.error(`FAIL ${n}: ${a} !== ${b}`); process.exit(1); }
  };
  eq(parseClock("9:06 PM"), 21 * 60 + 6, "pm");
  eq(parseClock("12:30 AM"), 30, "12am");
  eq(parseClock("12:15 PM"), 12 * 60 + 15, "12pm");
  eq(parseClock("14:30"), 14 * 60 + 30, "24h");
  eq(parseClock("All day"), null, "all day");
  const r = convert({ [DATE]: "2026-09-10", [START]: "11:30 PM", [END]: "12:15 AM" });
  eq("patch" in r && r.patch[END_KEY] > r.patch[DATE], true, "midnight wrap");
  const s = convert({ [DATE]: "2026-09-10", [START]: "All day", [END]: "All day" });
  eq("skip" in s, true, "all-day skipped");
  console.log("ALL PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
