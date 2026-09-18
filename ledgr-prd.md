# Ledgr — Product Requirements Document

**Owner:** Brandon Collins
**Status:** Draft v0.18 — **Markdown epoch**
**Last updated:** June 13, 2026

> **⚠️ Architecture epoch — Markdown-canonical (v0.18, 2026-06-13).** This document turned a corner from v0.17. Two foundational decisions changed, recorded in **ADR-037** and signalled by the git tag `v0.17-blocknote-canonical` (the last pre-pivot state): **(1)** the canonical body format is now **Markdown** (an extended dialect), not BlockNote JSON — markdown is the source of truth and every rich output renders from it; **(2)** the system is **bespoke-first** (each content type designed with its own features and, where useful, its own canvas, plus one customizable catch-all type), not "Notion-default / one generic canvas." Ledgr is also now built by **two people** (Brandon + Tyler) sharing one codebase across separate single-tenant deployments. Where older prose below still reads "BlockNote canonical," "Notion-default," or "every item opens the same canvas," ADR-037 governs. Sections have been updated to match; this banner stays as the marker of the turn.

---

## 1. Overview

Ledgr is a personal life management system replacing Notion, built by Brandon and Tyler as one shared codebase with separate single-tenant deployments. It stores meetings, tasks, notes, saved links, and richer workflow items (songs, papers, sermons, and more) as **Markdown documents** (an extended dialect that carries colors, footnotes, and chords) in a relational database, presented through a custom web app (PWA) and integrated with the ecosystems each instance lives in (Microsoft 365 and Todoist for Brandon; Google Workspace and iCloud for Tyler, behind the same provider seams).

The system follows one architectural rule: **the database is the source of truth, and OneDrive receives a one-way markdown export** for backup, portability, and preach-from-anywhere resilience.

### Why replace Notion

Notion's strengths (relational databases, "go deeper" pages, markdown storage, good formatting) come bundled with dealbreakers:

- No Microsoft integration: calendar and email, the center of Brandon's work life, can't connect
- Clunky task management and a difficult mobile app
- Hard to back up; data lives behind Notion's API
- AI agents are prohibitively expensive relative to Brandon's Claude access
- Notion AI can't reach local files or other systems

### Design principles

1. **DB-canonical, file-exported.** One-way sync to OneDrive. No bidirectional sync, ever.
2. **Everything is an item.** One table, typed, mirrors the Notion mental model.
3. **Relations are real.** Foreign keys and join tables, not wikilinks.
4. **Claude is a first-class client.** An MCP server exposes the system to Claude on desktop, Cowork, and mobile.
5. **Boring stack, few dependencies.** Every package is a future maintenance event.
6. **Sunday-proof.** The app can be down and Brandon can still preach (from the OneDrive export).
7. **Deterministic by default, AI on purpose.** Routine plumbing (calendar matching, metadata extraction, formatting, sync) is plain code with no model in the loop. AI is reserved for high-judgment, low-frequency, human-in-the-loop work invoked deliberately through the Claude/MCP layer, never baked into a cron job.
8. **Bespoke-first, one catch-all (v0.18, supersedes "Default to the Notion experience").** Design each content type with the features that type actually needs, and give it its own canvas where that earns its keep. A single customizable catch-all type absorbs temporary or unanticipated uses; a catch-all use that proves itself gets promoted to a permanent bespoke type. Notion remains a reference for individual interactions and Brandon's muscle memory where it fits, but the system is no longer generic-first. (The prior principle was: match Notion's UX by default. See ADR-037.)
9. **Fast for the user, cheap on the back end.** Every design choice is weighed on two axes at once: perceived speed in the user's hands (optimistic updates, instant cached reads, lazy loading) and back-end thrift (minimal compute, storage, and traffic). Neither is sacrificed quietly for the other (see §6.5).
10. **Observable and debuggable.** The app is built to be diagnosed by a solo maintainer working with Claude Code: structured logging, a toggleable debug mode that surfaces detailed errors and timings, clear human-readable error messages, and documentation (inline and in the runbook) kept current. When something breaks on a Saturday, the goal is a fast, legible trail to the cause (see §6.6).

---

## 2. User and context

v1 has exactly one user: Brandon, Executive Pastor at Edgewood Community Church (four campuses). However, staff accounts are a plausible future, so the schema is **multi-user-ready from day one**: every item carries an `owner_id`, queries are always owner-scoped, and auth uses a real users table with one row. This costs little now and avoids a painful retrofit later. What v1 does *not* build: invitations, permissions UI, sharing-to-accounts, or co-editing. Microsoft 365 church tenant (Outlook calendar/email, OneDrive, Teams). Existing Todoist account. Heavy Claude user (Cowork, Code, mobile). ~20GB Notion workspace to selectively migrate.

Primary devices: Windows desktop/laptop (deep work), iPhone (capture, reminders, reading), occasionally preaching from a tablet or printed page.

### Core workflows to support

1. **Capture:** one-line task or note from any device in under 10 seconds, including forwarding an email
2. **Go deeper:** open any item and expand it into a full document or project dashboard
3. **Meeting prep:** open a 1:1 note pre-populated with open tasks, recent meetings, and agenda headings for that person
4. **Write and preach:** compose a sermon with rich formatting, deliver it from the app or the OneDrive export
5. **Task flow:** see what's due, get reminded on mobile (via Todoist), check things off anywhere
6. **Review:** find anything via search or tag, including archived material

---

## 3. Data model

### 3.1 Items (the one big table)

Every unit of life is a row in `items`:

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `owner_id` | uuid | FK to `users`; one row in v1, multi-user-ready |
| `type` | text | FK to `types.key` (§3.6); built-in keys `task`, `meeting`, `note`, `link`, `entity`, extensible with user types |
| `title` | text | The "one-liner"; may be the entire content |
| `body` | jsonb | Canonical body, stored as `{format, text}` — `format: "markdown"` (default; an extended dialect, §4.1) or a markdown-family format like `chordpro` per type; `text` is the source of truth. Rich outputs (docx/PDF/chart) render from it (§6.1). Null until "gone deeper"; **never selected in list queries** |
| `status` | enum | `open`, `done`, `archived` (task-relevant; others default `open`) |
| `due_date` | timestamptz | nullable |
| `urgency` | enum | `low`, `normal`, `high`, `critical`; nullable |
| `meeting_at` | timestamptz | meetings only |
| `url` | text | links only; original web address |
| `todoist_id` | text | nullable; set when synced to Todoist |
| `ms_event_id` | text | nullable; set when created from a calendar event |
| `parent_id` | uuid | nullable; self-FK to `items.id` for subtask/containment hierarchy (§3.5) |
| `properties` | jsonb | nullable; user-defined custom fields (§3.6); GIN-indexed for filtering |
| `created_at`, `updated_at` | timestamptz | |

### 3.2 Entities (the unified tag system)

Notion's "Tags database" pattern carries over directly. An **entity** is itself an item (`type = entity`) representing a person, organization, campus, project, or topic: Roger, Edgewood, WPN, Sermon Series. Entities have bodies too, so `Roger` can hold notes about Roger.

Entity subtype lives in a `kind` field on entity items: `person`, `org`, `project`, `topic`, `campus`.

### 3.3 Relations

A single join table relates anything to anything. Because everything is an item (entities included), this is modeled as a generic page-to-page edge, exactly like a Notion relation, rather than an item-to-entity link:

```
relations (
  id          uuid primary key,
  source_id   uuid not null,                      -- edge start (FK items.id)
  target_id   uuid not null,                      -- edge end (FK items.id); often an entity, but any item is valid
  role        text not null default 'related',    -- optional label: 'tagged', 'attendee', 'references', ...
  match_state enum default 'confirmed',
  unique (source_id, target_id, role)
)
```

