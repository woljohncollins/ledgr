// verify-project-cards: the configurable project-card element system
// (2026-08-17) — the config parse, the settings map, the view→type→default
// resolution, and views.display carrying the per-view override.
//
// Pure — no DB, no network, no env — so scripts/verify-ci.mjs discovers it and
// CI runs it on every PR and push to main.
//
// What it guards, in order of what would actually break:
//   1. An ABSENT config resolves to the classic card (status, counts, progress,
//      people) — existing instances render exactly as before.
//   2. An EMPTY show list survives parsing (title-only cards are a real choice,
//      not a fallback-to-default).
//   3. parseDisplay round-trips display.card and stays tolerant of junk, so a
//      hand-edited views row can never wedge a render.
//   4. The card surfaces and the builders agree on the element catalog.
import { readFileSync } from "node:fs";
import {
  DEFAULT_PROJECT_CARD,
  PROJECT_CARD_ELEMENTS,
  cardShows,
  parseCardsByType,
  parseProjectCardConfig,
  resolveProjectCardConfig,
} from "../src/lib/project-card-config";
import { parseDisplay } from "../src/lib/views";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  (${String(detail)})` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  (${String(detail)})` : ""}`);
  }
}

// --- The default card is the classic card ------------------------------------
check(
  "default card = status, counts, progress, people",
  JSON.stringify(DEFAULT_PROJECT_CARD.show) === JSON.stringify(["status", "counts", "progress", "people"])
);
check(
  "resolve with nothing set → the default card",
  resolveProjectCardConfig(null, undefined) === DEFAULT_PROJECT_CARD
);

// --- Parse: tolerant, deduped, catalog-ordered --------------------------------
{
  const cfg = parseProjectCardConfig({ show: ["timeline", "status", "timeline", "bogus", 42] });
  check("parse drops unknown/dup entries", cfg !== null && cfg.show.length === 2, JSON.stringify(cfg?.show));
  check("parse normalizes to catalog order", cfg?.show[0] === "status" && cfg?.show[1] === "timeline");
}
{
  const cfg = parseProjectCardConfig({ show: [] });
  check("empty show list survives (title-only cards)", cfg !== null && cfg.show.length === 0);
}
check("parse rejects a non-object", parseProjectCardConfig("nope") === null);
check("parse rejects a missing show array", parseProjectCardConfig({ elements: ["status"] }) === null);
check("parse rejects an array", parseProjectCardConfig(["status"]) === null);

// --- The settings map ---------------------------------------------------------
{
  const map = parseCardsByType({
    project: { show: ["status"] },
    broken: { show: "status" },
    junk: 7,
  });
  check("cardsByType keeps valid entries, drops broken ones", Object.keys(map).join(",") === "project");
  check("kept entry parsed", map.project.show.length === 1 && map.project.show[0] === "status");
}
check("cardsByType tolerates junk root", Object.keys(parseCardsByType(null)).length === 0);

// --- Resolution order: view display.card → type default → classic -------------
{
  const typeDefault = { show: ["status" as const] };
  const viewCard = { show: ["timeline" as const] };
  check("view override wins", resolveProjectCardConfig(viewCard, typeDefault).show[0] === "timeline");
  check("type default wins when no view override", resolveProjectCardConfig(null, typeDefault).show[0] === "status");
  const resolved = resolveProjectCardConfig(undefined, typeDefault);
  check("cardShows reads the resolved set", cardShows(resolved, "status") && !cardShows(resolved, "people"));
}

// --- views.display carries the override --------------------------------------
{
  const d = parseDisplay({ card: { show: ["status", "progress"] } });
  check("parseDisplay keeps a valid card", d?.card?.show.length === 2);
  const round = parseDisplay(JSON.parse(JSON.stringify(d)));
  check("display.card round-trips through JSON", JSON.stringify(round?.card) === JSON.stringify(d?.card));
}
{
  const d = parseDisplay({ card: { show: "everything" }, mode: "month" });
  check("a malformed card is dropped, siblings kept", d !== null && d.card === undefined && d.mode === "month");
}
check("display of only junk collapses to null", parseDisplay({ card: 12 }) === null);

// --- The catalog and the surfaces agree ---------------------------------------
{
  const keys = PROJECT_CARD_ELEMENTS.map((e) => e.key);
  check(
    "element catalog is the six agreed tools",
    JSON.stringify(keys) === JSON.stringify(["status", "counts", "progress", "people", "links", "timeline"])
  );
  const grid = readFileSync("src/components/projects/ProjectCardGrid.tsx", "utf8");
  for (const k of keys) {
    check(`card body renders element "${k}"`, grid.includes(`"${k}"`));
  }
  // Structural guards: the deep links the chips promise actually point at the
  // real routes, and the builders offer the same catalog.
  check("count chips deep-link to the collection page", grid.includes("/collection/"));
  check("timeline chip deep-links to the spine page", grid.includes("/timeline"));
  const builder = readFileSync("src/components/views/ViewBuilder.tsx", "utf8");
  check("view builder offers the catalog", builder.includes("PROJECT_CARD_ELEMENTS"));
  const editor = readFileSync("src/components/build/CardElementsEditor.tsx", "utf8");
  check("Build card editor offers the catalog", editor.includes("PROJECT_CARD_ELEMENTS"));
  const lens = readFileSync("src/components/lists/ViewLensBody.tsx", "utf8");
  check("view lenses resolve project cards", lens.includes("projectCardsForView"));
  const viewPage = readFileSync("src/app/views/[id]/page.tsx", "utf8");
  check("the standalone view page resolves project cards", viewPage.includes("projectCardsForView"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
