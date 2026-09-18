// The snapshot spread: pure arithmetic, no filesystem, no database.
//
// Split out of src/lib/snapshots.ts so both sides can import it: the settings
// island in the browser (which cannot see node:fs) and
// scripts/verify-snapshots.mts (which runs in CI, where there is no cluster to
// dump). The filesystem and pg_dump half lives next door in snapshots.ts:
// import the numbers from here and the files from there.
//
// ── The one knob, and the spread it implies ──────────────────────────────────
//
// The owner sets "how many snapshots to keep". Everything else is computed: a
// second knob would be a second thing to get wrong, and the shape below is not
// a preference anyone holds, it is just "recent matters more than old".
//
// Dumps are taken hourly (cheap: one pg_dump of a database that fits in RAM).
// The PRUNER is what makes the spread: newest-per-bucket, tier by tier, the
// same decision borg/restic prune make. Gaps are handled by construction, since
// a machine that slept through a night has no buckets for those hours, so the
// older tiers keep what they would have kept anyway instead of spending the
// budget on empty windows.

const HOUR_MS = 3_600_000;

export type Tier = {
  /** How the tier reads in a sentence: "one every 6 hours". */
  label: string;
  /** Bucket width. One snapshot survives per bucket. */
  intervalMs: number;
  /** Share of the budget. */
  weight: number;
};

export const TIERS: Tier[] = [
  { label: "hour", intervalMs: HOUR_MS, weight: 0.35 },
  { label: "6 hours", intervalMs: 6 * HOUR_MS, weight: 0.25 },
  { label: "day", intervalMs: 24 * HOUR_MS, weight: 0.25 },
  { label: "3 days", intervalMs: 72 * HOUR_MS, weight: 0.15 },
];

export const DEFAULT_KEEP = 30;
export const MIN_KEEP = TIERS.length;
export const MAX_KEEP = 500;

/** A keep count that cannot produce a nonsense plan. */
export function clampKeep(raw: unknown): number {
  // null and "" both coerce to 0, which would silently become the minimum
  // rather than the default. Absent is absent.
  if (raw === null || raw === undefined || raw === "") return DEFAULT_KEEP;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_KEEP;
  return Math.min(MAX_KEEP, Math.max(MIN_KEEP, n));
}

export type PlannedTier = Tier & { count: number };

/**
 * Split the budget across the tiers. Every tier keeps at least one, the
 * remainder goes to the densest tiers first, and the counts sum to exactly
 * `keep`: the number the owner typed is the number of files on disk.
 */
export function tierPlan(keep: number): PlannedTier[] {
  const k = clampKeep(keep);
  const counts = TIERS.map((t) => Math.max(1, Math.floor(k * t.weight)));
  let total = counts.reduce((a, b) => a + b, 0);
  for (let i = 0; total < k; i++, total++) counts[i % counts.length] += 1;
  // Only reachable when the min-one floor overshot a very small budget.
  while (total > k) {
    const j = counts.findIndex((c) => c > 1);
    if (j < 0) break;
    counts[j] -= 1;
    total -= 1;
  }
  return TIERS.map((t, i) => ({ ...t, count: counts[i] }));
}

/** How far back a plan reaches, in ms. */
export function planSpanMs(plan: PlannedTier[]): number {
  return plan.reduce((ms, t) => ms + t.intervalMs * t.count, 0);
}

/** A duration in the words a person would use. */
export function humanSpan(ms: number): string {
  const hours = Math.round(ms / HOUR_MS);
  if (hours <= 1) return "an hour";
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(hours / 24);
  if (days === 1) return "a day";
  if (days < 14) return days === 7 ? "a week" : `${days} days`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? "a week" : `${weeks} weeks`;
}

/**
 * The spread in plain language, for the settings page. The knob is one number
 * and the shape it buys is not obvious from it, so the page says it out loud.
 */
export function describeSpread(keep: number): string {
  const plan = tierPlan(keep);
  const parts = plan.map((t) => `one every ${t.label} for ${humanSpan(t.intervalMs * t.count)}`);
  const sentence = parts.join(", then ");
  const capitalized = `${sentence[0].toUpperCase()}${sentence.slice(1)}`;
  return `${capitalized}. About ${humanSpan(planSpanMs(plan))} of history.`;
}

/**
 * Which snapshots survive a prune: newest first within each tier, one per
 * bucket, moving on to the next tier once a tier is full.
 *
 * @param times snapshot timestamps (ms), any order
 * @returns the timestamps to KEEP
 */
export function chooseKeepers(times: number[], keep: number): Set<number> {
  const sorted = [...new Set(times)].sort((a, b) => b - a);
  const kept = new Set<number>();
  let i = 0;
  for (const tier of tierPlan(keep)) {
    let lastBucket: number | null = null;
    let taken = 0;
    while (i < sorted.length && taken < tier.count) {
      const bucket = Math.floor(sorted[i] / tier.intervalMs);
      if (bucket !== lastBucket) {
        kept.add(sorted[i]);
        lastBucket = bucket;
        taken += 1;
      }
      i += 1;
    }
  }
  return kept;
}

// ── Size, before there is anything to measure ───────────────────────────────
//
// The estimate exists so the knob is not a blind bet on disk. Once real dumps
// exist their own average is the honest number; before that, all we have is the
// live database size and a compression ratio, so the surfaces say which one they
// are using rather than presenting a guess as a measurement.

/**
 * A custom-format dump as a fraction of `pg_database_size()`. MEASURED, not
 * guessed: a 787 MB production database dumped to 300 MB on 2026-08-25, so 0.36
 * in real life, rounded up here because a high estimate costs a moment's
 * hesitation and a low one costs a full disk. (The dump drops indexes, which is
 * most of the saving; zlib on markdown is the rest.)
 */
export const DUMP_COMPRESSION_RATIO = 0.4;

export function estimateSnapshotBytes(dbBytes: number): number {
  return Math.round(dbBytes * DUMP_COMPRESSION_RATIO);
}

/** Bytes in the units a person reads. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1000;
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}
