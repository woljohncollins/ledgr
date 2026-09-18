// Verifies the live canvas word count (src/lib/word-count.ts) with no DB and no
// browser: the count itself, the debounced trailing recount, and the item-id
// scoping that keeps a canvas modal's editor from rewriting the underlying page's
// count.
//   npx tsx scripts/verify-word-count.mts
import { wordCountOf } from "../src/lib/body";
import { publishBodyMarkdown, peekWordCount, peekWordCountPerTab } from "../src/lib/word-count";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- the count --------------------------------------------------------------
check("plain prose", wordCountOf("one two three") === 3);
check("markdown punctuation doesn't count", wordCountOf("# Title\n\n- a\n- b") === 3);
check("contractions and hyphens are one word", wordCountOf("don't re-count won’t") === 3);
check("empty body", wordCountOf("") === 0);

// --- markup is not prose ------------------------------------------------------
check(
  "inline HTML tags and attributes don't count",
  wordCountOf('a <mark class="hl-yellow">bright idea</mark> here') === 4,
  String(wordCountOf('a <mark class="hl-yellow">bright idea</mark> here'))
);
check(
  "a tag separates words rather than joining them",
  wordCountOf("one<br>two") === 2
);
check("html comments don't count", wordCountOf("one <!-- hidden note --> two") === 2);
check("prose angle brackets survive", wordCountOf("if 5 < 10 and 10 > 5") === 6);
check(
  "a comment's note doesn't count, its anchored text does",
  wordCountOf("This is a {==line with a comment==}{>>too vague, tighten this<<}.") === 7,
  String(wordCountOf("This is a {==line with a comment==}{>>too vague, tighten this<<}."))
);
check(
  "a point comment counts as nothing",
  wordCountOf("Budget is approved.{>>confirm with Roger first<<}") === 3
);
check(
  "a link's label counts, its URL doesn't",
  wordCountOf("see [the budget doc](https://example.com/finance/budget-2026) today") === 5,
  String(wordCountOf("see [the budget doc](https://example.com/finance/budget-2026) today"))
);
check(
  "a mention chip counts its label, not its uuid",
  wordCountOf("ask [@Roger Smith](ledgr://item/8f3a2b1c-77d4-4e21-9a0b-15c6d9e3f042) about it") === 5,
  String(
    wordCountOf("ask [@Roger Smith](ledgr://item/8f3a2b1c-77d4-4e21-9a0b-15c6d9e3f042) about it")
  )
);
check(
  "an image counts as nothing, alt text included",
  wordCountOf('before ![a wide chart](https://cdn.example.com/chart.png "Q3") after') === 2,
  String(wordCountOf('before ![a wide chart](https://cdn.example.com/chart.png "Q3") after'))
);
check("a bare URL counts as nothing", wordCountOf("read https://example.com/x now") === 2);
check("block anchors don't count", wordCountOf("Send the email ^a1b2c3") === 3);
check(
  "ordered list numbers don't count",
  wordCountOf("1. first\n2. second\n3. third") === 3,
  String(wordCountOf("1. first\n2. second\n3. third"))
);
check("task checkboxes don't count", wordCountOf("- [x] mow the lawn") === 3);
check("footnote markers don't count, the note's prose does", wordCountOf("Yes.[^1]\n\n[^1]: because so") === 3);
check("live item tokens count as nothing", wordCountOf("Due {{item.due}} for {{item.title}}") === 2);
check("html entities don't count", wordCountOf("a&nbsp;b &amp; c") === 3);
// Code the author typed counts; only its scaffolding (``` and the language tag)
// doesn't. "intro outro and too" (4) + "const x foo bar" (4) + "inline code" (2).
check(
  "code counts, its fence and language tag don't",
  wordCountOf("intro\n\n```js\nconst x = foo.bar();\n```\n\noutro and `inline code` too") === 10,
  String(wordCountOf("intro\n\n```js\nconst x = foo.bar();\n```\n\noutro and `inline code` too"))
);
check(
  // The tag and the URL survive as the literal text they are on screen.
  "markup rules don't reach inside code",
  wordCountOf('```\n<div class="wide">see https://example.com/x</div>\n```') === 9,
  String(wordCountOf('```\n<div class="wide">see https://example.com/x</div>\n```'))
);
check(
  "criticmarkup inside a code fence is literal text",
  wordCountOf("```\n{>>note<<}\n```") === 1,
  String(wordCountOf("```\n{>>note<<}\n```"))
);
check(
  "a canvas tab marker doesn't count",
  wordCountOf("<!-- tab: Notes -->\nreal words here") === 3
);
check(
  "a toggle keeps its summary and body",
  wordCountOf("<details open>\n<summary>The summary</summary>\n\nThe body\n\n</details>") === 4,
  String(
    wordCountOf("<details open>\n<summary>The summary</summary>\n\nThe body\n\n</details>")
  )
);
check(
  "a heading, quote and table keep their words",
  wordCountOf("## Big Idea\n\n> quoted line\n\n| a | b |\n|---|---|\n| one | two |") === 8,
  String(wordCountOf("## Big Idea\n\n> quoted line\n\n| a | b |\n|---|---|\n| one | two |"))
);

// --- the debounced publish --------------------------------------------------
check("nothing published yet", peekWordCount("item-a") === null);
publishBodyMarkdown("item-a", "one two three");
publishBodyMarkdown("item-a", "one two three four");
check("not recounted on the keystroke", peekWordCount("item-a") === null);

await new Promise((r) => setTimeout(r, 1200));
check(
  "trailing recount lands, latest text wins",
  peekWordCount("item-a") === 4,
  String(peekWordCount("item-a"))
);
check("another item is unaffected", peekWordCount("item-b") === null);

// A second item publishing takes over the slot (one canvas is in focus at a
// time); the first then falls back to its server-rendered count.
publishBodyMarkdown("item-b", "five six");
await new Promise((r) => setTimeout(r, 1200));
check("scoped to the publishing item", peekWordCount("item-b") === 2);
check("previous item falls back to its server count", peekWordCount("item-a") === null);
check("a whole-body publish is not tab-scoped", peekWordCountPerTab("item-b") === false);

// Tabbed bodies (ADR-095) count the ACTIVE tab: TabbedBody publishes the active
// section after the whole-body publish from the same change, and the later call
// wins, so the chrome shows that tab's count labeled "(this tab)".
publishBodyMarkdown("item-c", "<!-- tab: A -->\none two\n<!-- tab: B -->\nthree four five");
publishBodyMarkdown("item-c", "three four five", { perTab: true });
await new Promise((r) => setTimeout(r, 1200));
check("the active tab's count lands, not the whole body's", peekWordCount("item-c") === 3);
check("and it is marked tab-scoped", peekWordCountPerTab("item-c") === true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
