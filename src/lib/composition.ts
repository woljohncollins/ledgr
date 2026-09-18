// Widget composition: the Layer-2 (per-Type default) and Layer-3 (per-record
// override) shapes + tolerant parse + resolve overlay (ADR-111/PJ3). Pure,
// client-safe — no DB, no React — mirroring src/lib/canvas-layout.ts: a tolerant
// parse (bad shape → null), a generated default, and a resolve-on-read that
// overlays record → type-default → generated default. Reuses the dashboard grid
// cell shape so a Type template and a materialized record page are one vocabulary.
import { GRID_BREAKPOINTS, type GridBreakpoint, type GridCell } from "@/lib/dashboard-widgets";
import { widgetById } from "@/lib/widgets";

const VERSION = 1 as const;

// One enabled-and-arranged widget on a record (Layer 3) or in a Type default
// (Layer 2). `defId` → WIDGET_CATALOG.id; `instanceId` is stable across edits.
// Disabling sets hidden=true (hide, never delete — the backing items live in
// items/relations, untouched), so re-enabling restores.
export type RecordWidget = {
  instanceId: string;
  defId: string;
  options?: Record<string, unknown>;
  layout?: Partial<Record<GridBreakpoint, GridCell>>;
  hidden?: boolean;
};

export type DigestBehavior = {
  enabled: boolean;
  stalenessDays: number;
  upcomingDays: number;
};

export type Composition = {
  version: 1;
  widgets: RecordWidget[];
  behaviors: { digest?: DigestBehavior };
};

export const DEFAULT_DIGEST: DigestBehavior = {
  enabled: true,
  // 14, not 7 (Tyler, 2026-08-17): "haven't looked at it in a while" is a
  // two-week feeling. Opening the project resets the clock (the view beacon
  // writes checkin_reviewed), so an actively-read project never surfaces.
  stalenessDays: 14,
  upcomingDays: 7,
};

// --- The default Project composition (Tyler, 2026-07-01) --------------------
// The redesigned Project homepage: a header strip the canvas renders without
// card chrome (Status pinned top-right, People row + Progress bar on the left,
// none titled), then a uniform grid of section cards in a fixed starting order —
// Tasks, Milestones, Docs (Notes), Meetings. Overview / Recent Activity /
// Timeline aren't in the default; they're one tap away on the "+ Add section"
// button. Card ORDER is the composition array order (the canvas ignores grid
// x/y now, so no cell coordinates here); adding a section appends to the end.
function w(defId: string, cell: GridCell, options?: Record<string, unknown>): RecordWidget {
  return { instanceId: defId, defId, layout: { lg: cell }, ...(options ? { options } : {}) };
}

function seat(defId: string, options?: Record<string, unknown>): RecordWidget {
  return { instanceId: defId, defId, ...(options ? { options } : {}) };
}

const PROJECT_DEFAULT_WIDGETS: RecordWidget[] = [
  // Header (no card chrome, no titles) — see WidgetCanvas HEADER_WIDGETS.
  // Overview is back in the default (it was dropped in the 2026-07-01 redesign,
  // which is what made project descriptions vanish). It costs nothing when
  // empty: HeaderOverview collapses to a small lines glyph until something is
  // written, so a brand-new project shows a place to describe itself rather than
  // hiding the affordance entirely.
  seat("overview"),
  seat("status"),
  seat("people"),
  seat("progress"),
  // Section cards, fixed starting order.
  seat("tasks"),
  seat("milestones"),
  seat("notes"),
  seat("meetings"),
];

// A generic homepage for any non-project type that opts in (PJ10): its body +
// status. Everything else stays one toggle away in the gear.
const GENERIC_DEFAULT_WIDGETS: RecordWidget[] = [
  w("overview", { x: 0, y: 0, w: 12, h: 8 }),
  w("status", { x: 0, y: 8, w: 4, h: 2 }),
];

// A Pursuit's homepage (PRD §1/§9): the same widgets one scope up. Related
// Records surfaces its Projects; Progress / Next Action / Recent Activity roll
// up across them (record-widgets.ts aggregates when a record contains tracked
// children). The header strip + a status, then the projects and the roll-up log.
const PURSUIT_DEFAULT_WIDGETS: RecordWidget[] = [
  w("status", { x: 0, y: 0, w: 3, h: 2 }),
  w("nextAction", { x: 3, y: 0, w: 5, h: 2 }),
  w("progress", { x: 8, y: 0, w: 4, h: 2 }),
  w("overview", { x: 0, y: 2, w: 8, h: 6 }),
  w("relatedRecords", { x: 0, y: 8, w: 8, h: 8 }, { typeFilter: "project" }),
  w("recentActivity", { x: 8, y: 2, w: 4, h: 14 }),
];

export function generatedDefaultComposition(type: string): Composition {
  const widgets =
    type === "project"
      ? PROJECT_DEFAULT_WIDGETS
      : type === "pursuit"
        ? PURSUIT_DEFAULT_WIDGETS
        : GENERIC_DEFAULT_WIDGETS;
  // Digest is a default behavior for tracked container types (PRD §7).
  const behaviors =
    type === "project" || type === "pursuit" ? { digest: { ...DEFAULT_DIGEST } } : {};
  return { version: VERSION, widgets: widgets.map((x) => ({ ...x })), behaviors };
}

// --- Tolerant parse (bad shape → null), mirroring parseCanvasLayout ---------

function parseCell(raw: unknown): GridCell | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const x = num(r.x);
  const y = num(r.y);
  const ww = num(r.w);
  const h = num(r.h);
  if (x === null || y === null || ww === null || h === null) return null;
  return { x: Math.max(x, 0), y: Math.max(y, 0), w: Math.max(ww, 1), h: Math.max(h, 1) };
}

