// Verification for the Build-mode restructure (ADR-063). Pure logic only (no DB):
//   1. build-nav.ts — the sidebar taxonomy, isBuildPath, valid icons.
//   2. command-index.ts — static entries, match scoring, context-aware ranking,
//      mode-aware dynamic entries, group order.
//   3. nav-slot-options.ts — the "Build tools" destination category.
// Run: npx tsx scripts/verify-build-mode.mts
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- 1. build-nav ----------------------------------------------------------
const { BUILD_NAV, BUILD_ENTRIES, isBuildPath } = await import("../src/lib/build-nav");
const { isNavIcon } = await import("../src/lib/nav-icons");

check(
  "four groups, in order DATA / INTERFACE / MAINTAIN / SYSTEM",
  BUILD_NAV.map((g) => g.label).join(",") === "DATA,INTERFACE,MAINTAIN,SYSTEM"
);
check(
  "BUILD_ENTRIES flattens every group entry",
  BUILD_ENTRIES.length === BUILD_NAV.reduce((n, g) => n + g.entries.length, 0)
);
check(
  "every entry icon is a valid nav icon",
  BUILD_ENTRIES.every((e) => isNavIcon(e.icon)),
  BUILD_ENTRIES.filter((e) => !isNavIcon(e.icon)).map((e) => e.icon).join(",")
);
check(
  "Model Overview points at the /build home",
  BUILD_ENTRIES.some((e) => e.label === "Model Overview" && e.href === "/build")
);
check(
  "only Types & Properties is expandable this phase",
  BUILD_ENTRIES.filter((e) => e.expandable).map((e) => e.href).join(",") ===
    "/build/types"
);
check("isBuildPath true for /build", isBuildPath("/build"));
check("isBuildPath true for /build/types", isBuildPath("/build/types"));
check("isBuildPath true for a deep build route", isBuildPath("/build/types/note/edit"));
check("isBuildPath false for / (home)", !isBuildPath("/"));
check("isBuildPath false for /views (now Work-side)", !isBuildPath("/views"));
check("isBuildPath false for /settings (both-places)", !isBuildPath("/settings"));
check("isBuildPath false for a /buildfoo lookalike", !isBuildPath("/buildfoo"));
// The dashboards INDEX keeps Build chrome — managing dashboards is
// INTERFACE-building. An INDIVIDUAL dashboard does NOT: `/dashboards/<id>` is the
// "using it" context and keeps Work chrome (see the comment on isBuildPath).
//
// This line used to assert the opposite and had been failing silently, because
// nothing ran it. Do not "fix" the code to match the old expectation: claiming
// `/dashboards/...` as Build is what once made Build mode the ONLY way to view an
// unassigned dashboard. The narrower rule is the deliberate one.
check("isBuildPath true for /dashboards (the index)", isBuildPath("/dashboards"));
check(
  "isBuildPath FALSE for /dashboards/[id] (using one is Work)",
  !isBuildPath("/dashboards/abc")
);
check("isBuildPath false for /today (Work surface)", !isBuildPath("/today"));
check("isBuildPath false for a /dashboardsfoo lookalike", !isBuildPath("/dashboardsfoo"));

// --- 2. command-index ------------------------------------------------------
const {
  staticCommandEntries,
  dynamicCommandEntries,
  matchScore,
  rankCommands,
  groupOrder,
} = await import("../src/lib/command-index");

const statics = staticCommandEntries();
check("static entries include the Inbox page", statics.some((e) => e.href === "/inbox" && e.group === "Pages"));
check(
  "static entries include every Build section",
  BUILD_ENTRIES.every((be) => statics.some((e) => e.href === be.href && e.group === "Build & Settings"))
);
check(
  "static entries include a named setting (Trash retention)",
  statics.some((e) => e.label === "Trash retention" && e.href === "/settings")
);

check("matchScore: prefix beats word-boundary", (matchScore("Inbox", "inb") ?? 0) > (matchScore("User Settings", "settings") ?? 0));
check("matchScore: word-boundary beats substring", (matchScore("User Settings", "settings") ?? 0) > (matchScore("Templates", "plate") ?? 0));
check("matchScore: no match returns null", matchScore("Inbox", "zzz") === null);
check("matchScore: multi-token all-present matches", matchScore("Data Hygiene", "data hygiene") !== null);
check("matchScore: empty query scores 0 (passthrough)", matchScore("Anything", "") === 0);

// Ranking is context-aware: "views" surfaces the Views section higher in Build
// than in Work (group weight shifts), though both find it.
const sample = [
  ...statics,
  ...dynamicCommandEntries(
    { types: [{ key: "note", label: "Note", icon: "notes" }], views: [{ id: "v1", name: "My Views Board" }], templates: [] },
    "work"
  ),
];
const workRanked = rankCommands(sample, "data", "work");
const buildRanked = rankCommands(
  [...statics, ...dynamicCommandEntries({ types: [{ key: "note", label: "Note", icon: "notes" }], views: [], templates: [] }, "build")],
  "data",
  "build"
);
check("rankCommands: 'data' finds Data Hygiene in both modes", workRanked.some((r) => r.label === "Data Hygiene") && buildRanked.some((r) => r.label === "Data Hygiene"));
check("rankCommands: empty query is a passthrough (no filtering)", rankCommands(statics, "", "work").length === statics.length);
check("rankCommands: unmatched entries drop out", rankCommands(statics, "qqzz", "work").length === 0);

const work = dynamicCommandEntries({ types: [{ key: "note", label: "Note", icon: "notes" }], views: [], templates: [] }, "work");
const build = dynamicCommandEntries({ types: [{ key: "note", label: "Note", icon: "notes" }], views: [], templates: [] }, "build");
check("dynamic type href is the item list in Work", work[0].kind === "destination" && work[0].href === "/list/note");
check("dynamic type href is the edit page in Build", build[0].kind === "destination" && build[0].href === "/build/types/note/edit");

// A template has no builder route of its own; it opens its prototype item's
// canvas (the templates index links the same way). Guards the 404 regression.
const tmpl = dynamicCommandEntries(
  { types: [], views: [], templates: [{ id: "t1", name: "Weekly note", type: "note", prototypeItemId: "i9" }] },
  "build"
);
check("dynamic template href is the prototype item's canvas", tmpl[0].kind === "destination" && tmpl[0].href === "/items/i9");

check("groupOrder: Items first in Work", groupOrder("work")[0] === "Items");
check("groupOrder: Build & Settings first in Build", groupOrder("build")[0] === "Build & Settings");

// --- 3. nav-slot-options "Build tools" -------------------------------------
const { BUILD_TOOL_DESTS, buildDestOptions } = await import("../src/lib/nav-slot-options");
check("BUILD_TOOL_DESTS covers every Build entry", BUILD_TOOL_DESTS.length === BUILD_ENTRIES.length);
check("BUILD_TOOL_DESTS are grouped 'Build tools'", BUILD_TOOL_DESTS.every((d) => d.group === "Build tools"));
const opts = buildDestOptions([{ id: "v1", name: "A view" }], [{ key: "note", label: "Note", icon: "notes" }]);
check("buildDestOptions includes the Build tools category", opts.some((o) => o.group === "Build tools" && o.href === "/build/types"));
check("buildDestOptions still includes built-ins, views, types", ["Built-in", "Views", "Types"].every((g) => opts.some((o) => o.group === g)));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
