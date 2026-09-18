// Turning a contact-shaped property value into a clickable target (ADR-192).
//
// One place, because two surfaces need the same answer and would otherwise drift:
// the editable panel on a record canvas (build/CustomProperties.tsx) and a
// property column in a list's table layout (views/ViewRenderer.tsx). Pure and
// dependency-free so a pure verify suite can cover it.
//
// The rule for the whole file: the STORED value is whatever the owner typed, and
// nothing here rewrites it. These functions only derive an href. A phone number
// is displayed verbatim — "(309) 555-0142 x12" stays exactly that on screen — and
// only the href is stripped down to what a dialer accepts.

// Values shaped enough like an address to be worth a mailto. Deliberately loose
// (one @, a dot in the domain): the strict grammar for an address is far larger
// than anyone wants here, and the cost of being wrong is one dead link, not lost
// data. Used for DISPLAY decisions only — never to reject input.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Where a dialable number stops and a human note begins. An extension MUST be
// cut before stripping punctuation, or "(309) 555-0142 x12" collapses to the
// 12-digit 309555014212 and misdials — the extension digits read as more of the
// number. The extension stays visible in the displayed text (nothing here
// rewrites what's stored), so the owner can enter it once the call connects.
// Encoding it as `,,12` (DTMF pause) was considered and rejected: pause support
// varies by dialer, and a wrong pause is a silent misdial too.
const EXT_TAIL_RE = /[\s.\-–]*(?:x|ext|extn|extension)\.?\s*\d+\s*$/i;

// A `tel:` href from a human-typed number. Keeps digits and a leading `+`
// (country code) and drops everything else — spaces, dots, dashes, parens — after
// cutting anything past a `,`/`;` and a trailing extension.
//
// Returns null when no digit survives, so a field holding "ask Susan" gets no
// link rather than a `tel:` to nowhere.
export function telHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // A comma or semicolon separates the number from whatever follows it
  // ("3095550142, ask for Dale"), so the number is everything before it.
  const dialable = trimmed.split(/[;,]/)[0].replace(EXT_TAIL_RE, "").trim();
  if (!dialable) return null;
  // A leading + is meaningful (E.164); a + anywhere else is not.
  const plus = dialable.startsWith("+") ? "+" : "";
  const digits = dialable.replace(/[^\d]/g, "");
  if (!digits) return null;
  return `tel:${plus}${digits}`;
}

// A `mailto:` href. Trim only — an address with spaces inside is malformed and
// gets no link, rather than being "fixed" into a different address.
export function mailtoHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !EMAIL_RE.test(trimmed)) return null;
  return `mailto:${trimmed}`;
}

// An `https://` href for a `url` property typed without a scheme. Anything that
// already carries a scheme (http:, https:, mailto:, tel:, obsidian:, …) passes
// through untouched.
export function urlHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// --- The legacy key heuristic -------------------------------------------------
// Before the `phone`/`email` kinds existed, a contact field was a `text` field
// and the intent was guessed from its KEY. Production data (Brandon's Notion
// import, Tyler's people) still holds such fields, and retyping them all is not
// something this change gets to require — so the guess stays, scoped to `text`
// only, as back-compat. A declared kind always wins over it.
//
// This is why the kinds are worth having: below, "mobile_2" gets a dialer and
// "contact_line" doesn't, for no reason the owner can see.
const PHONE_KEY_RE = /phone|mobile|\btel\b|cell/;
const EMAIL_KEY_RE = /e-?mail/;

export type ContactIntent = "phone" | "email" | null;

// What a `text` field's key suggests it holds. `value` is consulted only for the
// email case, where a plain address is recognizable on sight regardless of key.
export function legacyTextIntent(key: string, value: string): ContactIntent {
  const k = key.toLowerCase();
  if (EMAIL_KEY_RE.test(k) && EMAIL_RE.test(value.trim())) return "email";
  if (EMAIL_RE.test(value.trim())) return "email";
  if (PHONE_KEY_RE.test(k) && /\d/.test(value)) return "phone";
  return null;
}

export type ContactLink = { href: string; title: string; external: boolean };

// The clickable target for a property value, or null when nothing sensible
// applies (which is most fields). `kind` is the declared property kind; the
// legacy key heuristic applies only when that kind is `text`.
export function contactLink(
  kind: string,
  key: string,
  value: unknown
): ContactLink | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;

  // image stores the same plain string url does (ADR-228/ADR-255): same link.
  if (kind === "url" || kind === "image") {
    const href = urlHref(v);
    return href ? { href, title: "Open link", external: true } : null;
  }
  if (kind === "phone") {
    const href = telHref(v);
    return href ? { href, title: "Call", external: false } : null;
  }
  if (kind === "email") {
    const href = mailtoHref(v);
    return href ? { href, title: "Send email", external: false } : null;
  }
  if (kind === "text") {
    const intent = legacyTextIntent(key, v);
    if (intent === "email") {
      const href = mailtoHref(v);
      return href ? { href, title: "Send email", external: false } : null;
    }
    if (intent === "phone") {
      const href = telHref(v);
      return href ? { href, title: "Call", external: false } : null;
    }
  }
  return null;
}

// The input type / on-screen keyboard for a scalar text-ish field. `phone` and
// `email` get theirs from the declared kind; a legacy `text` field gets it from
// the key heuristic (and keeps the wrapping textarea when neither applies, which
// is what returning null means).
export function contactInputType(
  kind: string,
  key: string
): { type: "email" | "tel"; inputMode: "email" | "tel" } | null {
  if (kind === "phone") return { type: "tel", inputMode: "tel" };
  if (kind === "email") return { type: "email", inputMode: "email" };
  if (kind !== "text") return null;
  const k = key.toLowerCase();
  if (EMAIL_KEY_RE.test(k)) return { type: "email", inputMode: "email" };
  if (PHONE_KEY_RE.test(k)) return { type: "tel", inputMode: "tel" };
  return null;
}