function parseLayout(raw: unknown): Partial<Record<GridBreakpoint, GridCell>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Partial<Record<GridBreakpoint, GridCell>> = {};
  for (const bp of GRID_BREAKPOINTS) {
    const cell = parseCell((raw as Record<string, unknown>)[bp]);
    if (cell) out[bp] = cell;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseWidget(raw: unknown): RecordWidget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const defId = typeof r.defId === "string" ? r.defId : null;
  if (!defId) return null;
  const instanceId = typeof r.instanceId === "string" && r.instanceId ? r.instanceId : defId;
  const out: RecordWidget = { instanceId, defId };
  if (r.options && typeof r.options === "object" && !Array.isArray(r.options)) {
    out.options = r.options as Record<string, unknown>;
  }
  const layout = parseLayout(r.layout);
  if (layout) out.layout = layout;
  if (r.hidden === true) out.hidden = true;
  return out;
}

function parseDigest(raw: unknown): DigestBehavior | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const days = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : fallback;
  };
  return {
    enabled: r.enabled !== false,
    stalenessDays: days(r.stalenessDays, DEFAULT_DIGEST.stalenessDays),
    upcomingDays: days(r.upcomingDays, DEFAULT_DIGEST.upcomingDays),
  };
}

export function parseComposition(raw: unknown): Composition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== VERSION) return null;
  if (!Array.isArray(r.widgets)) return null;
  const widgets: RecordWidget[] = [];
  const seen = new Set<string>();
  for (const wraw of r.widgets) {
    const parsed = parseWidget(wraw);
    if (parsed && !seen.has(parsed.instanceId)) {
      seen.add(parsed.instanceId);
      widgets.push(parsed);
    }
  }
  const behaviorsRaw = (r.behaviors ?? {}) as Record<string, unknown>;
  const digest = parseDigest(behaviorsRaw.digest);
  return { version: VERSION, widgets, behaviors: digest ? { digest } : {} };
}

// Drop instances whose widget isn't in the catalog (a removed widget), keeping
// everything else (hidden flag, options, layout). Run on read so a stale stored
// composition never references a vanished widget.
export function reconcileComposition(comp: Composition): Composition {
  return {
    ...comp,
    widgets: comp.widgets.filter((iw) => widgetById(iw.defId)),
  };
}

// The render-path resolver (ADR-111/PJ3): overlay Layer 3 (the record's own
// composition) over Layer 2 (the type default) over the generated default. The
// record diverges FROM the type default; it never defines it (PRD §2). Returns
// the effective composition plus where it came from (for "reset to type default").
export function resolveComposition(
  recordRaw: unknown,
  typeDefaultRaw: unknown,
  type: string
): { composition: Composition; source: "record" | "type" | "generated" } {
  const record = parseComposition(recordRaw);
  if (record) return { composition: reconcileComposition(record), source: "record" };
  const typeDefault = parseComposition(typeDefaultRaw);
  if (typeDefault) return { composition: reconcileComposition(typeDefault), source: "type" };
  return { composition: generatedDefaultComposition(type), source: "generated" };
}

// The widgets a record can still ADD (the gear's "which widgets" list): catalog
// widgets not already present as a (visible-or-hidden) instance. Disabled
// widgets stay in `widgets` with hidden=true, so they're "present" — toggled,
// not re-added.
export function addableWidgets(comp: Composition, available: { id: string }[]): string[] {
  const present = new Set(comp.widgets.map((iw) => iw.defId));
  return available.map((d) => d.id).filter((id) => !present.has(id));
}

// Is a widget instance currently surfaced on the canvas (present + not hidden)?
export function isWidgetEnabled(comp: Composition, defId: string): boolean {
  return comp.widgets.some((iw) => iw.defId === defId && !iw.hidden);
}

// The per-card preview cap for a collection/related widget (Tyler, 2026-07-01):
// how many rows the card shows before offering a "Showing N of M →" link into
// the full collection page. Stored per instance (the card's hover gear writes
// options.limit); default 5, clamped [1, 50] — or the literal "all" (Tyler,
// 2026-08-17), which reads back as Infinity so slice()/comparisons need no
// special case (the fan-out widens its fetch window, still bounded). Pure +
// client-safe so the fan-out, the canvas, and the gear all read one rule.
export const WIDGET_LIMIT_DEFAULT = 5;
export const WIDGET_LIMIT_MAX = 50;
export const WIDGET_LIMIT_ALL = "all";
export function widgetLimit(instance: RecordWidget): number {
  if (instance.options?.limit === WIDGET_LIMIT_ALL) return Number.POSITIVE_INFINITY;
  const n = Number(instance.options?.limit);
  if (!Number.isFinite(n)) return WIDGET_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.round(n), 1), WIDGET_LIMIT_MAX);
}

// The per-card display title override (Tyler, 2026-08-19, rides ADR-204): the
// card gear's Rename writes options.title, so a tool can be named per record
// ("Docs" → "Sermon research" on one project, untouched elsewhere). Null = no
// override; callers fall back to the catalog default. Trimmed and capped here
// (not just in the input) so a stored stray value can't blow up the header.
export const WIDGET_TITLE_MAX = 60;
export function widgetTitle(instance: RecordWidget): string | null {
  const raw = instance.options?.title;
  if (typeof raw !== "string") return null;
  const t = raw.trim().slice(0, WIDGET_TITLE_MAX);
  return t.length > 0 ? t : null;
}
