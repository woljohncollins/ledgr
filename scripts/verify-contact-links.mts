// verify-contact-links: the phone/email property kinds (ADR-192).
//
// Pure — no DB, no network, no env — so scripts/verify-ci.mjs discovers it and
// CI runs it on every PR and push to main.
//
// What it guards, in order of what would actually break:
//   1. telHref/mailtoHref never rewrite the STORED value; they only build hrefs.
//   2. The declared kind wins; the legacy key heuristic still covers `text`
//      fields from the Notion import, which is the back-compat promise.
//   3. Every builder that offers a kind offers these two, and the shared
//      contact-links module stays the single owner of the href rules.
import { readFileSync } from "node:fs";
import {
  contactInputType,
  contactLink,
  legacyTextIntent,
  mailtoHref,
  telHref,
  urlHref,
} from "../src/lib/contact-links";
import { PROPERTY_KINDS, parsePropertySchema } from "../src/lib/types";
import { opsForKind } from "../src/lib/view-where";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  (${String(detail)})` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  (${String(detail)})` : ""}`);
  }
}

// --- The kinds exist and validate -------------------------------------------
check("PROPERTY_KINDS includes phone + email", PROPERTY_KINDS.includes("phone") && PROPERTY_KINDS.includes("email"));

{
  const schema = parsePropertySchema([
    { key: "mobile", label: "Mobile", kind: "phone" },
    { key: "work_email", label: "Work email", kind: "email" },
  ]);
  check("parsePropertySchema accepts both kinds", schema.length === 2 && schema[0].kind === "phone" && schema[1].kind === "email");
  check("neither kind carries options", schema[0].options === undefined && schema[1].options === undefined);
}

// A kind neither the builder nor schema.md declares must still be rejected — the
// new kinds must not have loosened validation into "any string goes".
{
  let threw = false;
  try {
    parsePropertySchema([{ key: "x", label: "X", kind: "telephone" }]);
  } catch {
    threw = true;
  }
  check("an unknown kind is still rejected", threw);
}

// --- telHref: the value is never rewritten ----------------------------------
check("plain 10-digit", telHref("3095550142") === "tel:3095550142");
check("formatted number strips punctuation", telHref("(309) 555-0142") === "tel:3095550142");
check("dots and dashes strip", telHref("309.555.0142") === "tel:3095550142");
check("leading + is kept (E.164)", telHref("+1 309 555 0142") === "tel:+13095550142");
check("a + mid-string is not kept", telHref("309+555") === "tel:309555");
// The misdial guard: an extension must NOT become more digits of the number.
// Without the cut, each of these dials a 12-digit number that isn't the person.
check("'x12' extension is cut", telHref("(309) 555-0142 x12") === "tel:3095550142");
check("'ext. 203' is cut", telHref("309-555-0142 ext. 203") === "tel:3095550142");
check("'extension 5' is cut", telHref("3095550142 extension 5") === "tel:3095550142");
check("an extension on an E.164 number keeps the +", telHref("+1 309 555 0142 x9") === "tel:+13095550142");
check("a trailing note after a comma is cut", telHref("3095550142, ask for Dale") === "tel:3095550142");
check("a note after a semicolon is cut", telHref("3095550142; home") === "tel:3095550142");
// An 'x' that isn't an extension marker must not truncate a real number.
check("a bare 'x' with no digits after it does not cut", telHref("3095550142x") === "tel:3095550142");
check("extension-only value → no link", telHref("x12") === null);
check("no digits → no link", telHref("ask Susan") === null);
check("empty → no link", telHref("   ") === null);

// --- mailtoHref --------------------------------------------------------------
check("plain address", mailtoHref("tyler@bethanycentral.org") === "mailto:tyler@bethanycentral.org");
check("surrounding space is trimmed", mailtoHref("  a@b.co  ") === "mailto:a@b.co");
check("no @ → no link", mailtoHref("not an address") === null);
check("no dot in domain → no link", mailtoHref("a@localhost") === null);
check("inner space → no link", mailtoHref("a b@c.co") === null);

// --- urlHref (unchanged behavior, now shared) --------------------------------
check("bare host gets https://", urlHref("example.org") === "https://example.org");
check("an existing scheme passes through", urlHref("http://example.org") === "http://example.org");
check("a non-web scheme passes through", urlHref("obsidian://open?vault=x") === "obsidian://open?vault=x");

// --- contactLink: the declared kind wins ------------------------------------
{
  const l = contactLink("phone", "anything_at_all", "(309) 555-0142");
  check("phone kind links regardless of key name", l?.href === "tel:3095550142" && l?.title === "Call");
}
{
  const l = contactLink("email", "contact_line", "a@b.co");
  check("email kind links regardless of key name", l?.href === "mailto:a@b.co" && l?.title === "Send email");
}
check("phone kind holding no digits gets no link", contactLink("phone", "mobile", "n/a") === null);
check("email kind holding a non-address gets no link", contactLink("email", "email", "ask him") === null);
check("a non-string value never links", contactLink("phone", "mobile", 3095550142 as unknown) === null);
check("an unrelated kind never links", contactLink("number", "count", "5") === null);
{
  const l = contactLink("url", "site", "example.org");
  check("url kind still links out", l?.href === "https://example.org" && l?.external === true);
}
check("tel/mailto are not marked external", contactLink("phone", "m", "3095550142")?.external === false);

// --- The legacy `text` heuristic still works (back-compat) -------------------
check("legacy text keyed 'phone'", contactLink("text", "phone", "309-555-0142")?.href === "tel:3095550142");
check("legacy text keyed 'mobile'", contactLink("text", "mobile", "3095550142")?.href === "tel:3095550142");
check("legacy text keyed 'cell'", contactLink("text", "cell_number", "3095550142")?.href === "tel:3095550142");
check("legacy text keyed 'email'", contactLink("text", "email", "a@b.co")?.href === "mailto:a@b.co");
check("legacy text keyed 'e-mail'", contactLink("text", "e-mail", "a@b.co")?.href === "mailto:a@b.co");
check("an address in an oddly-keyed text field is still recognized", contactLink("text", "notes", "a@b.co")?.href === "mailto:a@b.co");
// The gap the kinds exist to close: a phone in a text field named nothing
// phone-like gets NO link. Asserted so the motivation stays visible.
check("a phone in an unrecognized text key gets no link (why the kind exists)", contactLink("text", "contact_line", "309-555-0142") === null);
check("ordinary prose never links", contactLink("text", "bio", "He lives in Peoria") === null);

check("legacyTextIntent: phone key", legacyTextIntent("mobile", "3095550142") === "phone");
check("legacyTextIntent: email shape", legacyTextIntent("whatever", "a@b.co") === "email");
check("legacyTextIntent: nothing", legacyTextIntent("bio", "hello") === null);

// --- Input type / on-screen keyboard ----------------------------------------
check("phone kind → tel input", contactInputType("phone", "x")?.type === "tel");
check("email kind → email input", contactInputType("email", "x")?.type === "email");
check("legacy text keyed phone → tel input", contactInputType("text", "mobile")?.inputMode === "tel");
check("legacy text keyed email → email input", contactInputType("text", "work_email")?.inputMode === "email");
check("ordinary text keeps the textarea (null)", contactInputType("text", "bio") === null);
check("a url field is not a contact input", contactInputType("url", "site") === null);

// --- Filtering ---------------------------------------------------------------
{
  const ops = opsForKind("phone");
  check("phone filters as text (contains/eq/neq/set/empty)", ops.includes("contains") && ops.includes("set") && ops.includes("empty") && !ops.includes("gt"));
  check("email filters the same as phone", JSON.stringify(opsForKind("email")) === JSON.stringify(ops));
}

// --- Structural: every kind menu offers both, one module owns the rules ------
for (const file of [
  "src/components/build/TypeBuilder.tsx",
  "src/components/build/StructureBuilder.tsx",
]) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  check(`${file} offers the phone kind`, /kind:\s*"phone"/.test(src));
  check(`${file} offers the email kind`, /kind:\s*"email"/.test(src));
}

{
  const src = readFileSync(new URL("../src/components/build/CustomProperties.tsx", import.meta.url), "utf8");
  check("CustomProperties imports the shared helper", /from "@\/lib\/contact-links"/.test(src));
  check("CustomProperties renders a control for phone/email", /case "phone":/.test(src) && /case "email":/.test(src));
  check("CustomProperties lets an empty phone/email recede", /RECEDE_KINDS[\s\S]{0,120}"phone"[\s\S]{0,40}"email"/.test(src));
  // The whole point of extracting contact-links.ts: no second copy of the
  // tel:/mailto: rules anywhere. A regressing edit would re-inline them.
  check("CustomProperties does not hand-roll a tel: href", !/`tel:\$\{/.test(src) && !/"tel:"/.test(src));
  check("CustomProperties does not hand-roll a mailto: href", !/`mailto:\$\{/.test(src));
}

{
  const src = readFileSync(new URL("../src/components/views/ViewRenderer.tsx", import.meta.url), "utf8");
  check("ViewRenderer takes propertyKinds", /propertyKinds\?:\s*Record<string, string>/.test(src));
  check("ViewRenderer links a phone/email cell via the shared helper", /contactLink\(/.test(src));
  // Table layout only, on purpose: the compact row is itself wrapped in a Link
  // to the item, and an anchor inside an anchor is invalid HTML that would also
  // steal the row tap. columnCell must therefore appear exactly twice — its
  // definition and the one table call. A third occurrence means some other
  // layout started rendering links; this fails and points at the comment.
  const uses = src.match(/columnCell\(/g)?.length ?? 0;
  check("columnCell is used by the table layout only", uses === 2, `${uses} occurrences`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("All checks passed.");
