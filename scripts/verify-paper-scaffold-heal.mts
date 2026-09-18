// Regression guard for the 2026-09-16 incident: an agent wrote a paper's
// scaffold over MCP by GUESSING its shape, nothing rejected the guess, and the
// paper became unopenable.
//
// The guesses were `{title, body}` for a section (real shape: `{id, title,
// paragraphs[]}`) and `{quote, source, citation, note}` for a quote-bank entry
// (real shape: `{id, text, source: {kind:"book"|"video", …}}`). Because
// migrateScaffold did `props.sections as OutlineSection[]` — a compile-time cast
// that checks nothing at runtime — the bad rows reached ShapeTab, OutlineTab,
// QuoteBank and lib/papers/outline.ts, all of which do `s.paragraphs.map(...)`
// unguarded. A missing array there does not degrade one tab; it throws and takes
// the whole record down.
//
// The contract these checks lock in: a bad write may leave a surface EMPTY or
// ODD-LOOKING, never unopenable, and healing is LOSSLESS — content that occupied
// a required slot in an unusable form is moved aside, never dropped.
//
//   npx tsx scripts/verify-paper-scaffold-heal.mts
import { healScaffold } from "../src/lib/papers/normalize";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- the exact shape the agent wrote ---------------------------------------
const agentWrote = {
  sections: [
    { title: "Authorship and Date", body: "What the assignment asks for here." },
    { title: "Occasion", body: "Second section prose." },
  ],
  quoteBank: [
    { quote: "A sentence pulled from a source.", source: "Author, Title, 41.", citation: "full", note: "use early" },
  ],
};
const healed = healScaffold(agentWrote as unknown as Record<string, unknown>);

check("a malformed scaffold is reported as changed", healed.changed);
check("every section now has the paragraphs array the renderers require",
  healed.sections.every((s) => Array.isArray(s.paragraphs) && s.paragraphs.length > 0));
check("every section now has a stable id", healed.sections.every((s) => typeof s.id === "string" && s.id.length > 0));
check("every paragraph has an id", healed.sections.every((s) => s.paragraphs.every((p) => typeof p.id === "string" && p.id)));
check("section titles are preserved",
  healed.sections.map((s) => s.title).join("|") === "Authorship and Date|Occasion");
check("a guessed `body` is MOVED to `note`, not dropped",
  healed.sections[0].note === "What the assignment asks for here.");
check("the stray `body` key is cleared once moved",
  (healed.sections[0] as unknown as Record<string, unknown>).body === undefined);

check("every quote now has an id", healed.quotes.every((q) => typeof q.id === "string" && q.id));
check("a guessed `quote` is MOVED to `text`, not dropped",
  healed.quotes[0].text === "A sentence pulled from a source.");
check("every quote now has a source the citation engine can switch on",
  healed.quotes.every((q) => q.source?.kind === "book" || q.source?.kind === "video"));
check("an unusable `source` string is PRESERVED as sourceText, not discarded",
  (healed.quotes[0] as unknown as Record<string, unknown>).sourceText === "Author, Title, 41.");
check("unknown keys the writer sent are kept, not silently deleted",
  (healed.quotes[0] as unknown as Record<string, unknown>).citation === "full" &&
  (healed.quotes[0] as unknown as Record<string, unknown>).note === "use early");

// --- healthy data is left completely alone ---------------------------------
const healthy = {
  sections: [
    { id: "s1", title: "One", paragraphs: [{ id: "p1", note: "a thought" }] },
  ],
  quoteBank: [
    { id: "q1", text: "quoted text", page: "41",
      source: { kind: "book", author: "A B", authorLast: "B", title: "T", shortTitle: "T", city: "C", publisher: "P", year: "2020" } },
  ],
};
const untouched = healScaffold(healthy as unknown as Record<string, unknown>);
check("a healthy scaffold reports NO change (so a good paper is never rewritten)", untouched.changed === false);
check("a healthy section is returned intact",
  JSON.stringify(untouched.sections) === JSON.stringify(healthy.sections));
check("a healthy quote is returned intact",
  JSON.stringify(untouched.quotes) === JSON.stringify(healthy.quoteBank));

// --- hostile shapes still can't take the record down -----------------------
for (const [label, props] of [
  ["sections is not an array", { sections: "nope", quoteBank: [] }],
  ["a section is a bare string", { sections: ["just text"], quoteBank: [] }],
  ["a section is null", { sections: [null], quoteBank: [] }],
  ["paragraphs is a string", { sections: [{ id: "a", title: "t", paragraphs: "x" }], quoteBank: [] }],
  ["a quote is a number", { sections: [], quoteBank: [7] }],
  ["quoteBank is an object", { sections: [], quoteBank: { a: 1 } }],
  ["both missing entirely", {}],
] as [string, Record<string, unknown>][]) {
  let threw = false;
  let ok = false;
  try {
    const r = healScaffold(props);
    ok = r.sections.every((s) => Array.isArray(s.paragraphs)) &&
         r.quotes.every((q) => !!q.source?.kind);
  } catch {
    threw = true;
  }
  check(`survives: ${label}`, !threw && ok, threw ? "THREW" : "");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
