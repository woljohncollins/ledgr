// Stable attachment addresses (ADR-228). Pure + client-safe on purpose: it has
// no DB or storage import, so client components and the pure-string helpers can
// use it. The DB-touching attachment code lives in ./attachments and re-exports
// these.
//
// What goes INTO an item body (or a person's `image` property) is the app-relative
// address below, never the storage provider's own URL. `/files/<id>` redirects to
// wherever the bytes currently live (src/app/files/[id]/route.ts), so changing
// R2_PUBLIC_BASE_URL — an r2.dev URL to a custom domain, or R2 to another
// provider entirely — is an env change with no body rewrite. Baking the provider
// URL in was the real lock-in: it made every stored body a copy of the storage
// decision.
//
// RELATIVE on purpose. An absolute URL would pin the body to one install, and
// bodies sync between the local and cloud installs.

// A v4-ish uuid, loose enough for any uuid we mint.
const UUID = "[0-9a-f]{8}-[0-9a-f-]{27}";

export function attachmentUrl(id: string): string {
  return `/files/${id}`;
}

// A provider public URL for an attachment has the shape
// `<base>/<ownerId>/<attachmentId>/<filename>` (see the storageKey built in
// reserveAttachment), so the attachment id is recoverable from the URL itself.
// Base-agnostic by design: it must keep matching after the public base changes,
// which is the whole point of the indirection.
const PROVIDER_URL = new RegExp(`^https?://[^/]+/${UUID}/(${UUID})/[^?#]*$`, "i");

// Same shape, but scanning for URLs EMBEDDED in body text, where they are
// bounded by markdown/HTML punctuation rather than by the ends of the string.
// Kept beside PROVIDER_URL so the two can't drift apart.
const PROVIDER_URL_IN_TEXT = new RegExp(
  `https?://[^\\s)"'<>]+/${UUID}/(${UUID})/[^\\s)"'<>]*`,
  "gi"
);

const STABLE_URL = new RegExp(`^/files/(${UUID})$`, "i");

// Normalize a provider URL to the stable address; anything else passes through
// untouched (an externally hosted image is a legitimate body URL). Used at embed
// time so a caller handing us a provider URL still stores the stable one, and by
// the one-time migration in scripts/migrate-attachment-urls.mts.
export function stableAttachmentUrl(url: string): string {
  const m = PROVIDER_URL.exec(url.trim());
  return m ? attachmentUrl(m[1].toLowerCase()) : url;
}

// The inverse: the attachment id in a stable address, or null for any other URL.
// A stable address carries no filename and no extension, so anything that used
// to read those off a provider URL (is this an image? what do I label it?) has
// to resolve them from the row instead — see getAttachment.
export function parseAttachmentUrl(url: string): string | null {
  const m = STABLE_URL.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

// The query parameter that lets an ANONYMOUS viewer read an attachment
// (ADR-231). The bucket is private and /files/<id> normally requires the
// owner's session, but a share link has no session — so the share render
// rewrites each address to carry the link's own token, and the route grants
// access only if that token is live and belongs to the attachment's PARENT
// item. Revoking the share therefore revokes its files in the same act, and a
// token for one item can't read another item's attachments.
export const SHARE_PARAM = "s";

// A stable address embedded in body text. Mirrors STABLE_URL (anchored) the way
// PROVIDER_URL_IN_TEXT mirrors PROVIDER_URL, and is kept beside it so the two
// can't drift. The negative lookahead skips an address that already carries a
// query, so re-running this is a no-op rather than appending a second token.
const STABLE_URL_IN_TEXT = new RegExp(`/files/(${UUID})(?!\\?)`, "gi");

export function attachmentUrlWithShare(id: string, token: string): string {
  return `${attachmentUrl(id)}?${SHARE_PARAM}=${encodeURIComponent(token)}`;
}

// Rewrite every stable address in a block of text so it carries `token`. Pure,
// so the share render can do this on the way out without touching what is
// stored: the body in the database keeps the plain, token-free address.
export function addShareTokenToAttachmentUrls(text: string, token: string): string {
  return text.replace(STABLE_URL_IN_TEXT, (_whole, id: string) =>
    attachmentUrlWithShare(id.toLowerCase(), token)
  );
}

// Rewrite every provider URL in a block of text to its stable address. Used by
// the one-time migration.
//
// `isKnownId` gates each replacement against the real attachment ids, so a URL
// that merely resembles the shape is left alone rather than rewritten into an
// address that would 404. Returns the new text and how many URLs changed.
export function rewriteProviderUrlsInText(
  text: string,
  isKnownId: (id: string) => boolean
): { text: string; rewritten: number } {
  let rewritten = 0;
  const out = text.replace(PROVIDER_URL_IN_TEXT, (whole, id: string) => {
    if (!isKnownId(id.toLowerCase())) return whole;
    rewritten += 1;
    return attachmentUrl(id.toLowerCase());
  });
  return { text: out, rewritten };
}
