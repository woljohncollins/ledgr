// Cold-share fix (ADR-191) verification: the pure helpers behind the anonymous
// share-target path — claim-query building and stash-id validation. No DB, no
// server; just the two functions that keep this route from ever reading an
// arbitrary storage key or losing an empty share.
// Run: npx tsx scripts/verify-share-claim.mts
import { buildClaimQuery } from "../src/app/capture/share/route";
import { shareRedirectBase } from "../src/lib/capture/share";
import { isValidStashId } from "../src/app/capture/share/claim/route";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- buildClaimQuery -------------------------------------------------------
check(
  "encodes and joins title/text/url",
  buildClaimQuery({ title: "Hi there", text: "body", url: "https://a.b/c" }) ===
    "title=Hi+there&text=body&url=https%3A%2F%2Fa.b%2Fc"
);
check("omits empty fields", buildClaimQuery({ title: "only this" }) === "title=only+this");
check("all-empty share yields an empty query", buildClaimQuery({}) === "");
check(
  "a long text share is still valid query syntax (caller decides the size fallback)",
  new URLSearchParams(buildClaimQuery({ text: "x".repeat(10_000) })).get("text")?.length === 10_000
);

// --- redirectBase ----------------------------------------------------------
// The mobile-share bug: request.url reads back as localhost:3000 behind
// Vercel's proxy, so every 303 pointed the share sheet at a dead URL.
const req = (headers: Record<string, string>) =>
  new Request("http://localhost:3000/capture/share", { headers });
check(
  "forwarded host wins over request.url",
  shareRedirectBase(req({ "x-forwarded-host": "ledgr.example.com", "x-forwarded-proto": "https" })) ===
    "https://ledgr.example.com"
);
check(
  "plain host header works too, keeping the request's own scheme (no proxy)",
  shareRedirectBase(req({ host: "ledgr.example.com" })) === "http://ledgr.example.com"
);
check(
  "localhost stays http (dev)",
  shareRedirectBase(req({ host: "localhost:3100" })) === "http://localhost:3100"
);
check(
  "a local install on a tailnet address stays http, not https",
  shareRedirectBase(req({ host: "ledgr-pc.tail1234.ts.net:3000" })) ===
    "http://ledgr-pc.tail1234.ts.net:3000"
);
check(
  "a proxy's forwarded-proto list takes its first entry",
  shareRedirectBase(req({ "x-forwarded-host": "a.b", "x-forwarded-proto": "https, http" })) ===
    "https://a.b"
);
check(
  "no headers at all falls back to the request origin, never an empty base",
  shareRedirectBase(req({})) === "http://localhost:3000"
);

// --- isValidStashId ---------------------------------------------------------
check("accepts a real UUID", isValidStashId(crypto.randomUUID()));
check("rejects null", !isValidStashId(null));
check("rejects the empty string", !isValidStashId(""));
check("rejects a path-traversal attempt", !isValidStashId("../../etc/passwd"));
check("rejects a key with the stash prefix baked in", !isValidStashId("share-stash/abc.json"));
check("rejects a near-miss UUID (wrong grouping)", !isValidStashId("123e4567e89b12d3a456426614174000"));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
