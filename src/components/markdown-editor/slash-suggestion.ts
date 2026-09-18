// The "/" slash-command menu — the first general command palette in the editor
// (mentions use "@", tokens use "{{"). Hand-rolled over Tiptap's Suggestion
// utility with a positioned <div>, mirroring token-suggestion.ts exactly, so
// there's no popup dependency (CLAUDE.md Principle 5). Commands run against the
// live editor and replace the "/query" range.
//
// The toggle command is gated by the user's toggleBlocksEnabled setting: the
// host calls setSlashToggleEnabled once settings load. It's a module-level flag
// (app-wide, one editor focused at a time), matching the memoized settings
// pattern in MarkdownEditor. Headings and lists are core and always offered.
"use client";

import {
  Extension,
  type ChainedCommands,
  type Editor,
  type Range,
} from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { insertToggle, wrapSelectionInToggle } from "./toggle-extension";

// A unique key: @tiptap/suggestion defaults every instance to the same
// "suggestion$" key, so a second default-keyed Suggestion (the "{{" token menu
// already uses the default) throws "Adding different instances of a keyed
// plugin". Mentions have their own key; this gives the slash menu its own too.
const slashSuggestionKey = new PluginKey("slashCommands");

// App-wide toggle-blocks gate (see setSlashToggleEnabled). Defaults on to match
// DEFAULT_SETTINGS; the host pushes the real value once /api/settings resolves.
let toggleEnabled = true;
export function setSlashToggleEnabled(on: boolean): void {
  toggleEnabled = on;
}

// Per-editor file picker for the "/file" command. Unlike the toggle gate this
// can't be app-wide: whether upload works depends on the HOST's uploadFile prop
// (scratch/changelog have none), and two editors with different hosts can be
// mounted at once. A WeakMap keyed by the editor keeps each registration scoped
// to its instance and lets it die with the editor.
const filePickers = new WeakMap<Editor, () => void>();
export function setSlashFilePicker(
  editor: Editor,
  open: (() => void) | null
): void {
  if (open) filePickers.set(editor, open);
  else filePickers.delete(editor);
}

type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  keywords: string[];
  enabled?: (editor: Editor) => boolean;
  run: (editor: Editor, range: Range) => void;
};

const setHeading =
  (level: 1 | 2 | 3) => (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).setNode("heading", { level }).run();
  };

// Every list/block command below is one Tiptap chain applied after the "/query"
// range is deleted, which is what makes them convert the block the caret is in
// (usually the empty paragraph the user just typed "/" into) rather than insert a
// second one. Taking the chain step as a callback keeps each command one readable
// line and stays type-safe, where indexing the chain by a union of method names
// would not. These are the same commands the toolbar buttons run
// (MarkdownEditor.tsx groups), so the two surfaces can't drift.
const block =
  (apply: (chain: ChainedCommands) => ChainedCommands) =>
  (editor: Editor, range: Range) => {
    apply(editor.chain().focus().deleteRange(range)).run();
  };

const COMMANDS: SlashCommand[] = [
  {
    id: "h1",
    label: "Heading 1",
    hint: "Large section heading",
    keywords: ["h1", "heading", "title"],
    run: setHeading(1),
  },
  {
    id: "h2",
    label: "Heading 2",
    hint: "Medium section heading",
    keywords: ["h2", "heading", "subtitle"],
    run: setHeading(2),
  },
  {
    id: "h3",
    label: "Heading 3",
    hint: "Small section heading",
    keywords: ["h3", "heading"],
    run: setHeading(3),
  },
  {
    id: "bulletList",
    label: "Bulleted list",
    hint: "Simple bulleted list",
    keywords: ["bullet", "list", "ul", "unordered", "dash"],
    run: block((c) => c.toggleBulletList()),
  },
  {
    id: "orderedList",
    label: "Numbered list",
    hint: "List with numbered steps",
    keywords: ["number", "numbered", "list", "ol", "ordered", "step"],
    run: block((c) => c.toggleOrderedList()),
  },
  {
    id: "taskList",
    label: "Checklist",
    hint: "Checkbox list you can tick off",
    keywords: ["check", "checkbox", "checklist", "task", "todo", "to-do", "box"],
    run: block((c) => c.toggleTaskList()),
  },
  {
    id: "quote",
    label: "Quote",
    hint: "Indented quotation block",
    keywords: ["quote", "blockquote", "citation", "excerpt"],
    run: block((c) => c.toggleBlockquote()),
  },
  {
    id: "codeBlock",
    label: "Code block",
    hint: "Monospaced, unformatted block",
    keywords: ["code", "codeblock", "pre", "snippet", "monospace"],
    run: block((c) => c.toggleCodeBlock()),
  },
  {
    id: "table",
    label: "Table",
    hint: "3×3 table with a header row",
    keywords: ["table", "grid", "rows", "columns", "spreadsheet"],
    // Same shape as the toolbar's Insert table button. insertTable replaces the
    // empty paragraph the caret is in, so no stray blank line is left above it.
    run: block((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })),
  },
  {
    id: "divider",
    label: "Divider",
    hint: "Horizontal rule between sections",
    keywords: ["divider", "rule", "hr", "line", "separator", "break"],
    run: block((c) => c.setHorizontalRule()),
  },
  {
    id: "toggle",
    label: "Toggle",
    hint: "Collapsible block",
    keywords: ["toggle", "details", "collapse", "expand", "fold"],
    enabled: () => toggleEnabled,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      insertToggle(editor);
    },
  },
  {
    id: "toggleWrap",
    label: "Turn into toggle",
    hint: "Wrap this block in a collapsible toggle",
    keywords: ["toggle", "wrap", "convert", "collapse", "fold", "details"],
    enabled: () => toggleEnabled,
    // Convert the current block into a toggle (its text becomes the summary),
    // mirroring the setHeading convert pattern above. After deleting the "/query"
    // range the caret sits in the block being converted; wrap it, falling back to
    // an empty toggle if wrapping isn't possible (e.g. already inside a toggle).
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      if (!wrapSelectionInToggle(editor)) insertToggle(editor);
    },
  },
  {
    id: "file",
    label: "File",
    hint: "Upload a file and link it here",
    keywords: ["file", "upload", "attach", "attachment", "pdf", "doc", "html"],
    // Only offered where the host wired an uploader (see setSlashFilePicker).
    enabled: (editor) => filePickers.has(editor),
    // Delete the "/query" first so the picked file's link lands where the "/"
    // was typed, then hand off to the editor's hidden any-file input.
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      filePickers.get(editor)?.();
    },
  },
];

