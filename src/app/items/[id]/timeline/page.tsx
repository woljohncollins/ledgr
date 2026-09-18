// The project review timeline (ADR-198 — Tyler's everything-timeline, built
// from explorations/project-review-timeline.md): scroll through a whole
// project as one vertical history. The spine itself now lives in
// src/components/timeline/TimelineSpine.tsx so the same display can render a
// saved view of any type (2026-09-03); this page is the record-scoped gatherer
// plus its controls.
//
// Three knobs, all query params so the page stays a zero-JS server render:
//   ?grain=  how much time one chip covers (hour → 5-year)
//   ?dir=    oldest-first (default) or newest-first
//   ?kinds=  which collections to show; the record-side analog of a property
//            filter, since a record spine merges five types and no single
//            property predicate spans them.
//
// Read-only on purpose: this is a REVIEW surface. Every entry links to its
// item; the Timeline card's "Showing N of M →" lands here.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import TimelineSpine from "@/components/timeline/TimelineSpine";
import { resolveComposition } from "@/lib/composition";
import { getItem } from "@/lib/items";
import { resolveOwner } from "@/lib/owner";
import { gatherProjectTimeline } from "@/lib/project-timeline";
import type { TimelineEntry } from "@/lib/timeline-entry";
import { GRAIN_LABELS, SPINE_GRAINS, parseGrain } from "@/lib/timeline-grain";
import { getAppTimezone } from "@/lib/today";
import { getType } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const owner = await resolveOwner();
    if (!owner) return {};
    const record = await getItem(owner.id, id);
    return { title: `Timeline · ${record.title || "Untitled"}` };
  } catch {
    return {};
  }
}

// The collections a reader can switch off. "created" is excluded: it is the
// record's own opening line, not one of the collections.
const FILTER_KINDS = [
  { kind: "meeting", label: "Meetings" },
  { kind: "milestone", label: "Milestones" },
  { kind: "task", label: "Tasks" },
  { kind: "note", label: "Notes" },
  { kind: "link", label: "Links" },
] as const satisfies readonly { kind: TimelineEntry["kind"]; label: string }[];

const ALL_KINDS = FILTER_KINDS.map((k) => k.kind);

function parseKinds(raw: string | string[] | undefined): TimelineEntry["kind"][] {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return [...ALL_KINDS];
  const asked = new Set(v.split(",").map((s) => s.trim()));
  const kept = ALL_KINDS.filter((k) => asked.has(k));
  // An unusable value (typo, stale link) shows everything rather than nothing.
  return kept.length ? kept : [...ALL_KINDS];
}

const CHIP_ON = "border-[var(--accent)] bg-surface-1 text-[var(--accent)]";
const CHIP_OFF = "border-line bg-surface-2 text-ink-subtle hover:text-ink-muted";

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] ${on ? CHIP_ON : CHIP_OFF}`}
    >
      {children}
    </Link>
  );
}

function ControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </div>
  );
}

export default async function RecordTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const owner = await resolveOwner();
  if (!owner) notFound();

  const grain = parseGrain(sp.grain);
  const dir = (Array.isArray(sp.dir) ? sp.dir[0] : sp.dir) === "desc" ? "desc" : "asc";
  const kinds = parseKinds(sp.kinds);
  const allKinds = kinds.length === ALL_KINDS.length;

  let record;
  try {
    record = await getItem(owner.id, id);
  } catch {
    notFound();
  }

  const [{ entries, undated, firstFutureIndex }, typeDef, tz] = await Promise.all([
    gatherProjectTimeline(owner.id, record, allKinds ? undefined : new Set(kinds)),
    getType(record.type).catch(() => null),
    getAppTimezone(owner.id),
  ]);

  // The no-date group's label follows the record's Timeline tool setting (its
  // own composition, else the type default), same as the card.
  const { composition } = resolveComposition(record.composition, typeDef?.defaultWidgets, record.type);
  const tlOptions = composition.widgets.find((w) => w.defId === "timeline")?.options;
  const undatedLabel =
    typeof tlOptions?.undatedLabel === "string" && tlOptions.undatedLabel
      ? tlOptions.undatedLabel
      : "Upcoming";

  // Control links preserve the other two knobs, and drop a param at its default
  // so a shared URL stays readable.
  const href = (next: { grain?: string; dir?: string; kinds?: string[] }) => {
    const q = new URLSearchParams();
    const g = next.grain ?? grain;
    const d = next.dir ?? dir;
    const k = next.kinds ?? kinds;
    if (g !== "month") q.set("grain", g);
    if (d !== "asc") q.set("dir", d);
    if (k.length !== ALL_KINDS.length) q.set("kinds", k.join(","));
    const s = q.toString();
    return s ? `/items/${id}/timeline?${s}` : `/items/${id}/timeline`;
  };
  const toggleKind = (k: TimelineEntry["kind"]) =>
    kinds.includes(k) ? kinds.filter((x) => x !== k) : ALL_KINDS.filter((x) => kinds.includes(x) || x === k);

  const total = entries.length + undated.length;

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-4xl px-2 pb-24 pt-4 sm:px-8">
        <nav className="mb-1 text-xs text-ink-subtle">
          <Link href={`/items/${id}`} className="hover:text-ink-muted">
            {record.title || "Untitled"}
          </Link>
          <span className="px-1.5 text-ink-faint">/</span>
          <span className="text-ink-muted">Timeline</span>
        </nav>
        <h1 className="mb-4 ui-title">
          Timeline
          <span className="ml-2 text-sm font-normal text-ink-subtle">{total}</span>
        </h1>

        <div className="mb-6 flex flex-col gap-2 rounded-card border border-line bg-surface-1 px-3 py-2.5">
          <ControlRow label="Group by">
            {SPINE_GRAINS.map((g) => (
              <Chip key={g} href={href({ grain: g })} on={g === grain}>
                {GRAIN_LABELS[g]}
              </Chip>
            ))}
          </ControlRow>
          <ControlRow label="Order">
            <Chip href={href({ dir: "asc" })} on={dir === "asc"}>
              Oldest first
            </Chip>
            <Chip href={href({ dir: "desc" })} on={dir === "desc"}>
              Newest first
            </Chip>
          </ControlRow>
          <ControlRow label="Show">
            {FILTER_KINDS.map((k) => (
              <Chip key={k.kind} href={href({ kinds: toggleKind(k.kind) })} on={kinds.includes(k.kind)}>
                {k.label}
              </Chip>
            ))}
            {!allKinds && (
              <Link href={href({ kinds: [...ALL_KINDS] })} className="ml-1 text-[11px] text-ink-subtle underline decoration-dotted hover:text-ink-muted">
                show all
              </Link>
            )}
          </ControlRow>
        </div>

        {total === 0 ? (
          <p className="mt-6 px-2 text-sm text-ink-subtle">
            {allKinds ? "Nothing here yet." : "Nothing matches these filters."}
          </p>
        ) : (
          <TimelineSpine
            entries={entries}
            tz={tz}
            grain={grain}
            dir={dir}
            todayBefore={firstFutureIndex}
            undated={undated}
            undatedLabel={undatedLabel}
          />
        )}
      </div>
    </main>
  );
}
