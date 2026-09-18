// The "@" mention suggestion: queries /api/items (server-side title match,
// same source the BlockNote editor used) and shows a small popup. Hand-rolled
// over Tiptap's suggestion lifecycle with a positioned <div> — no popup
// library, keeping the dependency count down (CLAUDE.md rule 5). The items
// returned are { id, label }, which Mention's default command maps straight
// onto the node's attrs.
//
// Create-on-miss: when the typed name matches nothing, the picker offers one
// TYPED create row per type it could be (person / project / Unsorted — see
// src/lib/mention-create.ts, which is also the shared POST) and inserts a mention
// to whichever is picked. The relation edge is NOT written here — mention edges
// are body-owned and diff-synced on save (src/lib/mentions.ts); inserting the
// mention node and letting the save create the edge keeps that contract.
"use client";

import type { MentionOptions } from "@tiptap/extension-mention";
import type { SuggestionProps } from "@tiptap/suggestion";
import { mentionGlyphSvg } from "@/lib/mention-glyph";
import {
  loadTypes,
  parseTypeToken,
  type TypeMeta,
} from "@/components/search/type-token";
import { formatPassageRef, parsePassageRef } from "@/lib/passages/ref";
import {
  createMentionTarget,
  createRowText,
  createTargets,
  type CreateTarget,
} from "@/lib/mention-create";
import { announceFloatingOpen } from "@/lib/floating";
import { trailingAnchor } from "@/lib/editor/block-anchor";

// `type` is the target's type key; it rides onto the inserted mention node's
// attrs so the chip is glyphed instantly (the default Mention command copies the
// item's fields onto the node). label/id are the existing contract. A passage
// candidate (ADR-149) rides the same list tagged with PASSAGE_TYPE + its resolved
// interval, so the selection handler inserts a passage node instead of a mention.
const PASSAGE_TYPE = "__passage__";
type Item = {
  id: string;
  label: string;
  type: string | null;
  startRef?: number;
  endRef?: number;
};

// The "/ref" scope inside the "@" picker (ADR-149, Tyler pt 4 — net-new scope
// parsing; "/passage", "/verse", "/scripture" alias it). Returns the query after
// the scope token when active, else null. create-on-miss is deliberately OFF for
// this scope — you can't create a verse.
const PASSAGE_SCOPE_RE = /^\/(ref|passage|verse|scripture)(?:\s+([\s\S]*))?$/i;
function passageScope(query: string): string | null {
  const m = PASSAGE_SCOPE_RE.exec(query.trim());
  return m ? (m[2] ?? "").trim() : null;
}

// Resolve the scope's query text to at most one passage candidate (the resolver
// is deterministic — one reference in, one canonical interval out). An empty or
// unparseable query yields no rows, so the picker shows its "type a reference"
// hint rather than a bogus match.
function passageCandidates(rest: string): Item[] {
  const ref = rest ? parsePassageRef(rest) : null;
  if (!ref) return [];
  return [
    {
      id: `${ref.startRef}-${ref.endRef}`,
      label: formatPassageRef(ref.startRef, ref.endRef),
      type: PASSAGE_TYPE,
      startRef: ref.startRef,
      endRef: ref.endRef,
    },
  ];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A leading "/type" token (e.g. "@/person bob") narrows the picker to one type;
// the token is resolved against the registry and the rest of the text becomes
// the title query. With no rest ("@/person"), it browses recent items of that
// type. An unknown/ambiguous token falls through to a literal search.
async function fetchItems(query: string, selfId?: string): Promise<Item[]> {
  // Passage scope short-circuits the item search: resolve the reference locally
  // (no server round-trip, no item lookup).
  const scope = passageScope(query);
  if (scope !== null) return passageCandidates(scope);
  const parsed = parseTypeToken(query, await loadTypes());
  const effective = parsed ? parsed.rest : query;
  const params = new URLSearchParams({ limit: "10" });
  if (effective) params.set("q", effective);
  if (parsed) params.set("type", parsed.type.key);
  const res = await fetch(`/api/items?${params}`);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    items: { id: string; title: string; type?: string | null }[];
  };
  return data.items
    .filter((it) => it.id !== selfId)
    .map((it) => ({ id: it.id, label: it.title || "Untitled", type: it.type ?? null }));
}

