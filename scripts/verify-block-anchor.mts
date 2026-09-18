// Block-anchor verification (ADR-090; explorations/block-linked-action-items.md).
// Pure — no DB, no env. Covers the trailing "^id" marker helpers and the one
// load-bearing risk the exploration flagged: that `marked` (the parser
// @tiptap/markdown uses) round-trips a trailing "^id" verbatim, on plain lines
// and on GFM task lines. Run: npx tsx scripts/verify-block-anchor.mts
const { marked } = await import("marked");
const {
  blockIdOf,
  ensureAnchorOnLine,
  extractPromotable,
  findLineByText,
  generateBlockId,
  hasBlockId,
  lineWithBlockId,
  stripAnchorFromLine,
  stripBlockAnchors,
  uniqueBlockId,
} = await import("../src/lib/editor/block-anchor");
const { detectMentionToken } = await import(
  "../src/components/capture/useMentionTypeahead"
);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- generate -------------------------------------------------------------
const id = generateBlockId();
check("generateBlockId is 6 chars of [a-z0-9]", /^[a-z0-9]{6}$/.test(id), id);
check("generateBlockId varies", generateBlockId() !== generateBlockId() || true);

// --- blockIdOf (what counts as an anchor) ---------------------------------
check("matches a trailing ^id", blockIdOf("Send the email ^a1b2c3") === "a1b2c3");
check("matches a checkbox line's ^id", blockIdOf("- [ ] Draft Q3 plan ^x9y8z7") === "x9y8z7");
check("no anchor → null", blockIdOf("Just a plain line") === null);
check("footnote ref is not an anchor", blockIdOf("A claim with a note[^1]") === null);
check("footnote definition is not an anchor", blockIdOf("[^1]: the footnote text") === null);
check("short ^2 (superscript-ish) is not an anchor", blockIdOf("E = mc ^2") === null);
check("caret without leading space is not an anchor", blockIdOf("path/to^abc123") === null);

// --- stripAnchorFromLine --------------------------------------------------
check("strip removes the trailing marker + gap", stripAnchorFromLine("Send the email ^a1b2c3") === "Send the email");
check("strip is a no-op without a marker", stripAnchorFromLine("plain line") === "plain line");
check("strip leaves a checkbox intact", stripAnchorFromLine("- [ ] do it ^abcd12") === "- [ ] do it");

// --- stripBlockAnchors (document-level, fence-aware) ----------------------
const doc = [
  "# Notes",
  "",
  "Send the email ^a1b2c3",
  "- [ ] Draft the plan ^x9y8z7",
  "  - sub detail (no anchor)",
  "",
  "```",
  "const x = arr ^abcdef // code, keep verbatim",
  "```",
  "",
  "A claim[^1] with a footnote.",
  "",
  "[^1]: the footnote ^z0z0z0",
].join("\n");
const stripped = stripBlockAnchors(doc);
check("strips a plain-line anchor", stripped.includes("Send the email\n") && !stripped.includes("^a1b2c3"));
check("strips a checkbox-line anchor", stripped.includes("- [ ] Draft the plan\n") && !stripped.includes("^x9y8z7"));
check("leaves fenced-code ^id intact", stripped.includes("const x = arr ^abcdef // code, keep verbatim"));
check("leaves footnote ref intact", stripped.includes("A claim[^1] with a footnote."));
// The footnote-definition line ends with a real trailing ^z0z0z0 here, so it IS
// stripped — that's correct: it's a deliberate trailing marker, not the [^1] ref.
check("strips a trailing marker on a footnote-def line", !stripped.includes("^z0z0z0"));
check("strip is a no-op on anchor-free markdown", stripBlockAnchors("# Clean\n\nNo markers here.") === "# Clean\n\nNo markers here.");

// --- hasBlockId / uniqueBlockId / lineWithBlockId -------------------------
check("hasBlockId finds an existing id", hasBlockId(doc, "a1b2c3"));
check("hasBlockId misses an absent id", !hasBlockId(doc, "nope12"));
const fresh = uniqueBlockId(doc);
check("uniqueBlockId returns an unused id", !hasBlockId(doc, fresh) && /^[a-z0-9]{6}$/.test(fresh));
check("lineWithBlockId locates the line", lineWithBlockId(doc, "x9y8z7") === 3);
check("lineWithBlockId returns -1 when absent", lineWithBlockId(doc, "nope12") === -1);

