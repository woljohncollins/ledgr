// Plain-text extraction from a body, maintained by app code on every save so
// the generated tsvector indexes real words, not markup (ADR-003). The body is
// canonical markdown now (ADR-037/ADR-040): pull its text and strip it through
// markdownToText, which drops markup, ledgr:// URIs, and color hexes while
// keeping prose, mention labels, and code text.
import { bodyMarkdown, isItemBody } from "@/lib/body";
import { CHORDPRO_FORMAT } from "@/lib/chordpro/types";
import { chordProToText } from "@/lib/chordpro/render-text";
import { markdownToText } from "@/lib/markdown-render";

// The canvas Notes tab (papers + songs) writes markdown to properties.notes
// rather than to the body, because those types spend their body on something
// else — a ChordPro chart, a paper's canonical draft. Nothing else in the app
// indexes properties, so folding the notes in here is what keeps them
// searchable: a song idea scribbled in Notes has to come back from search like
// any other note, or the tab is a drawer things fall into.
export function notesMarkdown(properties: unknown): string {
  const notes = (properties as Record<string, unknown> | null)?.notes;
  return typeof notes === "string" ? notes : "";
}

// Returns null for an empty/absent body so body_text stays NULL (and the
// tsvector coalesces it away) instead of storing empty strings. Branches on the
// body's own format tag (the first real consumer of the M6 format dimension): a
// chordpro body indexes lyrics only (chords/directives stripped); everything
// else stays on the markdown path, unchanged.
export function extractBodyText(
  body: unknown,
  properties?: unknown
): string | null {
  const text =
    isItemBody(body) && body.format === CHORDPRO_FORMAT
      ? chordProToText(body.text)
      : markdownToText(bodyMarkdown(body));
  const notes = markdownToText(notesMarkdown(properties));
  const joined = [text, notes].filter((s) => s.length > 0).join("\n\n");
  return joined.length > 0 ? joined : null;
}
