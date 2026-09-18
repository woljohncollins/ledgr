// ADR-189 verification: the user guide is served, reachable, and findable.
// Pure functions only (no DB, no browser) — the three doorways all read from
// static modules, so all three are checkable here.
//   npx tsx scripts/verify-user-guide.mts
import { readGuideResource, GUIDE_RESOURCE, MEMORY_PROTOCOL_RESOURCE } from "../src/lib/mcp/guide";
import {
  USER_GUIDE_URI,
  USER_GUIDE_ROUTE,
  USER_GUIDE_RESOURCE,
  USING_LEDGR_GUIDE,
} from "../src/lib/mcp/user-guide";
import { BUILD_ENTRIES } from "../src/lib/build-nav";
import { staticCommandEntries, rankCommands } from "../src/lib/command-index";
import { markdownToHtml } from "../src/lib/markdown-render";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- doorway 1: the MCP resource -------------------------------------------
const read = readGuideResource(USER_GUIDE_URI);
check("readGuideResource serves the user guide", read !== null);
check("…as markdown", read?.mimeType === "text/markdown");
check("…with the guide body", read?.text === USING_LEDGR_GUIDE);
check("…and the other two guides still resolve",
  readGuideResource(GUIDE_RESOURCE.uri) !== null &&
  readGuideResource(MEMORY_PROTOCOL_RESOURCE.uri) !== null);
check("an unknown guide URI is still null", readGuideResource("ledgr://guide/nope") === null);
check("the three guide URIs are distinct",
  new Set([GUIDE_RESOURCE.uri, MEMORY_PROTOCOL_RESOURCE.uri, USER_GUIDE_URI]).size === 3);
// The descriptor is what resources/list advertises; if its uri drifts from the
// one readGuideResource answers to, the resource lists but can't be read.
check("the descriptor points at the URI the reader serves",
  USER_GUIDE_RESOURCE.uri === USER_GUIDE_URI);
check("…and advertises markdown", USER_GUIDE_RESOURCE.mimeType === "text/markdown");

// --- doorway 2: the in-app page --------------------------------------------
// The page can't be imported here (it's a React server component), so check the
// two things it depends on: the route is in the Build nav, and the guide
// actually renders to HTML.
const navEntry = BUILD_ENTRIES.find((e) => e.href === USER_GUIDE_ROUTE);
check("the Build sidebar has a User Guide entry", navEntry !== undefined);
check("…in the MAINTAIN group, labelled User Guide", navEntry?.label === "User Guide");
const html = markdownToHtml(USING_LEDGR_GUIDE);
check("the guide renders to HTML", html.length > 0);
check("…with real structure, not one blob", html.includes("<h2") || html.includes("<h3"));

// --- doorway 3: the command palette ----------------------------------------
// The point of the keywords hook: someone who doesn't know the guide exists
// types "help", not "user guide".
const entries = staticCommandEntries();
function finds(query: string): boolean {
  return rankCommands(entries, query, "work").some(
    (r) => r.kind === "destination" && r.href === USER_GUIDE_ROUTE
  );
}
check('palette finds it by name ("guide")', finds("guide"));
check('palette finds it by "help"', finds("help"));
check('palette finds it by "docs"', finds("docs"));
check('palette finds it by "manual"', finds("manual"));
check("palette doesn't match it on an unrelated word", !finds("zzzz"));
// The keyword hook must not disturb entries that have no keywords.
check("keyword-less entries still match by label",
  rankCommands(entries, "trash", "work").some((r) => r.kind === "destination"));
check("a no-match query returns nothing", rankCommands(entries, "qqqzzz", "work").length === 0);

// --- the guide's own claims ------------------------------------------------
// A guide that names a route the app doesn't have is worse than no guide. Every
// /build/... route the guide mentions must be a real Build entry.
const buildHrefs = new Set(BUILD_ENTRIES.map((e) => e.href));
const cited = [...USING_LEDGR_GUIDE.matchAll(/`(\/build\/[a-z-]+)`/g)].map((m) => m[1]);
const unknown = [...new Set(cited)].filter((h) => !buildHrefs.has(h));
check("every /build route the guide cites exists", unknown.length === 0, unknown.join(", "));
check("the guide is not still the placeholder", !USING_LEDGR_GUIDE.includes("Placeholder —"));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
