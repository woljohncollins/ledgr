// Self-check for src/lib/diff.ts (the version-history diff). Run with:
//   npx tsx scripts/verify-diff.mts
// Guards the regression that motivated the two-tier rewrite: edits near both
// ends of a long doc must NOT render as a full delete + re-add.
import assert from "node:assert/strict";
import { diffWords, diffStats, type DiffSegment } from "../src/lib/diff";

// Every diff must reconstruct both inputs exactly (eq+del = a, eq+add = b).
function check(a: string, b: string): DiffSegment[] {
  const segs = diffWords(a, b);
  let olds = "";
  let news = "";
  for (const s of segs) {
    if (s.op !== "add") olds += s.text;
    if (s.op !== "del") news += s.text;
  }
  assert.equal(olds, a, "eq+del segments must reproduce the old text");
  assert.equal(news, b, "eq+add segments must reproduce the new text");
  return segs;
}

// Sermon-sized doc: 150 paragraphs, ~1500 words.
const para = (i: number) =>
  `Paragraph ${i} lorem ipsum dolor sit amet consectetur adipiscing elit.`;
const lines = Array.from({ length: 150 }, (_, i) => para(i));
const base = lines.join("\n\n");

// One small edit near the top AND one near the bottom: the case that used to
// blow past the LCS cell cap and dump ~1450 words as del-all + add-all.
{
  const edited = [...lines];
  edited[2] = edited[2].replace("dolor", "DOLOR-EDITED");
  edited[147] = edited[147].replace("ipsum", "IPSUM-EDITED");
  const stats = diffStats(check(base, edited.join("\n\n")));
  assert.deepEqual(stats, { added: 2, removed: 2 }, `far-apart edits stayed word-sized, got +${stats.added} −${stats.removed}`);
}

// Basics.
assert.deepEqual(diffWords("", ""), []);
assert.deepEqual(diffWords("same", "same"), [{ op: "eq", text: "same" }]);
assert.deepEqual(diffWords("", "new"), [{ op: "add", text: "new" }]);
assert.deepEqual(diffWords("old", ""), [{ op: "del", text: "old" }]);
check("no trailing newline", "no trailing newline changed");
check("a\nb\nc\n", "a\nB\nc\n");
check("only\nadded\n", "only\nadded\nlines\nhere\n");
check(base, lines.slice(0, 100).join("\n\n")); // big one-sided deletion

console.log("verify-diff: all checks passed");
