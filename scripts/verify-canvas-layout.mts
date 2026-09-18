// Verification for the per-type item canvas layout (ADR-069, Feature B), pure —
// NO database. Exercises the client-safe layout module end to end: defaultLayout
// reproduces the classic reading order; parseCanvasLayout tolerates junk → null
// and drops per-cell garbage; reconcile drops removed cards and appends added
// ones; deriveResponsive fills md/sm from lg. Runs anywhere: npx tsx
// scripts/verify-canvas-layout.mts
import type { PropertyDef } from "../src/lib/types";
import {
  cardVocabulary,
  defaultLayout,
  deriveResponsive,
  parseCanvasLayout,
  reconcile,
  resolveLayout,
  FOOTER_IDS,
  GRID_COLS,
  type CanvasLayout,
} from "../src/lib/canvas-layout";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// Ids of a breakpoint's cells in reading order (top-to-bottom, left-to-right).
function readingOrder(layout: CanvasLayout, bp: "lg" | "md" | "sm" = "lg"): string[] {
  return [...layout.layouts[bp]]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((c) => c.i);
}

// --- defaultLayout reproduces the classic reading order ------------------

const taskProps: PropertyDef[] = [];
const taskVocab = cardVocabulary("task", taskProps);
check(
  "task vocabulary is title → system strip → body → recurrence → completions → subtasks → related → discover → files → save → share → history → meta",
  JSON.stringify(taskVocab) ===
    JSON.stringify([
      "title",
      "sys:status",
      "sys:scheduledDate",
      "sys:dueDate",
      "sys:urgency",
      "body",
      "recurrence",
      "recurrenceCalendar",
      "subtasks",
      "related",
      "discover",
      // files joined the vocabulary in ADR-237 addendum 3 (the arrangeable
      // Files card), between the content web and export.
      "files",
      "saveOffline",
      "share",
      "history",
      "meta",
    ]),
  taskVocab.join(",")
);

const taskDefault = defaultLayout("task", taskProps);
check(
  "defaultLayout(task) lg reading order matches the vocabulary",
  JSON.stringify(readingOrder(taskDefault)) === JSON.stringify(taskVocab)
);
check(
  "defaultLayout(task) has a card meta for every vocabulary id",
  taskVocab.every((id) => taskDefault.cards[id] != null)
);
check(
  "defaultLayout(task) places every card at all three breakpoints",
  (["lg", "md", "sm"] as const).every(
    (bp) =>
      taskDefault.layouts[bp].length === taskVocab.length &&
      new Set(taskDefault.layouts[bp].map((c) => c.i)).size === taskVocab.length
  )
);
check(
  "defaultLayout(task) sm is a single column (every card x=0, w=1)",
  taskDefault.layouts.sm.every((c) => c.x === 0 && c.w === 1)
);
check(
  "defaultLayout(task) lg widths never exceed the column count",
  taskDefault.layouts.lg.every((c) => c.x + c.w <= GRID_COLS.lg)
);

// Type-conditional + field cards: note carries exactly its date-taken field and
// no subtasks (ADR-110); meeting gets meetingPrep + sys:meetingAt; a custom type
// maps props and relations.
check("note vocabulary is exactly the date-taken field (ADR-110), no subtasks", (() => {
  const v = cardVocabulary("note", []);
  const sys = v.filter((id) => id.startsWith("sys:"));
  return sys.length === 1 && sys[0] === "sys:noteDate" && !v.includes("subtasks");
})());
check("meeting vocabulary has meetingPrep + sys:meetingAt", (() => {
  const v = cardVocabulary("event", []);
  return v.includes("meetingPrep") && v.includes("sys:meetingAt") && !v.includes("subtasks");
})());

const bookProps: PropertyDef[] = [
  { key: "pages", label: "Pages", kind: "number" },
  { key: "author", label: "Author", kind: "relation", targetType: null, cardinality: "single" },
];
const bookVocab = cardVocabulary("book", bookProps);
check(
  "custom type maps scalar props to prop:* and relations to rel:* (props before relations)",
  bookVocab.includes("prop:pages") &&
    bookVocab.includes("rel:author") &&
    bookVocab.indexOf("prop:pages") < bookVocab.indexOf("rel:author")
);

// --- parseCanvasLayout tolerates junk → null ----------------------------

for (const [name, raw] of [
  ["null", null],
  ["undefined", undefined],
  ["a string", "nope"],
  ["a number", 42],
  ["an array", [1, 2]],
  ["empty object", {}],
  ["wrong version", { version: 2, cards: {}, layouts: { lg: [], md: [], sm: [] } }],
  ["missing cards", { version: 1, layouts: { lg: [], md: [], sm: [] } }],
  ["missing layouts", { version: 1, cards: {} }],
  ["layouts not an object", { version: 1, cards: {}, layouts: "x" }],
] as const) {
  check(`parseCanvasLayout(${name}) → null`, parseCanvasLayout(raw) === null);
}

