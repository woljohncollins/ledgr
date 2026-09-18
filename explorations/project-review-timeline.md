# Project review timeline — the everything-timeline of a record

**Status:** BUILT (2026-08-17, ADR-198 — same day as raised). The center-spine page below is live at `/items/[id]/timeline` (`src/lib/project-timeline.ts` gathers, the page renders), alongside its two siblings from the same session: the Timeline card preview and the ADR-197 markdown document's Timeline section. The task `completed_at` gap closed via ADR-197's stamp. **Extended 2026-09-03 (ADR-247):** the spine is no longer this page's private display. It is a component (`src/components/timeline/TimelineSpine.tsx`) fed by a shared `TimelineEntry` seam (`src/lib/timeline-entry.ts`), available as the **History** calendar mode on any saved view, so it renders on the view page, as a list lens tab, and as a dashboard widget. The record page gained Group by / Order / Show controls, and a view can now be placed by a type's own date property. Kept for the record and for the still-open ideas: "key findings" as a first-class signal, virtualization if year-old projects drown the spine, status-change entries from the activity log, an in-view mode toggle (Month → Timeline → History without editing the view), a spine as a first-class record WIDGET rather than only a full page, and container queries so a narrow widget's spine collapses to one column.

> **Pivot, same day (for the record):** Tyler first redirected this toward the timeline **living in the project's markdown file** (`explorations/project-markdown-file.md`, ADR-197), then greenlit this visual page as its interactive twin once the markdown shipped.

## The idea (Tyler's words, lightly compressed)

A full page that lets you review a whole project by scrolling through time: "a complete vertical timeline of everything — when notes were made, when meetings were had, when key findings came forward, when milestones got completed — with the bigger events (meetings, milestones) standing out among everything (task completions, notes made, links added). The user could scroll down through a whole project to review a project. I see the vertical timeline being a line in the middle of the page with dates popping up on the left and right and the big dates as like h1 or h2's on that page."

## What exists today (the seed)

- **`/items/[id]/timeline`** (2026-08-17): a light chronological page of the record's meetings + milestones, month-grouped, with open undated milestones in an "Uncompleted" tail. The Timeline widget card drills into it. This page is the natural home for the full version — same URL, richer render.
- **The data is already captured.** Every candidate event has a timestamp somewhere: `activity_events` (the record's activity log already records task_added / note_added / milestone_added / status changes with `occurred_at`), `items.created_at` for contained notes/links, `meeting_at` for meetings, `due_date` + the ADR-196 `properties.completed_at` stamp for milestones, and task `updated_at`-at-done (weak — see open questions). A first cut is a UNION over those sources, not new capture.

## Shape

- One vertical spine down the center; entries alternate left/right of it.
- **Two visual tiers:** big events (meetings, milestone completions, maybe status changes) render large — the h1/h2s of the scroll — with everything else (task completions, notes created, links added) as small ticks between them.
- Month/year headers as you scroll (the current page's month groups, promoted).
- Read-only; every entry links to its item. This is a REVIEW surface, not an editor.

## Open questions

- **Task completion times are not stored** — `updated_at` at done-time is an approximation that drifts on any later edit. If task ticks matter, tasks need the same `completed_at` stamp milestones got in ADR-196 (additive, same mechanism), or the timeline reads task events from `activity_events` instead.
- **"Key findings" is not a thing yet.** Closest existing signals: a note contained in the record, a comment, or a manually-pinned entry. May want nothing new: a note IS the finding, and its creation date places it.
- **Volume.** A year-old project could have hundreds of small ticks; the two-tier design plus month collapsing is probably enough, but virtualize if not.
- Whether this replaces the Timeline **widget card** (probably not — the card stays the glanceable preview; this is the drill-down).

## Related

- The dashboards-as-activity-surfaces direction (ADR-171) and the Recent Activity widget — this is the same activity data, project-scoped and rendered as a narrative instead of a feed.
- `explorations/flexible-surfaces.md` — if custom composable pages land, this could be a page template rather than a bespoke route.
