// Verifies the floating-panel layering rules (2026-08-12).
//
// Why this script exists: the "@" typeahead and the item "⋯" kebab were BOTH at
// z-index 50 — one portaled to <body>, one in the page flow — so which painted on
// top was a stacking-context accident and their text bled through each other
// (Tyler's screenshot). A z-index tie is invisible in a code review: each file
// looks fine on its own, and the bug only exists in the relationship between two
// files nobody reads together. That's exactly what a guard is for.
//
// Two rules, both greppable:
//   1. A panel portaled to <body> or positioned `fixed` sits at the float tier
//      (60) or above — never at the in-page menu tier (50) or below.
//   2. Every top-level floating surface participates in the one-open-at-a-time
//      broadcast (src/lib/floating.ts), so layering rarely has to arbitrate.
//
//   npx tsx scripts/verify-layering.mts
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${String(detail)})`}`);
  }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// --- the scale is declared, and documented ---------------------------------
const globals = read("src/app/globals.css");
const TIERS = ["sticky", "chrome", "modal", "float", "top"] as const;
for (const tier of TIERS) {
  check(`--z-${tier} is declared`, new RegExp(`--z-${tier}:\\s*\\d+;`).test(globals));
}
const values = TIERS.map((t) => {
  const m = new RegExp(`--z-${t}:\\s*(\\d+);`).exec(globals);
  return m ? Number(m[1]) : NaN;
});
check(
  "the tiers ascend (sticky < chrome < modal < float < top)",
  values.every((v, i) => i === 0 || v > values[i - 1]),
  values.join(" < ")
);
check(
  "the float tier outranks the in-page menu tier — the fix for the reported tie",
  values[3] > values[2],
  `float=${values[3]} modal=${values[2]}`
);
check(
  "the scale carries the why, not just the numbers",
  globals.includes("stacking context") && globals.includes("portaled"),
  "the comment block above the tokens should explain the tie"
);

// --- rule 1: the editor mention popup ---------------------------------------
// It is appended to <body> and placed from getBoundingClientRect(), i.e. VIEWPORT
// coords. As `absolute` those were read against the document, so on a scrolled
// page it landed off by the scroll offset. `fixed` is the space the numbers are in.
const editorCss = read("src/components/markdown-editor/markdown-editor.css");
const popupBlock = /\.ledgr-mention-popup\s*\{([^}]*)\}/.exec(editorCss)?.[1] ?? "";
check("the editor mention popup block was found", popupBlock !== "");
check(
  "it is `fixed`, matching the viewport coords it is placed with",
  /position:\s*fixed/.test(popupBlock),
  popupBlock.match(/position:[^;]*/)?.[0]
);
check(
  "it is NOT `absolute` (that was the scroll-offset bug)",
  !/position:\s*absolute/.test(popupBlock)
);
check(
  "it sits on the float tier token, not a hardcoded number",
  /z-index:\s*var\(--z-float/.test(popupBlock),
  popupBlock.match(/z-index:[^;]*/)?.[0]
);
check(
  "it no longer ties with the in-page menu tier",
  !/z-index:\s*50\b/.test(popupBlock)
);

// The suggestion module must place it in viewport coords to match `fixed`.
const suggestion = read("src/components/markdown-editor/mention-suggestion.ts");
check(
  "it is still placed from getBoundingClientRect (viewport) values",
  suggestion.includes("rect.bottom") && suggestion.includes("rect.left")
);
check(
  "placement does NOT add scrollY (which would double-count under `fixed`)",
  !/rect\.(bottom|top)\s*\+\s*window\.scroll/.test(suggestion)
);

// --- rule 1, continued: the textarea typeahead ------------------------------
const mentionUi = read("src/components/capture/mention-ui.tsx");
// Inspect className VALUES only. Grepping the whole file matches the comment that
// explains what the class used to be — a guard that fails on its own
// documentation trains people to ignore it.
const uiClasses = [...mentionUi.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
const zClasses = uiClasses.flatMap((c) => c.match(/\bz-\[?\d+\]?/g) ?? []);
check(
  "the textarea typeahead is on the float tier (it was z-20, under page chrome)",
  zClasses.includes("z-[60]"),
  zClasses.join(" ") || "no z- class found"
);
check(
  "no className is left below the float tier",
  !zClasses.some((z) => Number(z.replace(/\D/g, "")) < values[3]),
  zClasses.join(" ")
);

// --- rule 2: one open floating panel at a time ------------------------------
// The surfaces in the reported collision, plus the shared primitive. A surface
// that opens from a KEYSTROKE is the reason this exists: no outside-click fires,
// so nothing else would ever be told to close.
const ANNOUNCERS: [string, string][] = [
  ["src/components/markdown-editor/mention-suggestion.ts", "the editor @ picker"],
  ["src/components/capture/MentionTitleField.tsx", "the capture title @ picker"],
  ["src/components/tasks/AddTaskCard.tsx", "the task-add @ picker"],
  ["src/components/relations/AddRelation.tsx", "the + Relate box"],
  ["src/components/relations/RelationField.tsx", "the relation field"],
  ["src/components/canvas/ItemActionsMenu.tsx", "the item ⋯ kebab"],
  ["src/components/ui/Popover.tsx", "the shared Popover"],
];
for (const [path, label] of ANNOUNCERS) {
  check(`${label} announces when it opens`, read(path).includes("announceFloatingOpen"));
}
// Both halves of the reported pair must also LISTEN, or the broadcast is one-way.
for (const path of [
  "src/components/canvas/ItemActionsMenu.tsx",
  "src/components/ui/Popover.tsx",
]) {
  check(`${path} closes when another panel opens`, read(path).includes("onOtherFloatingOpen"));
}

// --- the primitive itself ---------------------------------------------------
const floating = read("src/lib/floating.ts");
check(
  "a surface ignores its OWN announcement (else it would close itself)",
  /who\s*!==\s*id/.test(floating)
);
check(
  "it is SSR-safe (these modules render on the server too)",
  (floating.match(/typeof window === "undefined"/g) ?? []).length >= 2
);
check(
  "unsubscribing is possible, so listeners can't pile up across mounts",
  floating.includes("removeEventListener")
);
check("no new dependency — a plain window event", !/^import .* from ["'][^.@]/m.test(floating));

console.log(
  failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE${failures === 1 ? "" : "S"}`
);
process.exit(failures === 0 ? 0 : 1);