// A valid layout round-trips, and per-cell / per-card junk is dropped (not fatal).
const dirty = {
  version: 1,
  cards: {
    body: { mode: "flow" },
    title: { mode: "fixed", hidden: true },
    bad: { mode: "sideways" }, // dropped (bad mode)
    alsoBad: 7, // dropped (not an object)
  },
  layouts: {
    lg: [
      { i: "body", x: 0, y: 0, w: 12, h: 8 },
      { i: "title", x: 0, y: 8, w: 99, h: 2 }, // w clamped to 12
      { i: "", x: 0, y: 0, w: 1, h: 1 }, // dropped (empty id)
      { i: "title", x: 1, y: 1, w: 1, h: 1 }, // dropped (duplicate id)
      "garbage", // dropped (not an object)
    ],
    md: [],
    sm: [],
  },
};
const parsed = parseCanvasLayout(dirty);
check("parseCanvasLayout keeps a valid layout", parsed !== null);
check("parseCanvasLayout drops bad card metas, keeps good", !!parsed && parsed.cards.bad === undefined && parsed.cards.body?.mode === "flow");
check("parseCanvasLayout preserves a card's hidden flag", !!parsed && parsed.cards.title?.hidden === true);
check("parseCanvasLayout drops junk/duplicate cells, keeps good", !!parsed && parsed.layouts.lg.length === 2);
check("parseCanvasLayout clamps an over-wide cell to the column count", !!parsed && parsed.layouts.lg.find((c) => c.i === "title")?.w === GRID_COLS.lg);

// --- reconcile drops removed + appends added ----------------------------

// Start from a book with [pages, author]; the user later removes `pages` and adds
// a scalar `isbn`. reconcile must drop prop:pages and append prop:isbn.
const before = defaultLayout("book", bookProps);
const afterProps: PropertyDef[] = [
  { key: "isbn", label: "ISBN", kind: "text" },
  { key: "author", label: "Author", kind: "relation", targetType: null, cardinality: "single" },
];
const reconciled = reconcile(before, "book", afterProps);
check("reconcile drops a removed property card from cards", reconciled.cards["prop:pages"] === undefined);
check("reconcile drops a removed property card from every breakpoint", (["lg", "md", "sm"] as const).every((bp) => !reconciled.layouts[bp].some((c) => c.i === "prop:pages")));
check("reconcile appends a newly-added property card", reconciled.cards["prop:isbn"] != null && readingOrder(reconciled).includes("prop:isbn"));
check("reconcile keeps the surviving relation card", reconciled.cards["rel:author"] != null);
check("reconcile covers exactly the new vocabulary", (() => {
  const vocab = new Set(cardVocabulary("book", afterProps));
  const ids = new Set(Object.keys(reconciled.cards));
  return vocab.size === ids.size && [...vocab].every((id) => ids.has(id));
})());
check("reconcile preserves a kept card's user mode", (() => {
  const pinned = JSON.parse(JSON.stringify(before)) as CanvasLayout;
  pinned.cards["rel:author"] = { mode: "fixed" }; // user pinned it
  return reconcile(pinned, "book", afterProps).cards["rel:author"]?.mode === "fixed";
})());

// --- reconcile sinks the footer cards under everything else (ADR-256) ---

check("reconcile places a newly-added property ABOVE the footer cards", (() => {
  const order = readingOrder(reconciled);
  const added = order.indexOf("prop:isbn");
  return FOOTER_IDS.every((id) => order.indexOf(id) > added);
})());
check("reconcile sinks a footer card the user dragged to the top, on every breakpoint", (() => {
  const moved = JSON.parse(JSON.stringify(before)) as CanvasLayout;
  for (const bp of ["lg", "md", "sm"] as const) {
    const m = moved.layouts[bp].find((c) => c.i === "meta")!;
    m.x = 0;
    m.y = 0;
  }
  const out = reconcile(moved, "book", bookProps);
  return (["lg", "md", "sm"] as const).every((bp) => {
    const o = readingOrder(out, bp);
    return o.indexOf("meta") > o.indexOf("body") && o.indexOf("meta") > o.indexOf("related");
  });
})());

// --- deriveResponsive fills md/sm from lg --------------------------------

const lgOnly: CanvasLayout = {
  version: 1,
  cards: { title: { mode: "flow" }, body: { mode: "flow" }, meta: { mode: "flow" } },
  layouts: {
    lg: [
      { i: "title", x: 0, y: 0, w: 12, h: 2 },
      { i: "body", x: 0, y: 2, w: 8, h: 8 },
      { i: "meta", x: 8, y: 2, w: 4, h: 3 },
    ],
    md: [],
    sm: [],
  },
};
const derived = deriveResponsive(lgOnly);
check("deriveResponsive fills md from lg", derived.layouts.md.length === 3 && derived.layouts.md.every((c) => c.x + c.w <= GRID_COLS.md));
check("deriveResponsive fills sm as a single column", derived.layouts.sm.length === 3 && derived.layouts.sm.every((c) => c.x === 0 && c.w === 1));
check("deriveResponsive leaves lg untouched", JSON.stringify(derived.layouts.lg) === JSON.stringify(lgOnly.layouts.lg));
check("deriveResponsive does not clobber an authored md", (() => {
  const withMd: CanvasLayout = { ...lgOnly, layouts: { ...lgOnly.layouts, md: [{ i: "title", x: 0, y: 0, w: 6, h: 2 }] } };
  return deriveResponsive(withMd).layouts.md.length === 1;
})());

// --- resolveLayout: null/invalid → default; valid → reconciled ----------

check("resolveLayout(null) → the generated default", resolveLayout(null, "task", []).isDefault === true);
check("resolveLayout(valid) → not default, reconciled to the schema", (() => {
  const raw = defaultLayout("book", bookProps);
  const r = resolveLayout(raw, "book", afterProps);
  return r.isDefault === false && r.layout.cards["prop:isbn"] != null && r.layout.cards["prop:pages"] === undefined;
})());

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
