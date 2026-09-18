// ADR-260 verification: the SURFACES contract — the named places content lives on
// a bespoke type, declared once in the module registry and read by both MCP and
// the REST API.
//
// Pure functions only (no DB, no components), like verify-module-registry: the
// resolvers (`surfacesForType`, `resolveSurfacesSync`, `resolveSurfaceTarget`)
// are deliberately synchronous so this file running in plain node IS the proof
// that the policy half stayed pure.
//
//  1. A paper declares its five surfaces, in workflow order, with Draft as the
//     primary artifact and Shape/Quote Bank/Outline read-only.
//  2. A song declares Notes + Chart, and the Chart is CHORDPRO — the fact every
//     MCP write path used to get wrong.
//  3. An ordinary type still reports exactly one markdown body surface, so
//     nothing about a note or task changed.
//  4. A type that BORROWS a bespoke tool gets that tool's surfaces, so the
//     contract isn't pinned to the `paper`/`song` type keys.
//  5. Content pairing: a property surface reads its key, a body surface reads the
//     body whatever its format, a derived surface carries none, and `empty` is
//     honest about each.
//  6. Write targeting: an unknown id is refused with the real list, a read-only
//     surface is refused with the WRITABLE list, and a writable one resolves to
//     its storage.
//  7. The canonical-format stamp: a song's body format resolves to chordpro, so
//     a markdown-shaped write gets corrected rather than stored as prose.
//
//   npx tsx scripts/verify-surfaces.mts
import { MARKDOWN_FORMAT } from "../src/lib/body";
import { canonicalFormatForType, surfacesForType } from "../src/lib/modules";
import {
  resolveSurfaceTarget,
  resolveSurfacesSync,
} from "../src/lib/item-surfaces";
import { CHORDPRO_FORMAT } from "../src/lib/chordpro/types";
// Side-effect import: registers the songs/papers workflow modules onto core.
import "../src/lib/modules/register";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- 1. the paper's five surfaces ------------------------------------------
const paper = surfacesForType("paper");
check(
  "paper declares five surfaces in workflow order",
  paper.map((s) => s.id).join(",") === "notes,shape,quotes,outline,draft",
  paper.map((s) => s.id).join(",")
);
check(
  "the Draft is the primary artifact, and it is the body",
  paper.find((s) => s.primary)?.id === "draft" &&
    paper.find((s) => s.id === "draft")?.storage.kind === "body"
);
check(
  "Notes live in properties.notes, not the body",
  JSON.stringify(paper.find((s) => s.id === "notes")?.storage) ===
    JSON.stringify({ kind: "property", key: "notes" })
);
check(
  "Shape, Quote Bank and Outline are read-only",
  ["shape", "quotes", "outline"].every((id) => paper.find((s) => s.id === id)?.readOnly === true)
);
check(
  "the Outline is derived from Shape + Quote Bank and stores nothing",
  paper.find((s) => s.id === "outline")?.storage.kind === "derived"
);
check(
  "every surface carries a description an agent can route on",
  paper.every((s) => s.description.trim().length > 20)
);

// --- 2. the song's two surfaces --------------------------------------------
const song = surfacesForType("song");
check("song declares Notes + Chart", song.map((s) => s.id).join(",") === "notes,chart");
check(
  "the Chart is the primary artifact AND is chordpro, not markdown",
  song.find((s) => s.id === "chart")?.primary === true &&
    song.find((s) => s.id === "chart")?.format === CHORDPRO_FORMAT
);
check(
  "a song's Notes are ordinary markdown",
  song.find((s) => s.id === "notes")?.format === MARKDOWN_FORMAT
);

// --- 3. ordinary types are untouched ---------------------------------------
for (const t of ["note", "task", "event", "person"]) {
  const s = surfacesForType(t);
  check(
    `${t} still reports exactly one markdown body surface`,
    s.length === 1 && s[0].storage.kind === "body" && s[0].format === MARKDOWN_FORMAT
  );
}

// --- 4. a borrowed capability brings its surfaces ---------------------------
const borrowedChart = surfacesForType("worship_set", undefined, "chord-chart");
check(
  "a user-named type carrying `chord-chart` gets the song's surfaces",
  borrowedChart.map((s) => s.id).join(",") === "notes,chart" &&
    borrowedChart.find((s) => s.id === "chart")?.format === CHORDPRO_FORMAT
);
const borrowedPaper = surfacesForType("article", undefined, "paper-workspace");
check(
  "a user-named type carrying `paper-workspace` gets the paper's five",
  borrowedPaper.length === 5 && borrowedPaper.find((s) => s.primary)?.id === "draft"
);
check(
  "an unknown capability falls back to the single body surface",
  surfacesForType("whatever", undefined, "no-such-tool").length === 1
);

// --- 5. content pairing -----------------------------------------------------
const paperItem = {
  type: "paper",
  body: { format: MARKDOWN_FORMAT, text: "The draft itself.[^1]" },
  properties: { notes: "half-formed thought", sections: [{ id: "s1" }], quoteBank: [] },
};
const resolved = resolveSurfacesSync(paperItem);
const by = (id: string) => resolved.find((s) => s.id === id)!;
check("the body surface reads the body", by("draft").content === "The draft itself.[^1]");
check("a property surface reads its own key", by("notes").content === "half-formed thought");
check("a derived surface carries no content", by("outline").content === null);
check(
  "`empty` is honest: a filled quote bank array vs an empty one",
  by("quotes").empty === true && by("shape").empty === false
);
check("an absent property reads as empty, not as a crash", by("draft").empty === false);

// A chordpro body comes back as its own source, not coerced to markdown.
const songItem = {
  type: "song",
  body: { format: CHORDPRO_FORMAT, text: "{title: Example}\n[C]placeholder lyric line" },
  properties: { notes: "capo 2" },
};
const songResolved = resolveSurfacesSync(songItem);
check(
  "a chordpro body resolves as its ChordPro source",
  songResolved.find((s) => s.id === "chart")?.content === songItem.body.text
);
check(
  "a song's notes resolve independently of its chart",
  songResolved.find((s) => s.id === "notes")?.content === "capo 2"
);

// --- 6. write targeting -----------------------------------------------------
const unknown = resolveSurfaceTarget("paper", "nope");
check(
  "an unknown surface is refused and names the real ones",
  unknown.ok === false && unknown.reason === "unknown" && unknown.known.includes("draft")
);
const ro = resolveSurfaceTarget("paper", "outline");
check(
  "a read-only surface is refused and names only the WRITABLE ones",
  ro.ok === false &&
    ro.reason === "read_only" &&
    !ro.known.includes("outline") &&
    ro.known.includes("notes")
);
const okNotes = resolveSurfaceTarget("paper", "notes");
check(
  "a writable surface resolves to its backing property",
  okNotes.ok === true && okNotes.surface.storage.kind === "property"
);
const okChart = resolveSurfaceTarget("song", "chart");
check(
  "a song's chart resolves to the body",
  okChart.ok === true && okChart.surface.storage.kind === "body"
);

// --- 7. the canonical-format stamp -----------------------------------------
check(
  "a song's canonical body format is chordpro",
  canonicalFormatForType("song") === CHORDPRO_FORMAT
);
check(
  "a paper's canonical body format is markdown",
  canonicalFormatForType("paper") === MARKDOWN_FORMAT
);
check(
  "a borrowed chord-chart capability carries the chordpro format too",
  canonicalFormatForType("worship_set", undefined, "chord-chart") === CHORDPRO_FORMAT
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
