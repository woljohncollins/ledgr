# schema.md: Ledgr Data Model

The concrete data model. This is what Claude Code implements against in Drizzle. It restates PRD §3 in implementable form; when this and the PRD disagree, the PRD's intent wins and this file should be corrected. Phase tags note when each piece ships, but the structural pieces (`items`, `types`, `relations`, `properties`) all land in Phase 1 even where the UI for them comes later.

## Design rules that shape the schema

- **Everything is an item.** Tasks, meetings, notes, links, entities, and user-defined types are all rows in `items`.
- **Owner-scoped.** Every item carries `owner_id`; every query filters on it. One user in v1, but the column and the discipline ship day one.
- **Hot fields are columns; everything custom is JSONB.** Queried fields (`status`, `due_date`, etc.) are real columns. User-defined fields live in `properties` (GIN-indexed).
- **Containment vs association are different.** Containment (subtask, project tree) uses the self-referential `parent_id`. Association (tags, references) uses the `relations` edge table.

---

## `users`
Real table, one row in v1. Exists so `owner_id` foreign keys are honest and multi-user is a non-event later.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `clerk_id` | text | maps to Clerk identity |
| `email` | text | |
| `created_at` | timestamptz | |

---

## `types` (Phase 1 table, builder UI Phase 3 — built slice 33, ADR-044)
Extensible type registry. `items.type` is a FK to `types.key`. Five system rows seed it; user types are just more rows (Gmail system-vs-user-label pattern). **Not owner-scoped** (no `owner_id`): types are an instance-global registry (one user per deploy). The Build surface CRUD is in `src/lib/types.ts`, guarded by `requireOwner`. The DB owns label/icon/`property_schema`/enumeration; the **module registry** (`src/lib/modules.ts`, ADR-043) owns a type's *code behavior* (canvas/format/exporters) — a user type isn't registered, so it falls back to the default markdown canvas + markdown format.

