# Mindmap tool — PRD (draft)

**Status:** ✅ v1 BUILT (2026-06-21) — pending in-browser eyeball. A bespoke module = "move fast, solo" per CLAUDE.md (an ADR only if it reaches into core). Scoped deliberately small: a **simple** mindmap whose canonical form is a **markdown file**. This doc captured the scoping conversation; the build followed it (Sections 2–6 as specced; the bespoke-SVG renderer from §5; §7 items deferred as fast-follows). Code: `src/lib/mindmap/`, `src/lib/modules/mindmap.ts`, `src/components/canvas/Mindmap*`, `scripts/seed-mindmap.mjs`. See `next_steps.md` → "Mindmap module".

> A mindmap is just a nested list. Everything below is a structured **view over one `markdown` body** (Principle: markdown is the source of truth, ADR-037). The radial/tree canvas is how you author and read that nested list; a plain `.md` upload reconstructs the whole map from the file. Nothing is stored as a second source, and the OneDrive export already emits the `.md` for free (Principle 1: DB canonical, export one-way).

---

## 1. Purpose

A bespoke `mindmap` type for thinking outward from a center: a brainstorm, a sermon-idea spray, a project breakdown, an outline-in-the-making. The user adds the Mindmap module to get a spatial, expand/collapse map canvas on top of an item, and what they build **is** a markdown nested list they can export, hand-edit, or feed into anything else.

The thing to keep simple: we are not building Miro. v1 is a **tree** (one root, nodes with children), auto-laid-out, edited in place. Free-form node positions, cross-branch links, colors, and images are explicitly **out of scope for v1** (Section 7) precisely because they are the features that would force a second non-markdown store.

## 2. The type and where it fits