Both columns are plain item ids with no type restriction, so the same table carries "tag" edges (target is an `entity` item like Roger or Edgewood) and item-to-item edges (a meeting referencing a note). This mirrors Notion, where a relation just connects two pages and a tag is simply a relation to a page in the Tags database. The optional `role` distinguishes kinds of link when it matters (Notion's named relation properties); leave it `'related'` for a generic edge.

`match_state` (`confirmed` | `suggested`) lets the UI show fuzzy or auto-generated matches as provisional until Brandon confirms them (§5.1). Manual and wizard-confirmed links default to `confirmed`; nothing `suggested` is treated as a real relation in queries until confirmed.

Tagging a task "Edgewood" = an edge from the task to the Edgewood entity. The Roger 1:1 task list is `SELECT i.* FROM items i JOIN relations r ON r.source_id = i.id WHERE r.target_id = :roger AND i.type = 'task' AND i.status = 'open'`. Backlinks ("what's connected to this item," §4.9) query both directions: `WHERE source_id = :me OR target_id = :me`.

### 3.4 Attachments

Large files do **not** live in the database. An `attachments` table stores metadata (filename, size, content type, storage key, parent item). Files themselves live in object storage (Cloudflare R2), behind a thin storage-provider interface so the back end isn't married to one vendor. Upload and download use presigned URLs (bytes never proxy through the app server), files serve through R2's CDN with long cache headers and pre-sized thumbnails, and each user has a quota (e.g., 10GB). This keeps the DB tiny, serves fast, and generalizes to any user without requiring a Microsoft account.

R2 is the recommended provider for its economics: roughly 10GB free, about $0.015/GB-month after, and no egress fees, which is what keeps a media-serving app inside the $0 target. The OneDrive export (§5.4) still receives copies of attachments for backup and offline preaching, so OneDrive remains the disaster-recovery and pulpit fallback, just not the hot-serving path.

### 3.5 Hierarchy (parent/child)

Containment (a subtask belonging to a task, that task belonging to a project) is a different relationship from association (tagging, references), so it gets its own mechanism: a self-referential `parent_id` on `items`. The child stores the id of the item above it, which directly answers "which one is on top," since the hierarchy is always read from the child upward.

- **Single parent.** An item has at most one parent (its container), matching Notion's sub-item model. Additional, non-containment links still use the relations edge table (§3.3), so a subtask can also be tagged to other people or projects without confusing the tree.
- **Projects are emergent.** A task with children renders as a mini-project: a parent view with its subtask checklist and a progress rollup (percent of children done), computed deterministically. There's no separate "project" machinery to maintain, and depth is open, so project → task → subtask is just three levels of the same pointer. ("project" also remains available as an entity kind for higher-level grouping that isn't strict containment.)
- **Guards.** The app prevents cycles (an item can't become its own ancestor) and uses a recursive query (`WITH RECURSIVE`) to fetch a whole tree.
- **Delete behavior.** Soft-deleting a parent takes its children to Trash with it so the unit restores together (§4.6), rather than silently orphaning them.

Why a dedicated column rather than folding this into the relations edge: trees want a clean single-parent pointer for fast recursive queries and an enforceable "one container" rule, and keeping containment separate from association stops "show me the subtask tree" from having to filter associative links out of the same table.

### 3.6 Custom types and properties (schema-ready v1, builder v3)

Beyond the built-in types, Brandon can define his own (Book, Movie, Sermon Series) the way Notion and Anytype allow, without code. The model stays faithful to "everything is an item" and "a database is a page":

- **Types live in an extensible `types` table, not a hard-coded enum.** Each row has a stable `key`, a label, an icon, an `is_system` flag, and (later) a property schema and default view. The five built-ins (`task`, `meeting`, `note`, `link`, `entity`) are seeded `is_system = true` rows whose `key`s the code keys its bespoke behavior off (§3.7). Creating "Book" just adds another row. This is the Gmail-labels pattern: system labels get special handling, user labels just organize, and you can add as many as you like. `items.type` is a foreign key to `types.key`.
- **A Type behaves like a page** (Anytype-style), so a Type can hold its own notes, property schema, and default view. Defining "Book" gives properties like Author (relation to a person entity), Status (select), Rating (number), Finished (date).
- **Items carry a `properties` JSONB bag** for their custom fields, so adding or changing a property is a config edit, never a database migration. Hot, queried fields (`due_date`, `status`, and the like) stay as real columns; user-defined fields live in JSONB, GIN-indexed for filtering.
- **A core set of property kinds** covers nearly everything: text, number, date, select, multi-select, checkbox, url, and relation (relation reuses the §3.3 edge table).
- **Views come free** from saved views (§4.2, §4.9): a Type's default view is just a stored filter plus layout over items of that type.
- **Deliberately out of scope:** formulas and rollups (beyond the simple subtask progress rollup in §3.5). They're the deep end of the Notion model and sit in the ideas parking lot; the JSONB design doesn't preclude adding them later.

**Phasing:** the `types` table and the `properties` JSONB column both ship in Phase 1, seeded with the five system types (near-zero cost, avoids a later migration). The user-facing "create a type / add properties" builder is Phase 3. This matches the multi-user-ready posture: cheap structural readiness now, product surface later.

### 3.7 Built-in vs custom types: capability tiers

Core types and custom types are not two separate systems, they're one type system with two tiers of behavior. Every item, built-in or custom, is a row in `items` with the same CRUD, search, and storage. What differs is how much bespoke behavior the platform ships for it.

*Implementation note:* built-in and user types are the same `types` table (§3.6); built-ins are `is_system = true` rows, shipped pre-built, bound to reserved columns, and wired to code by their stable `key`. This is the standard-object vs custom-object pattern proven in tools like Salesforce (and the Gmail system-vs-user-label pattern), and it keeps one mental model instead of two.

Three layers of capability, from universal to bespoke:

1. **Universal (every item, built-in or custom):** create/read/update, soft-delete and revisions (§4.6), full-text search, tagging and relations (§3.3), parent/child hierarchy (§3.5), and OneDrive export (§5.4). A custom "Book" type gets all of this for free.
2. **Property-kind-driven (any type with the right property):** behaviors keyed off a property's *kind*, not the type's identity. A date property lets an item appear in calendar and agenda views; a checkbox or status property makes it completable; a select property enables board grouping; a relation property powers backlinks and embedded views. Which views actually surface a given type is itself configurable per view (§4.2). Custom types are therefore not inert, they inherit generic behavior by declaring the right properties, exactly as a Notion database does.
3. **Type-specific code (built-in types only):** the bespoke plumbing that justifies hard-coding a type, Todoist sync (tasks), calendar sync and prep templates (meetings), link unfurling (links), planning modules (§4.8). These require code that understands the type's meaning, so they're reserved for the curated built-in set and deliberately withheld from custom types.

Why this split is right: hard-coding the handful of types Brandon lives in lets the platform deliver reliable core functionality and real integrations out of the box, avoiding the common Notion pitfall where the user has to assemble their own task system from generic parts. The custom-type sandbox then absorbs everything else ("I want to track books") without each new type demanding bespoke engineering, and the middle layer keeps that sandbox genuinely useful rather than a dead-end store. The rejected alternative, going fully generic with no privileged types (pure Notion), is exactly what reintroduces that pitfall and makes the integration plumbing brittle.

**v0.18 sharpening (ADR-037):** this tiering is now the default posture, not a curated exception. Ledgr is **bespoke-first** — most types are Tier-3 (their own features and, where useful, their own canvas, §4.13), and Tier 2 collapses toward a **single customizable catch-all type** for the temporary or unanticipated tail. A catch-all use that recurs gets **promoted** to a permanent bespoke type (Claude Code does the conversion). A Tier-3 type can also be packaged as a **contributed workflow module** (a type + canvas + exporters + optional integration) that registers onto the shared frame, so an instance can choose which modules it runs (module-ready; see §6.1 and the collaboration model in CLAUDE.md).

## 4. Features

### 4.1 Editor (markdown-canonical, v1)

**Canonical body format is Markdown** (v0.18, ADR-037), an extended dialect rich enough to carry everything Brandon's and Tyler's content needs: CommonMark/GFM as the base, inline HTML (`<mark class="hl-blue">…</mark>`, `<span style="color:#…">…</span>`) for the sermon colors/highlights that plain markdown can't hold, and markdown-family formats like ChordPro for songs (declared per type). Papers handle their own Pandoc-style footnotes (`[^id]`) inside the Papers module rather than through the shared dialect (ADR-048, ADR-190). The markdown *is* the stored document; rich features layer on top of it, and every other artifact (Word/`.docx` via the `docx` package, chord charts, slides, print/PDF) is rendered from the markdown on demand, never a second source of truth.

- **Markdown-native WYSIWYG editor.** The editing surface renders rich (headings, lists, checkboxes, quotes, dividers, code, bold/italic, highlight + text colors — enough to write and preach a sermon), not raw markdown, with a likely source/preview toggle for people who want the plain text. The specific library is TBD (tiptap / Milkdown / Lexical with markdown serialization, or any editor that can treat markdown as its store losslessly); BlockNote is one candidate, no longer the canonical-defining choice.
- **Per-type canvas.** A content type may declare its own canvas (a chord editor for songs, a paper workspace with a quote-bank sidebar for papers); a type without one gets the default markdown canvas (§4.13).
- **Color/highlight fidelity** rides the inline-HTML encoding above. A single color-to-tag mapping table keeps the renderers (export, print, on-screen) in sync. Obsidian's reading view, GitHub, and most viewers render it with no plugin; a CSS snippet can theme the class names. Pure serialization, no model.
- Paste images inline (stored as attachments in object storage per §3.4, rendered in place).
- Links to other items via `@`-mention (creates a relation row automatically).
- **The "Notion feel"** (slash menu, drag-to-reorder blocks) is desired and may be reproduced later or adopted from an existing library; it is explicitly **not** a v1 requirement, the cost paid to make markdown the durable base.

### 4.2 Views

- **Today / dashboard:** today's calendar meetings, tasks due today/overdue, quick-capture box (the Phase 1 fixed-layout seed of the widget dashboard, §4.11)
- **Inbox:** items that arrived untriaged (email-in, Todoist inbox pull-ins, share-target captures) awaiting type/entity/date assignment
- **Per-type lists:** tasks (filterable by status, urgency, due, entity), meetings (timeline), notes, links
- **Entity pages:** open any entity and see all related items grouped by type — the Notion "tag as dashboard" experience
- **Search:** full-text across titles and bodies (Postgres FTS), filtered by type/entity/date
- **Saved & custom views:** every view is a stored **View Definition** (filter, sort, grouping, layout, and which types/date-property it surfaces); see below

**Views are configurable, and built-in views are editable seeds.** A View Definition holds a filter (types, entities, status, date horizon, custom-property conditions), a sort and grouping, a layout (list, table, board, calendar, agenda), and, for time-based layouts, which date property drives placement and which types appear. The built-in views (Today, Inbox, per-type lists) ship as `system`-flagged View Definitions that Brandon can tweak or clone, so if the default Today view isn't right he edits it, and if he wants a 3-day agenda, a 1-week board, or a 3-month calendar filtered his own way, he builds one. This is the same engine as embedded query views (§4.9), just surfaced in navigation instead of inside a page, and the same `system`-vs-user pattern as types (§3.7), so it reuses a concept the architecture already needs rather than adding new complexity. Layout breadth is scoped to a core set (list, table, board, calendar, agenda); gallery, Gantt, and similar stay in the parking lot. **Phasing:** built-in views and simple list filters in Phase 1, the full view builder with multiple layouts in Phase 2 (alongside embedded views).

### 4.3 Meeting prep (the Roger scenario)

When a meeting item is created (manually or from calendar sync) with a person entity attached, its body is pre-populated from a template:

1. Open tasks related to that person (live query rendered as checklist)
2. Links to the last 3 meeting items sharing that person
3. Agenda / Notes / Action Items headings

Action items checked or written during the meeting can be promoted to task items (one click → creates task, relates it to the person, optionally pushes to Todoist).

### 4.4 Quick capture

- Global "new item" affordance on every screen, keyboard shortcut on desktop
- Title-only creation; type defaults to task; date/urgency/entity optional inline
- PWA share target: share a URL from the phone → creates a `link` item with URL and page title

### 4.5 PWA (v1)

- Installable on iOS/Android, responsive layouts for all core screens
- Web push notifications for: morning agenda summary, meeting-prep-ready notices
- ~~Task *reminders* remain Todoist's job~~ **Reversed (ADR-073/079):** tasks are native; reminders come from a Ledgr-published **ICS subscription feed** (any calendar app fires them) plus the web push above. Todoist is now an optional adapter behind the `tasks` seam.
- Offline: read-only cache of recently viewed items (best effort, not a sync engine)
- ~~Offline *capture* is explicitly Todoist's job~~ **Reversed (ADR-073/080):** offline capture is a native client outbox that syncs on reconnect (the PWA share-target + the Today/capture queue).

### 4.6 Revision history and soft deletes (v1)

- Deleting an item is a soft delete: it moves to a Trash view and purges after 30 days
- Document bodies snapshot to a `revisions` table on save (debounced), keeping the last ~50 versions per item with a simple "restore this version" action
- Rationale: without this, an editor bug or a fat-fingered delete is catastrophic instead of annoying. This is v1, not optional.

### 4.7 Pulpit Ready (v1)

The nightly export is not enough for a sermon finished Saturday at 11pm. Any document gets a one-tap **Pulpit Ready** action that:

1. Exports it to OneDrive immediately (not waiting for cron)
2. Pins it to the PWA offline cache with verification ("cached ✓" confirmation, not best-effort)
3. Generates a clean, print-styled PDF alongside the markdown

Rule of thumb the feature encodes: nothing preached on Sunday depends on Vercel, the database, or church wifi being up.

### 4.8 Planning rhythms (v3)

A **planning ritual** is a named, configurable routine tied to a time horizon (daily, weekly, monthly, 90-day, annual, 3-year) and triggered either manually ("Start weekly planning") or on a schedule. Each ritual is assembled from modules the user turns on, so the shape of a weekly plan is the user's to define. This holds to Principle 7: the modules are deterministic queries and actions, and only the final agenda synthesis uses a model, running in the Claude/MCP layer.

Module catalog (enabled per ritual):

- **Meetings:** pull every calendar item across the horizon, each with an **Add** button that spawns its meeting-note template (§4.3), so initial thoughts (talking points, coaching goals, personal-connection ideas) can be seeded ahead of time
- **Tasks:** surface overdue and stale tasks to clear, holding-bin (undated) tasks to schedule, and a space to envision upcoming tasks
- **Goals:** review and set goals, including people and relational goals tied to person entities
- **Data hygiene:** scrub and tidy (untriaged inbox items, orphaned tasks, stale entities)

How the day-of agenda assembles: the manual pass above seeds thoughts onto meeting items in advance. Then a daily planning step, which can fire automatically as a scheduled Claude task, reads those seeded notes, combines them with deterministic searches across recent action items, tasks, and prior meetings for the same people, and drafts the full agenda for review. The searches do the gathering, the model only does the synthesis, and the output is a draft Brandon edits rather than an autonomous action.

A ritual is itself an item, so a "Weekly Plan — Jun 15" note links to everything it touched and stays searchable. It needs almost no new schema (rituals reference items through the existing relations table), which is part of why it can wait safely.

**Phasing:** targeted v3. The scaffolding rides on calendar sync, meeting templates, task management, and search (Phase 1-2) plus the Claude/MCP layer for synthesis (Phase 3), so it can't meaningfully precede them. The thin manual slice (the Meetings module's Add-to-template) could ship late Phase 2 as an extension of meeting prep, but the AI-assembled agenda waits for Phase 3.