| Field | Type | Notes |
|---|---|---|
| `key` | text PK | stable key: `task`, `meeting`, `note`, `link`, `person`, then user keys. **Immutable** (PK + FK target; the builder never lets it change). Slug-shaped: `^[a-z][a-z0-9_]*$` |
| `label` | text | display name |
| `icon` | text | optional icon name |
| `is_system` | boolean | true for the built-ins (the five base types, plus `transcript`/`milestone`/`unmarked`, and `project`/`tag` since migration 0052, 2026-08-17); code keys bespoke behavior off system keys. System types are extendable in the builder but never deletable |
| `property_schema` | jsonb | the type's custom fields as an **ordered `PropertyDef[]`**: `{key, label, kind, options?}` (slice 33 builder writes this; per-item values live in `items.properties`). See "Property kinds" below |
| `status_schema` | jsonb | nullable (ADR-082). The type's configurable statuses as an ordered `StatusDef[]`: `{key, label, category, color, isDefault?}` (`src/lib/status.ts`). `null` = inherit the system default (To Do / Done / Archived). Each status maps to a fixed `status_category` the plumbing keys off |
| `status_mode` | text | nullable (migration 0032, ADR-106). The type's status **display mode**: `none` \| `checkbox` \| `select`. **Presentation only** — `status_category` stays the source of truth for "is it done". `null` resolves via `resolveStatusMode` (`none`, or `select` when a custom `status_schema` is present). Seeded: `task`=checkbox, `project`=select, the rest=none (status is opt-in). **Do not collapse status into a boolean to "simplify" it — see the StatusMode block in `src/lib/status.ts`** |
| `show_in_quick_capture` | boolean | not null, default true (migration 0008). Whether the type appears in the quick-capture dropdown (data-driven + opt-in, PRD §4.4 / exploration type-and-kind-ux §2) |
| `listen_enabled` | boolean | not null, default false (migration 0050). Whether this type's items get a Listen (read-aloud, browser `speechSynthesis`) control on the canvas. Toggled from the Build → Types "Listen" column, mirrors `show_in_quick_capture` |
| `listen_open_in_edge` | boolean | not null, default false (migration 0050). Nested under `listen_enabled` (meaningful only when it's on): when true, the Listen control redirects to Microsoft Edge (better free voices) instead of playing locally, unless already in Edge or on a platform with no redirect (iOS) |
| `capability` | text | nullable (migration 0011, ADR-051). Attached module-capability id; when set, the registry resolves this type's canvas/format/exporters from it (bespoke-tool catalog) |
| `hidden` | boolean | not null, default false (migration 0015, ADR-059). Hidden from quick capture, +New menus, list tabs, nav options; still exists and works |
| `canvas_layout` | jsonb | nullable (migration 0019, ADR-069). The type's arrangeable item-canvas layout: `{version, cards: Record<CardId,{mode:"flow"\|"fixed", hidden?}>, layouts:{lg,md,sm: Cell[]}}`. **null = the generated default** (the classic stacked render, untouched). Parsed tolerantly (bad shape → null) in `src/lib/canvas-layout.ts`; applies only to the default markdown canvas. See "Item canvas layout" below |
| `default_view_id` | uuid | FK to `views.id`, nullable |
| `deleted_at` | timestamptz | nullable (migration 0014, ADR-058). Soft-delete stamp; a deleted type stays a row so trashed items keep a valid FK |
| `created_at` | timestamptz | |

Seed rows (Phase 1): `task`, `meeting`, `note`, `link`, `person`, all `is_system = true`. Deleting a user type is blocked while any item references it (the FK, plus a counted pre-check in the store).

> **`unmarked` system type (ADR-067).** A sixth seeded `is_system` type, **hidden** (so it stays out of quick capture, +New menus, list tabs, and nav options), whose display **label is a glyph** (a small dash/dot, not the word "unmarked"; the key is code-facing only). It is the placeholder for "not yet typed": create-on-miss from a free-text `@`-mention or the generic + Relate picker makes an `unmarked` item with `inbox = true`. Triaging it out of the Inbox is a **retype** (the item PATCH path) plus clearing `inbox`, so the row/links/body survive intact. A null `items.type` was rejected for this (type drives canvas, export path, FTS, and queries); the placeholder type gives the same "typeless until I say" feel with no downstream special-casing, and it is the Principle-6 catch-all.

> **`person` replaced `entity` (ADR-055).** The former `entity` meta-type — a single type subdivided by a `kind` column into person/org/project/topic/campus — was retired once the Build surface let any type carry its own properties and relate freely. `person` is now just a bespoke system type like the others (calendar attendee matching points at it); org/project/topic/campus are no longer built in (create them as types if needed). The `items.kind` column was dropped with it.

> **Item canvas layout (`canvas_layout`, ADR-069, Feature B).** The default item canvas can be arranged into a free 2D `react-grid-layout` grid, **per type**, at **field-level** granularity: every system field, custom property, and relation field is its own draggable/resizable card (the markdown **body**, the **title**, and the **Related** panel stay single blocks). Stored as the nullable `canvas_layout` jsonb; **`null` renders the classic stacked canvas unchanged** (never forced). Each card is **flow** (height follows content, the default) or **fixed** (a set cell whose content scrolls). Layouts are **per breakpoint**, and each viewing surface maps to one: the full-page expand fills the browser → `lg` (Desktop); the modal panel (~768px) → `md` (Tablet); a phone → `sm` (one column). A Desktop/Tablet/Phone width switcher in the arrange editor lets the user arrange each (the others auto-derive until overridden). Breakpoints are chosen by grid-*container* width (`{lg:1024, md:480, sm:0}`); the grid fills its container so the breakpoint follows the surface, and only phone-width containers (<480px) collapse to one column. A non-customized (classic) item keeps a readable column on the full page rather than stretching prose to full width. The shape + all pure logic (vocabulary, default, tolerant parse, reconcile-on-read, responsive derivation) live in client-safe `src/lib/canvas-layout.ts` (the `dashboard-widgets.ts ↔ dashboards.ts` split); arrange mode is the full-page `?arrange=1` route, saved via `PATCH /api/types/[key]/layout`. Because each scalar property is now its own card, property edits use an **atomic per-key merge** (`propertyPatch` → Postgres `properties || $patch::jsonb` in `updateItem`) so one card can't clobber another's value. Grouping/collapsible container cards are deferred (the `CardMeta` shape leaves room).

---

## `items` (the one big table)

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | FK `users.id`. **Filter every query on this.** |
| `type` | text | FK `types.key` |
| `title` | text | the "one-liner"; may be the entire content |
| `body` | jsonb | Canonical body as `{format, text}` — `format: "markdown"` (default; extended dialect, PRD §4.1) or a markdown-family format like `chordpro` per type; `text` is the markdown source of truth. Null until "gone deeper". **Never selected in list queries.** *(Markdown-canonical since ADR-037; was BlockNote JSON through v0.17.)* |
| `body_text` | text | plain-text extraction of `body.text`, maintained by app code on save; feeds the generated FTS column (ADR-003). With markdown canonical this is a near-identity strip of markdown syntax, not a JSON walk. Never selected in list queries. |
| `status` | text | the item's status **key** (ADR-082): a slug from its type's `status_schema` (`open`/`done`/`archived` in the inherited default). Free text, **not an enum**, because statuses are user-defined per type. |
| `status_category` | enum | `not_started` \| `in_progress` \| `done` \| `archived` (ADR-082). The fixed bucket the `status` key maps to, **denormalized** so the hot queries, the done-checkbox, and recurrence-complete key off an indexed enum, never the label. Default `not_started`. Re-synced for a type's items when its schema recategorizes a status. |
| `due_date` | timestamptz | nullable; the **deadline**. Since ADR-253 it is ANCHORED to `scheduled_date`: when the plan date moves N days the deadline moves N days, preserving the gap, unless `properties.datePins.due` is set. Set both in one patch to state them independently. |
| `scheduled_date` | timestamptz | nullable (migration 0021, ADR-076). The **planned date**, distinct from the due-date deadline (native tasks, ADR-073). A real column because it is hot (Today, the focus layer, the ICS feed, the overdue auto-roll all query it); UTC-midnight calendar day like `due_date` (ADR-008). For a recurring task it auto-advances on completion to the next uncompleted occurrence. Moving it carries the item's `due_date` AND every unpinned dated descendant by the same delta (ADR-253). Indexed (`items_scheduled_date_idx`) |
| `urgency` | enum | `low` \| `normal` \| `high` \| `critical`; nullable |
| `meeting_at` | timestamptz | meetings only |
| `end_at` | timestamptz | nullable (migration 0048, ADR-166). The **end** of a timed item, pairing with `meeting_at` as its start (the range rule): a real zoned instant so an event can span hours or days. `null` = single-anchor (renders as a point/chip, not a bar). Not indexed (like `meeting_at`, read on already-fetched rows, not window-queried). Custom date properties carry their own end at `properties[<key>__end]` (a UTC-midnight ISO scalar, ADR-008) when the `date` PropertyDef has `withEnd`; when it also has `withTime` (ADR-254) both start and end are full ISO instants |
| `note_date` | timestamptz | nullable (migration 0033, ADR-110). Notes only: the **date the note was taken**, distinct from `created_at` (row birth) / `updated_at` (last edit). A real column because it is hot (the natural sort/group key for notes + future date-window views); UTC-midnight calendar day like `due_date`/`scheduled_date` (ADR-008). Defaults to the creation day on create; user-editable. Indexed (`items_note_date_idx`) |
| `url` | text | links only; original web address |
| `inbox` | boolean | not null, default false; untriaged flag (PRD §4.2 Inbox). Arrival paths (quick capture; later email-in/Todoist/share-target) set it, triage clears it |
| `todoist_id` | text | nullable; set when synced to Todoist |
| `ms_event_id` | text | nullable; set when created from a calendar event (dedupe key) |
| `parent_id` | uuid | nullable; self-FK to `items.id` (containment, §hierarchy) |
| `exported_at` | timestamptz | nullable; when the OneDrive export last wrote this item (machine state, ADR-017). Incremental selection is `updated_at > exported_at` |
| `export_path` | text | nullable; where the export file lives, so renames clean up their old file and trash/archive moves to `/_archive/` |
| `properties` | jsonb | nullable; user-defined custom fields; GIN-indexed |
| `deleted_at` | timestamptz | nullable; soft-delete marker (Trash; purge after 30 days) |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

Notes:
- **Status (ADR-082, ADR-106).** Two fields, one model: `status` is the user-facing **key/label**, `status_category` is the fixed **plumbing** bucket every hot path keys off — `status_category = 'done'` is the canonical "done" (the checkbox, recurrence-complete, the default task filter). A type's `status_mode` (`none`/`checkbox`/`select`, on `types`) is **presentation only** over that model. **Do not collapse status into a boolean `done` column** — the category already *is* the boolean, and it is what lets a recurring task advance, the `in_progress`/`archived` buckets and the planned archive axis exist, and multi-status types (e.g. `project`) work. Engine + rationale: `src/lib/status.ts`.
- **Date anchoring (ADR-253)** lives in `properties.datePins` (jsonb, no column): `{ scheduled?: true, due?: true }`, tolerant-parsed, key dropped entirely when nothing is pinned. The rule it opts out of: **a date tracks its anchor unless it is pinned** — a child's dates follow its parent's `scheduled_date`, an item's `due_date` follows its own `scheduled_date`, both by DELTA (`src/lib/date-anchor.ts`, `shiftChildDates`). Deliberately not a column: it is sparse, never filtered per-row at scale, and only read alongside the row's own dates. Supersedes `properties.relativeSchedule` (ADR-085) for live subtask trees — that field required an explicit stamp that only one control ever wrote, so most children silently never tracked; it survives ONLY on the template apply path, where a dateless prototype has no gap for anchoring to measure. Also supersedes `recurrence.maintainDueOffset` as the deadline lever (that flag is no longer read; `set_recurrence` translates an explicit `false` into a due pin).
- **Recurrence (ADR-076)** lives in `properties.recurrence` (jsonb), not a column: `{ rrule, dtstart, completeInstances[], skippedInstances[], occurrenceMode: "virtual"|"materialized", anchorMode: "fixed"|"completion", maintainDueOffset? }`. `rrule` is a constrained RFC-5545 string (`FREQ`/`INTERVAL`/`BYDAY`/`COUNT`/`UNTIL`); occurrences are computed deterministically (`src/lib/recurrence.ts`), never stored as rows. Completing a recurring task advances `scheduled_date` to the next uncompleted occurrence (model C — per-date completion log; no spawned clones, no overdue stacking). A **materialized** occurrence is its own item, a deep clone of the series prototype, linked to the series by an `occurrence` relation (role, not `parent_id`); created via create-next-after-completion (one live occurrence at a time).
- People are items with `type = 'person'`. They have bodies, so "Roger" can hold notes about Roger, and relate to his meetings/tasks/prayer through the `relations` table. (Sub-classifying people — staff/volunteer — is a `select` property on the type, not a built-in column; the former `kind` column was dropped with the entity type, ADR-055.)

### Hierarchy (parent/child)
- Single parent: an item has at most one `parent_id` (its container).
- Projects are emergent: a task with children renders as a mini-project with a progress rollup (percent of children done), computed deterministically. No separate project table.
- Guard against cycles (an item can't become its own ancestor).
- Fetch trees with `WITH RECURSIVE`.
- Soft-deleting a parent cascades `deleted_at` to children so the unit restores together.

---

## `relations` (the unified tag + link system)
A single generic page-to-page edge table with no type restriction: any item links to any item. Tagging a task with a person is an edge; item-to-item references use the same table.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `source_id` | uuid | FK `items.id`; edge start |
| `target_id` | uuid | FK `items.id`; edge end (often a person, but any item is valid) |
| `role` | text | default `'related'`; optional label: `tagged`, `attendee`, `references`, ... For a **typed relation property** (ADR-067) the role is the field's `key`, so a type's Author/Attendees box is just edges with that role; `'mention'` is reserved for body-owned `@`-mention edges (ADR-015). |
| `match_state` | enum | `confirmed` \| `suggested`; default `confirmed` |
| | | **unique (`source_id`, `target_id`, `role`)** |

- `match_state = 'suggested'` is provisional (fuzzy/auto matches). It renders dotted/grayed and is **excluded from trusted queries** until confirmed. Manual and wizard-confirmed links are `confirmed`.
- Backlinks query both directions: `WHERE source_id = :me OR target_id = :me`.
- Example (Roger's open tasks): `SELECT i.* FROM items i JOIN relations r ON r.source_id = i.id WHERE r.target_id = :roger AND i.type = 'task' AND i.status = 'open' AND r.match_state = 'confirmed' AND i.deleted_at IS NULL`.

---

## `attachments`
Metadata only. Bytes live in R2 (presigned URLs; bytes never proxy through the app server). OneDrive export holds a backup copy.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | FK `users.id`; per-user quota (~10GB) |
| `parent_item_id` | uuid | FK `items.id` |
| `filename` | text | |
| `content_type` | text | |
| `size_bytes` | bigint | |
| `storage_key` | text | R2 object key (behind the storage-provider interface) |
| `exported_at` | timestamptz | nullable; when the export copied the bytes to OneDrive. Attachment bytes are immutable, so one stamp is done forever (ADR-017) |
| `created_at` | timestamptz | |

---

## `job_state` (Phase 1, slice 17)
Per-job persistent state, one row per job key: the export job's last-run record now (`onedrive_export` → `{lastRunAt, lastSuccessAt, lastResult}`, read by `/health`); calendar delta links and Todoist sync tokens land here in Phase 2. Machinery, not user content, so it is deliberately not an item.

| Field | Type | Notes |
|---|---|---|
| `key` | text PK | job identifier |
| `value` | jsonb | not null; job-defined shape |
| `updated_at` | timestamptz | |

---

## `revisions` (Phase 1)
Body snapshots for restore. Debounced on save; cap ~50 per item with a prune step.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid | FK `items.id` |
| `body` | jsonb | snapshot of the canonical `{format, text}` body (markdown since ADR-037) |
| `created_at` | timestamptz | |

---

## `views` (Phase 1 system seeds; full builder Phase 2)
Every view is a stored View Definition. Built-in views (Today, Inbox, per-type lists) ship as `system`-flagged rows that Brandon can tweak or clone. Same engine powers embedded query views (§4.9) and, in Phase 2, dashboard widgets (PRD §4.11): a widget is a view rendered as a card.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | FK `users.id` |
| `name` | text | |
| `is_system` | boolean | built-in seed vs user-built |
| `filter` | jsonb | types, entities, status, date horizon, custom-property conditions |
| `sort` | jsonb | |
| `grouping` | jsonb | |
| `layout` | enum | `list` \| `table` \| `board` \| `calendar` \| `agenda` (gallery/Gantt parked) |
| `date_property` | text | for time-based layouts: which date drives placement |
| `columns` | jsonb | ordered field/property selectors for list+table layouts; null = layout defaults |
| `display` | jsonb | Planner display config (ADR-131, migration 0038): the interactive `calendar` layout's options — `mode` (month\|timegrid), `dayCount`, `slotMinutes`, `placeBy` (scheduled\|due), work-hours window, `showWeekends`. null = defaults. Tolerant-parsed in `views.ts`. |
| `dashboard_order` | integer | dashboard config (slice 29, migration 0005): null = not a widget; a number = position in the widget grid. One dashboard per owner in v1 — the config rides the view it shows, no separate table. |
| `created_at` | timestamptz | |

---

## `matchers` (Phase 2, built slice 23; calendar event → template/entity)
Ordered, user-built rules (no seeded list). Editable without redeploy. Populated via setup wizard and learn-by-confirmation. Created in migration 0004, which also enables the `pg_trgm` extension for the fuzzy condition (ADR-024).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | |
| `priority` | int | evaluation order |
| `condition` | jsonb | one of: attendee-email, calendar series id, title regex, title fuzzy (`pg_trgm` `similarity()` fallback) |
| `action` | jsonb | apply named template, attach default entities/tags, set default urgency |
| `created_at` | timestamptz | |

Condition priority order: attendee email → series id → title regex → fuzzy title (last resort, only when no attendee/series match).

---

## `push_subscriptions` (Phase 2, slice 30; Web Push)
One row per browser/device the owner enabled notifications on (PRD §4.11). The push service `endpoint` is the unique key; `p256dh`/`auth` are the RFC 8291 message-encryption keys the browser supplies at subscribe time. Owner-scoped; a subscription the push service reports Gone (404/410) is pruned, so the table self-heals to live endpoints. Migration 0006.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | FK `users.id` |
| `endpoint` | text | **unique**; the push service URL |
| `p256dh` | text | base64url; subscription public key |
| `auth` | text | base64url; subscription auth secret |
| `created_at` | timestamptz | |

VAPID keys live in env (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`), not the DB; the Web Push protocol (VAPID JWT + RFC 8291 encryption) is hand-rolled over `node:crypto`, no `web-push` dependency (ADR-034).

---

## `share_tokens` (Phase 2, slice 31; public share links)
One row per issued public link (PRD §4.12): an unguessable `token` grants read-only access to one item's print render with no Clerk on the path. Owner-scoped issuance; revocation is a `revoked_at` stamp, not a delete, so the history is auditable and a revoked string can't be silently reissued. Cascade-deletes with the item at purge. Migration 0007.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | FK `users.id` |
| `item_id` | uuid | FK `items.id`, `ON DELETE CASCADE` |
| `token` | text | **unique**; 24 random bytes base64url (~192 bits) |
| `revoked_at` | timestamptz | nullable; set on revoke (the link stops resolving) |
| `created_at` | timestamptz | |

The public resolve joins token→item in one query so it only ever yields a live (non-revoked) token bound to a live (non-trashed) item. Indexes on `item_id` (list a page's links) and `owner_id`.

---

## `api_credentials` (ADR-224; minted machine credentials)
One row per API credential the owner creates in User Settings, replacing "edit `LEDGR_API_TOKENS` and redeploy" as the way to issue and revoke machine access. Two parts, the Planning Center / Stripe / AWS shape: a **public** `key_id` stored in plaintext (the lookup handle, and what the UI displays) and a **secret** whose sha256 is all that persists. Auth is `Authorization: Basic base64(keyId:secret)`, with `Bearer <keyId>:<secret>` also accepted. Same hashing and constant-time compare as the env tokens (`src/lib/auth/machine.ts`), the same row-not-env arrangement as `sync_peers` (plan decision 15): revocation is a `revoked_at` stamp, effective on the caller's next request, with no redeploy. Migration 0058.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `owner_id` | uuid | FK `users.id`; who minted it. Multi-user-ready (Principle 7) — the machine routes still act for the single `resolveMachineOwner`, a multi-user build would read the acting owner here |
| `name` | text | free-form, ≤60 chars; shown in the list and echoed as the caller's identity in machine-route logs |
| `key_id` | text | **unique**, PUBLIC, plaintext. `lgrk_` + 12 random bytes hex |
| `secret_hash` | text | sha256 hex of the secret (`lgrs_` + 24 random bytes hex). The secret itself is returned once at creation and never stored |
| `scopes` | jsonb | `string[]` of scope strings (`api`, `mcp`, `cron`, `diag`) — the same vocabulary the env entries use, validated server-side against the offered set |
| `created_at` | timestamptz | |
| `last_used_at` | timestamptz | nullable; advanced on successful auth, off the request path and throttled to one write a minute |
| `revoked_at` | timestamptz | nullable; set on revoke. Not a delete, so the list still shows what the credential was and when it stopped working |

Verification is one indexed fetch by `key_id` then one `timingSafeEqual` on the hash, versus the env scheme's walk over every entry. Unique index on `key_id` (the lookup), index on `owner_id` (the owner-scoped list). Caps enforced in the lib, not the schema: 25 active credentials and 10 created per hour, both counted in SQL because a serverless instance's memory resets on every cold start.

---

## `error_log` (Phase 1; or use a free Sentry tier)
No silent failures. Failed crons/webhooks captured here and surfaced through `/health` and the UI.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `correlation_id` | text | ties to structured logs |
| `source` | text | which job/route |
| `message` | text | human-readable |
| `detail` | jsonb | verbose context (shown when debug mode on) |
| `created_at` | timestamptz | |

---

## Property kinds (for `types.property_schema` and `items.properties`)
A core set covers nearly everything. **Built in the slice-33 builder (ADR-044):** `text`, `number`, `date`, `checkbox`, `url`, `select`, `multi_select` (the last two carry an `options: string[]`). `property_schema` is an **ordered array** of `{key, label, kind, options?}` (`key` is a stable slug, immutable once created, so renaming a label never orphans `items.properties` values). Formulas and rollups are out of scope (parking lot), except the deterministic subtask progress rollup.

**`date` flags (ADR-166, ADR-254).** A `date` PropertyDef may carry `withEnd: true` (its end lives at `properties[<key>__end]`, so one field is a range) and/or `withTime: true` (the value is a full ISO instant such as `2026-09-11T02:06:00.000Z` instead of a day scalar `2026-09-10`). Readers tell the two shapes apart by length (`placement.ts` `propInstant`), never by the flag, so flipping a flag on later leaves every existing value readable and a cleared time falls back to a day. The flags are set in the type builder's Date row and echoed by MCP `list_types`.

**`phone` and `email` (ADR-192).** Two scalar kinds that are `text` in storage and differ only in rendering: a `tel:` / `mailto:` link plus the matching on-screen keyboard, so a person's number is tappable on a phone instead of something to read and retype into the dialer. **The stored value is exactly what the owner typed** — nothing validates or reformats it, because phone formats are a swamp (extensions, country codes, "x203") and a field that refuses a valid number is worse than one that renders an odd one. Normalization happens only when building the href (`src/lib/contact-links.ts`: digits plus a leading `+`, with anything past a `,`/`;` or a trailing extension cut so an extension can't read as more digits of the number). They filter as text (`contains`/`eq`/`neq`/`set`/`empty`) over the raw value, so a stored `(309) 555-0142` does not match a `3095550142` search. **Back-compat:** before these kinds existed the intent was guessed from the field's *key* (`phone`, `mobile`, `cell`, `email`), and that heuristic still applies to `text` fields so imported Notion data keeps working — a declared kind always wins over it. Nothing migrates: an existing `text` field keeps behaving as it did until someone changes its kind.

**`relation` (un-deferred, ADR-067).** A property any type can declare in the builder, a typed link box on the form (a Book's "Author", a Meeting's "Attendees"). Its `PropertyDef` carries two extra fields: `targetType` (the type its links accept, e.g. `person`; optional, unset means any type) and `cardinality` (`single` | `many`). **Its value is NOT stored in `items.properties`; it is stored as `relations` edges with `role` set to the field's `key`** (the Author box = edges from this item with role `author`). So one source of truth for links (the relations table, the schema rule), and typed-field links show in the generic Related panel for free. Cardinality is enforced in the app layer (a `single` field replaces its edge on a new pick), not by a DB constraint; the existing unique `(source_id, target_id, role)` already lets several typed fields connect the same pair. *(Was deferred through ADR-044/ADR-055 because the universal `@`-mention + `RelatedPanel` covered ad hoc links; un-deferred once Brandon's attendees/author boxes proved a recurring typed need, ADR-067.)* The pre-built Bible/passage hub (ADR-060) is built on plain item-to-item relations, not this kind. **Caution before declaring a new relation field (ADR-175):** a typed field reads *only* its own role, so a field whose meaning is really "any connected item of type X" will disagree with the role-blind writers (inbox chips, MCP `relateTo`, promoted action items, `+ Relate`) that stamp `related`. Person connections on tasks are deliberately generic `related` edges surfaced by a bespoke People row — the old task `people` field was retired for exactly this. A typed field is for a role with real semantics of its own (event `attending`, group `members`, hiring `reference`, task `project`).

**`include_in_share` (forthcoming, ADR-062):** a per-`PropertyDef` flag deciding whether a property is exposed when an item is shared/printed — Share/Print renders the canvas plus the opted-in fields. Mirrors the type-level `show_in_quick_capture` toggle but lives on the property. Per-type default field sets are decided type by type.

---

## Index plan
- B-tree: `items.type`, `items.owner_id`, `items.status`, `items.status_category` (ADR-082), `items.due_date`, `items.scheduled_date`, `items.note_date` (ADR-110), `items.parent_id`; partial on `items.owner_id where inbox and deleted_at is null` (nav badge count + Inbox view).
- `relations.source_id` and `relations.target_id` indexed **separately** so both-direction backlink queries use bitmap index scans.
- GIN on `items.properties`.
- FTS: a `GENERATED ALWAYS AS ... STORED` `tsvector` column on `items`, GIN-indexed, weighted (ADR-014): title (`A`), body_text (`B`), then url (punctuation-split so URL words match) and `properties` string values via `jsonb_to_tsvector` (both `C`). Status/urgency/dates deliberately excluded (enums are filters, not prose). Not computed per query. (`body_text` is app-maintained: it strips markdown syntax from `body.text`. Generating the tsvector straight from the raw `body` jsonb would index structural noise, ADR-003; with markdown canonical the extraction is a light strip rather than a JSON walk.)
- B-tree on `push_subscriptions.owner_id` and `share_tokens.owner_id`/`share_tokens.item_id` (slices 30/31); `endpoint` and `token` are unique constraints.
- Composite indexes as query patterns prove them out; log additions in `decisions.md`.

## Phase 2+ structures, noted ahead (don't build in Phase 1)
- **Dashboard widgets (PRD §4.11):** a widget references a `views` row plus per-widget config (item count N, position, badge on/off). Likely a small `widgets` table (owner_id, view_id, position, item_count, show_badge) or a JSONB layout doc per user; decide at Phase 2 and log it.
- **Navigation slots (PRD §4.12):** 4-5 ordered slots per user (target view/type/item, badge source). Small enough to be a JSONB config on `users` or a tiny `nav_slots` table; decide at Phase 2.
- **Bible/passage relational structure (ADR-060, 2026-06-14 meeting; post-foundation module):** the canon pre-built as a relational structure — **book → chapter → verse, verse atomic**. Any item relates to one or more verses via the existing `relations` table (no new edge mechanism); a passage range links each verse in the range. A deterministic RefTagger-style auto-tagger (cron, no model) wires references in many surface forms. Modeled as a **bespoke `passage` type** (a verse is an item of that type), **not** as a `kind` of a generic entity — the `entity` meta-type and `kind` column were retired in ADR-055, so the old "passage as an `entity.kind`" framing in `explorations/scripture-passages-as-entities.md` is superseded. The exact row shape (one row per verse + chapter/book containers) is decided at build, but the relations + FTS reuse is the point. Touches core invariants (relations/search), so it's both-agree + ADR (done: ADR-060); the build itself is module-level. **Model amended — ADR-149 (2026-07-06, accepted; Brandon + Tyler agreed):** verse-as-item is dropped. Passages become a *reference dimension* — a tiny static canon (book + verses-per-chapter counts) + a deterministic ref→integer resolver + a purpose-built `passage_refs` interval edge table (`source_item_id, start_ref, end_ref, role`), surfaced through a **linkable-provider seam** so `@/ref` and the relate button treat passages like a type. No verse rows, no per-verse export files; a passage "page" is a generated virtual view and ranges are `[start,end]` intervals (not per-verse edges). Build is ready (resolver first, minimal build per ADR-149); see ADR-149. (Proposed as ADR-134; renumbered — 134 is the cross-device edit guard.)
- **Per-owner settings/profile store (cross-cutting; mostly shipped, ADR-053):** the V5 UI work added a `users.settings` jsonb (accent/highlight color, trash retention, nav position; migration 0012, ADR-053). The Papers "enter author/school once" (next_steps P2) and any future per-user module config (paragraph-titles on/off, etc.) want the same store. Consolidate on that one settings blob rather than per-feature columns; the author-name piece is core-adjacent (flag for an ADR when the profile surface is formalized). Per-type maps live here too, keyed by type key: `listTabs` (list lenses) and `tocByType` (floating-TOC on/off + levels, ADR-114) — both tolerant-parsed, additive, no migration.
- **Meeting AI (PRD §4.15):** needs no new tables. Audio is an `attachments` row; transcript/summary are sections in the meeting `body`; suggested tasks are task items related to the meeting with `match_state = 'suggested'`.

## Known schema-adjacent gaps (track, don't block)
- ~~Custom property values aren't full-text searched~~ resolved 2026-06-12: `properties` string values and link URLs joined the FTS document at weight `C` (ADR-014, migration 0002). The entity-kind term was dropped from the document when the column was removed (ADR-055, migration 0013).
- **Embedded query-view blocks have no faithful markdown form.** They export as a static snapshot/placeholder, not a live view (fine for the pulpit fallback since sermons are prose).
- ~~Entity `kind` placement~~ resolved: column on `items` (ADR-003); later removed with the entity type (ADR-055) — sub-classification is now a `select` property on a type.
