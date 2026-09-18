// ADR-262 verification: the machine API can READ a body, and says so when it
// cannot do what it was asked.
//
// The gap this closes: /api/machine/items could write a body and never read
// one, so "copy this item's content onto that item" fell back to whatever was
// holding the request retyping the text. A 10,737-character note came back
// 10,736 characters long, every tricky element (emoji variation selectors,
// escaped tildes, &amp; entities, trailing newlines) verified individually, and
// the missing character was unlocatable without a reference copy. Byte-exact
// content moves are the one job this surface exists for.
//
// Runs the real route handlers against the dev DB with a real minted
// credential: no HTTP server, no mocks, so what passes here is what a curl
// gets. DB-backed, so verify-ci.mjs classifies it local/manual.
//   npx tsx scripts/verify-machine-read.mts
//
// What it pins down, in order:
//  1. GET without includeBody is unchanged — no `body` key on any row.
//  2. GET ?includeBody=true returns the stored { format, text } object, and the
//     text is byte-identical to what was written, character count included.
//  3. ?id=<uuid> filters to that item (it used to be ignored, answering with an
//     unfiltered list — a typo came back looking like a successful read of the
//     wrong item), and a non-uuid is a 400.
//  4. Round trip: read a body, PATCH it verbatim onto another item, re-read
//     both, byte-identical.
//  5. The per-item route returns JSON for a real id, JSON 404 for an unknown
//     one, and names the type's surfaces — a bespoke type's content lives in
//     `properties`, so a copy that misses those copies half the record.
//  6. The catch-all answers JSON, never the app's HTML shell.
//  7. Unknown query parameters are a 400 naming them.
//  8. includeBody is capped, so an opt-in can't become a full-table export.
import { readFileSync } from "node:fs";

// Minimal .env.local loader (DATABASE_URL + DEV_USER_EMAIL); no dotenv dep.
for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { eq, inArray } = await import("drizzle-orm");
const { getDb } = await import("../src/db");
const { apiCredentials, items } = await import("../src/db/schema");
const { createCredential, revokeCredential } = await import("../src/lib/auth/credentials");
const { resolveMachineOwner } = await import("../src/lib/machine/owner");
const { createItem } = await import("../src/lib/item-mutations");
const { MAX_BODY_ROWS } = await import("../src/lib/items");
const listRoute = await import("../src/app/api/machine/items/route");
const itemRoute = await import("../src/app/api/machine/items/[id]/route");
const catchAll = await import("../src/app/api/machine/[...unmatched]/route");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const ownerId = await resolveMachineOwner();
if (!ownerId) {
  console.error("No machine owner. Set DEV_USER_EMAIL in .env.local and seed the dev DB.");
  process.exit(1);
}

// A body carrying every element that made the retyped copy unverifiable: an
// emoji with a variation selector (two code units, one glyph), a backslash-
// escaped tilde, an HTML entity that must survive as text rather than decoding,
// a CriticMarkup comment (part of the dialect), and trailing newlines, which are
// exactly what a hand-copy drops.
const TRICKY = [
  "# Working Bibliography",
  "",
  "Sources marked ✔️ are read. Ranges use escaped tildes: \\~1200\\~1250.",
  "Ampersands stay literal: Smith &amp; Sons, not Smith & Sons.",
  "{==anchored==}{>>note to self<<}",
  "",
  "- [ ] one",
  "- [x] two",
  "",
  "",
].join("\n");

const made = await createCredential(ownerId, `verify-machine-read ${Date.now()}`, ["api"]);
if (!made.ok) {
  console.error(`could not mint a credential: ${made.error}`);
  process.exit(1);
}
const AUTH = `Basic ${Buffer.from(`${made.keyId}:${made.secret}`).toString("base64")}`;
const headers = { authorization: AUTH };

const created: string[] = [];

// Call a route handler the way Next.js would.
const list = (qs: string) =>
  listRoute.GET(new Request(`https://x.test/api/machine/items${qs}`, { headers }));
const one = (id: string, qs = "") =>
  itemRoute.GET(new Request(`https://x.test/api/machine/items/${id}${qs}`, { headers }), {
    params: Promise.resolve({ id }),
  });

