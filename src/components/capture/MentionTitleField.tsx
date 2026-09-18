// The capture title as an "@-mention" field: a plain textarea where typing "@"
// opens a live item picker (any type, "/type" to narrow), and picking an item
// CONSUMES the "@query" text out of the title and drops the item into a "Linked"
// chip row below. Resolved links leave the text immediately (no strip-on-save
// guesswork); an "@" you never resolve stays literal. The parent turns each chip
// into a real `related` relation on save.
//
// Search + token logic live in useMentionTypeahead (headless); the popup + chips
// are the shared mention-ui pieces (also used by the task-add card). This file
// wires them to a plain textarea and owns the keyboard selection + consume.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  consumeMentionText,
  detectMentionToken,
  useMentionTypeahead,
  type MentionHit,
} from "./useMentionTypeahead";
import { LinkedChips, MentionPopup, useTypeGlyphs, type LinkedItem } from "./mention-ui";
import {
  createMentionTarget,
  createTargets,
  type CreateTarget,
} from "@/lib/mention-create";
import { loadTypes, type TypeMeta } from "@/components/search/type-token";
import { announceFloatingOpen } from "@/lib/floating";

export type { LinkedItem };

export default function MentionTitleField({
  value,
  onChange,
  linked,
  onLinkedChange,
  placeholder = "Capture…",
  autoFocus = true,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  linked: LinkedItem[];
  onLinkedChange: (items: LinkedItem[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  // Enter when the picker is closed = submit (a title has no newlines). While
  // the picker is open, Enter picks the selected row instead.
  onEnter?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { glyph, typeLabel } = useTypeGlyphs();
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [creating, setCreating] = useState(false);
  // The rawQuery an Escape / blur dismissed at: the popup stays shut until the
  // user types again (any keystroke clears it), mirroring the editor.
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  // The type registry, for the create-on-miss rows (which types a bare name can
  // be created as). Memoized in type-token, so this is one shared fetch.
  const [types, setTypes] = useState<TypeMeta[]>([]);
  useEffect(() => {
    void loadTypes().then(setTypes);
  }, []);

  const active = useMemo(() => detectMentionToken(value, caret), [value, caret]);
  const { hits, typeFilter, query } = useMentionTypeahead(active);

  const alreadyLinked = (id: string) => linked.some((l) => l.id === id);
  const visibleHits = hits.filter((h) => !alreadyLinked(h.id));
  // Create-on-miss (parity with the editor): offer it when there's a non-empty
  // query with no exact title match among the hits. One row per type it could be
  // (lib/mention-create.ts) — a scoped "@/person Jane" yields exactly one.
  const showCreate =
    query !== "" &&
    !hits.some((h) => h.title.trim().toLowerCase() === query.toLowerCase());
  const targets = useMemo(
    () => (showCreate ? createTargets(types, typeFilter) : []),
    [showCreate, types, typeFilter]
  );
  const rowCount = visibleHits.length + targets.length;

  const dismissed = active != null && dismissedQuery === active.rawQuery;
  const open = active != null && !dismissed && rowCount > 0;
  const sel = Math.min(selected, Math.max(0, rowCount - 1));

  // Close any other open floating panel when this typeahead appears. Announced on
  // the OPEN transition only, so it doesn't re-fire per keystroke.
  useEffect(() => {
    if (open) announceFloatingOpen("capture-mention");
  }, [open]);

  // A latest-state ref for the once-registered Escape listener below, kept fresh
  // in an effect (never written during render).
  const escRef = useRef({ open, rawQuery: active?.rawQuery ?? null });
  useEffect(() => {
    escRef.current = { open, rawQuery: active?.rawQuery ?? null };
  }, [open, active]);

  // Escape closes only the popup, not the modal. The modal listens on document
  // in the capture phase; child effects register before parent effects, so this
  // capture-phase listener (registered once, never re-subscribed) stays ahead of
  // the modal's and stops it firing while the popup is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && escRef.current.open) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDismissedQuery(escRef.current.rawQuery);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  function syncCaret() {
    const el = ref.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }

  function link(item: MentionHit | LinkedItem) {
    if (!active) return;
    if (!alreadyLinked(item.id)) {
      onLinkedChange([...linked, { id: item.id, title: item.title, type: item.type }]);
    }
    const { text, caret: nextCaret } = consumeMentionText(value, active.start, caret);
    onChange(text);
    setDismissedQuery(null);
    setSelected(0);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
        setCaret(nextCaret);
      }
    });
  }

  // Create the item as the picked type, then link it like any other hit. A null
  // return means the POST failed: the "@query" text stays put so it isn't lost
  // and the user can retry.
  async function createAndLink(target: CreateTarget) {
    if (creating || !query) return;
    setCreating(true);
    const made = await createMentionTarget(query, target);
    setCreating(false);
    if (made) link({ id: made.id, title: made.title, type: made.type });
  }

  function pickSelected() {
    if (sel < visibleHits.length) link(visibleHits[sel]);
    else {
      const target = targets[sel - visibleHits.length];
      if (target) void createAndLink(target);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((sel + 1) % rowCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((sel - 1 + rowCount) % rowCount);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        pickSelected();
        return;
      }
      // Escape is handled by the capture-phase document listener above.
    }
    if (!open && e.key === "Enter") {
      e.preventDefault();
      onEnter?.();
    }
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="relative">
        <textarea
          ref={ref}
          rows={1}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
            setSelected(0);
            setDismissedQuery(null);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onBlur={() => setDismissedQuery(active?.rawQuery ?? null)}
          placeholder={placeholder}
          aria-label="Title"
          className="min-w-0 w-full resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-base font-medium leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        {open && (
          <MentionPopup
            hits={visibleHits}
            selected={sel}
            createTargets={targets}
            creating={creating}
            query={query}
            typeFilter={typeFilter}
            onHover={setSelected}
            onPick={link}
            onCreate={(target) => void createAndLink(target)}
            glyph={glyph}
            typeLabel={typeLabel}
          />
        )}
      </div>
      <LinkedChips linked={linked} onRemove={(id) => onLinkedChange(linked.filter((l) => l.id !== id))} glyph={glyph} />
    </div>
  );
}
