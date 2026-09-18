// Keyboard shortcuts for the body editor's toolbar tooltips.
//
// The shortcuts themselves are Tiptap's, not ours: StarterKit and
// @tiptap/extension-list register them (Bold = Mod-b, Heading = Mod-Alt-<level>,
// bullet list = Mod-Shift-8, Tab/Shift-Tab to nest and un-nest, and so on). This
// file only *names* them for display, so a button's tooltip can read "Bold
// (⌘B)". Nothing here binds a key: change a binding in the editor extensions and
// this table has to be updated to match, which is what verify-editor-shortcuts
// checks against the toolbar's button list.
//
// Specs use Tiptap's own notation ("Mod-b", "Shift-Mod-z"), so the string in the
// toolbar is the same string you'd search the Tiptap source for. `Mod` is the
// platform's primary modifier: ⌘ on Apple keyboards, Ctrl everywhere else. We
// render the shortcut for the keyboard you're actually on rather than listing
// both, the way every editor does; a Mac user has no use for "Ctrl+Alt+1".

// Apple layout → ⌘/⌥/⇧ symbols, no separators. Everything else → "Ctrl+Alt+1".
// `navigator.platform` is deprecated but still the most reliable Mac signal;
// userAgent covers iPadOS, which reports as a Mac, and any browser that has
// dropped platform. Evaluated per call (not module load) because a module-level
// constant would bake in the server's answer during SSR.
export function isAppleKeyboard(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

const APPLE: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
  ctrl: "⌃",
  tab: "⇥",
};

const OTHER: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  ctrl: "Ctrl",
  tab: "Tab",
};

// Modifiers read in a fixed order regardless of how the spec was written, so
// "Shift-Mod-z" and "Mod-Shift-z" both print as ⇧⌘Z / Ctrl+Shift+Z.
const ORDER = ["ctrl", "alt", "shift", "mod"];

export function formatShortcut(spec: string, apple = isAppleKeyboard()): string {
  const names = apple ? APPLE : OTHER;
  const parts = spec.split("-");
  const mods = parts
    .slice(0, -1)
    .map((p) => p.toLowerCase())
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    .map((p) => names[p] ?? p);
  const key = parts[parts.length - 1];
  const last = names[key.toLowerCase()] ?? key.toUpperCase();
  // Apple convention puts ⌘ closest to the key and uses no separator; Windows
  // and Linux spell it out with "+".
  return apple ? [...mods, last].join("") : [...mods, last].join("+");
}

// "Bold" + "Mod-b" → "Bold · ⌘B". No spec → the label unchanged, so a button
// without a shortcut keeps exactly the tooltip it had.
//
// A dot rather than parentheses because several labels already carry a
// parenthetical of their own ("Checklist (- [ ])", "Outdent (un-nest list
// item)"), and "Checklist (- [ ]) (⇧⌘9)" reads as a typo.
export function withShortcut(title: string, spec?: string, apple?: boolean): string {
  return spec ? `${title} · ${formatShortcut(spec, apple)}` : title;
}
