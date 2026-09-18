// P-module verification: the Papers module registers onto core and resolves its
// paper canvas + markdown format; the MSM citation engine emits the three
// footnote forms correctly for books and videos; and the docx renderer turns a
// markdown body + meta into a non-empty .docx with footnotes allocated
// positionally. Node-pure (no React): imports the registration boot site and the
// pure papers/ core directly.
//
//   npx tsx scripts/verify-papers.mts
import "../src/lib/modules/register";
import {
  canonicalFormatForType,
  canvasIdForType,
  moduleForType,
} from "../src/lib/modules";
import { citeFull, citeIbid, citeShort } from "../src/lib/papers/citation";
import { renderMsmDocx } from "../src/lib/papers/msm-docx";
import type { BookSource, VideoSource } from "../src/lib/papers/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// ── registration + resolvers ──────────────────────────────────────────────────
check("papers module registered", moduleForType("paper")?.id === "papers");
check("paper resolves the paper canvas", canvasIdForType("paper") === "paper");
check("paper resolves the markdown format", canonicalFormatForType("paper") === "markdown");
check("songs still registered", moduleForType("song")?.id === "songs");
// `note` resolves the LONGFORM canvas (ADR-157), not the plain markdown one.
// This asserted "markdown" and had been failing silently since, because nothing
// ran it. The point is that note keeps its own core canvas rather than picking up
// the paper canvas, so name the canvas instead of assuming the default.
check(
  "core types unaffected",
  canvasIdForType("note") === "longform" && canonicalFormatForType("task") === "markdown",
  `note canvas=${canvasIdForType("note")} task format=${canonicalFormatForType("task")}`
);

// ── MSM citation engine: books ────────────────────────────────────────────────
const book: BookSource = {
  kind: "book",
  author: "Patrick Schreiner",
  authorLast: "Schreiner",
  title: "The Visual Word: Illustrated Outlines of the New Testament Books",
  shortTitle: "The Visual Word",
  editor: "Connor Sterchi",
  city: "Chicago",
  publisher: "Moody",
  year: "2021",
};
check(
  "book full reference",
  citeFull(book, "112") ===
    "Patrick Schreiner, *The Visual Word: Illustrated Outlines of the New Testament Books*, ed. Connor Sterchi (Chicago: Moody, 2021), 112.",
  citeFull(book, "112")
);
check("book short reference", citeShort(book, "112") === "Schreiner, *The Visual Word*, 112.", citeShort(book, "112"));
check("book ibid with page", citeIbid(book, "112") === "Ibid., 112.");
check("book ibid without page", citeIbid(book) === "Ibid.");

const noEditor: BookSource = { ...book, editor: undefined };
check(
  "book full omits absent editor",
  citeFull(noEditor, "5") === "Patrick Schreiner, *The Visual Word: Illustrated Outlines of the New Testament Books* (Chicago: Moody, 2021), 5.",
  citeFull(noEditor, "5")
);

// ── MSM citation engine: videos ───────────────────────────────────────────────
const video: VideoSource = {
  kind: "video",
  author: "Thomas Schreiner",
  authorLast: "Schreiner",
  title: "1 Peter",
  shortTitle: "1 Peter",
  url: "https://youtu.be/abc",
  accessed: "June 14, 2026",
};
check(
  "video full reference",
  citeFull(video) === 'Thomas Schreiner, "1 Peter," YouTube video, accessed June 14, 2026, https://youtu.be/abc.',
  citeFull(video)
);
check("video short reference (period inside quote)", citeShort(video) === 'Schreiner, "1 Peter."', citeShort(video));
check("video ibid has no page", citeIbid(video, "99") === "Ibid.");

// ── MSM docx render smoke test ────────────────────────────────────────────────
const md = [
  "An opening paragraph with a first citation.[^a]",
  "",
  "## A Subheading",
  "",
  "> A block quotation carrying its own footnote.[^b]",
  "",
  "A closing paragraph reuses the source as a shortened note.[^c]",
  "",
  "[^a]: " + citeFull(book, "112"),
  "[^b]: " + citeFull(video),
  "[^c]: " + citeShort(book, "118"),
].join("\n");

const render = await renderMsmDocx(md, { title: "A Teaching Overview", school: "MBTS", author: "Tyler Collins" });
check("docx renders a non-empty buffer", render.buffer.length > 1000, `${render.buffer.length} bytes`);
check("docx allocates one footnote per marker", render.footnoteCount === 3, `count=${render.footnoteCount}`);
check("docx produced body blocks", render.bodyBlocks >= 4, `blocks=${render.bodyBlocks}`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
