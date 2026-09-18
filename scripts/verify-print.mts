// Verification for the Save Offline / share print render (slice 18, reworked
// for markdown bodies in M3/ADR-040): markdownToHtml turns a canonical markdown
// body into the document body markup, and renderPrintDocument wraps it in the
// self-contained shell. Pure functions, no DB, no browser.
//   npx tsx scripts/verify-print.mts
import { markdownToHtml } from "../src/lib/markdown-render";
import { renderPrintDocument, escapeHtml } from "../src/lib/print-html";
import { makeMarkdownBody } from "../src/lib/body";
import { mentionToMarkdown } from "../src/lib/editor/mention-markdown";
import { ACCENT_HIGHLIGHT, textColorTag, highlightTag } from "../src/lib/colors";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- headings shift under the document's <h1> ------------------------------
check("h1 in body renders <h2> (title owns <h1>)", markdownToHtml("# Point").includes("<h2>Point</h2>"));
check("h2 renders <h3>", markdownToHtml("## Sub").includes("<h3>Sub</h3>"));
check("h6 clamps at <h6>, no overflow to <h7>", markdownToHtml("###### Deep").includes("<h6>Deep</h6>"));

// --- inline marks ----------------------------------------------------------
check("bold", markdownToHtml("**b**").includes("<strong>b</strong>"));
check("italic", markdownToHtml("*i*").includes("<em>i</em>"));
check("strikethrough", markdownToHtml("~~x~~").includes("<s>x</s>"));
// The underline mark serializes to ++text++; markdown-it has no ins rule of its
// own, so markdown-render adds one (otherwise the plus signs print literally).
check("underline", markdownToHtml("++u++").includes("<u>u</u>"));
check("underline keeps nested formatting", markdownToHtml("++a **b**++").includes("<u>a <strong>b</strong></u>"));
check("lone ++ is left alone", markdownToHtml("2 ++ 2").includes("2 ++ 2"));
check("++ inside code is left alone", markdownToHtml("`a++b++c`").includes("a++b++c"));

// --- mention renders as a tappable /items/<id> anchor ----------------------
const id = "9f8c2b14-0000-4abc-8def-112233445566";
const mHtml = markdownToHtml(`Prep with ${mentionToMarkdown(id, "Roger 1:1")}.`);
check(
  'mention → <a href="/items/<id>" class="mention">',
  mHtml.includes(`<a href="/items/${id}" class="mention">@Roger 1:1</a>`),
  mHtml,
);
check("mention drops the ledgr:// href (resolves to in-app route)", !mHtml.includes("ledgr://"), mHtml);
// A malformed mention (empty id) must never leak a broken anchor or URI.
const badHtml = markdownToHtml("See [@Ghost](ledgr://item/).");
check(
  "empty-id mention flattens to <span class=\"mention\">",
  badHtml.includes('<span class="mention">@Ghost</span>') && !badHtml.includes("ledgr://"),
  badHtml,
);

// --- color / highlight inline HTML passes through --------------------------
const colorMd = `${textColorTag("red").open}covenant${textColorTag("red").close}`;
check("text color span survives", markdownToHtml(colorMd).includes(textColorTag("red").open));
const hlMd = `${highlightTag("yellow").open}grace${highlightTag("yellow").close}`;
check("highlight mark survives", markdownToHtml(hlMd).includes('<mark class="hl-yellow"'));

// --- ordinary links still anchor -------------------------------------------
const linkHtml = markdownToHtml("[site](https://example.com)");
check("https link → anchor", linkHtml.includes('<a href="https://example.com">site</a>'), linkHtml);

// --- block structures ------------------------------------------------------
const listHtml = markdownToHtml("- a\n- b");
check("bullet list", listHtml.includes("<ul>") && listHtml.includes("<li>a</li>") && listHtml.includes("<li>b</li>"));
const olHtml = markdownToHtml("1. one\n2. two");
check("numbered list", olHtml.includes("<ol>") && olHtml.includes("<li>one</li>"));
check("blockquote", markdownToHtml("> q").includes("<blockquote>"));
check("code block", markdownToHtml("```\ncode\n```").includes("<pre><code>code\n</code></pre>"));
check("divider", markdownToHtml("---").includes("<hr>"));
const tableHtml = markdownToHtml("| A | B |\n| --- | --- |\n| 1 | 2 |");
check("table renders th + td", tableHtml.includes("<table>") && tableHtml.includes("<th>A</th>") && tableHtml.includes("<td>1</td>"), tableHtml);

// --- task lists (GFM, ADR-044): - [ ] / - [x] → checkboxes --------------------
const taskHtml = markdownToHtml("- [ ] todo\n- [x] done");
check("task list marks the <ul> contains-task-list", taskHtml.includes('contains-task-list'), taskHtml);
check("unchecked item → empty checkbox + stripped marker",
  taskHtml.includes('<input type="checkbox" disabled> todo') && !taskHtml.includes("[ ] todo"), taskHtml);
check("checked item → checked checkbox",
  taskHtml.includes('<input type="checkbox" disabled checked> done'), taskHtml);
check("plain bullet list is untouched by the task rule",
  !markdownToHtml("- a\n- b").includes("contains-task-list"));

// --- empty ------------------------------------------------------------------
check("empty markdown → empty body", markdownToHtml("") === "");

// --- escapeHtml + the document shell ---------------------------------------
check("escapeHtml escapes the dangerous four", escapeHtml(`<a&"`) === "&lt;a&amp;&quot;");
const doc = renderPrintDocument("Sermon <Notes>", makeMarkdownBody("# Intro\n\nGrace."));
check("shell escapes the title", doc.includes("<h1>Sermon &lt;Notes&gt;</h1>"));
check("shell renders the body markdown", doc.includes("<h2>Intro</h2>") && doc.includes("<p>Grace.</p>"));
check("shell is a complete, self-contained page", doc.startsWith("<!doctype html>") && doc.includes("<style>") && doc.includes("window.print()"));
check("shell hl-* CSS is present for highlights", doc.includes("mark.hl-yellow{"));

// The accent highlight in THIS document (colors.ts). The shell carries no app
// context, so a live `var(--accent)` has nothing to resolve against: the owner's
// accent is resolved server-side into a literal. A var() reaching this page would
// render as no highlight at all, which is the Sunday-proof failure to guard.
const accentMd = `${highlightTag(ACCENT_HIGHLIGHT).open}grace${highlightTag(ACCENT_HIGHLIGHT).close}`;
const accentDoc = renderPrintDocument("T", makeMarkdownBody(accentMd), { accent: "#2563eb" });
check(
  "accent highlight gets a literal rule in the shell, with no var() left in it",
  accentDoc.includes("mark.hl-accent{background-color:rgba(37,99,235,0.4)"),
  accentDoc.match(/mark\.hl-accent\{[^}]*\}/)?.[0] ?? "no rule",
);
check(
  "that rule keeps color:inherit, so a highlight can't repaint colored text",
  /mark\.hl-accent\{[^}]*color:inherit/.test(accentDoc),
);
check(
  "no accent rule when the caller passes no accent",
  !renderPrintDocument("T", makeMarkdownBody(accentMd)).includes("mark.hl-accent{"),
);
const shared = renderPrintDocument("Doc", makeMarkdownBody("Body."), { footerHtml: "Shared from Ledgr · read-only" });
check("footer appears when given", shared.includes('<div class="doc-footer">Shared from Ledgr · read-only</div>'));
check("no footer element by default", !doc.includes('<div class="doc-footer">'));
check("null/empty body renders the title with no body markup", renderPrintDocument("T", null).includes("<h1>T</h1>"));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