### 4.9 Linked views, backlinks, and inline editing

Two related capabilities make "relations are real" tangible from inside any item.

**Backlinks panel (Phase 1).** Every item's detail view shows what it's connected to, computed by traversing the relations table in both directions: the people, meetings, projects, and notes linked to it, grouped by type and clickable. Because relations exist from day one, this is cheap, and it's the payoff for the join-table model. Suggested vs confirmed links (§3.3) render differently here too, so a provisional calendar match is obvious right where you'd act on it.

**Interactive embedded query views (Phase 2).** A saved filter can be embedded inside a document or entity page as a live list. The Roger meeting note's "open tasks" checklist (§4.3) is the first instance, now generalized:

- **The query is editable.** The filter is a structured spec (entities, type, status, due predicate, sort), for example "tagged Roger AND (due within 7 days OR no due date)," and Brandon can adjust it inline.
- **The list is interactive.** Each row is the real item, so a typo gets fixed, a box checked, or a date changed in place, all PATCHing the item without leaving the view (optimistic update).
- **Create inherits the view's filters.** Adding an item from the view pre-fills it from the filter's assignment clauses, so a new task here is auto-related to Roger. Range or OR predicates (like the due window) stay blank rather than guess a value, since they're ambiguous.
- **Remove means un-relate, not delete.** Removing a row from a filtered-by-entity view drops the relation (un-tags it) and never deletes the underlying item. Deletion stays explicit and soft (§4.6).

Implementation: embeddable views are a custom markdown construct (a fenced directive / code block whose attributes hold the filter spec), and the same renderer powers entity pages and meeting-prep templates. Live queries re-run on load, fine at single-user scale with indexes on `relations` and `due_date`.

### 4.10 Two-surface architecture: Work and Build

The app presents two distinct surfaces, switched from a toggle/dropdown in the main menu (the WordPress front-end/back-end pattern, but the builder is visual rather than code):

- **Work** is the daily-use surface: the dashboard, views, items, capture. It's shaped to make working easy.
- **Build** is the configuration surface: creating custom types and properties (§3.6), defining views (§4.2), assembling workflows and wikis (§4.14), and choosing what surfaces where on Work. It's shaped to make building easy.

The connective idea is **building blocks**: Build produces structures (types, tables, views), and the user wires them into slots that Work exposes, which are dashboard widgets (§4.11) and navigation slots (§4.12). Build can hold fifty databases, but only the handful wired into Work are ever in the user's face; the rest are data feeding other things, exactly the Notion pattern of a hidden "data" section powering visible dashboards, made first-class.

Two consequences:

- **Work ships first.** It's the simpler UI and the one Brandon lives in daily. Build's full surface (the type/property builder, workflow and wiki templates) is Phase 3, though pieces of configuration (view tweaks, matcher rules) exist earlier in lightweight forms.
- **New users start with structure, not a blank slate.** The core modules already specced (tasks, meetings, notes, links, entities, plus the system views) come pre-loaded, so the app is usable out of the box and customizable from there. This directly answers the core Notion complaint of opening to an empty page with no guidance, and it's already how the architecture works: the five `is_system` types (§3.7) and the system View Definitions (§4.2) are the pre-load.

The surface names (Work, Build) are intentional but provisional; they should stay intuitive and can be revisited if other users come aboard.

### 4.11 Work surface: the widget dashboard (Phase 1 fixed, Phase 2 widgets)

The main screen is a **dashboard with a menu over top** (the Planning Center Home pattern). Phasing follows "live in it fast":

