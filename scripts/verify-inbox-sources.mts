// Verifies where a capture lands now that the Inbox is per-source (ADR-249).
// Pure functions plus a structural guard on the one gate they feed — no DB, no
// server.
//
// Why this script exists: until ADR-249 the answer to "does this arrive in the
// Inbox?" was the literal `inbox: true`, typed out seven times in seven files.
// Now it is one owner setting resolved at create time, and the failure mode has
// changed shape. A bad route no longer breaks a screen, it quietly sends a
// capture somewhere the owner will not look for it. So the fallbacks are the
// point: an unknown source, a hand-edited settings blob, a project that has
// since been trashed all have to land somewhere findable.
//
// `routeFor` and the settings parser are pure, so they are executed here. The
// last section covers the half of the gate that reads the database
// (`resolveRoute` in item-mutations.ts) the only way a DB-free script can:
// by reading the source and pinning the four rules that must not drift.
//
//   npx tsx scripts/verify-inbox-sources.mts
import { readFileSync } from "node:fs";
import { INBOX_SOURCES, routeFor } from "../src/lib/inbox-sources";
import { parseSettings } from "../src/lib/settings";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${String(detail)})`}`);
  }
}

const PROJECT = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_PROJECT = "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d";

// --- the source table -------------------------------------------------------
check(
  "all seven arrival paths are named",
  INBOX_SOURCES.length === 7,
  INBOX_SOURCES.length
);
check(
  "keys are unique, so one source cannot shadow another's setting",
  new Set(INBOX_SOURCES.map((s) => s.key)).size === INBOX_SOURCES.length
);
check(
  "every default is a mode word, never a project id nobody has",
  INBOX_SOURCES.every((s) => s.defaultRoute === "inbox" || s.defaultRoute === "filed")
);
check(
  "Claude is the only path that defaults to filed",
  INBOX_SOURCES.filter((s) => s.defaultRoute === "filed").map((s) => s.key).join(",") ===
    "ai_mcp",
  INBOX_SOURCES.filter((s) => s.defaultRoute === "filed").map((s) => s.key).join(",")
);
check(
  "every row is labelled and explained, since each one is a select on the Capture page",
  INBOX_SOURCES.every((s) => s.label.length > 0 && s.help.length > 0)
);

// --- routeFor: the three routes --------------------------------------------
check(
  'a route of "inbox" queues the capture',
  JSON.stringify(routeFor({ quick_capture: "inbox" }, "quick_capture")) ===
    JSON.stringify({ inbox: true, destinationId: null })
);
check(
  'a route of "filed" does NOT queue it',
  JSON.stringify(routeFor({ quick_capture: "filed" }, "quick_capture")) ===
    JSON.stringify({ inbox: false, destinationId: null })
);
check(
  "a project id files the capture AND names the destination",
  JSON.stringify(routeFor({ email_in: PROJECT }, "email_in")) ===
    JSON.stringify({ inbox: false, destinationId: PROJECT })
);
check(
  "one source's project never leaks onto another source",
  routeFor({ email_in: PROJECT, todoist: OTHER_PROJECT }, "todoist").destinationId ===
    OTHER_PROJECT
);
check(
  "a project id is matched case-insensitively, the way settings stores it",
  routeFor({ email_in: PROJECT.toUpperCase() }, "email_in").destinationId ===
    PROJECT.toUpperCase()
);

// --- routeFor: nothing configured yet ---------------------------------------
// The state every install starts in: settings.inboxRoutes is `{}`.
for (const source of INBOX_SOURCES) {
  const expected = source.defaultRoute === "inbox";
  check(
    `${source.key} with no route set falls back to its default (${source.defaultRoute})`,
    routeFor({}, source.key).inbox === expected &&
      routeFor({}, source.key).destinationId === null
  );
}

// --- routeFor: the ways a route can be wrong --------------------------------
// None of these may strand a capture. A source that knows its default gets it;
// a source nobody has heard of gets the Inbox, the one place the owner looks.
check(
  "an unknown source key lands in the Inbox rather than filing itself away",
  JSON.stringify(routeFor({}, "some_future_integration")) ===
    JSON.stringify({ inbox: true, destinationId: null })
);
check(
  "an unknown source ignores a stale value stored under its own key",
  routeFor({ some_future_integration: "sideways" }, "some_future_integration").inbox === true
);
const BAD_VALUES: Record<string, unknown> = {
  typo: "Inbox",
  word: "archive",
  shortId: "3f1b2c4d",
  empty: "",
  space: " inbox ",
  number: 7,
  nully: null,
  objecty: { mode: "inbox" },
  arrayey: ["inbox"],
};
for (const [name, value] of Object.entries(BAD_VALUES)) {
  check(
    `an unparseable route (${name}) falls back to the source's default, not to nowhere`,
    JSON.stringify(
      routeFor({ email_in: value } as Record<string, string>, "email_in")
    ) === JSON.stringify({ inbox: true, destinationId: null }),
    JSON.stringify(routeFor({ email_in: value } as Record<string, string>, "email_in"))
  );
  check(
    `an unparseable route (${name}) on a filed-by-default source still files`,
    routeFor({ ai_mcp: value } as Record<string, string>, "ai_mcp").inbox === false
  );
}

