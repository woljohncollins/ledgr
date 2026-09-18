// Pure checks for the private-attachment share path (ADR-231). No DB, no
// network: this is the string glue that decides whether an anonymous reader of
// a share page can see its images, so it is worth pinning exactly.
import {
  SHARE_PARAM,
  attachmentUrl,
  attachmentUrlWithShare,
  addShareTokenToAttachmentUrls,
} from "../src/lib/attachment-url";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const ID = "3f1a2b4c-5d6e-4f70-8123-456789abcdef";
const ID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TOK = "abc123_-XYZ";

console.log("\n# the address a share link hands out");
check("param is 's'", SHARE_PARAM === "s");
check("plain address is unchanged", attachmentUrl(ID) === `/files/${ID}`);
check(
  "share address carries the token",
  attachmentUrlWithShare(ID, TOK) === `/files/${ID}?s=${TOK}`,
  attachmentUrlWithShare(ID, TOK)
);
check(
  "a token needing encoding is encoded",
  attachmentUrlWithShare(ID, "a+b/c=") === `/files/${ID}?s=a%2Bb%2Fc%3D`,
  attachmentUrlWithShare(ID, "a+b/c=")
);

console.log("\n# rewriting a body on the way out");
check(
  "an image embed is rewritten",
  addShareTokenToAttachmentUrls(`![scan](/files/${ID})`, TOK) === `![scan](/files/${ID}?s=${TOK})`
);
check(
  "a file link is rewritten",
  addShareTokenToAttachmentUrls(`[deed](/files/${ID})`, TOK) === `[deed](/files/${ID}?s=${TOK})`
);
check(
  "every address in the body is rewritten, not just the first",
  addShareTokenToAttachmentUrls(`![a](/files/${ID}) and ![b](/files/${ID2})`, TOK) ===
    `![a](/files/${ID}?s=${TOK}) and ![b](/files/${ID2}?s=${TOK})`
);
check(
  "an externally hosted image is left alone",
  addShareTokenToAttachmentUrls("![x](https://example.com/cat.png)", TOK) ===
    "![x](https://example.com/cat.png)"
);
check(
  "a non-uuid /files path is left alone",
  addShareTokenToAttachmentUrls("[x](/files/readme)", TOK) === "[x](/files/readme)"
);
check(
  "re-running is a no-op (no second token appended)",
  addShareTokenToAttachmentUrls(addShareTokenToAttachmentUrls(`![a](/files/${ID})`, TOK), TOK) ===
    `![a](/files/${ID}?s=${TOK})`
);
check(
  "an unrelated query on a /files address is not double-tokened",
  addShareTokenToAttachmentUrls(`![a](/files/${ID}?x=1)`, TOK) === `![a](/files/${ID}?x=1)`
);
check(
  "text with no attachments is untouched",
  addShareTokenToAttachmentUrls("# Title\n\nplain body", TOK) === "# Title\n\nplain body"
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