- **Phase 1: fixed layout.** The Today view as specced in §4.2: today's meetings, due/overdue tasks, quick capture. One batched fetch, no configuration surface.
- **Phase 2: the widget system.** The dashboard becomes a user-arranged grid of **widgets**, landing alongside the view builder because a widget is a View Definition (§4.2) rendered as a card. Drag-and-drop arrangement; add/remove widgets; anything built on the Build surface can be pulled in as a widget.

Widget behavior:

- **Height is driven by item count.** A widget shows its top N items (the user picks N), and N maps to a standard height, so choosing 5 across several widgets yields equal rows. Equal heights are an option, not a constraint.
- **Fill the screen on desktop.** A large monitor gets a full dashboard, not a centered column. On mobile the same widgets stack vertically and scroll, with the most-needed content placed at the top.
- **Badge counts.** A widget (and its navigation slot, §4.12) can surface a count, such as today's task count or suggested tasks awaiting review (§4.15), for at-a-glance status.

### 4.12 Navigation: bottom bar and sidebar

Navigation is a small set of user-chosen slots, not a fixed menu:

- A persistent **floating bottom bar** with a locked number of slots (4 or 5). Home (the dashboard) is always slot 1; the remaining slots are user-assigned to whatever they reach for most: tasks, projects, a workflow, an inbox. Slots can carry badge counts (§4.11). The bar floats over content, so it stays visible while scrolling.
- **Mobile: settled.** The floating bottom bar is the mobile navigation.
- **Desktop: two candidates, decided in testing (open Q9).** The same floating bottom bar (always visible, small enough to never cover content) versus a **right sidebar** (cheaper on horizontal pixels, the same slots vertically). Both are specced so either can be built behind the same slot model; layout preference is subjective and depends on how content sits against the nav, so this is a try-both-and-keep-one decision, possibly per-breakpoint.

Either way, the slot contents, order, and badges are user-configured from the Build surface, the same building-block contract as widgets (§4.10).

### 4.13 Item view: the canvas

Opening any item lands in a canvas (§4.1). The default canvas is the **markdown-native editor**, and no item type dead-ends in a bare row. **A content type may declare its own canvas** (v0.18, ADR-037): a chord editor for songs, a paper workspace with a quote-bank sidebar and stage tracker for papers. A type without a declared canvas gets the default markdown canvas, so the uniform "everything opens to a real editing surface" promise holds while bespoke types get the surface their workflow actually needs. (This revises the former v0.17 rule that *every* item opened the same single editor canvas.)

- **Opening modes.** Side panel, center modal, full screen, or new tab. The default is a center modal with a one-click expand to full screen, and the mode is a per-user preference. (Side panel and new tab can follow; the default markdown renderer is shared.)
- **Fields split top and bottom.** Item properties render in two zones: a **top strip** above the body for the fields actually needed at a glance, and a **bottom section** below (or collapsed) for the rest. Which fields go where is user-configurable per type. This avoids the Notion failure mode of every property stacked above the content whether you need it or not.
- **Horizontal property layout.** The top strip lays fields out horizontally (label-value pairs in a row), not as a vertical stack, so two or three key fields cost one line, not five.
- **Fields are collapsible.** The bottom section collapses by default once configured, keeping the canvas as the star.

### 4.14 Build surface: workflows and wikis (Phase 3)

The Build surface exists for the structures that don't fit the standard task/project/calendar shapes. Real examples from the Notion years: a hiring tracker (candidates aren't tasks), a writing project (a database of chapters, written inside each), a D&D campaign wiki (sessions, places, characters, cross-referenced), a camping packing-and-trips list. Two recurring categories:

- **Workflows:** structured, step-based processes (hiring, content production). Steps, stages, and the views that move items through them.
- **Wikis:** interconnected reference data (campaign notes, trip archives). Heavy on relations and cross-linking, light on status.

**Template-driven creation is the point.** The Build surface leads with a small set of big, obvious starting buttons ("New Workflow," "New Wiki," and the like). Each prompts for the key parameters (what are the steps, what data does each record carry) and then auto-generates the type, properties, and default views using the §3.6 machinery. The insight from the Tyler conversation: Brandon is accustomed to Notion's setup friction, so it feels normal to him, but a fresh user would find it high-friction; templates are the fix. Creating the same kind of structure over and over from raw tables is the waste the templates remove.

Templates lower friction without imposing rigidity:

- **Tweak on the fly.** Mid-use changes stay cheap: adding a "family situation" text field in the middle of an interview is a seconds-long edit to the type, not a rebuild. The JSONB property model (§3.6) makes this a config change by design.
- **Surface it, then retire it.** Once built, a workflow or wiki can be wired into Work as a dashboard widget and/or a navigation slot (§4.10). When the hiring round ends or the trip is over, it's removed from Work and the data stays put, archived and searchable, never deleted. Multiple layers of "move it out of my face" (off the dashboard, off the nav, archived) without loss.
- **Claude can assist, deterministically delivered.** "Hey Claude, I need a workflow for X" through the MCP layer (§5.5) can generate the same template parameters a human would click through; the structure creation itself stays plain code.

### 4.15 Meeting capture and AI processing (later phase, designed-for now)

The goal: a meeting ends, and shortly after, its meeting item holds a transcript, a bulleted summary, and a list of **suggested tasks** waiting for one-tap review ("yes, yes, yes, add those"). This matters because the volume problem is real: back-to-back meetings produce action items faster than there's time to recapture them, so an end-of-day review queue (surfaced as a badge count, §4.11) beats relying on memory.

**This is not in the current build phases.** It's specced now so the rest of the system is built with it in mind, and it lands after the core is done (post-Phase 3, promoted from the parking lot when its open questions resolve). The design-ahead hooks, all cheap or free today:

- **Meeting bodies reserve the shape.** The meeting template (§4.3) already has Agenda / Notes / Action Items headings; Transcript and Summary become two more sections the processor fills in.
- **Audio is just an attachment.** A recording stores to object storage like any file (§3.4); no new storage concept.
- **Suggested tasks reuse `suggested` state.** Extracted tasks are created as real task items related to the meeting with `match_state = 'suggested'` (§3.3), so they render provisionally, stay out of trusted queries until confirmed, and confirming them uses the same gesture as calendar-match confirmation. Context is preserved for free: opening the task later shows the meeting it came from via backlinks (§4.9).
- **Processing rides the existing API.** Whatever triggers it calls the same authenticated endpoints the MCP server and crons use (§5.5, §6.1); no privileged side door.

**Two implementation options, decided later:**

1. **Automated:** record in-app (or pull a Teams transcript via Graph), transcribe with **Whisper**, then call the **Anthropic API** to draft the summary and suggested tasks. Trigger is either a "Process this meeting" button (human-initiated, which keeps Principle 7 fully intact) or an automatic post-recording job (which would mean deliberately amending Principle 7 to allow this one scoped AI job, and adding an explicit AI line to the cost target).
2. **Manual fallback (no API cost):** record with Apple Voice Memos (built-in transcription), paste the transcript to Claude via MCP, and have it write the summary and suggested tasks back through the same endpoints. One manual step, zero new infrastructure.

**Open questions before promotion (Q10):** Whisper's real accuracy on meeting audio (75 to 80 percent is likely fine for notes; verify), actual API cost per meeting (estimated well under $25/month, unknowable until tested), and the trigger choice above. A budget note for the future: once the build phase winds down, redirecting the Claude subscription spend toward API tokens is the natural funding path.

---

## 5. Integrations

### 5.1 Microsoft Calendar (Graph API) — Phase 2

- Poll upcoming events (next 14 days) on a schedule. Cadence is flexible and free either way (the GitHub Actions trigger in §6.1 runs the same at 30 min, 6h, or 12h), so prep-freshness, not cost, sets it; default 6h with an on-demand "sync now"
- Auto-create meeting items for events matching configurable rules; store `ms_event_id` to prevent duplicates
- **Event mutations:** if an event is rescheduled, the meeting item's `meeting_at` updates; if canceled, the item is flagged canceled but never deleted (prep notes survive rescheduling)
- Auth (two modes, because of MFA): **interactive** sign-in to the app is delegated OAuth, where MFA happens normally at the Microsoft login (Clerk + Microsoft, §6.1). **Unattended** jobs (calendar poll, email-in, export writes) use **app-only client-credential** tokens so MFA never blocks the cron, since they authenticate as the app, not as Brandon. Brandon is the tenant admin, so he grants consent himself
- **Scope discipline:** app-only application permissions are tenant-wide by default, so the Exchange scopes (`Calendars.Read`, `Mail.Read`) are restricted to Brandon's mailbox via an Application Access Policy. The OneDrive export's file scope (app-only `Files.ReadWrite.All` vs a stored delegated token) is finalized at build, since the access-policy mechanism is Exchange-only
- **Maintenance note:** the app-only client secret expiry is tracked as a recurring reminder; rotation documented in the runbook

#### Matching events to templates and entities (no AI)