try {
  const source = await createItem(ownerId, {
    type: "note",
    title: "verify-machine-read SOURCE",
    body: { format: "markdown", text: TRICKY },
  });
  created.push(source.id);
  const target = await createItem(ownerId, {
    type: "note",
    title: "verify-machine-read TARGET",
  });
  created.push(target.id);

  // --- 1. the default payload is unchanged ----------------------------------
  const plain = await (await list(`?id=${source.id}`)).json();
  check(
    "GET without includeBody carries no body key",
    plain.items.length === 1 && !("body" in plain.items[0]),
    Object.keys(plain.items[0] ?? {}).join(",")
  );
  check(
    "properties ride the default payload (a bespoke type's content lives there)",
    plain.items.length === 1 && "properties" in plain.items[0]
  );

  // --- 2/3. includeBody + the id filter -------------------------------------
  const read = await (await list(`?id=${source.id}&includeBody=true`)).json();
  check("?id= filters to exactly that item", read.items?.length === 1, `got ${read.items?.length}`);
  const body = read.items?.[0]?.body;
  check(
    "body comes back as the { format, text } object PATCH accepts",
    body?.format === "markdown" && typeof body?.text === "string",
    JSON.stringify(body).slice(0, 80)
  );
  check(
    "the text is byte-identical to what was written",
    body?.text === TRICKY,
    `wrote ${TRICKY.length} chars, read ${body?.text?.length}`
  );
  check(
    "character count matches exactly (UTF-16 units and code points)",
    body?.text?.length === TRICKY.length &&
      [...(body?.text ?? "")].length === [...TRICKY].length,
    `${body?.text?.length} vs ${TRICKY.length}`
  );
  check(
    "trailing newlines survive (the thing a hand-copy drops)",
    body?.text?.endsWith("\n\n\n") === TRICKY.endsWith("\n\n\n")
  );

  const badId = await list("?id=not-a-uuid&includeBody=true");
  check("a non-uuid id is a 400, not an unfiltered list", badId.status === 400);

  // --- 4. the round trip ----------------------------------------------------
  const patched = await listRoute.PATCH(
    new Request("https://x.test/api/machine/items", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id: target.id, body }),
    })
  );
  check("PATCH accepts a read result unreshaped", patched.status === 200);
  const both = await (await list(`?id=${source.id},${target.id}&includeBody=true`)).json();
  check("?id= takes a comma-separated set", both.items?.length === 2);
  const texts = both.items?.map((i: { body?: { text?: string } }) => i.body?.text);
  check(
    "round trip is lossless: both bodies byte-identical",
    texts?.[0] === TRICKY && texts?.[1] === TRICKY,
    texts?.map((t: string) => t?.length).join(" vs ")
  );

  // --- 5. the per-item route ------------------------------------------------
  const solo = await one(source.id);
  check("GET /items/<uuid> is JSON 200", solo.status === 200 &&
    (solo.headers.get("content-type") ?? "").includes("application/json"));
  const soloBody = await solo.json();
  check("it carries the body", soloBody.item?.body?.text === TRICKY);
  check("it carries properties", "properties" in (soloBody.item ?? {}));
  check(
    "it names the type's surfaces (ADR-260)",
    Array.isArray(soloBody.surfaces) && soloBody.surfaces.length >= 1,
    JSON.stringify(soloBody.surfaces?.map((s: { id: string }) => s.id))
  );

  const missing = await one("00000000-0000-4000-8000-000000000000");
  const missingType = missing.headers.get("content-type") ?? "";
  check(
    "an unknown uuid is JSON 404, never the app's HTML shell",
    missing.status === 404 && missingType.includes("application/json") &&
      !missingType.includes("text/html"),
    `${missing.status} ${missingType}`
  );

  // --- 6. the catch-all -----------------------------------------------------
  const nowhere = await catchAll.GET(
    new Request("https://x.test/api/machine/nope/deeper"),
    { params: Promise.resolve({ unmatched: ["nope", "deeper"] }) }
  );
  const nowhereType = nowhere.headers.get("content-type") ?? "";
  check(
    "an unmatched machine path is JSON 404, never HTML behind a 200",
    nowhere.status === 404 && nowhereType.includes("application/json"),
    `${nowhere.status} ${nowhereType}`
  );

  // --- 7. unknown parameters ------------------------------------------------
  const typo = await list("?includebody=true");
  const typoBody = await typo.json();
  check(
    "an unknown parameter is a 400 naming it",
    typo.status === 400 && typoBody.error?.includes("includebody"),
    typoBody.error
  );
  check(
    "the 400 also names what IS accepted",
    typoBody.error?.includes("includeBody") && typoBody.error?.includes("relatedTo")
  );
  const badBool = await list("?includeBody=maybe");
  check("a non-boolean includeBody is a 400", badBool.status === 400);
  const offIsOff = await (await list(`?id=${source.id}&includeBody=false`)).json();
  check(
    "includeBody=false means off, not 'any value is on'",
    !("body" in (offIsOff.items?.[0] ?? {}))
  );
  const soloTypo = await one(source.id, "?includeBody=true");
  check("the per-item route rejects parameters too", soloTypo.status === 400);

  // --- 8. the cap -----------------------------------------------------------
  const over = await (await list(`?includeBody=true&limit=${MAX_BODY_ROWS + 50}`)).json();
  check(
    `includeBody is capped at ${MAX_BODY_ROWS} rows`,
    over.items.length <= MAX_BODY_ROWS,
    `${over.items.length} rows`
  );
  const uncapped = await (await list("?limit=100")).json();
  check(
    "the cap applies only to body reads (a body-free list still pages to 100)",
    uncapped.items.length > MAX_BODY_ROWS || uncapped.items.length === over.items.length,
    `${uncapped.items.length} body-free rows`
  );
} finally {
  if (created.length > 0) await db.delete(items).where(inArray(items.id, created));
  await revokeCredential(ownerId, made.credential.id);
  await db.delete(apiCredentials).where(eq(apiCredentials.id, made.credential.id));
  console.log(`cleanup: removed ${created.length} test items and the test credential`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
