// One clip, one item — the server-side half (see src/lib/capture/share.ts).
// The client latches can't cover an older bookmarklet re-handing the same clip
// to a second relay page load, so the capture paths refuse a repeat of the same
// URL inside a short window and hand back the item they already made.
// Live Neon (dev): same URL twice = one item; a trashed clip is not resurrected
// (re-clipping after a delete makes a fresh item). Cleans up.
// Run: npx tsx scripts/verify-capture-dedupe.mts
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getDb } = await import("../src/db");
const { items, users } = await import("../src/db/schema");
const { captureSharedUrlOrText } = await import("../src/lib/capture/share");
const { softDeleteItem } = await import("../src/lib/item-mutations");
const { inArray } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const ownerId = (await db.select({ id: users.id }).from(users))[0].id;
// Unreachable on purpose: extraction and the title fetch both fail fast, so
// this script needs no network and no live page.
const url = `http://127.0.0.1:9/ledgr-dedupe-${Date.now()}`;
const created: string[] = [];

try {
  const first = await captureSharedUrlOrText(ownerId, { url });
  check("a clip lands as an item", !!first);
  if (first) created.push(first);

  const second = await captureSharedUrlOrText(ownerId, { url });
  check("the same URL again returns the SAME item", !!second && second === first, `${first} vs ${second}`);
  if (second && second !== first) created.push(second);

  // The window must not stand in the way of a deliberate re-clip after the
  // owner trashes one: a soft-deleted clip is not a live capture.
  if (first) await softDeleteItem(ownerId, first);
  const third = await captureSharedUrlOrText(ownerId, { url });
  check("re-clipping after a delete makes a fresh item", !!third && third !== first, `${third}`);
  if (third) created.push(third);
} finally {
  if (created.length) await db.delete(items).where(inArray(items.id, created));
}

console.log(failures ? `${failures} failed` : "all passed");
process.exitCode = failures > 0 ? 1 : 0;