function filterCommands(query: string, editor: Editor): SlashCommand[] {
  const q = query.trim().toLowerCase();
  return COMMANDS.filter((c) => c.enabled?.(editor) ?? true).filter(
    (c) =>
      q === "" ||
      c.label.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.includes(q))
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function suggestionConfig(editor: Editor) {
  return {
    editor,
    pluginKey: slashSuggestionKey,
    char: "/",
    // Fires only at the start of a block or after a space (Suggestion's default
    // allowedPrefixes), so a "/" inside "http://" or "and/or" won't open it.
    items: ({ query }: { query: string }): SlashCommand[] =>
      filterCommands(query, editor),
    command: ({
      editor,
      range,
      props,
    }: {
      editor: Editor;
      range: Range;
      props: SlashCommand;
    }) => {
      props.run(editor, range);
    },
    render: () => {
      let popup: HTMLDivElement | null = null;
      let items: SlashCommand[] = [];
      let selected = 0;
      let cmd: SuggestionProps<SlashCommand>["command"] | null = null;
      let onDocPointer: ((e: MouseEvent) => void) | null = null;

      const close = () => {
        popup?.remove();
        popup = null;
        if (onDocPointer) {
          document.removeEventListener("mousedown", onDocPointer, true);
          onDocPointer = null;
        }
      };

      const paint = () => {
        if (!popup) return;
        popup.innerHTML = "";
        if (items.length === 0) {
          const empty = document.createElement("div");
          empty.className = "ledgr-slash-empty";
          empty.textContent = "No matching command";
          popup.appendChild(empty);
          return;
        }
        items.forEach((it, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "ledgr-slash-item" + (i === selected ? " is-selected" : "");
          row.innerHTML =
            `<span class="ledgr-slash-item-label">${escapeHtml(it.label)}</span>` +
            `<span class="ledgr-slash-item-hint">${escapeHtml(it.hint)}</span>`;
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            cmd?.(it);
          });
          popup!.appendChild(row);
          // The command list is taller than the popup's max-height, so arrowing
          // down past the visible rows would move the selection off-screen. Keep
          // the selected row scrolled into view (nearest = no jump when it's
          // already visible). Only meaningful once the list overflows.
          if (i === selected) row.scrollIntoView({ block: "nearest" });
        });
      };

      const place = (rect: DOMRect | null) => {
        if (!popup || !rect) return;
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${rect.bottom + 4}px`;
      };

      const mount = () => {
        document.querySelectorAll(".ledgr-slash-popup").forEach((n) => n.remove());
        popup = document.createElement("div");
        popup.className = "ledgr-slash-popup";
        document.body.appendChild(popup);
        onDocPointer = (e: MouseEvent) => {
          if (popup && !popup.contains(e.target as Node)) close();
        };
        document.addEventListener("mousedown", onDocPointer, true);
      };

      return {
        onStart: (props: SuggestionProps<SlashCommand>) => {
          items = props.items;
          selected = 0;
          cmd = props.command;
          mount();
          paint();
          place(props.clientRect?.() ?? null);
        },
        onUpdate: (props: SuggestionProps<SlashCommand>) => {
          items = props.items;
          selected = 0;
          cmd = props.command;
          if (!popup) mount();
          paint();
          place(props.clientRect?.() ?? null);
        },
        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
          const count = Math.max(items.length, 1);
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
            const it = items[selected];
            if (it) cmd?.(it);
            return true;
          }
          if (event.key === "Escape") {
            close();
            return true;
          }
          return false;
        },
        onExit: () => close(),
      };
    },
  };
}

export const SlashCommands = Extension.create({
  name: "slashCommands",
  addProseMirrorPlugins() {
    return [Suggestion(suggestionConfig(this.editor))];
  },
});
