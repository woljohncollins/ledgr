# An item in two projects

Raised by Brandon, 2026-08-28. **RESOLVED and BUILT the same day: ADR-232.**
Tyler agreed to the per-type split (relayed via Brandon). `home` semantics did
not change, so no migration was needed. The doc is kept for the evidence trail
and for the open edge noted at the end.

## What Brandon wants

An item that genuinely belongs to two projects, showing up in both projects'
cards. Today attaching it to a second project takes it out of the first.

Brandon's refinement (2026-08-28): this should not be one rule for every type.
A **task** and a **milestone** should still live in exactly one project. A
**note**, a **meeting**, a **link** and probably several other types should be
free to belong to more than one. See "Brandon's recommendation" below, which
turns out to line up with where the code's own danger line already sits.

## What the code actually does today

Three facts, because they are easy to get backwards.

1. **`home` is singular and enforced.** `setHome` (src/lib/relations.ts:366)
   calls `clearHomeEdges` first, and a partial unique index
   (`relations_one_home_per_source_uq`) makes a second home edge fail the
   insert. ADR-138 / PJ1 (2026-06-29, decisions.md:1816) states it: "a record
   has at most one home parent".

2. **The collection cards do not use `home`.** Tyler changed this three days
   after PJ1 landed (src/lib/record-widgets.ts:240-248, 2026-07-01): "the box
   should pull anything of that type that is associated with the project",
   role- and home-agnostic. `relatedHome` now only gates the generic Related
   Records box and the Pursuit roll-up.

3. **The dual edge is already written in production.** A note jotted on a
   meeting keeps the meeting as its home and gets a plain `contains` edge to
   the meeting's project so it shows in that project's Docs box
   (src/app/api/records/[id]/contain/route.ts, 2026-07-01). decisions.md:2606
   says it out loud: "a plain `relate_items` was already enough to make a task
   appear in a project's Tasks card. Home is what makes it live there."

So showing an item in two projects' cards **already works**. The only thing
stopping it is that our "attach to a project" write path uses `setHome`, which
evicts the previous home. That is a UI choice, not a schema wall.

## Was one-home deliberate?

Partly. PJ1's "Why / alternatives" paragraph argues four other choices and
never defends the singularity. What it does do, in the same sentence, is carve
out the escape hatch: `home=false` is "surfaced-elsewhere". ADR-001 lists
"single-parent containment" as a settled premise with no argument.

Read plainly: **home was deliberately singular by definition (a "primary
residence"), and multi-placement was deliberately routed to non-home edges.**
"An item can only be in one project" is a consequence of which write path the
UI happens to call, not a decision anyone defended.

The one design that would have needed a single home is the OneDrive export
folder layout. `explorations/storage-organization.md:30` still lists it as
open: "what is each item's one canonical path, given it can have many
relations?" The shipped export never answered it. Paths are `type/year/name`
(src/lib/export/engine.ts:328), completely indifferent to containment.

## What still depends on a single home

Ordered by how much it would hurt.

| Depends on it | Where | What happens with two |
|---|---|---|
| **Project completion sweep** | src/lib/project-completion.ts:14,99 | The real risk. Completing project A would close tasks that also live in B. decisions.md:3359 draws the line deliberately: "scope is containment, not association". |
| DB invariant | the partial unique index | A second home edge fails the insert. Hard blocker, but only for a true second *home*. |
| Activity log subject | src/lib/activity.ts:63 (`homeParentOf`, `.limit(1)`) | A completed task narrates one arbitrary project; the other project's activity silently misses it. |
| Next Action auto-advance | src/lib/item-mutations.ts:695 | Could advance the wrong project's pinned Next Action. |
| Breadcrumb / project chip | src/components/tasks/TaskListRow.tsx:118 | Picks the first home edge. Arbitrary, degrades rather than breaks (there is already a non-home fallback). |
| Parent breadcrumb map | src/lib/task-row-meta.ts:117 | Keyed one parent per child; a second row silently overwrites. |
| Digest milestone lookup | src/lib/digest/notify.ts:64 | Would ping both projects. Probably wanted, currently undecided. |
| Pursuit roll-up | src/lib/record-widgets.ts:156 | A project in two pursuits counts in both. |

Not affected: the export path (see above), progress/points rollups (already
association-wide, already double-counts a related task today), the project
markdown projection (ADR-197) and the project timeline (ADR-198), which both
use the same home-agnostic association the cards use.

## Brandon's recommendation: make it per type

Not one rule for everything. Some types should stay in exactly one project,
others should be free to belong to several:

| Type | Rule | Why |
|---|---|---|
| **task** | one project | It gets completed, it rolls up into progress, it drives Next Action and the breadcrumb chip. Every ambiguity below is a task ambiguity. |
| **milestone** | one project | It carries a points share of one project's progress bar. A milestone in two projects is two different percentages of two different bars. |
| **note** | many | A doc can legitimately serve two efforts. Nothing completes it or counts it. |
| **event / meeting** | many | One meeting really does cover two projects. This is the case that started the conversation. |
| **link** | many | Same reasoning as a note. |
| custom types | probably many, but ask per type | A user type with a Done checkbox behaves like a task (see below). |

### The code already agrees with this split

The project-completion sweep is the one place where loosening `home` could
destroy data, and it draws its line almost exactly where Brandon does. Two
facts from src/lib/project-completion.ts:

1. **A non-home `contains` edge IS swept.** The scope predicate is
   `r.home or r.role in ('project','contains')` (:97-102). So model A's second
   edge does not dodge the sweep by being `home=false`. This matters: it is the
   opposite of what you would guess.

2. **But a type with no completion concept is never swept.** Rule 3 in the
   header comment: "a type with no completion concept (statusMode 'none': a
   person, note, link, event, or receipt)" is skipped and reported, not
   completed.