// Create-on-miss item, through the shared creator so this surface can't drift
// from the other four. Mapped onto the picker's { id, label, type } row shape.
async function createItem(
  title: string,
  target: CreateTarget
): Promise<Item | null> {
  const made = await createMentionTarget(title, target);
  return made ? { id: made.id, label: made.title, type: made.type } : null;
}

export function createMentionSuggestion(
  selfId?: string
): MentionOptions["suggestion"] {
  return {
    items: ({ query }) => fetchItems(query, selfId),

    // Titles routinely contain spaces ("Roger Smith", "Elder Board Meeting"),
    // so the suggestion must NOT terminate at the first space — otherwise most
    // items are untypeable. Tiptap defaults allowSpaces to false; turn it on so
    // the query keeps growing across spaces until a row is picked or the match
    // breaks.
    allowSpaces: true,

    render: () => {
      let popup: HTMLDivElement | null = null;
      let items: Item[] = [];
      let query = "";
      let selected = 0;
      let creating = false;
      let cmd: SuggestionProps<Item>["command"] | null = null;
      // The editor + replace range, captured each update, so a passage pick can
      // insert a passage node directly (the mention `command` only inserts a
      // mention node).
      let editor: SuggestionProps<Item>["editor"] | null = null;
      let range: SuggestionProps<Item>["range"] | null = null;
      let onDocPointer: ((e: MouseEvent) => void) | null = null;
      // Type registry for the row icons/labels and the "/type" token; loaded
      // once, repaints when ready.
      let types: TypeMeta[] = [];

      // The active "/type" filter (or null), and the query with the token
      // stripped — what the create-on-miss row and the API actually use.
      const token = () => parseTypeToken(query, types);
      const effectiveQuery = () => {
        const t = token();
        return (t ? t.rest : query).trim();
      };

      // The leading type glyph + trailing type label for one result row.
      const rowInner = (it: Item) => {
        // Passage candidate: canonical label + a "Passage" tag (no type glyph —
        // it isn't an item type). Reuses the existing row label/type CSS.
        if (it.type === PASSAGE_TYPE) {
          return `<span class="ledgr-mention-item-label">${escapeHtml(
            it.label
          )}</span><span class="ledgr-mention-item-type">Passage</span>`;
        }
        const meta = it.type ? types.find((t) => t.key === it.type) : undefined;
        const glyph = mentionGlyphSvg(
          { type: it.type, icon: meta?.icon ?? null, statusCategory: null },
          16
        );
        const typeLabel = meta?.label
          ? `<span class="ledgr-mention-item-type">${escapeHtml(meta.label)}</span>`
          : "";
        return `<span class="ledgr-mention-item-icon">${glyph}</span><span class="ledgr-mention-item-label">${escapeHtml(
          it.label
        )}</span>${typeLabel}`;
      };

      // Whether to show the create-on-miss row: a non-empty (post-token) query
      // with no exact (case-insensitive) title match among the hits. Never in the
      // passage scope (ADR-149 / Tyler pt 4 — you can't create a verse).
      const showCreate = () =>
        passageScope(query) === null &&
        effectiveQuery() !== "" &&
        !items.some(
          (it) => it.label.trim().toLowerCase() === effectiveQuery().toLowerCase()
        );
      // The create rows to offer: one per type the name could become when nothing
      // narrows it, or the single scoped type when "/person" is active.
      const targets = (): CreateTarget[] =>
        showCreate() ? createTargets(types, token()?.type ?? null) : [];
      const rowCount = () => items.length + targets().length;

      // Insert the chosen row. A passage candidate inserts a passage node at the
      // captured range (the mention `command` only makes mention nodes); anything
      // else goes through the mention command unchanged.
      const select = (it: Item) => {
        if (it.type === PASSAGE_TYPE && editor && range && it.startRef != null) {
          const end = it.endRef ?? it.startRef;
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: "passage", attrs: { startRef: it.startRef, endRef: end, label: it.label } },
              { type: "text", text: " " },
            ])
            .run();
          close();
          return;
        }
        cmd?.(it);
      };

      // One place to tear the popup down so every exit path (onExit, Escape,
      // click-away) also unregisters the document listener — otherwise a stray
      // listener leaks. The DOM node lives on document.body (outside React), so
      // if it isn't removed here nothing else will: that was the bug where the
      // "No matches" box survived clicking away and even a route change, until
      // a full refresh. See also the unmount sweep in MarkdownEditor.tsx.
      const close = () => {
        popup?.remove();
        popup = null;
        if (onDocPointer) {
          document.removeEventListener("mousedown", onDocPointer, true);
          onDocPointer = null;
        }
      };

      // Create the item as the picked type, then insert the mention to it. Guarded
      // against double-submit; cmd is captured at call time.
      const runCreate = async (target: CreateTarget) => {
        const title = effectiveQuery();
        if (creating || !title) return;
        creating = true;
        const insert = cmd;
        paint(); // show "Creating …" on the row that was picked
        const made = await createItem(title, target);
        creating = false;
        if (made && insert) insert(made);
        else if (!made) paint(); // surface that nothing happened; let them retry
      };

      const paint = () => {
        if (!popup) return;
        popup.innerHTML = "";
        // Active scope chip so the narrowing is legible: a "/type" filter, or the
        // passage "/ref" scope.
        const inPassage = passageScope(query) !== null;
        const active = token();
        if (inPassage) {
          const chip = document.createElement("div");
          chip.className = "ledgr-mention-filter";
          chip.innerHTML = `<span>Passage</span>`;
          popup.appendChild(chip);
        } else if (active) {
          const chip = document.createElement("div");
          chip.className = "ledgr-mention-filter";
          chip.innerHTML = `${mentionGlyphSvg(
            { type: active.type.key, icon: active.type.icon, statusCategory: null },
            14
          )}<span>${escapeHtml(active.type.label)}</span>`;
          popup.appendChild(chip);
        }
        if (items.length === 0 && !showCreate()) {
          const empty = document.createElement("div");
          empty.className = "ledgr-mention-empty";
          empty.textContent = inPassage ? "Type a reference, e.g. Rom 8:5" : "No matches";
          popup.appendChild(empty);
          return;
        }
        items.forEach((it, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className =
            "ledgr-mention-item" + (i === selected ? " is-selected" : "");
          row.innerHTML = rowInner(it);
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            select(it);
          });
          popup!.appendChild(row);
        });
        // Create-on-miss: one row per type the name could become, each carrying
        // that type's glyph and label so the block reads as a question with
        // answers rather than a blind "Create". Matches the hit rows' shape (and
        // the textarea picker's, mention-ui.tsx) on purpose.
        targets().forEach((target, n) => {
          const i = items.length + n;
          const row = document.createElement("button");
          row.type = "button";
          row.className =
            "ledgr-mention-item ledgr-mention-create" +
            (i === selected ? " is-selected" : "");
          const meta = types.find((t) => t.key === target.key);
          row.innerHTML = `<span class="ledgr-mention-item-icon">${mentionGlyphSvg(
            { type: target.key, icon: meta?.icon ?? target.icon, statusCategory: null },
            16
          )}</span><span class="ledgr-mention-item-label">${escapeHtml(
            createRowText(effectiveQuery(), creating)
          )}</span><span class="ledgr-mention-item-type">${escapeHtml(
            target.label
          )}</span>`;
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            void runCreate(target);
          });
          popup!.appendChild(row);
        });
      };

      const place = (rect: DOMRect | null) => {
        if (!popup || !rect) return;
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${rect.bottom + 4}px`;
      };

      // Build the popup + wire its click-away dismiss. Extracted so onUpdate can
      // re-open it after a space-led query closed it (e.g. "@ " then backspace),
      // not just onStart.
      const mount = () => {
        // Clear any orphan popup left by a previous session that didn't tear
        // down cleanly (belt-and-suspenders with close()).
        document
          .querySelectorAll(".ledgr-mention-popup")
          .forEach((n) => n.remove());
        popup = document.createElement("div");
        popup.className = "ledgr-mention-popup";
        document.body.appendChild(popup);
        // Close any other open floating panel (the item "⋯" kebab was the one
        // that overlapped this in practice). Announced on MOUNT, not on every
        // update: this popup opens from a keystroke, so nothing else's
        // outside-click listener would ever fire to dismiss it.
        announceFloatingOpen("editor-mention");
        // Clicking anywhere outside the popup dismisses it (capture phase so we
        // see the click before it's swallowed; row mousedowns live inside).
        onDocPointer = (e: MouseEvent) => {
          if (popup && !popup.contains(e.target as Node)) close();
        };
        document.addEventListener("mousedown", onDocPointer, true);
      };

      // "@" immediately followed by a space is plain text, not a mention ("email
      // me @ 3pm"), so the popup should stay shut. allowSpaces lets a space
      // *inside* a query through ("@Elder Board"); those queries never BEGIN
      // with a space, so a leading space is the unambiguous "this isn't a
      // mention" signal.
      //
      // A trailing block anchor closes it for the same reason: with the caret
      // after "@Roger-Tester ^1nr6v7" the user is at the end of the line, not
      // editing the mention, and the anchor rode into the query — the picker
      // offered to create an item literally named "Roger-Tester ^1nr6v7", and
      // accepting it also swallowed the anchor into the mention's replace range.
      const isLiteralAt = (query: string) =>
        query.startsWith(" ") || trailingAnchor(query) !== null;

      return {
        onStart: (props: SuggestionProps<Item>) => {
          items = props.items;
          query = props.query;
          selected = 0;
          creating = false;
          cmd = props.command;
          editor = props.editor;
          range = props.range;
          if (isLiteralAt(query)) return; // "@ …" — leave the @ as plain text
          mount();
          paint();
          place(props.clientRect?.() ?? null);
          // Fill the type glyphs/labels (and enable "/type" parsing) once the
          // registry arrives, then repaint.
          if (types.length === 0) {
            void loadTypes().then((t) => {
              types = t;
              paint();
            });
          }
        },
        onUpdate: (props: SuggestionProps<Item>) => {
          items = props.items;
          query = props.query;
          selected = 0;
          cmd = props.command;
          editor = props.editor;
          range = props.range;
          // A space right after "@" means it isn't a mention — dismiss. (A space
          // later in the query doesn't begin with one, so multi-word titles are
          // unaffected.)
          if (isLiteralAt(query)) {
            close();
            return;
          }
          // Re-open if a previous space-led query had closed us but the user
          // backspaced into a real query again.
          if (!popup) mount();
          paint();
          place(props.clientRect?.() ?? null);
        },
        onKeyDown: ({ event }) => {
          // No popup, no keys: the plugin stays active while the query is one we
          // deliberately refuse (a literal "@ ", a trailing anchor), and without
          // this Enter would insert a mention nobody could see being chosen.
          if (!popup) return false;
          const count = Math.max(rowCount(), 1);
          if (event.key === "ArrowDown") {
            selected = (selected + 1) % count;
            paint();
            return true;
          }
          if (event.key === "ArrowUp") {
            selected = (selected - 1 + count) % count;
            paint();
            return true;
          }
          if (event.key === "Enter") {
            if (selected < items.length) {
              const it = items[selected];
              if (it) select(it);
            } else {
              const target = targets()[selected - items.length];
              if (target) void runCreate(target);
            }
            return true;
          }
          if (event.key === "Escape") {
            close();
            return true;
          }
          return false;
        },
        onExit: () => {
          close();
        },
      };
    },
  };
}
