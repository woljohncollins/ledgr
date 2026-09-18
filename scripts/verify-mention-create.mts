// Verifies create-on-miss: what "@Jake Tourtillott" makes when nothing matches
// (2026-08-12). Pure functions plus a structural guard — no DB, no server.
//
// Why this script exists: the behavior it covers is spread across FIVE surfaces
// (the body editor's "@" picker, the capture title's, the task card's, the generic
// "+ Relate" box, and a null-targetType relation field). Before this change each
// carried its own copy of the same POST and they had ALREADY drifted — the three
// "@" pickers sent inbox:true even for a scoped "@/person Jane" while
// RelationField sent inbox:!targetType. Consolidating them is only half a fix if
// nothing stops the sixth site from hardcoding "unmarked" again, so the last
// section greps the real files for exactly that.
//
//   npx tsx scripts/verify-mention-create.mts
import { readFileSync } from "node:fs";
import {
  UNSORTED_TARGET,
  createRowText,
  createTargets,
  needsTriage,
} from "../src/lib/mention-create";
import type { TypeMeta } from "../src/components/search/type-token";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail === undefined ? "" : `  (${String(detail)})`}`);
  }
}

// A registry shaped like /api/types returns it: system + user types, and NOT the
// hidden `unmarked` placeholder (listTypes filters hidden, which is exactly why
// UNSORTED_TARGET is hardcoded rather than looked up).
const TYPES: TypeMeta[] = [
  { key: "task", label: "Task", icon: "tasks" },
  { key: "note", label: "Note", icon: "note" },
  { key: "person", label: "Person", icon: "person" },
  { key: "project", label: "Project", icon: "project" },
  { key: "song", label: "Song", icon: "music" },
];

// --- the unscoped picker (the case the whole change is for) -----------------
const open = createTargets(TYPES, null);
check(
  "an unscoped query offers person, project, then Unsorted",
  open.map((t) => t.key).join(",") === "person,project,unmarked",
  open.map((t) => t.key).join(",")
);
check("person is first (a bare name is overwhelmingly a person)", open[0]?.key === "person");
check("the catch-all is last, never first", open[open.length - 1]?.key === UNSORTED_TARGET.key);
check(
  "the rows carry their type's own icon, so the glyph isn't generic",
  open[0]?.icon === "person" && open[1]?.icon === "project",
  JSON.stringify(open.map((t) => t.icon))
);
check(
  "the catch-all reads 'Unsorted', never the code-facing key",
  open[2]?.label === "Unsorted" && open[2]?.key === "unmarked"
);
check(
  "the picker stays short — a menu to read is not a question to answer",
  open.length <= 3,
  `${open.length} rows`
);

// --- the scoped picker (must look exactly like it did before) --------------
const scoped = createTargets(TYPES, TYPES[4]); // "@/song Cornerstone"
check(
  "a scoped query asks nothing: one row, the scoped type",
  scoped.length === 1 && scoped[0].key === "song",
  JSON.stringify(scoped)
);
check("a scoped row is labelled with that type", scoped[0]?.label === "Song");
check(
  "a scoped query does NOT append the catch-all (the type is already known)",
  !scoped.some((t) => t.key === UNSORTED_TARGET.key)
);

// --- registry gaps ---------------------------------------------------------
const noProject = createTargets(
  TYPES.filter((t) => t.key !== "project"),
  null
);
check(
  "a type missing from this instance is skipped, not rendered dead",
  noProject.map((t) => t.key).join(",") === "person,unmarked",
  noProject.map((t) => t.key).join(",")
);
const empty = createTargets([], null);
check(
  "before the registry loads there is still an escape hatch",
  empty.length === 1 && empty[0].key === UNSORTED_TARGET.key,
  JSON.stringify(empty)
);
check(
  "keys are unique, so React row keys can't collide",
  new Set(open.map((t) => t.key)).size === open.length
);

// --- triage: the one rule that used to differ per surface ------------------
check("the catch-all still lands in the Inbox", needsTriage(UNSORTED_TARGET));
check("a named type does NOT need triage", !needsTriage(open[0]));
check("a scoped type does NOT need triage", !needsTriage(scoped[0]));
check(
  "every offered row except the catch-all is triaged on arrival",
  open.filter((t) => needsTriage(t)).length === 1
);

// --- row text -------------------------------------------------------------
check(
  "the row names what you typed, not the type (the type is the right-edge label)",
  createRowText("Jake Tourtillott", false) === "Create “Jake Tourtillott”",
  createRowText("Jake Tourtillott", false)
);
check(
  "an in-flight create says so on the row",
  createRowText("Jake Tourtillott", true) === "Creating “Jake Tourtillott”…",
  createRowText("Jake Tourtillott", true)
);
check("curly quotes, matching the rest of the UI", createRowText("x", false).includes("“"));

// --- structural: all five surfaces go through the shared creator ------------
// The "do all five or none" invariant. A site that hardcodes the placeholder is
// back to answering the question instead of asking it, which is the bug.
const SITES = [
  "src/components/markdown-editor/mention-suggestion.ts",
  "src/components/capture/MentionTitleField.tsx",
  "src/components/tasks/AddTaskCard.tsx",
  "src/components/relations/AddRelation.tsx",
  "src/components/relations/RelationField.tsx",
];
for (const path of SITES) {
  const src = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  check(
    `${path} creates through the shared creator`,
    src.includes("createMentionTarget")
  );
  // The old shape: `type: typeFilter?.key ?? "unmarked"` / `typeKey || "unmarked"`
  // / `targetType ?? "unmarked"` — a silent default where a question belongs.
  check(
    `${path} does not default a create to the placeholder type`,
    !/(\?\?|\|\|)\s*"unmarked"/.test(src),
    /(\?\?|\|\|)\s*"unmarked"/.exec(src)?.[0]
  );
}
// The placeholder type itself must stay reachable — this change narrows how it's
// CHOSEN, it does not retire it (quick-capture still files straight to it).
const shared = readFileSync(
  new URL("../src/lib/mention-create.ts", import.meta.url),
  "utf8"
);
check(
  "the placeholder type is still offered, from one place",
  shared.includes('key: "unmarked"')
);
check(
  "the inbox rule lives in one expression, so it flips in one edit",
  (shared.match(/export function needsTriage/g) ?? []).length === 1
);

console.log(
  failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE${failures === 1 ? "" : "S"}`
);
process.exit(failures === 0 ? 0 : 1);