The whole match step is deterministic, and it prefers structured data over fuzzy text. An event arrives from Graph carrying attendees (emails), location, and a body as discrete fields, so the most reliable signal is the attendee email, not the title.

A small ordered **matchers** config (a table or JSON file, editable without a redeploy) drives it. Each rule names a condition and an action:

- **Conditions, in priority order:** attendee-email match (e.g., `roger@…` resolves to the Roger person-entity), calendar series id, title regex, then title fuzzy-similarity as the last resort
- **Actions:** apply a named template, attach default entities/tags, set default urgency

Fuzzy title matching ("Brandon/Roger 1:1 Check-in" to a "Roger 1:1" template) uses Postgres' built-in `pg_trgm` extension and a `similarity()` threshold, so there's no new dependency. It only fires when no attendee or series match is available (external guests, room-only invites).

Metadata flows in as plain parsing: attendees match to person entities by email, location and event details copy straight into the relevant template sections. Anything genuinely ambiguous is left for an on-demand Claude/MCP action (§5.5), not the cron.

**The matchers are user-built, not seeded.** No rules ship pre-loaded. The config grows two ways:

- **Setup wizard:** during onboarding the app pulls a sampling of recent and upcoming calendar events and lets the user pick which to match to which entity or template, writing the first rules
- **Learn by example:** when Brandon creates or links a meeting that coincides with a calendar event (overlapping time window), the app suggests the connection; confirming it links that instance and offers to save a reusable rule (for example, "always match events with attendee `roger@…` to Roger"), so the matcher set grows from confirmed decisions

Promoting a single match into a standing rule is always an explicit confirm, so one good match never silently creates an over-broad rule.

**Suggested vs confirmed matches.** Matches carry state so trust is visible (the `match_state` column on `relations`, §3.3). Manual and wizard-confirmed links are `confirmed` and render solid. Attendee-email and fuzzy-title matches land as `suggested` and render provisionally (dotted or grayed) with one-click confirm or reject. Nothing `suggested` enters the trusted, queried-against set until Brandon confirms it, and a confirmation is also the signal that can be promoted into a standing matcher rule.

### 5.2 Todoist — Phase 2

> **⚠️ Reversed by ADR-073/081 (2026-06-17): tasks go fully native.** Ledgr owns tasks end to end — native recurrence (ADR-076), scheduling/reschedule + overdue auto-roll (ADR-077), a Top-3 focus layer (ADR-078), reminders via a published ICS feed + web push (ADR-079), and offline capture via a client outbox (ADR-080). **Todoist is now an OPTIONAL adapter behind the `tasks` provider seam** (`TASKS_ADAPTER=todoist`), not the engine; Brandon's instance runs native (sync off), Tyler can keep Todoist. The rules below describe that optional adapter; specifically **"recurrence delegated to Todoist" and "Todoist is the notification engine" no longer hold for the native default.** The §5.2 sync code is unchanged and still correct when the Todoist adapter is selected.

- **Push rule:** any task item with a due date is pushed to Todoist automatically (content, due date, priority mapping, link back to the Ledgr item in the description). Undated tasks stay app-only.
- Completions sync back (webhook preferred; polling fallback) and mark the item `done`
- **Conflict rule:** Ledgr is canonical for content; Todoist edits sync back only as completions and date changes. Edits in both places within a sync window resolve in Ledgr's favor.
- **Inbox pull-in (v1, required):** tasks created natively in Todoist's inbox are imported on sync. This is the offline capture path — Todoist's app queues offline reliably, so a hallway capture with no signal still lands in Ledgr.
- **Recurrence is delegated to Todoist entirely.** Recurring tasks (payroll, weekly reports) live as recurring Todoist tasks; each completion logs back to Ledgr as a completed occurrence. Ledgr builds no recurrence engine.
- Todoist remains the mobile notification engine by design

### 5.3 Email-in — Phase 2 (Outlook folder via Graph)

Capture works off a dedicated Outlook folder, not a separate inbound email address. Brandon creates a "Ledgr Import" folder, and Outlook rules can auto-file mail into it by sender, subject, or category, so routine sources land without manual forwarding. The app polls that folder on the same GitHub Actions schedule.

- Each message → a `note` item (or `task` if the subject is prefixed `task:`), body = email converted to markdown (HTML email converts imperfectly, accepted), attachments stored to object storage (§3.4)
- **Efficiency:** a Graph `messages/delta` query returns only what's new since the last sync; imported messages are marked read and moved to an "Imported" subfolder so nothing double-imports
- **Sender matching is now feasible** because the original headers survive (forwarded mail mangles them). v1 still drops new items into the inbox view for manual entity tagging, but sender-to-entity matching by email is a clean later add
- Auth: extends the existing Azure app registration with `Mail.Read` (or `Mail.ReadWrite` to move messages); see §6.3 and open question 4

**Why this over a dedicated address:** it reuses the Graph auth already in place for calendar, removes a whole external dependency (no Cloudflare/Postmark inbound, no webhook, no signing secret, no public address to leak or allowlist), keeps everything inside the ECC tenant, and lets Outlook's own rules do the routing. The cost is one added Graph scope, which ties to the same admin-consent question as calendar. A dedicated inbound address stays documented as the fallback if Mail scope can't be granted.

### 5.4 OneDrive export — Phase 1

- One-way, DB → files, on a nightly cron plus on-demand "export now"
- Structure mirrors the data model: `/Export/{type}/{year}/{slug}.md` with YAML frontmatter (id, type, dates, entities, status) and the markdown body
- Attachments are copied from object storage (§3.4) into the export tree; frontmatter records their paths
- Deleted/archived items move to an `/Export/_archive/` path rather than disappearing
- This export is the **disaster recovery plan and the pulpit fallback**, and it makes the whole corpus greppable by Claude Cowork

### 5.5 Claude (MCP server) — Phase 3

- Thin MCP server over the app's API: search items, read item, create item, update item, list by entity/date
- Enables: "what's open with Roger," "file this as a task due Friday," "prep tomorrow's 1:1" from Claude desktop or mobile
- Auth via a personal API token
- Scheduled Claude tasks (morning briefing, weekly health check) consume the same API

---

## 6. Technical requirements

### 6.1 Stack (proposed, boring on purpose)

- **Frontend/backend:** Next.js (single app) on Vercel
- **Database:** Postgres on Neon (free tier to start); connect through Neon's connection pooler, not a direct connection (serverless requirement, §6.5). Neon chosen over Supabase because storage (R2) and auth (Clerk) are handled elsewhere, so Supabase's bundled extras would go unused
- **Data layer / migrations:** Drizzle, a lightweight, SQL-close TypeScript ORM (the layer the app uses to read/write Postgres in typed code instead of hand-written SQL strings, and to version schema changes as migrations). Chosen over Prisma for being thinner and serverless-friendly, matching Principle 5
- **Editor & body format (v0.18, ADR-037):** **Canonical body format is Markdown**, an extended dialect (CommonMark/GFM + inline HTML for colors/highlights + markdown-family formats like ChordPro per type; Papers-only footnotes live in that module, not the shared dialect, ADR-190). Markdown is the source of truth; the Word/`.docx`, chord chart, slides, and the Save-Offline print/PDF are all **rendered from** it (the `docx` package and pure serializers, no model). The editor is a markdown-native WYSIWYG surface; library TBD (tiptap / Milkdown / Lexical / BlockNote-as-candidate). This reverses the v0.17 BlockNote-JSON-canonical choice: the durable, greppable, multi-output base is worth giving up BlockNote's turnkey block UX for, with the "Notion feel" a later nice-to-have (§4.1).
- **Auth:** Clerk (free tier), Microsoft sign-in as the primary method (one identity, the ECC tenant). Multi-user auth comes built, matching the "maybe staff later" posture. Machine-to-machine access (MCP server, cron, webhooks) uses scoped API tokens, separate from Clerk.
- **Scheduler:** Vercel Hobby cron only runs daily jobs, so sub-daily schedules (e.g., 6-hour calendar polling, §5.1) are triggered by a free GitHub Actions workflow hitting authenticated endpoints. Protects the $0 target. (Note the failure mode in §12: GitHub auto-disables Actions after 60 days of repo inactivity; the `/health` export-timestamp check catches a silently stalled sync.)
- **File storage:** Cloudflare R2 (object storage + CDN) behind a storage-provider interface; presigned URLs, per-user quota; OneDrive receives backup copies via export (§3.4, §5.4)
- **Repo:** GitHub (also serves as code backup and the place Claude Code works)
- **Cost target:** ~$0/month on free tiers; domain ~$12/year; Clerk free tier; Cloudflare R2 within free tier (10GB, no egress)

**Provider-interface discipline (keeps a future local build cheap).** Storage already sits behind a thin provider interface (§3.4), which is the seam that lets a self-hosted build swap R2 for the local filesystem with no app changes. To keep the Phase 4 packageable local build (§8) a packaging exercise rather than a rewrite, the same discipline should extend to the other two embedded cloud dependencies: **auth** (Clerk should be reachable behind an interface so a local single-user mode can stand in) and the **scheduler** (the GitHub Actions trigger in §6.1 should call the same authenticated endpoints a local cron could call, so the trigger is swappable). The DB itself is already portable: Drizzle makes Neon-pooler-vs-local-Postgres a connection-string change. This costs little now and is the difference between Phase 4 being feasible and being a fork.

