// Headless "@-mention" typeahead for a plain <textarea> (the capture title).
// The rich body editor already has this over Tiptap (mention-suggestion.ts); a
// textarea can't use that ProseMirror machinery, so this hook re-implements the
// same behavior with no DOM and no dependency: given the field's current value +
// caret it finds the active "@token", runs the same debounced /api/items search
// (with "/type" narrowing via the shared type-token helpers), and hands back the
// hits. The consuming component owns the popup, keyboard selection, and chips.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trailingAnchor } from "@/lib/editor/block-anchor";
import {
  loadTypes,
  parseTypeToken,
  type TypeMeta,
} from "@/components/search/type-token";

export type MentionHit = { id: string; title: string; type: string | null };

// The "@…" the caret is sitting in, or null when the caret isn't in a mention.
export type ActiveMention = { start: number; rawQuery: string };

// Find an active "@mention" token that ends at the caret. Rules mirror the
// editor's suggestion: "@" only starts a mention at the string start or right
// after whitespace ("email a@b" is not a mention), a newline ends it, and a
// leading space ("@ 3pm") means the "@" is literal text, not a mention. Spaces
// *inside* the query are allowed so multi-word titles ("@Elder Board") stay
// typeable — the token grows until the row is picked or the popup dismissed.
export function detectMentionToken(
  value: string,
  caret: number
): ActiveMention | null {
  const upto = value.slice(0, Math.max(0, caret));
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(value[at - 1])) return null;
  const rawQuery = upto.slice(at + 1);
  if (rawQuery.includes("\n")) return null;
  if (rawQuery.startsWith(" ")) return null; // "@ …" — literal @, not a mention
  // A trailing block anchor ends the token, the way a newline does: with the
  // caret parked after "@Roger-Tester ^1nr6v7" the user is at the end of the
  // line, not editing the mention — and the anchor would otherwise ride into
  // the query and offer to create an item literally named after it.
  if (trailingAnchor(rawQuery)) return null;
  return { start: at, rawQuery };
}

// Remove the consumed "@query" span from the value and return the tidied text +
// where the caret should land, collapsing the seam so we never leave a double
// space or a stray leading/trailing space at the join.
export function consumeMentionText(
  value: string,
  start: number,
  caret: number
): { text: string; caret: number } {
  const before = value.slice(0, start).replace(/\s+$/, "");
  const after = value.slice(caret).replace(/^\s+/, "");
  if (before && after) return { text: `${before} ${after}`, caret: before.length + 1 };
  return { text: before + after, caret: before.length };
}

// Debounced item search for the active token. `active` is null when the caret
// isn't in a mention (the caller then keeps the popup closed). Returns the hits,
// the resolved "/type" filter (for a header chip), and the post-token query text
// (what the create-on-miss row and an exact-match check use).
export function useMentionTypeahead(active: ActiveMention | null): {
  hits: MentionHit[];
  typeFilter: TypeMeta | null;
  query: string;
} {
  const [types, setTypes] = useState<TypeMeta[]>([]);
  const [hits, setHits] = useState<MentionHit[]>([]);
  // A monotonic request id so a slow response can't overwrite a newer one.
  const reqId = useRef(0);

  useEffect(() => {
    void loadTypes().then(setTypes);
  }, []);

  const raw = active?.rawQuery ?? "";
  const parsed = useMemo(
    () => (active ? parseTypeToken(raw, types) : null),
    [active, raw, types]
  );
  const query = (parsed ? parsed.rest : raw).trim();
  const typeFilter = parsed?.type ?? null;

  useEffect(() => {
    if (!active) return; // caller ignores hits when inactive (derived below)
    const id = ++reqId.current;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: "8" });
        if (query) params.set("q", query);
        if (typeFilter) params.set("type", typeFilter.key);
        const res = await fetch(`/api/items?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as {
          items: { id: string; title?: string; type?: string | null }[];
        };
        if (id !== reqId.current) return; // a newer keystroke already fired
        setHits(
          data.items.map((it) => ({
            id: it.id,
            title: it.title || "Untitled",
            type: it.type ?? null,
          }))
        );
      } catch {
        // aborted or offline; the next keystroke retries
      }
    }, 200);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [active, query, typeFilter]);

  // Derived, so the effect never clears state synchronously: an inactive token
  // simply yields no hits without a setState round-trip.
  return { hits: active ? hits : [], typeFilter, query };
}
