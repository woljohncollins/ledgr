// Verifies the quick-add sigil parsing: "#" = tags, "+" = project (2026-08-12).
//
// Why this script exists: the previous version of this logic lived inline in
// AddTaskCard and shipped a silent bug — an unmatched "#foo" was stripped out of
// the title and did nothing, so typing "#outreach" quietly deleted the word. A
// code read didn't catch it; a test would have. Pure functions, no DB, no server.
//
//   npx tsx scripts/verify-sigils.mts
import {
  parseMentionTokens,
  parseTagTokens,
  parseProjectToken,
  stripConsumedTokens,
  type NamedItem,
} from "../src/lib/tags";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${String(detail)})`}`);
  }
}

const TAGS: NamedItem[] = [
  { id: "t-work", title: "Work" },
  { id: "t-meet", title: "Meetings" },
  { id: "t-fall", title: "Fall Festival" },
];
const PROJECTS: NamedItem[] = [
  { id: "p-retreat", title: "Fall Retreat 2026" },
  { id: "p-hiring", title: "Worship Hiring" },
];

// --- tags ------------------------------------------------------------------
const t1 = parseTagTokens("Call Bob #work", TAGS);
check("an existing tag resolves", t1.length === 1 && t1[0].tag?.id === "t-work", JSON.stringify(t1));
check("resolution is case-insensitive", parseTagTokens("x #WORK", TAGS)[0]?.tag?.id === "t-work");

const t2 = parseTagTokens("Plan it #outreach", TAGS);
check("an unknown tag is marked for creation", t2.length === 1 && t2[0].tag === null && t2[0].name === "outreach");

const t3 = parseTagTokens("#work #meetings", TAGS);
check("several tags all parse", t3.length === 2 && t3.every((t) => t.tag !== null));

const t4 = parseTagTokens("#fall-festival", TAGS);
check("dashes expand to spaces and match", t4[0]?.tag?.id === "t-fall", JSON.stringify(t4));

const t5 = parseTagTokens("#work #Work #WORK", TAGS);
check("duplicates collapse to one", t5.length === 1, `got ${t5.length}`);

check("no tokens is an empty list", parseTagTokens("plain title", TAGS).length === 0);
check("a bare # is not a tag", parseTagTokens("cost # each", TAGS).length === 0);
// Exact-match-only: the substring rule a project uses would wrongly reuse
// "Fall Festival" for "#fall", silently mis-tagging instead of creating.
const t6 = parseTagTokens("#fall", TAGS);
check("a partial name creates rather than reusing a longer tag", t6[0]?.tag === null, JSON.stringify(t6));

// --- project ---------------------------------------------------------------
const p1 = parseProjectToken("Book rooms +fall-retreat", PROJECTS);
check("a project matches on substring", p1?.project?.id === "p-retreat", JSON.stringify(p1));
check("no + token is null", parseProjectToken("no token here", PROJECTS) === null);
const p2 = parseProjectToken("+nonexistent", PROJECTS);
check("an unmatched project keeps its token but resolves to null", p2 !== null && p2.project === null);
// "#" must no longer route a project — that was the whole point of the change.
check("# does NOT match a project", parseProjectToken("#fall-retreat", PROJECTS) === null);

// --- stripping -------------------------------------------------------------
check(
  "consumed tag + project tokens leave a clean title",
  stripConsumedTokens(
    "Book rooms +fall-retreat #work",
    parseTagTokens("Book rooms +fall-retreat #work", TAGS),
    parseProjectToken("Book rooms +fall-retreat #work", PROJECTS)
  ) === "Book rooms"
);
// THE REGRESSION THIS SCRIPT EXISTS FOR: an unmatched project must keep its text,
// because nothing happened in its place. The old code stripped it regardless.
check(
  "an UNMATCHED project token is left in the title, not silently eaten",
  stripConsumedTokens(
    "Ship it +nope",
    parseTagTokens("Ship it +nope", TAGS),
    parseProjectToken("Ship it +nope", PROJECTS)
  ) === "Ship it +nope"
);
// An unmatched TAG is safe to strip: it does act (the tag is created).
check(
  "an unmatched tag token IS stripped, since it creates the tag",
  stripConsumedTokens(
    "Ship it #brandnew",
    parseTagTokens("Ship it #brandnew", TAGS),
    parseProjectToken("Ship it #brandnew", PROJECTS)
  ) === "Ship it"
);
check(
  "stripping collapses the whitespace it leaves behind",
  stripConsumedTokens(
    "a #work b",
    parseTagTokens("a #work b", TAGS),
    null
  ) === "a b"
);
check(
  "a title that is only tokens collapses to empty",
  stripConsumedTokens("#work", parseTagTokens("#work", TAGS), null) === ""
);

// "@name" in a PRE-FILLED title (the promote-to-task flow) — the typed capture
// consumes these on pick, but promoted text never had a pick.
check(
  "pre-filled @tokens parse, expand dashes, and dedupe",
  JSON.stringify(parseMentionTokens("Email @Roger and @elder-board again @roger")) ===
    JSON.stringify([
      { token: "@Roger", name: "Roger" },
      { token: "@elder-board", name: "elder board" },
    ])
);
check(
  "an @ mid-word is not a mention (an email address stays text)",
  parseMentionTokens("mail me at a@b.com").length === 0
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
