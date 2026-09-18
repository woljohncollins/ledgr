// Validates any image-kind property's value (originally the person's built-in
// `image` url field, migration 0053 / ADR-202 addendum 3; generalized to any
// image-kind property, ADR-255). Pure + client-safe. Only a real image
// address counts — anything else (a stray string, a data: URI someone pasted)
// falls back to the avatar's initials/glyph rather than a broken <img>.
//
// Two shapes are real: an http(s) URL (an image hosted anywhere, including a
// pasted one), and a stable /files/<id> attachment address (ADR-228), which is
// what an uploaded picture now stores. Accepting only http(s) here is what made
// every uploaded avatar silently fall back to initials the moment uploads
// started storing the relative address.
import { parseAttachmentUrl } from "./attachment-url";

export function imageUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (/^https?:\/\//i.test(v)) return v;
  return parseAttachmentUrl(v) ? v : null;
}

export function personImage(properties: unknown): string | null {
  return imageUrl((properties as Record<string, unknown> | null | undefined)?.image);
}