- A `mindmap` is an **item** (`items.type = "mindmap"`), markdown-canonical (`body.format = "markdown"`). One row, one body, like every other item (Principle 2).
- Registered as a **module** (`ModuleManifest` in `src/lib/modules.ts`, registered in `src/lib/modules/register.ts`) declaring a `mindmap` type whose `canvasId: "mindmap"` is wired into the `CANVAS_COMPONENTS` map in `src/lib/module-wiring.tsx`. Resolution: `canvasIdForType()` (`src/lib/modules.ts`) maps the type to its canvas id, `canvasComponentFor()` maps the id to the component. The type is seeded in `scripts/seed.mjs`. Core is untouched: an unregistered/unwired `mindmap` row falls back to `DEFAULT_CANVAS = "markdown"` (where you'd just see the nested list as text), so the module only adds the spatial rendering/editing behavior.
- **It's a capability, not just a type ("add it to your type").** This is the answer to "a bespoke tool people can add to their type." Ledgr already has an attachable-behavior mechanism: a module declares a `ModuleCapability` (`{ id, label, description, usage, canvasId, canonicalFormat }`, see `src/lib/modules.ts`; the Chord and Paper canvases are offered this way), and a user attaches it to their **own** custom type via the `types.capability` column. So the Mindmap module ships both:
  1. a ready-made `mindmap` **type** (for "I just want a mindmap"), and
  2. a `mindmap` **capability** (`canvasId: "mindmap"`, `canonicalFormat: "markdown"`) any custom type can adopt to get the map canvas. A user's "Brainstorm" or "Project" type can *become* a mindmap by attaching this, no new type needed.
- **No bespoke exporter needed.** Because the body is already a markdown nested list, the standard markdown/OneDrive export emits the `.md`. That satisfies the "outputs as a markdown file" requirement with zero new export code.
- **Properties:** keep v1 minimal. `status` (optional select) and whatever the user adds. People/meetings/notes relate in via the generic relations panel; cross-links between mindmap *nodes* are out of scope for v1 (Section 7).

## 3. The data model: a markdown nested list is canonical

This is the whole design. The mindmap maps 1:1 to a markdown document, [markmap](https://markmap.js.org/)-style:

- **Root node** = the document's top heading (or the item title). One root in v1.
- **Branch nodes** = nested bullet list items. Indentation depth = distance from the root. A node's children are the list items nested under it.

Example body (`items.body.text`):

```markdown
# Sunday series ideas

- Identity in Christ
  - Adoption
  - "No condemnation" (Rom 8)
- Spiritual disciplines
  - Prayer
    - Fixed-hour
    - Examen
  - Scripture intake
- Community
  - Small groups
  - One-anothers
```

That document renders as a center node "Sunday series ideas" with three main branches, each expanding outward. Edit the map and the markdown updates; edit the markdown (or upload a hand-written `.md`) and the map reconstructs. The nested list **is** the mindmap.

Why this shape:
- **Round-trips losslessly** with no sidecar data, because a tree of text nodes is exactly what a nested list expresses.
- **Export is free** (Section 2).
- **Forgiving import**: any markdown file that's mostly a nested list produces a sane map, the way the Papers outline parser tolerates loose input.
- **No body-vs-sidecar problem**: v1 stores *no* node positions or layout. Layout is **computed deterministically** at render time (Section 4), never persisted. This is the deliberate trade that keeps v1 pure-markdown.

## 4. The canvas (simple v1)

A single canvas (no tabs). It parses the nested list into a tree, lays it out, and renders interactive nodes.

**Layout:** deterministic, computed from the tree, not stored. v1 picks one layout (proposed: left-to-right tree, the most legible for outline-shaped content; radial is a later option). Same body always produces the same layout.

**Interactions (v1 scope):**
- **Add child / add sibling** to any node (clear `+` affordance, low friction).
- **Edit node text** in place.
- **Delete node** (with its subtree, matching outline-section semantics).
- **Collapse / expand** a branch. Collapse state is a UI affordance, ephemeral in v1 (persist per-item later only if it earns it, same call the Sermons PRD made).
- **Reorder by drag = move the subtree.** Grab a node and its descendants travel with it. This maps exactly to moving a list item (and its nested items) in the markdown, so DnD round-trips. Reuse the no-dependency touch-drag work (`src/lib/board-touch-drag.ts`, `useBoardTouchDrag.ts`); no DnD library (Principle 5).
- **Pan / zoom** the canvas (basic), since maps outgrow the viewport.

**Everything writes back to the one markdown body** (debounced, snapshotting to `revisions` like every other item per the working conventions).

## 5. Rendering approach (the one real decision)

Two ways to draw an editable tree, and they trade Principle 5 (few deps) against build effort:

- **(A) Bespoke SVG/DOM renderer (leaning this).** Compute a tree layout (a small, well-known algorithm) and render nodes as positioned DOM/SVG with our own edit affordances and the existing touch-drag. Zero new dependency; full control over inline editing, which is the part libraries are weakest at. More layout code to write.
- **(B) `markmap-lib` + `markmap-view`.** Purpose-built markdown→interactive-mindmap, and its input format is literally our nested-list convention, so it would render the body almost as-is. But markmap is **read/zoom-oriented**: it renders a map, it does not give you in-canvas node editing, add/delete, or drag-reorder. We'd still build all the editing ourselves and fight its render loop, and we'd own a non-trivial dep (Principle 5). Possible role: a fast **read-only preview** while editing happens in an outline pane, if we ever want that split.

**Recommendation:** start with **(A)** for an actually-editable map with no new dependency. Revisit markmap only if we decide v1 is "edit as an outline, view as a map" rather than "edit on the map."

## 6. Output as a markdown file

This is a stated requirement and it's already satisfied by the data model:
- The item's body **is** the markdown nested list, so the standard **OneDrive / markdown export** writes the `.md` with no mindmap-specific code.
- Add a lightweight **"Copy as markdown" / "Download .md"** affordance on the canvas for the in-app case (trivial: it's just `body.text`).
- The emitted file is markmap-compatible, so it also renders in any markmap viewer if the user wants a quick external render.

## 7. Out of scope for v1 (and why)

These are the features that would each force a non-markdown store or a big jump in complexity. Parked deliberately:
- **Free-form node positions** (drag a node anywhere on an infinite canvas). Would require persisting x/y per node outside the markdown → breaks pure-markdown canonical. v1 uses computed layout only. (If we ever want this, it pairs with `explorations/canvas-drag-and-drop.md` and needs a position sidecar decision.)
- **Cross-branch links** (a node linked to another node, making it a graph not a tree). Markdown nested lists are trees. Cross-links would lean on the `relation` property kind / wiki-links (ADR-067) and a graph renderer. Later.
- **Multiple roots** on one canvas.
- **Per-node color / styling / icons / images.** Pandoc attribute spans could encode some of this in markdown later, but the body dialect does **not** allow them today (ADR-190 removed the claim that it did; nothing parses or renders `{.class}`), so this would need the dialect extended first. Not v1. The existing `<span style>` color HTML is the shipped way to carry per-span styling.
- **Collaborative / real-time** editing. Single-user (Principle 7).

## 8. Open questions

- **Root = title or top `#` heading?** Leaning: the top `#` heading is the root; fall back to the item title if absent. Decide at build.
- **Headings vs. pure bullets for structure?** markmap treats `#` headings as top levels then bullets below. Simpler v1 rule: one `#` (root) + nested bullets for everything else. Confirm the parser is forgiving of a file that's all bullets (synthesize a root from the title).
- **Layout: left-to-right tree vs. radial for v1?** Leaning left-to-right (most legible for outline-shaped content); radial as a toggle later.
- **Collapse state: persist or ephemeral?** Ephemeral first (matches Sermons PRD), persist per-item only if it earns it.
- **Editing model:** edit directly on the map (option A) vs. an outline pane with a live map preview. Leaning edit-on-map, but the outline-pane split is the cheaper build if A's inline editing gets fiddly.

## 9. Build precedent / pointers

- **Module seam:** `src/lib/modules.ts` / `src/lib/module-wiring.tsx` (register the `ModuleManifest` + canvas), `scripts/seed.mjs` (seed the `mindmap` type row). Same path the Sermons module PRD documents.
- **Tabbed-canvas-over-one-markdown-body precedent:** the **Papers module** (`src/lib/papers/`: `outline.ts` parses a markdown outline into a tree; `src/components/paper-editor/`). The outline parser is the closest existing "markdown nested structure ↔ tree" code; borrow its parse/serialize approach for the list↔tree mapping.
- **No-dependency DnD:** `src/lib/board-touch-drag.ts`, `useBoardTouchDrag.ts`, and `explorations/canvas-drag-and-drop.md` for the zero-dep drag stance.
- **Body format contract:** `items.body` = `{format, text}` jsonb, `format: "markdown"`; markdown is the source of truth (ADR-037). Snapshot to `revisions` on save (working conventions).
- **Related parked docs:** `explorations/canvas-drag-and-drop.md`, `explorations/item-canvas-layout.md`, `explorations/related-items-discovery.md` (the cross-link/graph direction, deferred per Section 7).
