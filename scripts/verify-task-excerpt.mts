// Verification: excerptLine, the pure first-line extractor behind the task
// row's description line (tasks-row-redesign, ADR-202). The list ships a
// capped 240-char head of the body; this reduces it to one readable line —
// markdown stripped, link labels kept, empty/image-only/rule-only lines
// skipped. Pure (no DB, no server). Run:
//   npx tsx scripts/verify-task-excerpt.mts
import { excerptLine } from "../src/lib/excerpt";

let failures = 0;
function check(name: string, got: string, want: string) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
  if (!ok) failures += 1;
}

check("plain first line", excerptLine("Buy the cable\nsecond line"), "Buy the cable");
check("null body", excerptLine(null), "");
check("empty body", excerptLine(""), "");
check("whitespace-only", excerptLine("   \n\t\n"), "");
check("skips leading blank lines", excerptLine("\n\nreal text"), "real text");
check(
  "heading stripped",
  excerptLine("## Notes from the call\nmore"),
  "Notes from the call"
);
check("quote stripped", excerptLine("> remember this"), "remember this");
check("bullet stripped", excerptLine("- first thing"), "first thing");
check("numbered stripped", excerptLine("1. first thing"), "first thing");
check("task box stripped", excerptLine("- [ ] call Roger"), "call Roger");
check(
  "emphasis stripped",
  excerptLine("**Bold** and ++underlined++ and `code`"),
  "Bold and underlined and code"
);
check(
  "link keeps label",
  excerptLine("Go here: [Overview](https://coda.io/d/x)"),
  "Go here: Overview"
);
check(
  "mention chip keeps label",
  excerptLine("Ask [@Roger](ledgr://item/abc) about it"),
  "Ask @Roger about it"
);
check(
  "bare url survives",
  excerptLine("Go Here to see what to edit next: https://coda.io/d/x"),
  "Go Here to see what to edit next: https://coda.io/d/x"
);
check("image-only line skipped", excerptLine("![shot](a.png)\ncaption"), "caption");
check("rule-only line skipped", excerptLine("---\nafter the rule"), "after the rule");
check(
  "critic comment dropped, anchor kept",
  excerptLine("{==the plan==}{>>check this<<} stands"),
  "the plan stands"
);
check("inline html stripped", excerptLine("<mark>hot</mark> item"), "hot item");
check(
  "first line only, marker plus box plus emphasis",
  excerptLine("* [x] **done** thing\nnext"),
  "done thing"
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll excerpt checks passed.");