// --- the settings parser drops the same junk before it is ever read ---------
// Belt and braces on purpose: parseSettings is the gate on a hand-edited blob,
// routeFor is the gate on anything that slips past it.
const parsed = parseSettings({
  inboxRoutes: {
    quick_capture: "filed",
    email_in: PROJECT,
    todoist: "archive",
    web_clipper: 7,
    share_target: null,
  },
});
check(
  "the parser keeps the two mode words and a project id",
  parsed.inboxRoutes.quick_capture === "filed" && parsed.inboxRoutes.email_in === PROJECT,
  JSON.stringify(parsed.inboxRoutes)
);
check(
  "the parser drops every unroutable value instead of storing it",
  !("todoist" in parsed.inboxRoutes) &&
    !("web_clipper" in parsed.inboxRoutes) &&
    !("share_target" in parsed.inboxRoutes),
  JSON.stringify(parsed.inboxRoutes)
);
check(
  "a dropped value leaves the source on its default",
  routeFor(parsed.inboxRoutes, "todoist").inbox === true
);
check(
  "no routes at all is a valid state, not a crash",
  JSON.stringify(parseSettings({}).inboxRoutes) === "{}"
);
check(
  "a non-object inboxRoutes is discarded whole",
  JSON.stringify(parseSettings({ inboxRoutes: ["inbox"] }).inboxRoutes) === "{}" &&
    JSON.stringify(parseSettings({ inboxRoutes: "inbox" }).inboxRoutes) === "{}"
);

// --- structural: the gate in createItem ------------------------------------
// These four rules need a database to execute, so they are pinned by reading
// the source. Each one is a behavior the owner would notice breaking.
const mutations = readFileSync(
  new URL("../src/lib/item-mutations.ts", import.meta.url),
  "utf8"
);
const gate = mutations.slice(mutations.indexOf("async function resolveRoute("));
check(
  "resolveRoute exists and createItem asks it where the item lands",
  gate.length > 0 && mutations.includes("await resolveRoute(ownerId, input)")
);
// Rule 1, the one that keeps this additive: an explicit inbox always wins, in
// BOTH directions, and short-circuits before settings are read. Every caller
// written before ADR-249 passes one, so every one of them behaves as it did.
check(
  "an explicit inbox short-circuits the whole gate, either way",
  /if \(input\.inbox !== undefined \|\| !input\.source\) \{\s*return \{ inbox: input\.inbox \?\? false, destinationId: null \};/.test(
    gate
  )
);
check(
  "the settings read happens AFTER that short-circuit, so an ordinary create adds no query",
  gate.indexOf("input.inbox !== undefined") < gate.indexOf("getSettings(ownerId)") &&
    gate.indexOf("getSettings(ownerId)") !== -1
);
// Rule 2: a trashed destination sends the capture to the Inbox instead of
// filing it somewhere unreachable, and leaves the setting alone so restoring
// the project restores the routing.
check(
  "the destination is checked for life, owner-scoped and excluding Trash",
  /eq\(items\.id, route\.destinationId\)/.test(gate) &&
    /eq\(items\.ownerId, ownerId\)/.test(gate) &&
    /isNull\(items\.deletedAt\)/.test(gate)
);
check(
  "a trashed or missing destination falls back to the Inbox",
  /live\.length > 0 \? route : \{ inbox: true, destinationId: null \}/.test(gate)
);
check(
  "nothing in the gate writes back to settings",
  !/updateSettings/.test(gate)
);
// Rule 3: the destination edge is written inside createItem, not at the API
// route's relateTo, because four of the seven paths never touch HTTP.
check(
  "a project destination writes the relation from inside createItem",
  /if \(destinationId\) \{\s*await relateItems\(ownerId, created\.id, destinationId, "project"\)/.test(
    mutations
  )
);
check(
  "the edge is best-effort, so a failed relation never undoes a capture",
  /relateItems\(ownerId, created\.id, destinationId, "project"\)\.catch\(\(\) => \{\}\)/.test(
    mutations
  )
);
check(
  "the resolved flag is what gets inserted, not a second copy of the rule",
  /\n\s+inbox,\n/.test(mutations)
);

console.log(
  failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE${failures === 1 ? "" : "S"}`
);
process.exit(failures === 0 ? 0 : 1);