### 6.2 Maintenance design (from the risk discussion)

- `/health` endpoint checking DB, Todoist API, Graph token validity, last successful export timestamp
- Weekly scheduled Claude task hits `/health` and emails Brandon on failure
- Dependencies pinned; updates batched intentionally, never auto
- Calendar reminders for Azure client secret expiry
- Rule: be deliberate with production deploys (prefer additive, reversible changes; git + the safety net make mistakes recoverable). No fixed weekend/Saturday no-deploy window (reframed by ADR-119); use judgment on the rare sermon-sensitive weekend.
- Runbook file in the repo documenting token rotation and common fixes (written for future-Brandon with Claude Code)

### 6.3 Security and sensitive content

- Single user, but internet-exposed: all routes behind Clerk auth; API tokens for MCP/automation scoped and revocable
- Email-in uses a scoped Graph `Mail.Read` permission against a single Outlook folder, not a public inbound address (§5.3)
- No church-confidential compensation data stored (that stays in existing ECC systems)

#### Encryption posture and pastoral content

"Encryption at rest" means two different things, and only one of them is worth building. **Platform encryption at rest** (default on Neon/Supabase, Cloudflare R2, and OneDrive) protects against a stolen disk or a storage-layer breach. It is free and effectively already on, but it does not defend against the threats that actually matter here (a stolen login, a leaked token, a provider compromise or subpoena, and the app's own export and Claude pathways), because the data is decrypted the moment the app reads it. **Application-level field encryption** would defend against a database dump, but it can't search ciphertext (breaking full-text search), it forces the export to either leak plaintext or omit items (breaking the pulpit fallback and Claude's greppable corpus), and the decryption key still has to live server-side for cron, export, and the MCP server to function, so it isn't true end-to-end anyway.

**Decision (v0.4): baseline posture.** Given that field encryption fights three core features for protection that's partial at best, v1 commits to platform encryption at rest plus a hardened access path, which is where the realistic risk lives:

- Microsoft SSO with MFA as the only interactive sign-in
- Short-lived, scoped, revocable API tokens for MCP, cron, and webhooks; rotate on any suspicion
- No sensitive content in logs or error payloads

This is enough that pastoral and personnel notes can live in the tool normally rather than being held out, which was the whole point. The one rule that carries over from Notion unchanged: the rare detail that would seriously harm someone if leaked still gets referenced obliquely, not written down verbatim. A field-encrypted "confidential" tier was considered and deferred (it costs search, export, and Claude access on those items); it remains a clean future add if the need sharpens.

### 6.4 Backups

- **Content:** nightly OneDrive markdown export (§5.4) plus on-demand Pulpit Ready exports
- **Everything else:** weekly `pg_dump` of the full database (relations, revisions, metadata) written to OneDrive via the export job; free-tier Postgres point-in-time recovery is thin, so this is the real restore path
- **Attachments:** object storage (R2) is durable on its own, and the OneDrive export holds a second copy, so files survive a provider loss
- Restore procedure documented in the runbook and tested once before Phase 2 (an untested backup is a hope, not a backup)

### 6.5 Performance and efficiency (design-level)

Two goals are weighed in every design choice (Principle 9): the tool feels instant in the user's hands, and the back end stays cheap on compute, storage, and traffic. At single-user scale there's no scaling wall, so this is about perceived speed and resource discipline, not throughput. These rules are mirrored into the runbook (§6.2) so future query-writing, often by Claude Code, doesn't quietly break them.

**Front-end (perceived speed):**

- **Optimistic updates.** Inline edits, check-offs, and captures apply in the UI immediately and reconcile with the server in the background, so nothing waits on a round-trip.
- **Stale-while-revalidate.** Render from the local/PWA cache instantly, then refetch and update, so repeat views feel instant.
- **Lazy-load the editor.** A rich WYSIWYG editor is heavy; code-split it so opening the app (lists, Today) doesn't pay the editor's cost until an item is actually opened.
- **Virtualized long lists** and pagination, so a 1,000-item list renders a screenful, not all of it.
- **Batched page loads.** A screen like Today fetches its data in one request, not a query per widget.

**Back-end (cheap compute, storage, traffic):**

- **Pooled DB connections are mandatory.** Serverless functions (Vercel) plus Postgres is a classic footgun: each invocation can open a connection and exhaust a free-tier cap fast. Use the host's pooler (Neon/Supabase pooler or a serverless driver) from day one, never a direct connection.
- **List queries never select `body`.** Bodies (markdown, sermon-sized) load only when an item is opened, so a task list never pulls megabytes.
- **Index plan.** Index `type`, `owner_id`, `status`, `due_date`, and `parent_id`; index `relations.source_id` and `relations.target_id` separately so both-direction backlink queries use bitmap index scans; GIN-index `properties` and the FTS tsvector (a maintained generated column, not computed per query).
- **Incremental everything.** Calendar, email, and Todoist sync use delta/changed-since queries, not full re-pulls; the nightly export writes only items changed since the last run; the weekly `pg_dump` is the one full snapshot (§6.4).
- **Right-sized crons.** Sub-daily jobs run at the cadence the feature actually needs (calendar 6h, not 30 min) to limit function invocations and stay in free tiers.
- **Cache-friendly file serving.** Attachments serve through R2's CDN with long cache headers and pre-sized thumbnails (and R2 charges no egress), and public share links are statically rendered/cached, so origin hits and bandwidth cost stay low.
- **No N+1.** Relations and embedded-view rows are fetched in bulk per page, not per item.
- **Bounded growth.** Revision snapshots are capped per item with a prune step (§4.6).

Cold starts are the one accepted cost: Vercel functions and Neon's scale-to-zero can add a second of lag after idle, fine for a personal tool, with the health ping (§6.2) doubling as a keep-warm if needed. None of these block the build, they're the choices that keep a $0, serverless stack feeling instant.

### 6.6 Observability and debugging (design-level)

Built to be diagnosed by a solo maintainer with Claude Code (Principle 10), so a Saturday-night failure leaves a legible trail rather than a mystery:

- **Structured logging.** Server actions, sync jobs, and webhooks log as JSON with a correlation id, so one capture or one sync run can be traced end to end.
- **Toggleable debug mode.** An env flag (and a per-session toggle for the UI) surfaces verbose errors, query timings, and the calendar-matcher and sync decisions; off in normal use so it costs nothing day to day.
- **No silent failures.** A failed cron or webhook is captured (a small `error_log` table, or a free Sentry tier) and surfaced through `/health` (§6.2) and the UI, never swallowed. UI errors are human-readable, with a detail panel when debug is on.
- **Documentation kept current.** Inline docs for non-obvious logic, the runbook (§6.2) for operations and fixes, and this PRD for intent. The performance rules (§6.5) live in the runbook too.

Worth stating explicitly rather than leaving to the build, since logging depth, debug toggles, and doc discipline vary widely by default, and being explicit is what makes them actually get built in.

---

## 7. Migration (selective)

1. Full Notion export (markdown + CSV) saved to OneDrive as the permanent archive of record — nothing is lost, ever, regardless of what gets imported
2. Import **active** items: open tasks, meetings from the last ~6 months, actively referenced notes and links, and the entity/tag list
3. Import script maps Notion relations → entities/relations rows; Claude Code writes and runs it against the export
4. Old archive remains searchable two ways: the raw export on OneDrive (greppable by Claude) and selective pull-ins later ("import that 2024 sermon series note")

---

## 8. Phasing

### Phase 1 — Core (build first, live in it)
Data model (including the `properties` JSONB column, schema-ready for custom types per §3.6), auth, item CRUD, block editor, item canvas with top/bottom field zones (§4.13), entity pages, parent/child subtasks (§3.5), Today view (fixed layout, §4.11), navigation shell (mobile bottom bar; desktop per open Q9), search, quick capture, backlinks panel (§4.9), PWA shell, OneDrive export.

### Phase 2 — Integrations + sharing
Calendar sync + meeting prep templates, Todoist sync (push, completions, inbox pull-in), email-in (Outlook folder via Graph, §5.3), view builder (custom views + layouts, §4.2) and interactive embedded query views (§4.9), **widget dashboard** (drag-and-drop widgets over View Definitions, badge counts, fill-screen layout, §4.11), push notifications, **public share links** (read-only, print-friendly, PDF download — a named Notion pain point, so it doesn't wait).

### Phase 3 — Claude layer + migration + Build surface
MCP server, scheduled briefings/health checks, selective Notion migration, share-to-app, the **Build surface** (§4.10, §4.14: the custom type & property builder of §3.6 plus workflow/wiki templates and Work-surface wiring), and **planning rhythms** (§4.8: configurable rituals, AI-assembled agendas). The Meetings module's manual Add-to-template slice may ride along late Phase 2.

### Phase 4 — Packageable local / self-hosted build (exploratory)
A downloadable build that runs the whole stack on a local machine, pointed at the database. The app tier is already most of the way there: Next.js + Postgres + Drizzle runs locally against any connection string, so "point it at the DB and run everything local" is largely true for the app today. What isn't local yet are the external dependencies (Clerk auth, R2 storage, Graph/Todoist integrations, GitHub Actions scheduler); a local build swaps or stubs them behind the provider interfaces (§6.1). Two motivations point different ways, worth separating before committing: if the goal is **resilience** (cloud down, still need my stuff), the OneDrive export and Pulpit Ready (§4.7, §5.4) already cover it, so a local build adds little. The real case is a **genuine alternative deployment**: dropping the Vercel/Neon/Clerk dependency, dodging the multi-user free-tier cost cliff (§12), or data sovereignty. Gated on that motivation becoming real; the cheap insurance is the §6.1 interface discipline kept up meanwhile. Note this also softens the storage-tiering question below, since local disk is cheap.

### Later / ideas parking lot
**Meeting capture and AI processing** (§4.15: record/transcribe via Whisper or Teams-transcript pull, Anthropic API summary + suggested tasks; specced and designed-for now, promoted when Q10 resolves), pulpit mode (large-type distraction-free render), staff accounts (schema is ready; product work deferred), Notion-style synced blocks, Notion-style formulas and rollups (custom-type deep end, §3.6), gallery and Gantt view layouts (view deep end, §4.2), email-out.

**Tiered attachment storage (cold-demotion), gated on a real quota trigger.** Idea: once an attachment hasn't been accessed in a couple of weeks, demote it off R2's hot/CDN path to cheaper/slower storage. Held lightly because the problem may not exist: §3.4 keeps attachments small by design and open Q8 hasn't confirmed real volume yet, so this is complexity (a per-attachment hot/cold state machine plus link rewriting inside markdown bodies) against Principle 5 until R2 nears the 10GB quota. The originally floated mechanism (demote to a OneDrive *share link*) is the weak form: OneDrive links resolve to HTML preview pages, the direct-download URL format is unofficial and shifts, and they're rate-limited, so serving a demoted image reliably would force bytes back through the app server via Graph, breaking the "bytes never proxy through the app server" rule (§3.4) and reintroducing the Microsoft coupling that section deliberately shed. It also needs per-attachment last-access tracking the app doesn't have today (CDN serving means the app never sees most reads). **Cleaner variant if cost ever bites:** since OneDrive already holds a backup copy (§5.4), "cold" can just mean *delete from R2 and rehydrate from Graph on demand*, no second storage system and no new link type. Revisit only on the R2-approaching-quota trigger.

---

## 9. Success criteria

- Brandon stops opening Notion for new items within 2 weeks of Phase 2 completing
- A 1:1 with Roger can be prepped in one click and conducted entirely in the app
- A sermon is written in the app and preached from it (or its export) at least once
- Zero data-loss incidents; export verified restorable
- Maintenance incidents ≤ 5/year, each resolved in under an hour with Claude Code
- Monthly cost stays ~$0 (excluding existing Todoist/Claude subscriptions)

## 10. Decisions log

- **Users:** v1 single-user, schema multi-user-ready (owner_id everywhere); staff accounts deferred to "Later"
- **Recurrence:** delegated entirely to Todoist; no native recurrence engine
- **Todoist push:** automatic for any task with a due date; undated tasks stay app-only
- **Sharing:** public share links + print + PDF land in Phase 2
- **Email-in:** Outlook "Ledgr Import" folder pulled via Graph (`messages/delta`, mark-read + move), reusing calendar auth; dedicated inbound address demoted to fallback; manual entity tagging in v1, sender matching now feasible and deferred
- **Offline capture:** Todoist inbox is the offline capture path; PWA does not promise offline writes
- **Pulpit Ready:** v1 feature; Sunday never depends on the app being up
- **Auth:** Clerk free tier, Microsoft sign-in primary; API tokens for machine access
- **Document format (revised v0.18, ADR-037):** **Markdown canonical** (extended dialect: GFM + inline HTML for colors/highlights + ChordPro per type); every rich output renders from it. *(Was, through v0.17: BlockNote JSON canonical, markdown the lossy export.)*
- **History:** soft deletes + revision snapshots are v1
- **Scheduling:** GitHub Actions triggers sub-daily jobs (Vercel Hobby cron is daily-only)
- **AI scope:** deterministic by default; routine plumbing (calendar matching, metadata extraction, formatting, sync) runs with no model; AI is reserved for deliberate human-in-the-loop work in the Claude/MCP layer (Principle 7)
- **Calendar matching:** structured-first via an ordered matchers config (attendee email → series id → title regex → `pg_trgm` fuzzy fallback); metadata is plain parsing
- **Formatting export:** colors/highlights serialize to standard inline HTML (`<mark>`/`<span>`) so markdown export stays lossless and renders in Obsidian with no plugin
- **Encryption:** baseline posture for v1 (platform at-rest + MFA SSO + scoped tokens); pastoral/personnel notes may live in the tool; field-encrypted "confidential" tier considered and deferred
- **Planning rhythms:** configurable rituals (horizon + toggled modules, manual or scheduled trigger); modules are deterministic, agenda synthesis is the only AI step; targeted v3, with the manual meeting-planning slice a possible late-v2 extension
- **Matchers are user-built:** no seeded list; populated via setup-wizard sampling and learn-by-confirmation, with rule promotion always an explicit confirm
- **Match state:** `relations` carry `confirmed` | `suggested`; fuzzy and auto matches render provisional until confirmed and are excluded from trusted queries
- **Linked views:** backlinks panel (Phase 1) plus interactive embedded query views (Phase 2); embedded views are editable filters with inline edit, check-off, and create-inherits-filters; remove = un-relate, never delete; ambiguous filters (ranges/ORs) don't auto-assign defaults
- **Relations model:** generic page-to-page edge (`source_id`/`target_id`, optional `role`), Notion-faithful; tags are just edges to entity items; backlinks query both directions
- **Bespoke-first (Principle 8, revised v0.18, ADR-037):** design each type with its own features and, where useful, its own canvas; one customizable catch-all type for the temporary tail, with a promotion path to a permanent type. *(Was: Notion-default — match Notion's UX where options exist.)*
- **Hierarchy:** containment via a self-referential `parent_id` (single parent), separate from associative relations; projects are emergent (any task with children gets a subtask checklist + progress rollup); cycle-guarded, recursive tree reads; soft-delete cascades to children
- **Custom types:** middle path — user-defined Types (each a page with a property schema + default view) plus a `properties` JSONB bag and a core set of property kinds (text/number/date/select/multi-select/checkbox/url/relation); views reuse saved views; `properties` column ships Phase 1, builder UI Phase 3; formulas/rollups out of scope (parking lot)
- **Type tiers (§3.7):** one type system, two behavior tiers; built-in types are `system`-flagged with reserved columns and bespoke code (integrations, templates, planning), custom types get universal item behavior plus property-kind-driven generic behavior (date → calendar, etc.); type-specific plumbing stays reserved for built-in types; fully generic (no privileged types) rejected
- **Performance posture (§6.5):** pooled DB connections required; list queries exclude `body`; index `type`/`status`/`due_date`/`parent_id` and both relation columns; GIN on `properties` + FTS; incremental nightly export; serverless cold starts accepted
- **Views (§4.2):** every view is a stored View Definition (filter, sort, grouping, layout, type/date-property surfacing); built-in views are editable/clonable `system` seeds; users build their own (3-day, 1-week, 3-month, etc.); same engine as embedded views (§4.9); core layouts list/table/board/calendar/agenda, gallery/Gantt parked; view builder Phase 2
- **Performance principle (9):** weigh perceived speed (optimistic UI, stale-while-revalidate, lazy editor, virtualized lists) and back-end thrift (pooled connections, no-body-in-lists, incremental syncs, right-sized crons, CDN serving) on every choice; rules mirrored into the runbook
- **File storage (§3.4):** Cloudflare R2 primary (presigned URLs, CDN, per-user quota ~10GB, no egress) behind a provider interface; OneDrive demoted to export/backup target; generalizes to non-Microsoft users
- **Body format (clarified v0.13, reversed v0.18 — ADR-037):** `items.body` stores canonical **Markdown** as `{format, text}` (§3.1, §4.1, §6.1); rich outputs render from it. *(The v0.13 decision was the opposite — BlockNote JSON canonical, markdown derived — superseded by the Markdown epoch.)*
- **Integration phasing (clarified v0.13):** export is Phase 1; calendar, Todoist, and email-in are Phase 2; MCP server is Phase 3 (§5 headings now match §8)
- **Microsoft auth (v0.14):** two modes to handle MFA — interactive login uses delegated OAuth (MFA at the Microsoft prompt), unattended jobs use app-only client credentials (no MFA), scoped to Brandon's mailbox via an Application Access Policy; Brandon self-consents as tenant admin
- **Name (v0.15):** the app is **Ledgr**
- **DB host (v0.15):** Neon (storage on R2, auth on Clerk, so Supabase's extras are unused)
- **Data layer (v0.15):** Drizzle ORM + migrations (lightweight, SQL-close, serverless-friendly; over Prisma)
- **Types are table-backed (v0.15, resolves Q6):** `items.type` is a FK to an extensible `types` table seeded with five `is_system` rows; user types are more rows (Gmail system-vs-user-label pattern); table ships Phase 1, builder UI Phase 3
- **Observability (Principle 10, §6.6):** structured JSON logging with correlation ids, a toggleable debug mode, captured-and-surfaced cron/webhook errors (no silent failures), and current inline + runbook docs
- **Packageable local build (v0.16, Phase 4 exploratory, §8):** a self-hosted local deployment pointed at the DB; app tier already portable (Next.js + Postgres + Drizzle), external deps swap behind provider interfaces; gated on a genuine alternative-deployment motivation (not resilience, already covered by export + Pulpit Ready); the §6.1 interface discipline (auth + scheduler behind seams, storage already is) is the cheap insurance that keeps it feasible
- **Attachment storage tiering (v0.16, parked, §8):** cold-demotion off R2 is deferred until a real R2-quota trigger, not built now (problem unconfirmed per Q8, adds a state machine + body link-rewriting against Principle 5); the OneDrive-share-link mechanism is rejected (unreliable hotlinking, forces proxying, reintroduces Microsoft coupling); if cost ever bites, the chosen variant is delete-from-R2-and-rehydrate-from-the-existing-OneDrive-copy via Graph, no second storage system
- **Two-surface architecture (v0.17, §4.10):** the app has a Work surface (daily use) and a Build surface (configuration), switched from the main menu; Build produces structures, Work exposes them through widget and navigation slots (the building-block contract); Work ships first; names provisional but intentional
- **Pre-loaded core (v0.17, §4.10):** new users start with the five system types and system views already in place, never a blank slate; this is the existing `is_system` architecture doing double duty as onboarding
- **Dashboard phasing (v0.17, §4.11):** main screen is a dashboard; Phase 1 ships the fixed-layout Today view, Phase 2 ships the widget system (drag-and-drop View-Definition cards, item-count-driven heights, badge counts, fill-screen desktop layout) alongside the view builder it depends on
- **Navigation (v0.17, §4.12):** user-configured slots with badges, home always slot 1; floating bottom bar settled for mobile; desktop is bottom-bar vs right-sidebar, both specced behind the same slot model, decided in testing (Q9)
- **Item canvas (v0.17, revised v0.18 — ADR-037, §4.13):** every item opens to a canvas (no bare rows); the **default** is the markdown editor, but a content type **may declare its own canvas** (song chord editor, paper workspace). Default center modal with expand to full screen; properties split into a horizontal top strip (user-picked, at-a-glance fields) and a collapsible bottom section, per type. *(v0.17 had every item open the same single editor canvas.)*
- **Build surface use cases (v0.17, §4.14):** workflows (step-based processes) and wikis (interconnected reference) are the two template categories; creation is template-led ("New Workflow"/"New Wiki" prompting key parameters, auto-generating type + properties + views via §3.6), with on-the-fly tweaks kept cheap; retired structures leave Work but archive, never delete
- **Meeting capture + AI (v0.17, §4.15):** specced as a later-phase feature, designed-for now (transcript/summary sections on meeting bodies, audio as attachments, suggested tasks via `match_state = 'suggested'`, processing over the existing API); implementation options (Whisper + Anthropic API vs manual Voice Memos + MCP) and trigger (button vs auto) stay open as Q10; Principle 7 and the $0 cost target are not amended yet

## 11. Open questions

1. *(Resolved)* App name is **Ledgr**. (Domain/email-in naming follows from it)
2. *(Resolved)* Email-in uses an Outlook folder pulled via Graph (§5.3); no external inbound provider needed. Dedicated address remains the fallback if Mail scope is denied
3. *(Resolved)* Calendar sync scope: user-built matchers, no seed list, populated via setup wizard and learn-by-confirmation (§5.1, Decisions)
4. *(Resolved)* Brandon is the M365 tenant admin and grants consent himself. MFA is handled by splitting auth: interactive login does MFA normally, unattended jobs use app-only client credentials (no MFA prompt), scoped to his mailbox via an Application Access Policy (§5.1). Remaining sub-detail: the OneDrive export's file scope (app-only vs delegated token), settled at build
5. *(Resolved)* Postgres host is **Neon**, since storage (R2) and auth (Clerk) are handled elsewhere (§6.1)
6. *(Resolved)* Custom-type modeling: `type` is a FK to an extensible `types` table, seeded with five `is_system` rows; user types are just more rows (§3.6, §3.7). The Phase-1 schema includes the table; the builder UI is Phase 3
7. **Multi-user scope of integrations:** if staff accounts ever happen, do non-Microsoft users need Google Calendar/Gmail equivalents, or does the product stay Microsoft-only for integrations while storage and core generalize? Determines how literally the "generalizes to any user" claim holds
8. **Migrated attachment volume vs the R2 ~10GB quota:** selective migration should keep it small, but confirm what attachments actually come over so the quota isn't a surprise
9. **Desktop navigation: floating bottom bar vs right sidebar (§4.12).** Mobile is settled (bottom bar). Both desktop options are specced behind the same slot model; build one, try the other, keep what wins. Subjective and content-dependent, so it's a testing decision, not a spec decision
10. **Meeting AI processing inputs (§4.15):** Whisper's real-world accuracy on meeting audio, actual Anthropic API cost per processed meeting (est. under $25/month), and trigger choice (button-initiated, which preserves Principle 7, vs automated post-recording, which would amend it). Resolve before promoting §4.15 out of the parking lot

---

## 12. Risks, pinch points, and accepted edge cases

These aren't blockers, they're the soft spots worth holding in view as the build proceeds. Most are accepted tradeoffs given a single user and the $0 target; a few are genuine gaps to close before the phase that depends on them.

**External dependencies that can gate features**

- **Azure app registration / admin consent (resolved, Q4).** Brandon is the tenant admin, so consent is self-served. MFA is handled by using app-only client credentials for unattended jobs (no MFA prompt) and normal interactive MFA for login (§5.1). The only residual is the OneDrive export's file-scope choice, a build-time detail.
- **Auth is two third parties deep.** Day-to-day access depends on Clerk and Microsoft SSO both being up. The Sunday-proof principle is preserved by the OneDrive export and Pulpit Ready PDF, but routine access has this dependency. Accepted.
- **GitHub Actions as the sub-daily scheduler.** GitHub auto-disables Actions after 60 days of repo inactivity, which would silently stop calendar/email sync. The `/health` export-timestamp check catches it; just a known failure mode (§6.1).
- **Free-tier ceilings.** The $0 target holds only while staying inside every free tier at once (Neon/Supabase rows+compute, Clerk MAU, Vercel Hobby, GitHub Actions minutes, R2 10GB). Fine at single-user scale; a future multi-user expansion would cross several at once and is a real cost cliff, not a gentle slope.

**Microsoft coupling vs the "generalizes to any user" claim**

- Storage (R2) and the core app generalize cleanly, but calendar sync and email-in are Graph-only. A future non-Microsoft user would get the core plus storage and lose those integrations until Google equivalents exist (open Q7). The generalization is real but partial, worth stating honestly.

**Data-model gaps to close before their phase**

- **Custom-type item identity (open Q6).** How a custom-typed item declares its type against the fixed `type` enum is unsettled. Low risk now (deferred to Phase 3), but the Phase 3 builder can't start until it's decided.
- **Dynamic constructs have no static export form (v0.18).** With markdown canonical (ADR-037), prose no longer round-trips — the markdown *is* the document, so export and Claude access are lossless for ordinary content. The residual gap is the reverse: live constructs embedded in a body — embedded query views (§4.9), and any markdown directive that resolves at render time — can't carry their live behavior into a flat exported file. They export as a static snapshot or placeholder, not a live view. Fine for the pulpit fallback (sermons are prose); flagged so the export's limits stay explicit.
- **Full-text search covers title and body, not custom property values.** Custom `properties` are filterable via GIN but not necessarily full-text searchable. Minor, likely fine, just unspecified.

**Concurrency and sync edge cases (low risk at one user)**

- **Two-device concurrent edits.** Optimistic UI plus last-write-wins on `body` means editing the same document on desktop and phone at once could clobber one side. Revision snapshots (§4.6) are the safety net (restore, not merge). Accepted for a single user; no real-time collaboration is promised.
- **Todoist content edits are lossy by rule.** The conflict rule resolves in Ledgr's favor, so a content edit made on the Todoist side (not date/completion) can be overwritten on sync. Intentional, but worth remembering it means "don't rewrite task content in Todoist."
- **Offline note capture has no path.** Offline *task* capture is covered by Todoist's queue, but an offline *note* (not a task) can't be captured, since the PWA doesn't promise offline writes. A small product gap, acceptable given the capture-as-task default.
