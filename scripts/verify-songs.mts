// S2 verification: the Songs module registers onto core, the `song` type
// resolves its chord canvas + chordpro format, and the render-surface consumers
// (FTS body-text + the print/share document) branch correctly on body.format
// while leaving the markdown default unchanged. Node-pure (no React): it imports
// the registration boot site directly, not module-wiring.
//
//   npx tsx scripts/verify-songs.mts
import "../src/lib/modules/register";
import {
  canonicalFormatForType,
  canvasIdForType,
  moduleForType,
} from "../src/lib/modules";
import { extractBodyText } from "../src/lib/body-text";
import { renderPrintDocument } from "../src/lib/print-html";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const CHORDPRO = {
  format: "chordpro",
  text: `{title: Demo}\n{key: G}\n{section: Chorus}\n[G]Worthy is the [C]Lamb`,
};
const MARKDOWN = { format: "markdown", text: "# Heading\n\nWorthy is the **Lamb**." };

// ── registration + resolvers ──────────────────────────────────────────────────
check("songs module registered", moduleForType("song")?.id === "songs");
check("song resolves the chord canvas", canvasIdForType("song") === "chord");
check("song resolves the chordpro format", canonicalFormatForType("song") === "chordpro");
// Core resolution must be untouched by registering a module. `note` resolves the
// LONGFORM canvas, not the plain markdown one (ADR-157) — this line asserted
// "markdown" and had been failing silently ever since, because nothing ran it.
// The point is that note keeps its OWN core canvas rather than picking up the
// song's chord canvas, so name that canvas rather than assuming the default.
check(
  "core types unaffected",
  canvasIdForType("note") === "longform" && canonicalFormatForType("task") === "markdown",
  `note canvas=${canvasIdForType("note")} task format=${canonicalFormatForType("task")}`
);

// ── FTS body-text branches on format ──────────────────────────────────────────
const songText = extractBodyText(CHORDPRO) ?? "";
check("chordpro FTS keeps lyrics", songText.includes("Worthy is the Lamb"));
check("chordpro FTS drops chords + directives", !songText.includes("[G]") && !songText.includes("{") && !songText.includes("Key"));
const mdText = extractBodyText(MARKDOWN) ?? "";
check("markdown FTS unchanged", mdText.includes("Worthy is the Lamb") && !mdText.includes("#"));

// ── print/share document branches on format ───────────────────────────────────
const songDoc = renderPrintDocument("Demo", CHORDPRO);
check("chordpro print renders the chart", songDoc.includes('class="cc-chart"') && songDoc.includes('class="cc-chord"'));
check("chordpro print includes the chart CSS", songDoc.includes(".cc-body{column-count:2"));
check("chordpro print suppresses the outer <h1>", !songDoc.includes("<h1>Demo</h1>"));
const mdDoc = renderPrintDocument("Doc", MARKDOWN);
check("markdown print unchanged (outer h1 + markdown body)", mdDoc.includes("<h1>Doc</h1>") && mdDoc.includes("<strong>Lamb</strong>"));
// the chart CSS ships in every doc's <style>; the markdown doc must carry no chart *markup*
check("markdown print has no chord chart markup", !mdDoc.includes('class="cc-chart"'));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
