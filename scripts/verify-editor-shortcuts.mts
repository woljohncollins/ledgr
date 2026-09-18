// Editor toolbar keyboard-shortcut tooltips — pure verification. No DB.
// Run: npx tsx scripts/verify-editor-shortcuts.mts
//
// Two things are checked, and the second is the one that matters. Formatting is
// easy to eyeball; what rots silently is the *claim*. The toolbar's `keys:`
// specs are hand-copied from Tiptap's extensions, so a Tiptap upgrade that
// moves a binding would leave a tooltip confidently teaching the wrong keys.
// So every spec the toolbar advertises is checked against the shortcut strings
// actually registered in the installed @tiptap packages.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const { formatShortcut, withShortcut } = await import("../src/lib/editor/shortcuts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- formatting: Apple symbols vs. spelled-out Ctrl+… ---
check("Mod-b → ⌘B on Apple", formatShortcut("Mod-b", true) === "⌘B", formatShortcut("Mod-b", true));
check("Mod-b → Ctrl+B elsewhere", formatShortcut("Mod-b", false) === "Ctrl+B", formatShortcut("Mod-b", false));
check("Mod-Alt-1 → ⌥⌘1", formatShortcut("Mod-Alt-1", true) === "⌥⌘1", formatShortcut("Mod-Alt-1", true));
check("Mod-Alt-1 → Alt+Ctrl+1", formatShortcut("Mod-Alt-1", false) === "Alt+Ctrl+1", formatShortcut("Mod-Alt-1", false));
check("Tab formats bare", formatShortcut("Tab", true) === "⇥" && formatShortcut("Tab", false) === "Tab");
check("Shift-Tab formats", formatShortcut("Shift-Tab", false) === "Shift+Tab", formatShortcut("Shift-Tab", false));
// Modifier order is normalized, so the two spellings of redo print alike.
check(
  "modifier order normalized",
  formatShortcut("Shift-Mod-z", true) === formatShortcut("Mod-Shift-z", true) &&
    formatShortcut("Shift-Mod-z", true) === "⇧⌘Z",
  formatShortcut("Shift-Mod-z", true)
);
check("withShortcut composes", withShortcut("Bold", "Mod-b", true) === "Bold · ⌘B", withShortcut("Bold", "Mod-b", true));
// A label with its own parenthetical must not end up with two of them.
check(
  "no nested parentheses",
  withShortcut("Checklist (- [ ])", "Mod-Shift-9", true) === "Checklist (- [ ]) · ⇧⌘9",
  withShortcut("Checklist (- [ ])", "Mod-Shift-9", true)
);
check("withShortcut without a spec is the bare label", withShortcut("Insert table", undefined, true) === "Insert table");

// --- the claims: every advertised spec is a shortcut Tiptap really binds ---
const toolbar = readFileSync("src/components/markdown-editor/MarkdownEditor.tsx", "utf8");
const specs = [...toolbar.matchAll(/keys: "([^"]+)"/g)].map((m) => m[1]);
check("toolbar advertises shortcuts", specs.length >= 14, `${specs.length} found`);

// Every quoted shortcut key registered by the installed Tiptap packages. Heading
// builds its own as `Mod-Alt-${level}`, so that one template is expanded here;
// everything else appears literally in the shipped source.
const TIPTAP = "node_modules/@tiptap";
const bound = new Set<string>();
if (existsSync(TIPTAP)) {
  for (const pkg of readdirSync(TIPTAP)) {
    const dist = join(TIPTAP, pkg, "dist");
    if (!existsSync(dist)) continue;
    for (const f of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(join(dist, f), "utf8");
      // Quoted ("Mod-Shift-8":) and, for the ones that need no quotes, bare
      // object keys (Tab:) — both are how a keyboard-shortcut map is written.
      for (const m of src.matchAll(
        /["'`]((?:Mod|Alt|Shift|Ctrl)-[A-Za-z0-9-]*|Tab)["'`]|[{,\s](Tab):/g
      )) {
        bound.add((m[1] ?? m[2]).toLowerCase());
      }
      if (/Mod-Alt-\$\{level\}/.test(src)) {
        for (let l = 1; l <= 6; l += 1) bound.add(`mod-alt-${l}`);
      }
    }
  }
}
check("scanned the installed Tiptap packages", bound.size > 10, `${bound.size} bindings`);

// A spec matches if Tiptap binds that exact combination, in any modifier order
// (Tiptap writes both "Shift-Mod-z" and "Mod-Shift-z" for redo).
const canon = (s: string) => {
  const p = s.toLowerCase().split("-");
  return [...p.slice(0, -1).sort(), p[p.length - 1]].join("-");
};
const boundCanon = new Set([...bound].map(canon));
for (const spec of [...new Set(specs)]) {
  check(`Tiptap binds ${spec}`, boundCanon.has(canon(spec)));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
