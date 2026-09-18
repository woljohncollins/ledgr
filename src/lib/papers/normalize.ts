// Runtime healing for the paper scaffold (Tyler, 2026-09-16).
//
// `items.properties` is untyped JSON, so `sections` and `quoteBank` arrive as
// whatever a writer put there. The canvas used to take them on trust
// (`props.sections as OutlineSection[]` — a compile-time cast that checks
// nothing at runtime), and every renderer then reaches straight into the shape:
// `s.paragraphs.map(...)` in ShapeTab, OutlineTab, QuoteBank and
// `lib/papers/outline.ts`. A section written without a `paragraphs` array throws
// on the first render, which does not degrade the tab: it takes the whole record
// down, and the owner simply cannot open their paper.
//
// That is exactly what happened when an agent wrote the scaffold over MCP by
// guessing its shape (`{title, body}` for a section, `{quote, source, citation,
// note}` for a quote). The guesses were wrong, nothing rejected them, and the
// paper became unopenable.
//
// The rule here: a bad write may leave a surface EMPTY or ODD-LOOKING, never
// unopenable. So this coerces rather than validates, and it is deliberately
// LOSSLESS — every original key is preserved by spreading it first, and anything
// occupying a required slot in an unusable form is moved aside (to `note` /
// `sourceText`) rather than dropped. The writer can see what they wrote and fix
// it; nothing is silently deleted.
//
// Pure (no React, no DB), like the rest of lib/papers, so the verify script
// exercises the real function.
import type { OutlineParagraph, OutlineSection, QuoteEntry, Source } from "@/lib/papers/types";

// Crypto.randomUUID is available in every runtime this ships to (browser,
// node 18+, edge); the fallback keeps the function pure-callable in a bare test.
function uuid(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// An empty book source: the shape QuoteBank renders without complaint. Used when
// a quote arrived with no usable `source` object, so the row still draws.
function emptyBookSource(): Source {
  return {
    kind: "book",
    author: "",
    authorLast: "",
    title: "",
    shortTitle: "",
    city: "",
    publisher: "",
    year: "",
  };
}

// True when a value is already a usable Source (has the discriminant the
// citation engine switches on).
function isSource(v: unknown): v is Source {
  return isRecord(v) && (v.kind === "book" || v.kind === "video");
}

export type ScaffoldRepair = {
  sections: OutlineSection[];
  quotes: QuoteEntry[];
  // True when anything had to be healed, so the caller persists the repair
  // instead of leaving the record broken on disk.
  changed: boolean;
  // Human-readable notes on what was healed, for logging and for the verify
  // script. Never surfaced as an error: healing is not a failure.
  repairs: string[];
};

// Coerce one paragraph into a renderable OutlineParagraph.
function healParagraph(raw: unknown, repairs: string[]): OutlineParagraph {
  if (!isRecord(raw)) {
    repairs.push("paragraph was not an object; replaced with an empty one");
    return { id: uuid() };
  }
  const out: OutlineParagraph = { ...(raw as OutlineParagraph) };
  if (!asString(out.id)) {
    out.id = uuid();
    repairs.push("paragraph had no id");
  }
  return out;
}

// Coerce one section into a renderable OutlineSection. The `paragraphs` array is
// the load-bearing one: its absence is what crashes the canvas.
function healSection(raw: unknown, repairs: string[]): OutlineSection {
  if (!isRecord(raw)) {
    repairs.push("section was not an object; replaced with an empty one");
    return { id: uuid(), title: "", paragraphs: [{ id: uuid() }] };
  }
  const out = { ...raw } as Record<string, unknown>;

  if (!asString(out.id)) {
    out.id = uuid();
    repairs.push("section had no id");
  }
  if (typeof out.title !== "string") {
    out.title = asString(out.title) ?? "";
    repairs.push("section had no title");
  }
  // A stray `body` is the shape an agent guesses for "the section's prose". The
  // real field is `note`, so move it rather than leave it inert and invisible.
  if (out.body !== undefined && out.note === undefined) {
    const body = asString(out.body);
    if (body !== undefined) {
      out.note = body;
      delete out.body;
      repairs.push("section carried `body`; moved to `note`");
    }
  }
  if (!Array.isArray(out.paragraphs)) {
    out.paragraphs = [{ id: uuid() }];
    repairs.push("section had no paragraphs array (this is what made the record unopenable)");
  } else {
    out.paragraphs = (out.paragraphs as unknown[]).map((p) => healParagraph(p, repairs));
  }
  return out as unknown as OutlineSection;
}

// Coerce one quote-bank entry into a renderable QuoteEntry.
function healQuote(raw: unknown, repairs: string[]): QuoteEntry {
  if (!isRecord(raw)) {
    repairs.push("quote was not an object; replaced with an empty one");
    return { id: uuid(), text: "", source: emptyBookSource() };
  }
  const out = { ...raw } as Record<string, unknown>;

  if (!asString(out.id)) {
    out.id = uuid();
    repairs.push("quote had no id");
  }
  // `quote` is the shape an agent guesses for the quote text; the real key is
  // `text`. Move it rather than render an empty row over real content.
  if (typeof out.text !== "string") {
    const guessed = asString(out.quote);
    if (guessed !== undefined) {
      out.text = guessed;
      delete out.quote;
      repairs.push("quote carried `quote`; moved to `text`");
    } else {
      out.text = "";
      repairs.push("quote had no text");
    }
  }
  if (!isSource(out.source)) {
    // Preserve whatever was there (commonly a citation string) instead of
    // discarding it, then supply a source the renderer can draw.
    if (out.source !== undefined) {
      out.sourceText = out.source;
      repairs.push("quote's `source` was not a {kind:…} object; preserved as `sourceText`");
    } else {
      repairs.push("quote had no source");
    }
    out.source = emptyBookSource();
  }
  return out as unknown as QuoteEntry;
}

// Heal a whole scaffold. Safe to run on healthy data: it returns the same
// entries with `changed: false`, so a good paper is never rewritten.
export function healScaffold(props: Record<string, unknown>): ScaffoldRepair {
  const repairs: string[] = [];
  const rawSections = Array.isArray(props.sections) ? (props.sections as unknown[]) : [];
  const rawQuotes = Array.isArray(props.quoteBank) ? (props.quoteBank as unknown[]) : [];

  const sections = rawSections.map((s) => healSection(s, repairs));
  const quotes = rawQuotes.map((q) => healQuote(q, repairs));

  return { sections, quotes, changed: repairs.length > 0, repairs };
}
