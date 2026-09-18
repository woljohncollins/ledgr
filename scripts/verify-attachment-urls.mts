// Checks the stable-attachment-address glue (ADR-228): provider URL -> /files/<id>,
// the body-text rewrite the one-time migration runs on, and the export's rewrite
// to relative paths that keeps the OneDrive tree offline-usable.
//
//   npx tsx scripts/verify-attachment-urls.mts
//
// Pure functions only, no DB and no network.
import {
  attachmentUrl,
  parseAttachmentUrl,
  rewriteProviderUrlsInText,
  stableAttachmentUrl,
} from "../src/lib/attachment-url";
import { personImage } from "../src/lib/person-image";
import { rewriteAttachmentPaths } from "../src/lib/export/engine";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const OWNER = "11111111-1111-1111-1111-111111111111";
const ATT = "22222222-2222-2222-2222-222222222222";
const R2 = `https://pub-abc123.r2.dev/${OWNER}/${ATT}/image1.png`;
const CUSTOM = `https://files.example.org/${OWNER}/${ATT}/image1.png`;

console.log("# stableAttachmentUrl");
check("an r2.dev provider URL becomes the stable address", stableAttachmentUrl(R2) === attachmentUrl(ATT), stableAttachmentUrl(R2));
// The base-agnostic match is the point: after the custom-domain move, URLs
// already stored under the OLD base must still normalize.
check("a custom-domain provider URL also normalizes", stableAttachmentUrl(CUSTOM) === attachmentUrl(ATT));
check("an already-stable address is unchanged", stableAttachmentUrl("/files/" + ATT) === "/files/" + ATT);
check("an unrelated external image is untouched", stableAttachmentUrl("https://example.org/logo.png") === "https://example.org/logo.png");
check("a URL with only one uuid segment is untouched", stableAttachmentUrl(`https://x.r2.dev/${OWNER}/logo.png`) === `https://x.r2.dev/${OWNER}/logo.png`);

console.log("\n# parseAttachmentUrl");
check("reads the id back out", parseAttachmentUrl(attachmentUrl(ATT)) === ATT);
check("rejects a provider URL", parseAttachmentUrl(R2) === null);
check("rejects a non-attachment path", parseAttachmentUrl("/files/nope") === null);

console.log("\n# rewriteProviderUrlsInText (the migration)");
const known = (id: string) => id === ATT;
const body = [
  `![a photo](${R2})`,
  `and a [file link](${R2}) inline`,
  `<img src="${R2}" alt="html">`,
  `an unrelated https://example.org/pic.png stays`,
].join("\n\n");
const out = rewriteProviderUrlsInText(body, known);
check("rewrites every occurrence", out.rewritten === 3, `rewritten=${out.rewritten}`);
check("markdown image survives", out.text.includes(`![a photo](/files/${ATT})`));
check("markdown link survives", out.text.includes(`[file link](/files/${ATT})`));
check("html src survives", out.text.includes(`<img src="/files/${ATT}"`));
check("the external URL is left alone", out.text.includes("https://example.org/pic.png"));
check("no provider URL remains", !out.text.includes("r2.dev"));
// Guards the reason isKnownId exists: a URL of the right SHAPE whose row is gone
// must be left alone, not rewritten into an address that would 404.
const orphan = rewriteProviderUrlsInText(R2, () => false);
check("an unknown attachment id is skipped", orphan.rewritten === 0 && orphan.text === R2);
check("running twice changes nothing more", rewriteProviderUrlsInText(out.text, known).rewritten === 0);

console.log("\n# rewriteAttachmentPaths (the export)");
const path = `_attachments/33333333-3333-3333-3333-333333333333/${ATT.slice(0, 8)}-image1.png`;
const live = rewriteAttachmentPaths(`![a](/files/${ATT})`, "note/2026/x-1234abcd.md", [path]);
check("a live item climbs two levels", live === `![a](../../${path})`, live);
const archived = rewriteAttachmentPaths(`![a](/files/${ATT})`, "_archive/note/2026/x-1234abcd.md", [path]);
check("an archived item climbs three", archived === `![a](../../../${path})`, archived);
check("a body with no attachments is untouched", rewriteAttachmentPaths("plain text", "note/2026/x.md", []) === "plain text");
check(
  "an address with no exported copy is left as-is",
  rewriteAttachmentPaths(`![a](/files/${OWNER})`, "note/2026/x.md", [path]) === `![a](/files/${OWNER})`
);

// personImage gates what an avatar will render. It accepted only http(s), so
// once uploads started storing the stable address every uploaded avatar would
// have silently fallen back to initials — the exact failure this guards.
console.log("\n# personImage accepts a stable address");
check("a stable /files address renders", personImage({ image: attachmentUrl(ATT) }) === attachmentUrl(ATT));
check("an http URL still renders", personImage({ image: "https://example.org/p.jpg" }) === "https://example.org/p.jpg");
check("a data: URI is still refused", personImage({ image: "data:image/png;base64,AAA" }) === null);
check("a stray string is still refused", personImage({ image: "/files/nope" }) === null);
check("no image property", personImage({}) === null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