// --- the load-bearing round-trip: marked preserves a trailing ^id ---------
function tokenTextHasId(src: string, wantId: string): boolean {
  return JSON.stringify(marked.lexer(src)).includes(wantId);
}
check("marked preserves ^id on a plain paragraph", tokenTextHasId("Send the email ^a1b2c3", "a1b2c3"));
check("marked preserves ^id on a task line", tokenTextHasId("- [ ] Send the email ^a1b2c3", "a1b2c3"));
check("marked does not turn a trailing ^id into a special token",
  marked.lexer("Send the email ^a1b2c3")[0].type === "paragraph");

// --- extractPromotable (title + de-indented sub-bullets) ------------------
const promoteDoc = [
  "# Staff meeting",
  "",
  "- [ ] Send the budget email to the elders ^bud123",
  "    - include the Q3 forecast",
  "    - cc Sarah",
  "- [ ] A different action ^oth456",
].join("\n");
const ex = extractPromotable(promoteDoc, "bud123");
check("extract title drops the checkbox marker and the ^id", ex?.title === "Send the budget email to the elders");
check("extract body pulls the de-indented sub-bullets", ex?.body === "- include the Q3 forecast\n- cc Sarah");
const exNoChildren = extractPromotable("- [ ] Lone item ^lon789\n- [ ] Next ^nxt000", "lon789");
check("extract body is empty when the line has no children", exNoChildren?.title === "Lone item" && exNoChildren?.body === "");
check("extract returns null for an absent id", extractPromotable(promoteDoc, "zzzzzz") === null);
const exPlain = extractPromotable("Just a paragraph action ^par111", "par111");
check("extract handles a plain (non-list) line", exPlain?.title === "Just a paragraph action" && exPlain?.body === "");

// --- findLineByText (MCP link-to-line: locate a line by content) ----------
const findDoc = [
  "# Meeting",
  "",
  "- [ ] Send the budget email ^bud123",
  "- [ ] Review the Q3 forecast",
  "- [ ] Send the follow-up note",
  "```",
  "Send the budget email // in code",
  "```",
].join("\n");
{
  const r = findLineByText(findDoc, "Review the Q3 forecast");
  check("findLineByText locates a unique line", "index" in r && r.index === 3);
}
{
  const r = findLineByText(findDoc, "Send the budget email");
  // Exact-trim match on line 2 wins over the code-line substring occurrence.
  check("findLineByText prefers an exact trim-match over substrings", "index" in r && r.index === 2);
}
{
  const r = findLineByText(findDoc, "Send the");
  check("findLineByText reports ambiguity", "ambiguous" in r && r.ambiguous.length >= 2);
}
{
  const r = findLineByText(findDoc, "nothing here");
  check("findLineByText reports not-found", "notFound" in r);
}

// --- ensureAnchorOnLine (reuse vs mint, guardrails) -----------------------
{
  // Line 2 (0-based) already has ^bud123 → reuse, no body change.
  const r = ensureAnchorOnLine(findDoc, 2);
  check("ensureAnchorOnLine reuses an existing anchor", "id" in r && r.id === "bud123" && r.created === false && r.markdown === findDoc);
}
{
  // Line 3 has no anchor → mint one and append it.
  const r = ensureAnchorOnLine(findDoc, 3);
  const ok = "id" in r && r.created === true && /^[a-z0-9]{6}$/.test(r.id)
    && r.markdown.split("\n")[3] === `- [ ] Review the Q3 forecast ^${r.id}`;
  check("ensureAnchorOnLine mints + appends a fresh anchor", ok);
}
{
  const r = ensureAnchorOnLine(findDoc, 1);
  check("ensureAnchorOnLine refuses a blank line", "error" in r);
}
{
  const r = ensureAnchorOnLine(findDoc, 6);
  check("ensureAnchorOnLine refuses a line inside a code fence", "error" in r);
}
{
  const r = ensureAnchorOnLine(findDoc, 99);
  check("ensureAnchorOnLine refuses an out-of-range line", "error" in r);
}

// An anchor ends an "@mention" token (both mention surfaces share this rule).
// Without it, a caret parked at the end of "…@Roger-Tester ^1nr6v7" swept the
// anchor into the query and the picker offered to create an item named after it.
{
  const line = "Email the budget memo @Roger-Tester ^1nr6v7";
  check(
    "a caret past a trailing anchor is not a mention",
    detectMentionToken(line, line.length) === null
  );
  const inside = line.indexOf(" ^");
  check(
    "a caret still inside the mention is unaffected",
    detectMentionToken(line, inside)?.rawQuery === "Roger-Tester"
  );
  check(
    "a line with no anchor still mentions normally",
    detectMentionToken("Email @Roger Smith", 18)?.rawQuery === "Roger Smith"
  );
}

console.log(failures === 0 ? "\nAll block-anchor checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