Put those together: the types Brandon wants to keep single-project (task,
milestone) are exactly the types the sweep touches. The types he wants to free
(note, event, link) are exactly the ones the sweep already refuses to touch.
The dangerous case and the wanted case do not overlap.

The same holds for the other dependencies. Progress and points rollups are
about tasks and milestones. Next Action advances a task. The breadcrumb chip
is on a task row. Nothing downstream cares which project a note primarily
lives in, except the activity log's subject line, which would narrate one of
them.

### The one edge to decide

A user can give any type a Done checkbox in Build, and the sweep comment says
so: "give the type a Done checkbox in Build and it starts being swept." So the
rule should not be a hardcoded list of type keys. Two ways to say it:

- **Derived:** a type may belong to many projects when it has no completion
  concept (`statusMode: "none"`). Self-maintaining, and it means adding a Done
  checkbox silently narrows the type to one project, which may surprise
  someone who already put items in two.
- **Declared:** a per-type flag in the type registry ("can live in multiple
  records"), defaulting to the derived answer but overridable. More honest,
  one more thing to configure.

## What implementing it looks like

Under the per-type rule, the change is small, because the read side already
works (see above). Attach on a card would either call `setHome` (single-project
types: task, milestone) or write a plain `contains` edge and leave the existing
home alone (multi types: note, event, link). One branch, in one write path.

The heavier alternative, true peer memberships with no primary at all, needs a
migration to drop the partial unique index, plus an answer for `homeParentOf`
(`.limit(1)`), the breadcrumb, and the activity subject. Under the per-type
rule, none of that is needed, because the types that would have forced those
answers are the ones staying single.

## The question for Tyler

1. Was one-home a decision you would defend, or the path of least resistance
   while building PJ1? The ADR does not say, so only you know.
2. Does the per-type split above read right to you: tasks and milestones stay
   in one project, notes/meetings/links can belong to several?
3. Derived from `statusMode: "none"`, or a declared per-type flag? Brandon
   leans toward whatever needs the least configuration, but the derived version
   means adding a Done checkbox to a type quietly changes its containment rule.
4. The sweep predicate is `r.home or r.role in ('project','contains')`, so a
   non-home `contains` edge is still swept. Under the per-type rule that never
   bites, since the multi types are skipped for having no completion concept.
   Is that reasoning airtight from where you sit, or is there a case we are
   missing where a completable item picks up a second `contains` edge?
5. Anything you built downstream that assumes one home and is not in the table
   above?

Also worth knowing: several code comments cite **ADR-111** for containment
(relations.ts:333, views.ts:52, item-mutations.ts:695). ADR-111 is the
dashboard canvas ADR. The containment decision is ADR-138 / PJ1. Harmless, but
it sent this investigation down a wrong path for a while.

## What shipped (ADR-232)

The per-type rule, derived from `statusMode` rather than configured, plus two
choices made after this doc was written:

- **The second edge is `related`, not `contains`** (Brandon). A `contains` edge
  sits inside the completion sweep's scope, so it would only be safe by virtue
  of the sweep's separate skip for types with no completion concept. `related`
  is outside the scope structurally.
- **A detach ✕ on merely-related rows is the only visible delineation**
  (Brandon). A row with an ✕ is a visitor; a row without one lives here.

Still open, and deliberately not decided: the derived rule means giving a type a
Done checkbox in Build narrows it to one record from then on. Existing `related`
edges are left alone (the sweep does not touch them), they simply stop being
created for that type. If that ever surprises someone, the fix is the declared
per-type flag this doc originally floated.
