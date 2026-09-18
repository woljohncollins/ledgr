// The spoke-side sync loop (built in phase 1, armed in phase 3): push local
// ops / pull remote ops against an ORDERED hub list, walking to the next hub
// on failure — that walk IS the backup-hub behavior. Dependency-free by
// design (fetch + setTimeout); runs inside the app process via the
// instrumentation hook, only when LEDGR_SYNC_HUBS is set, so the cloud hub
// (passive) and Tyler's instance never start it.
//
// Env:
//   LEDGR_SYNC_HUBS             comma-separated ordered hub base URLs
//   LEDGR_SYNC_TOKEN            this device's token (minted on the hub)
//   LEDGR_SYNC_PUSH_DEBOUNCE_MS default 2000 — how soon after a write we push
//   LEDGR_SYNC_PULL_MS          default 10000 — the full-exchange cadence
//
// Cursors persist in job_state (one row per hub) — sync bookkeeping, exactly
// what that table exists for; no new table needed.
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { jobState, syncDevice, syncOps } from "@/db/schema";
import { applySyncOps } from "./apply";
import { HOLD_GRACE_DAYS_DEFAULT } from "./peers";
import { latestSchemaVer } from "./version";
import type { SyncOp } from "./engine";
import { createLogger } from "@/lib/log";

const log = createLogger("sync-client");

// "held" = a push is deliberately withheld (first-push size guard or a
// clock-skew hold); pulling still proceeds in that state.
export type SyncState = "synced" | "pending" | "offline" | "held";

export type SyncMode = "full" | "pull-only";

export type HoldReason = "first_push_size" | "clock_skew";

// ── Per-hub behavior: two independent axes (ADR-210) ───────────────────────
//
// CADENCE is how often we exchange with a hub; FALLBACK TRUST is whether this
// instance may start *relying* on it silently. They were one `role` field in
// the first draft, which was wrong: a fast hub you would happily fall back to
// and a daily hub you want to be asked about are the common pair, but the
// axes are genuinely independent.
//
// The rule that makes "prompt first" coherent, because using a hub is two
// different things:
//   - PUSHING to a hub is always safe and never prompts. Depositing a copy of
//     your changes somewhere cannot corrupt you, and a backup that stops
//     receiving is not a backup. Every configured hub is pushed to on its own
//     cadence, automatic or emergency.
//   - PULLING is where trust lives. Not because stale rows are dangerous in
//     the merge (per-field LWW means an older row loses to a newer one), but
//     because your sense of freshness degrades silently: you would be reading
//     a system that has not heard from your other machines in a day while the
//     UI says "synced". That is the Principle 9 failure the staleness refusal
//     fixed from the other direction.
/**
 * How often to exchange with a hub, in MINUTES. 0 means "every normal round",
 * which is what the two-value enum called "continuous".
 *
 * ADR-221 replaced that enum ("continuous" | "daily") with the number it was
 * already reducing to. The enum was not a simplification, it was a missing
 * feature wearing one: the owner's ladder is continuous, a few minutes, a
 * quarter hour, hourly, daily, weekly, and each of those was expressible as an
 * interval all along (`cadenceIntervalMs` existed to turn the enum INTO one).
 * Storing the number removes the translation rather than widening it.
 *
 * READS ARE TOLERANT, so nothing has to be migrated: a hub stored before this
 * change carries the string "continuous" or "daily" and reads as 0 or 1440,
 * which is exactly what it was doing (the same additive move ADR-210 used when
 * it introduced the field).
 */
export type HubCadence = number;
export type HubFallback = "automatic" | "prompt";

export const CADENCE_DAILY_MS = 24 * 60 * 60 * 1000;
export const CADENCE_CONTINUOUS = 0;
export const CADENCE_DAILY_MINUTES = 1440;
export const CADENCE_WEEKLY_MINUTES = 10_080;

/**
 * The ladder the owner picks from. Presets, not free entry: a text box invites
 * "every 3 minutes on a Tuesday" and nothing in the loop rewards that
 * precision. The supervisor's job config made the same call and says why.
 */
export const CADENCE_PRESETS: { minutes: number; label: string }[] = [
  { minutes: CADENCE_CONTINUOUS, label: "Continuously" },
  { minutes: 1, label: "Every minute" },
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: CADENCE_DAILY_MINUTES, label: "Once a day" },
  { minutes: CADENCE_WEEKLY_MINUTES, label: "Once a week" },
];

/** How a cadence reads in a sentence, for any value including stored ones. */
export function cadenceLabel(minutes: HubCadence): string {
  const preset = CADENCE_PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes < CADENCE_DAILY_MINUTES) return `Every ${Math.round(minutes / 60)} hours`;
  return `Every ${Math.round(minutes / CADENCE_DAILY_MINUTES)} days`;
}

// Per-hub view of the exchange round (ADR-209, extended by ADR-210): one
// entry per configured hub, in hub-list order, updated on every attempt — so
// the Network page can show which uplink is healthy and which is failing, not
// just the blended state. The guard fields are per hub on purpose (ADR-210):
// they were one global reading, which meant a slow emergency hub with a day
// of ops queued could trip a hold that then blocked the healthy mirror.
export type HubStatus = {
  url: string;
  cadence: HubCadence;
  fallback: HubFallback;
  // ADR-240: is this hub contacted only when there is something to send?
  onChange: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  // When this hub is next due for an exchange (ISO), null when due now.
  nextDueAt: string | null;
  // Did the last attempt pull, or push only? An emergency hub is push-only
  // until the owner approves pulling from it.
  pulling: boolean;
  holdReason: HoldReason | null;
  heldOpsCount: number | null;
  skewMs: number | null;
  // How many of THIS instance's own changes this hub has not received yet —
  // the freshness gap, computed from the per-hub push cursor that already
  // exists. Null until the status endpoint computes it.
  behindOps: number | null;
};

// The pending decision the loop records when every automatic hub has been
// failing longer than the threshold and an emergency hub exists. The loop runs
// server-side and cannot prompt, so it records this and the UI surfaces it —
// the pattern the hold reasons already prove.
export type FallbackPrompt = {
  // The highest-priority emergency hub on offer.
  url: string;
  cadence: HubCadence;
  // What each automatic hub actually said, so the prompt shows evidence.
  automaticErrors: { url: string; error: string | null }[];
  // How long every automatic hub has been failing, ms.
  failingForMs: number;
  // How stale this backup is: when it last exchanged, and how many of our
  // own changes it has not received.
  lastSyncAt: string | null;
  behindOps: number | null;
};

// The owner's answer, stored in job_state (never synced, like every other
// per-instance sync flag). Auto-clears once an automatic hub is fully caught
// up again — Brandon's refinement: the recovered hub gets brought up to speed
// FIRST, then the approval drops.
export type FallbackApproval = {
  url: string;
  // Brandon chose "ask each time" for cadence promotion, and promotion
  // reverts when the primary returns — so it lives here, on the ephemeral
  // approval, never written into the hub's configured cadence.
  promoteCadence: boolean;
  approvedAt: string;
};

export type SyncStatus = {
  state: SyncState;
  pendingOps: number;
  activeHubIndex: number;
  lastSyncAt: string | null;
  lastError: string | null;
  // Guardrail 2/3: why a push is currently held, if it is.
  holdReason: HoldReason | null;
  // Populated only when holdReason === "first_push_size".
  heldOpsCount: number | null;
  // Guardrail 3: last measured (serverTime - local time), ms. Positive means
  // the hub's clock reads ahead of this peer's. Null until the first
  // exchange completes (skew is learned FROM that exchange's response, so it
  // can never gate the very first round-trip — only ones after it).
  skewMs: number | null;
  // True once |skewMs| has reached the warn threshold, independent of hold.
  skewWarn: boolean;
  // Per-hub attempt results (additive, ADR-209).
  hubs: HubStatus[];
  // ADR-210: set when the loop wants the owner's approval to start pulling
  // from an emergency hub. Null the rest of the time.
  fallbackPrompt: FallbackPrompt | null;
  // ADR-210: the approval currently in force, if any.
  fallbackApproval: FallbackApproval | null;
};

// In-memory status for the SyncPill / /build/updates, plus the loop's
// one-shot first-push flag, held on globalThis.
//
// Module-level was NOT enough, which is what the first real spoke found:
// /api/sync/status and /build/updates reported "Offline, never synced" on a
// peer the database proved was pulling (a Principle 9 silent misreport). Next
// bundles the instrumentation hook and the route handlers as separate server
// entries, so this module is instantiated more than once in the one process.
// The loop mutated one instance's object; every reader read another's, which
// is still at its defaults and always will be. The loop-arming guard below
// already reached for globalThis for exactly this reason; the state it
// protects has to live there too, or the guard is the only part that works.
//
// This fixes duplication WITHIN a process, which is the observed cause. It
// cannot fix separate processes: if the app is ever served by more than one,
// status has to move to the database (job_state) instead.
// ADR-210 makes the guard state PER HUB (`hubRuntime`, keyed by url): the
// first-push flag and the learned skew were single global readings, so a slow
// emergency hub with a day of ops queued could trip a hold that then blocked
// the healthy mirror. `automaticFailingSince` is the clock behind the
// fallback prompt.
export type HubRuntime = {
  firstPushDone: boolean;
  skewMs: number | null;
  // Epoch ms; 0 means due now.
  nextDueAt: number;
  // Consecutive failed exchanges with this hub, cleared by the next success.
  // Drives the retry backoff in nextDueAfter (ADR-239).
  consecutiveFails: number;
  // Epoch ms of the last attempt, success or failure. Debounces the
  // change-triggered exchange (ADR-240) so a burst of edits is one round
  // trip, not one per edit.
  lastExchangeAt: number;
};
type SyncShared = {
  status: SyncStatus;
  loopArmed: boolean;
  hubRuntime: Record<string, HubRuntime>;
  automaticFailingSince: number | null;
  // Set by requestCheckIn(); cleared by the next tick. See below.
  checkInRequestedAt: number | null;
};
const shared: SyncShared = ((globalThis as { __ledgrSync?: SyncShared }).__ledgrSync ??= {
  status: {
    state: "offline",
    pendingOps: 0,
    activeHubIndex: 0,
    lastSyncAt: null,
    lastError: null,
    holdReason: null,
    heldOpsCount: null,
    skewMs: null,
    skewWarn: false,
    hubs: [],
    fallbackPrompt: null,
    fallbackApproval: null,
  },
  // Guardrail 2's "only the FIRST push is gated" boundary: once a real push
  // attempt has been let through (or found nothing to send), this never gates
  // again for the rest of the process's lifetime. Deliberately separate from
  // `status`, which is allowed to move back and forth (e.g. holdReason clears
  // once resolved) — this flag must not. Per hub since ADR-210.
  loopArmed: false,
  hubRuntime: {},
  automaticFailingSince: null,
  checkInRequestedAt: null,
});
const status = shared.status;

function hubRuntime(url: string): HubRuntime {
  return (shared.hubRuntime[url] ??= { firstPushDone: false, skewMs: null, nextDueAt: 0, consecutiveFails: 0, lastExchangeAt: 0 });
}

export function getSyncStatus(): SyncStatus {
  return { ...status };
}

/**
 * "Check in now": exchange with every hub on the next tick, cadence ignored.
 *
 * A cadence is a promise about the WORST case, and until this existed it was
 * also the best case: a peer set to hourly held its own writes for up to an
 * hour and could not be told to hurry, so a change made on another copy — a job
 * assignment, most sharply (ADR-225) — arrived whenever it arrived. One button
 * turns that into a bounded wait the owner controls.
 *
 * Deliberately a flag rather than an exchange call: the loop already serializes
 * exchanges behind its own guard, and a second entry point that could run one
 * concurrently would race the cursors for no gain. The tick interval is the
 * push debounce (2s by default), so "now" means within a couple of seconds.
 */
export function requestCheckIn(): { armed: boolean } {
  shared.checkInRequestedAt = Date.now();
  return { armed: shared.loopArmed };
}

// The hub list, parsed the one way everywhere (loop arming, status endpoint,
// the nav pill's server-side gate).
export function parseHubs(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

// Is this instance a sync SPOKE at all? False on the cloud hub and on Tyler's
// instance (no LEDGR_SYNC_HUBS), which is what keeps every sync surface —
// the /api/sync/status work, the nav pill mount — off those deploys entirely.
export function syncEnabled(): boolean {
  return parseHubs(process.env.LEDGR_SYNC_HUBS).length > 0;
}

// Guardrail 1: is this peer allowed to push at all? Read fresh from env
// everywhere (like parseHubs) rather than cached, since it's static config.
export function parseSyncMode(raw: string | undefined): SyncMode {
  return raw === "pull-only" ? "pull-only" : "full";
}

// ── The effective push mode (GUI-settable, per instance) ────────────────────
//
// LEDGR_SYNC_MODE (supervisor config) is only the INITIAL value now. The owner
// can flip this instance between pull-only and full from /build/updates, and
// that has to work without editing a config file and restarting — which is
// what it took the first time, and is not a thing to ask of anyone.
//
// The override lives in job_state, deliberately: job_state is NOT in ADR-206's
// synced set, so one peer's mode can never replicate to another. It is read
// fresh on every tick (like parseHubs), so a change takes effect on the next
// exchange with no restart.
//
// This is the SPOKE's own choice. The hub's per-device pull_only flag is
// separate and authoritative: a spoke set to full still gets a 403 if the hub
// has not allowed that device to push.
const SYNC_MODE_KEY = "sync:mode";

/** The precedence rule, pure: a stored override wins, else the env default. */
export function effectiveSyncMode(stored: unknown, envRaw: string | undefined): SyncMode {
  if (stored === "pull-only" || stored === "full") return stored;
  return parseSyncMode(envRaw);
}

export async function readSyncMode(): Promise<SyncMode> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, SYNC_MODE_KEY));
  const stored = (rows[0]?.value as { mode?: unknown } | undefined)?.mode;
  return effectiveSyncMode(stored, process.env.LEDGR_SYNC_MODE);
}

export async function writeSyncMode(mode: SyncMode): Promise<void> {
  await getDb()
    .insert(jobState)
    .values({ key: SYNC_MODE_KEY, value: { mode } })
    .onConflictDoUpdate({ target: jobState.key, set: { value: { mode }, updatedAt: new Date() } });
}

// ── Releasing a held first push (GUI-settable, one-shot) ────────────────────
//
// Guardrail 2 holds a first push whose pending oplog exceeds maxFirstPush.
// The release used to be `confirmLargePush: true` in supervisor config plus a
// restart — exactly the friction the mode toggle removed. The owner can now
// release from Build → Network; the flag lives in job_state (never synced)
// and the loop re-reads it every tick.
//
// ONE-SHOT on purpose: the loop clears the stored flag as soon as the first
// push has gone through. A flag that stayed true would let a FUTURE process's
// bad restore sail past the guard — the exact failure the guard exists for.
// The env var (supervisor config) keeps its standing meaning for people who
// set it deliberately; only the stored flag self-clears.
const SYNC_CONFIRM_KEY = "sync:confirmLargePush";

/** The precedence rule, pure: either source releases the hold. */
export function effectiveConfirmLargePush(stored: unknown, envRaw: string | undefined): boolean {
  return stored === true || /^(1|true)$/i.test(envRaw ?? "");
}

export async function readStoredConfirmLargePush(): Promise<boolean> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, SYNC_CONFIRM_KEY));
  return (rows[0]?.value as { confirm?: unknown } | undefined)?.confirm === true;
}

export async function writeStoredConfirmLargePush(confirm: boolean): Promise<void> {
  if (!confirm) {
    await getDb().delete(jobState).where(eq(jobState.key, SYNC_CONFIRM_KEY));
    return;
  }
  await getDb()
    .insert(jobState)
    .values({ key: SYNC_CONFIRM_KEY, value: { confirm: true } })
    .onConflictDoUpdate({
      target: jobState.key,
      set: { value: { confirm: true }, updatedAt: new Date() },
    });
}

// ── The hub list (GUI-editable, per instance — ADR-209) ─────────────────────
//
// Supervisor config (env LEDGR_SYNC_HUBS + the single LEDGR_SYNC_TOKEN) is
// only the INITIAL value, exactly like the mode above. The owner manages hubs
// from Build → Network, which needs (a) a per-instance store — job_state, so
// one peer's hub list never replicates to another — and (b) a token PER hub,
// which the single env token cannot express. The loop re-reads the list every
// tick, so add/remove takes effect on the next exchange with no restart.
//
// The stored token is this device's credential FOR that hub, held in the
// local database — the same trust boundary as the plaintext deviceToken in
// supervisor/config.json on the same disk.
//
// ADR-210 adds `cadence` and `fallback` — two independent axes, additive on a
// store that already exists, and parse-tolerant: an entry written before this
// change reads as continuous + automatic, which is exactly what it was doing.
export type HubConfig = {
  url: string;
  token: string;
  // Minutes since ADR-221. The two legacy strings are part of the STORED
  // shape, not a compatibility shim in the readers: an entry written before
  // that change still says "daily", and typing it honestly is what keeps every
  // reader going through `hubCadence` instead of quietly assuming a number.
  cadence?: HubCadence | "continuous" | "daily";
  fallback?: HubFallback;
  // "Only when there are changes" (ADR-252, replacing ADR-240's reading of the
  // same stored flag). Off by default, so every hub written before this
  // behaves exactly as it did. When on, the cadence is the FASTEST this hub is
  // contacted and this flag decides whether there is any reason to: a round
  // with nothing of ours to send is skipped entirely, so a quiet week is a
  // quiet week. "Hourly, only when there are changes" therefore means at most
  // once an hour, and nothing at all on a day nobody touched anything.
  //
  // That is what makes a serverless hub affordable, because every contact
  // wakes a database that then bills for a fixed idle tail whether the round
  // trip carried work or not.
  //
  // The one thing it costs: changes made on ANOTHER copy cannot arrive while
  // we stay quiet, since this machine has no way to know they exist until it
  // asks. Right for a cloud archive that writes nothing; wrong for a second
  // machine of yours, which is why the flag is per-hub. `maxSafeGapMs` is the
  // backstop that keeps a long quiet spell from aging out of the hub's
  // retention window.
  onChange?: boolean;
};

/** The defaults, applied in one place so every reader agrees. Tolerant of the
 * pre-ADR-221 strings, and of anything unreadable, which reads as continuous:
 * a mangled setting must sync too often rather than too rarely, because the
 * cost of the first is a few wasted round trips and of the second is a peer
 * that quietly falls outside the retention window. */
export function hubCadence(h: Pick<HubConfig, "cadence">): HubCadence {
  const raw = h.cadence;
  if (raw === "daily") return CADENCE_DAILY_MINUTES;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), CADENCE_WEEKLY_MINUTES);
  }
  return CADENCE_CONTINUOUS;
}
export function hubFallback(h: Pick<HubConfig, "fallback">): HubFallback {
  return h.fallback === "prompt" ? "prompt" : "automatic";
}
/** Tolerant like the two above: anything but an explicit true is off, so an
 * unreadable setting falls back to the old always-wait-for-the-cadence
 * behavior rather than to a livelier one. */
export function hubOnChange(h: Pick<HubConfig, "onChange">): boolean {
  return h.onChange === true;
}

/**
 * The longest a peer may go without exchanging at all, in minutes.
 *
 * One number, two jobs. It is the ceiling the cadence picker enforces
 * (`cadenceRefusal`), and it is the backstop that overrides "only when there
 * are changes" (`quietSkip`) — because both are the same question: how long
 * can this peer stay silent and still catch up rather than needing a full
 * re-fill? The hub holds a peer's place in the oplog for `grace_days`, and the
 * rule is that you must be able to miss ONE check and still be inside the
 * window, so the answer is half of it, capped at the weekly preset.
 */
export function maxSafeGapMinutes(graceDays = HOLD_GRACE_DAYS_DEFAULT): number {
  return Math.min(CADENCE_WEEKLY_MINUTES, (graceDays / 2) * 1440);
}
export function maxSafeGapMs(graceDays = HOLD_GRACE_DAYS_DEFAULT): number {
  return maxSafeGapMinutes(graceDays) * 60_000;
}

/**
 * Should an "only when there are changes" hub be left alone this round, even
 * though its cadence IS up? Pure, so the rule is checkable without a database
 * or a network.
 *
 * ADR-252 turned ADR-240's reading of the flag around. The cadence is now the
 * fastest this hub is contacted, not the slowest, and this is the gate that
 * decides whether a due round happens at all. Nothing of ours to send means
 * nothing to say, and saying nothing is the entire saving: an empty round trip
 * wakes a serverless hub's database for its full idle tail.
 *
 * Two clauses stop the quiet from becoming a different bug:
 *
 *   - A FAILING hub is never skipped. Its retries are already spaced by the
 *     ADR-239 backoff, and skipping them would leave a broken hub reporting
 *     itself fine, with no attempt that could ever clear the error.
 *   - A hub nobody has spoken to in `maxSafeGapMs` is never skipped. Silence
 *     past that ages this peer out of the hub's retention window (ADR-208),
 *     which costs a full re-fill instead of a catch-up. A fortnight away is
 *     exactly the ordinary case that would otherwise walk into it.
 */
export function quietSkip(opts: {
  onChange: boolean;
  hasLocalChanges: boolean;
  consecutiveFails: number;
  msSinceLastExchange: number;
  livenessFloorMs: number;
}): boolean {
  if (!opts.onChange) return false;
  if (opts.hasLocalChanges) return false;
  if (opts.consecutiveFails > 0) return false;
  return opts.msSinceLastExchange < opts.livenessFloorMs;
}

/** How long between exchanges with a hub on this cadence. `continuousMs` is
 * the loop's own pull window, so 0 means "every normal round" — and so does
 * any cadence shorter than that window, which is why the max is here rather
 * than in the picker. */
export function cadenceIntervalMs(cadence: HubCadence, continuousMs: number): number {
  return Math.max(cadence * 60_000, continuousMs);
}

/**
 * THE GUARDRAIL, and the reason this is not just a longer dropdown.
 *
 * A hub prunes its change log (`pruneSyncOps`): ops older than the retention
 * floor go, except those a still-holding peer has not read. A peer holds while
 * the hub has heard from it inside its window (`grace_days`, defaulting to
 * HOLD_GRACE_DAYS_DEFAULT). Fall outside that window and the next exchange is
 * refused with a 410 (ADR-208) and the peer needs a full re-fill. That refusal
 * is the safety working correctly; being walked into it by a dropdown is not.
 *
 * The rule: **you must be able to miss one sync and still be inside the
 * window.** Two intervals, not one, because a machine that was switched off
 * over a long weekend has missed exactly one, and that is the ordinary case
 * rather than the exotic one. It falls out at weekly against the default
 * 14-day window, which is why the preset ladder stops there.
 *
 * Note what this does NOT need: the window lives on the HUB (per remote
 * device) and the cadence on the peer, opposite machines. It is checkable here
 * anyway because both run the same build (the version gate refuses an exchange
 * otherwise), so the default is a shared constant rather than a fact to fetch.
 * A hub-side `grace_days` override can only widen the window, never narrow it
 * below the default, so a local check can be wrong only in the safe direction.
 */
export function cadenceRefusal(minutes: HubCadence, graceDays = HOLD_GRACE_DAYS_DEFAULT): string | null {
  if (minutes <= 0) return null;
  // Weekly is a hard ceiling as well as the answer the window happens to give,
  // so that a widened `grace_days` cannot open a gap wider than `hubCadence`
  // will read back. Otherwise the picker would accept a value the reader
  // silently clamps, which is the same class of quiet disagreement this whole
  // guardrail exists to prevent. Shared with `quietSkip`'s backstop (ADR-252),
  // so the dropdown and the on-changes gate can never disagree about how long
  // silence is safe.
  const maxMinutes = maxSafeGapMinutes(graceDays);
  if (minutes <= maxMinutes) return null;
  const maxDays = maxMinutes / 1440;
  const gap = maxDays >= 1 ? `${Math.floor(maxDays)} days` : `${Math.round(maxDays * 24)} hours`;
  return (
    `"${cadenceLabel(minutes)}" leaves too long a gap. This device would only have to miss one ` +
    `check to fall outside the ${graceDays} days of history the other copy keeps for it, and it ` +
    `would then need a full copy of everything again instead of catching up. The longest gap ` +
    `that stays safe is ${gap}.`
  );
}

/**
 * The one validation, and Brandon's instinct about it is right: if any hub is
 * configured, at least one must be automatic. With every hub set to
 * prompt-first the instance never syncs unattended — it just sits waiting for
 * a human, which is a silently-not-syncing peer wearing a "synced" face. (A
 * peer that should only sync when told is what pull-only MODE is for; that is
 * a different control.) Returns the user-facing refusal, or null when fine.
 */
export function hubListRefusal(hubs: Pick<HubConfig, "fallback">[]): string | null {
  if (hubs.length === 0) return null;
  if (hubs.some((h) => hubFallback(h) === "automatic")) return null;
  return (
    "At least one hub has to be automatic. With every hub set to ask first, " +
    "this instance would never sync unattended — it would sit waiting for you " +
    "while reporting itself synced."
  );
}

/**
 * May this instance PULL from this hub right now? Automatic hubs always;
 * an emergency hub only while the owner's approval names it.
 */
export function shouldPullFrom(
  hub: Pick<HubConfig, "url" | "fallback">,
  approvedUrl: string | null
): boolean {
  return hubFallback(hub) === "automatic" || hub.url === approvedUrl;
}

/**
 * The effective cadence for a hub, honoring an approval that also promoted it.
 * Promotion lives on the approval, never on the config, so it reverts by
 * itself when the approval clears — Brandon's requirement.
 */
export function effectiveCadence(
  hub: Pick<HubConfig, "url" | "cadence">,
  approval: FallbackApproval | null
): HubCadence {
  if (approval?.promoteCadence && approval.url === hub.url) return CADENCE_CONTINUOUS;
  return hubCadence(hub);
}

/** Ceiling on the gap between retries of a hub that keeps failing (ADR-239).
 * Long enough that a broken hub costs a handful of requests an hour; short
 * enough that a hub coming back is picked up while the owner is still there. */
export const MAX_RETRY_BACKOFF_MS = 15 * 60 * 1000;

/**
 * When is a hub next due after an attempt? A success waits the full cadence;
 * a FAILURE retries on the normal pull window instead, so a daily hub that
 * errors does not disappear for 24 hours.
 *
 * A failure that REPEATS backs off, doubling each time (ADR-239). Without
 * this, one change the hub can never accept was re-sent every 10 seconds for
 * as long as the process lived: ~8,600 requests a day, enough on its own to
 * hold a serverless hub's database awake around the clock. Seen live on
 * 2026-08-30. The FIRST retry keeps the old timing, so an ordinary blip still
 * recovers at once; only a persistent failure slows down.
 */
export function nextDueAfter(opts: {
  now: number;
  ok: boolean;
  cadenceMs: number;
  retryMs: number;
  /** Consecutive failures INCLUDING this one. 1 (the default) = first failure. */
  fails?: number;
}): number {
  if (opts.ok) return opts.now + opts.cadenceMs;
  const base = Math.min(opts.retryMs, opts.cadenceMs);
  const attempts = Math.max(1, Math.floor(opts.fails ?? 1));
  // Clamp the exponent before the shift so a long outage cannot reach Infinity.
  const backoff = base * 2 ** Math.min(attempts - 1, 20);
  // Never slower than the cap, and never slower than the hub's own cadence.
  return opts.now + Math.min(backoff, Math.max(opts.cadenceMs, MAX_RETRY_BACKOFF_MS));
}

/**
 * A hub's next-due time, corrected for a config change since it was set.
 *
 * The rig caught this live: per-hub schedules live in memory, so a hub set to
 * `daily` and then switched back to `continuous` kept the due time the daily
 * cadence had written — up to 24 hours away — and was silently skipped every
 * round in between. Clamping to the CURRENT cadence means a schedule change
 * takes effect within one interval, like every other GUI sync setting.
 *
 * `floorMs` is what stops this from undoing a retry backoff (ADR-239): a
 * continuous hub's cadence is 10 seconds, so without the floor the clamp
 * would drag every backed-off retry straight back down to 10 seconds and the
 * backoff would never happen at all.
 */
export function clampNextDue(
  nextDueAt: number,
  now: number,
  cadenceMs: number,
  floorMs = 0
): number {
  return Math.min(nextDueAt, now + Math.max(cadenceMs, floorMs));
}

/**
 * Should the owner be asked to start pulling from an emergency hub? Only when
 * every automatic hub has been failing for longer than the threshold, an
 * emergency hub exists, and nothing is approved already.
 */
export function shouldPromptFallback(opts: {
  automaticFailingSince: number | null;
  now: number;
  thresholdMs: number;
  hasEmergency: boolean;
  approvedUrl: string | null;
}): boolean {
  if (opts.approvedUrl) return false;
  if (!opts.hasEmergency) return false;
  if (opts.automaticFailingSince === null) return false;
  return opts.now - opts.automaticFailingSince >= opts.thresholdMs;
}

const SYNC_HUBS_KEY = "sync:hubs";

/** The precedence rule, pure: a stored list wins (even an empty one — the
 * owner removing every hub means "stop syncing", not "fall back to config");
 * absent falls back to the env pair. Malformed stored entries are dropped. */
export function effectiveHubs(
  stored: unknown,
  envHubs: string | undefined,
  envToken: string | undefined
): HubConfig[] {
  if (Array.isArray(stored)) {
    return stored
      .filter(
        (h): h is HubConfig =>
          !!h &&
          typeof h === "object" &&
          typeof (h as HubConfig).url === "string" &&
          (h as HubConfig).url.length > 0 &&
          typeof (h as HubConfig).token === "string" &&
          (h as HubConfig).token.length > 0
      )
      // Normalize the ADR-210 axes here so nothing downstream has to guess:
      // an entry stored before they existed reads as continuous + automatic,
      // which is precisely the behavior it already had.
      .map((h) => ({
        ...h,
        cadence: hubCadence(h),
        fallback: hubFallback(h),
        onChange: hubOnChange(h),
      }));
  }
  const token = (envToken ?? "").trim();
  if (!token) return [];
  return parseHubs(envHubs).map((url) => ({
    url,
    token,
    cadence: CADENCE_CONTINUOUS as HubCadence,
    fallback: "automatic" as HubFallback,
    onChange: false,
  }));
}

export async function readSyncHubs(): Promise<HubConfig[]> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, SYNC_HUBS_KEY));
  const stored = (rows[0]?.value as { hubs?: unknown } | undefined)?.hubs;
  return effectiveHubs(stored, process.env.LEDGR_SYNC_HUBS, process.env.LEDGR_SYNC_TOKEN);
}

export async function writeSyncHubs(hubs: HubConfig[]): Promise<void> {
  await getDb()
    .insert(jobState)
    .values({ key: SYNC_HUBS_KEY, value: { hubs } })
    .onConflictDoUpdate({
      target: jobState.key,
      set: { value: { hubs }, updatedAt: new Date() },
    });
}

// ── The fallback approval (GUI-settable, auto-clearing — ADR-210) ──────────
//
// Stored in job_state like every other per-instance sync flag, so it survives
// a restart and is never replicated to another peer. The loop re-reads it every
// tick and CLEARS it once an automatic hub has completed a fully drained
// exchange — Brandon's refinement: when the primary comes back it gets brought
// up to speed FIRST, then the approval (and any cadence promotion with it)
// drops. Clearing on a half-finished exchange would hand freshness back to a
// hub that has not caught up yet.
const SYNC_FALLBACK_KEY = "sync:fallbackApproval";

/** Parse-tolerant read of a stored approval, pure. Rejects anything that no
 * longer names a configured hub — a removed hub cannot stay approved. */
export function effectiveFallbackApproval(
  stored: unknown,
  hubUrls: string[]
): FallbackApproval | null {
  if (!stored || typeof stored !== "object") return null;
  const a = stored as Partial<FallbackApproval>;
  if (typeof a.url !== "string" || !hubUrls.includes(a.url)) return null;
  return {
    url: a.url,
    promoteCadence: a.promoteCadence === true,
    approvedAt: typeof a.approvedAt === "string" ? a.approvedAt : new Date(0).toISOString(),
  };
}

export async function readFallbackApproval(hubUrls: string[]): Promise<FallbackApproval | null> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, SYNC_FALLBACK_KEY));
  return effectiveFallbackApproval(
    (rows[0]?.value as { approval?: unknown } | undefined)?.approval,
    hubUrls
  );
}

export async function writeFallbackApproval(approval: FallbackApproval | null): Promise<void> {
  if (!approval) {
    await getDb().delete(jobState).where(eq(jobState.key, SYNC_FALLBACK_KEY));
    return;
  }
  await getDb()
    .insert(jobState)
    .values({ key: SYNC_FALLBACK_KEY, value: { approval } })
    .onConflictDoUpdate({
      target: jobState.key,
      set: { value: { approval }, updatedAt: new Date() },
    });
}

export type FullSyncStatus =
  | { enabled: false }
  | ({ enabled: true; hubCount: number; mode: SyncMode } & SyncStatus);

// Pure shape assembly (verify-sync-ui.mts exercises this): the in-memory loop
// status plus an on-demand pendingOps count. Freshly written ops the loop
// hasn't pushed yet flip a "synced" reading to "pending" — the loop only
// refreshes its own copy when it runs, and the status endpoint reads between
// runs. A "held" reading is never downgraded by the pendingOps recompute.
/**
 * Which state to report after a round of exchanges.
 *
 * The distinction that matters: a hub that was NOT DUE was never asked, and
 * that is not the same as a hub that did not answer. A daily hub spends 23h59m
 * of every day not due, so treating -1 as offline turned the normal condition
 * of a daily archive into an alarm — the owner saw "Offline (no hub reachable)"
 * beside a green hub row reading "synced 5 minutes ago", both technically
 * derived from the same healthy round. (automaticFailingSince already draws
 * this line for the fallback clock; this is the same rule for the state.)
 *
 * Offline is therefore reserved for two honest cases: a readable hub was
 * ASKED and failed, or this peer has never completed a sync at all.
 */
export function resolveSyncState(o: {
  readHealthy: boolean;
  readAttempted: boolean;
  everSynced: boolean;
  holdReason: string | null;
  pendingOps: number;
}): SyncState {
  const settled: SyncState = o.holdReason ? "held" : o.pendingOps > 0 ? "pending" : "synced";
  if (o.readHealthy) return settled;
  return o.readAttempted || !o.everSynced ? "offline" : settled;
}
export function buildSyncStatus(
  hubs: Pick<HubConfig, "url" | "cadence" | "fallback" | "onChange">[],
  s: SyncStatus,
  pendingOps: number,
  mode: SyncMode,
  // Per-hub "our changes it has not received" counts, by url (ADR-210).
  behindByUrl: Record<string, number> = {}
): FullSyncStatus {
  if (hubs.length === 0) return { enabled: false };
  // The configured list is authoritative for shape and order: a hub added
  // between ticks appears immediately (config-only, no attempt yet) rather
  // than waiting for the loop to notice it.
  const seen = new Map(s.hubs.map((h) => [h.url, h] as const));
  const merged: HubStatus[] = hubs.map((h) => {
    const prior = seen.get(h.url);
    return {
      url: h.url,
      cadence: hubCadence(h),
      fallback: hubFallback(h),
      onChange: hubOnChange(h),
      lastSyncAt: prior?.lastSyncAt ?? null,
      lastError: prior?.lastError ?? null,
      nextDueAt: prior?.nextDueAt ?? null,
      pulling: prior?.pulling ?? shouldPullFrom(h, s.fallbackApproval?.url ?? null),
      holdReason: prior?.holdReason ?? null,
      heldOpsCount: prior?.heldOpsCount ?? null,
      skewMs: prior?.skewMs ?? null,
      behindOps: behindByUrl[h.url] ?? prior?.behindOps ?? null,
    };
  });
  const prompt = s.fallbackPrompt
    ? { ...s.fallbackPrompt, behindOps: behindByUrl[s.fallbackPrompt.url] ?? s.fallbackPrompt.behindOps }
    : null;
  return {
    enabled: true,
    hubCount: hubs.length,
    mode,
    ...s,
    hubs: merged,
    fallbackPrompt: prompt,
    pendingOps,
    state: s.state === "synced" && pendingOps > 0 ? "pending" : s.state,
  };
}

// The /api/sync/status read: cheap `{enabled: false}` with zero queries when
// this instance can't sync at all, otherwise the live status with pendingOps
// computed from the oplog (max local seq past the active hub's push cursor).
// The effective hub list (stored ?? env) decides enabled-ness, so a hub added
// from Build → Network counts without a restart.
export async function gatherSyncStatus(): Promise<FullSyncStatus> {
  if (!syncEnabled() && !process.env.LEDGR_SUPERVISOR_DIR) return { enabled: false };
  const hubs = await readSyncHubs();
  if (hubs.length === 0) return { enabled: false };
  const s = getSyncStatus();
  const hub = hubs[Math.min(Math.max(s.activeHubIndex, 0), hubs.length - 1)];
  const cursor = await readCursor(hub.url);
  const pendingOps = await pendingCount(cursor.push);
  // The freshness gap, per hub, from cursors that already exist — no new
  // protocol, which is why ADR-210 needs no wire change for this half.
  const behindByUrl: Record<string, number> = {};
  for (const h of hubs) {
    const c = h.url === hub.url ? cursor : await readCursor(h.url);
    behindByUrl[h.url] = h.url === hub.url ? pendingOps : await pendingCount(c.push);
  }
  return buildSyncStatus(hubs, s, pendingOps, await readSyncMode(), behindByUrl);
}

// ── Guardrail 2: first-push size guard (pure, tested directly) ─────────────

export type FirstPushCheck =
  | { hold: false; done: true }
  | { hold: true; done: false; reason: string };

/**
 * Decide whether the client's first-ever push attempt this process should be
 * held. `firstPushDone` makes this a one-shot gate: once a decision comes
 * back non-held, the caller must flip it permanently so a legitimately busy
 * spoke is never throttled again.
 */
export function checkFirstPush(opts: {
  firstPushDone: boolean;
  pendingCount: number;
  maxFirstPush: number;
  confirmLargePush: boolean;
}): FirstPushCheck {
  if (opts.firstPushDone) return { hold: false, done: true };
  if (opts.pendingCount > opts.maxFirstPush && !opts.confirmLargePush) {
    return {
      hold: true,
      done: false,
      reason:
        `First push held: ${opts.pendingCount} pending changes exceed the ` +
        `first-push limit of ${opts.maxFirstPush}. Look at what is pending, ` +
        `then release it from Build → Network ("Send anyway"), raise ` +
        `maxFirstPush, or set confirmLargePush: true in ` +
        `supervisor/config.json and restart.`,
    };
  }
  return { hold: false, done: true };
}

// ── Guardrail 3: clock-skew detection (pure, tested directly) ──────────────

export type SkewClass = "ok" | "warn" | "hold";

/** abs(skewMs) classified against the two configured thresholds. */
export function classifySkew(skewMs: number, warnMs: number, holdMs: number): SkewClass {
  const abs = Math.abs(skewMs);
  if (abs >= holdMs) return "hold";
  if (abs >= warnMs) return "warn";
  return "ok";
}

// ── Push decision (pure, tested directly) ───────────────────────────────────
// Composes guardrails 1-3 into one place: given what THIS round could push
// (already-fetched candidates, so no DB access here) and the current guard
// state, decide what actually goes out. Pulling is never part of this
// decision — the caller runs the pull side unconditionally regardless of the
// result, which is what keeps a held/pull-only device pulling normally.
export type PushSelection = {
  ops: SyncOp[];
  holdReason: HoldReason | null;
  heldOpsCount: number | null;
  firstPushDoneAfter: boolean;
};

export function selectPushOps(opts: {
  mode: SyncMode;
  candidateOps: SyncOp[];
  pendingCount: number;
  firstPushDone: boolean;
  maxFirstPush: number;
  confirmLargePush: boolean;
  skewMs: number | null;
  skewWarnMs: number;
  skewHoldMs: number;
}): PushSelection {
  if (opts.mode === "pull-only") {
    // Guardrail 1: never send local ops, regardless of firstPushDone/skew.
    return { ops: [], holdReason: null, heldOpsCount: null, firstPushDoneAfter: opts.firstPushDone };
  }
  if (opts.skewMs !== null && classifySkew(opts.skewMs, opts.skewWarnMs, opts.skewHoldMs) === "hold") {
    // Guardrail 3: not limited to the first push — holds for as long as the
    // skew stays this bad, however many pushes in.
    return {
      ops: [],
      holdReason: "clock_skew",
      heldOpsCount: null,
      firstPushDoneAfter: opts.firstPushDone,
    };
  }
  const check = checkFirstPush({
    firstPushDone: opts.firstPushDone,
    pendingCount: opts.pendingCount,
    maxFirstPush: opts.maxFirstPush,
    confirmLargePush: opts.confirmLargePush,
  });
  if (check.hold) {
    return {
      ops: [],
      holdReason: "first_push_size",
      heldOpsCount: opts.pendingCount,
      firstPushDoneAfter: false,
    };
  }
  return { ops: opts.candidateOps, holdReason: null, heldOpsCount: null, firstPushDoneAfter: true };
}

/**
 * The push decision FOR ONE HUB, reading and writing that hub's own guard
 * state. This exists as its own function because the trap it closes was real
 * (ADR-210): the first-push flag and the learned skew used to be single
 * global readings, so a slow emergency hub with a day of ops queued would
 * trip a hold that then blocked the healthy mirror hub too. Keyed state makes
 * "held" a property of one uplink instead of the whole process.
 */
export function pushSelectionForHub(
  runtime: Record<string, HubRuntime>,
  url: string,
  opts: Omit<Parameters<typeof selectPushOps>[0], "firstPushDone" | "skewMs">
): PushSelection {
  const rt = (runtime[url] ??= { firstPushDone: false, skewMs: null, nextDueAt: 0, consecutiveFails: 0, lastExchangeAt: 0 });
  const sel = selectPushOps({ ...opts, firstPushDone: rt.firstPushDone, skewMs: rt.skewMs });
  rt.firstPushDone = sel.firstPushDoneAfter;
  return sel;
}

const PUSH_BATCH = 500;
// How far past the cap a push batch extends to finish the last op's same-`at`
// run (one local transaction) — see unpushedOps.
const RUN_EXTEND_CAP = 500;
// A batch is capped by SIZE as well as by count. 500 ordinary edits are tiny;
// 500 whole item bodies are not. The 2026-08-27 attachment-address migration
// (ADR-228) queued 1,413 body rewrites, and the first 500 of them came to
// 4.2 MB — past the 4.5 MB request body a Vercel function accepts. Every round
// came back HTTP 413 and the queue could never drain. A count cap alone cannot
// bound a payload whose rows carry bodies.
const PUSH_MAX_BYTES = 3_000_000;

/**
 * Trim a batch to a byte budget WITHOUT splitting a same-`at` run — the same
 * invariant the count cap respects, since the hub applies one transaction's
 * items deletes as a single statement (ADR-206 addendum 7). Cutting only at a
 * run boundary is why this measures forward instead of popping off the end.
 *
 * The first run always goes, whatever it weighs: returning an empty batch
 * would stall the queue permanently, which is the failure this exists to end.
 */
export function trimBatchToBytes(ops: SyncOp[], maxBytes: number): SyncOp[] {
  let bytes = 0;
  let lastBoundary = 0;
  for (let i = 0; i < ops.length; i++) {
    bytes += JSON.stringify(ops[i]).length;
    const runEnds = i === ops.length - 1 || ops[i + 1].at !== ops[i].at;
    if (!runEnds) continue;
    // ponytail: a SINGLE op over the budget still goes out alone and can still
    // be refused. Splitting one row's body across requests is the only fix for
    // that, and it needs a wire change — do it if one body ever exceeds 4.5 MB.
    if (bytes > maxBytes && lastBoundary > 0) return ops.slice(0, lastBoundary);
    lastBoundary = i + 1;
  }
  return ops;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

type Cursor = { push: number; pull: number };

async function readCursor(hub: string): Promise<Cursor> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, `sync:cursor:${hub}`));
  const v = rows[0]?.value as Partial<Cursor> | undefined;
  return { push: Number(v?.push ?? 0), pull: Number(v?.pull ?? 0) };
}

async function writeCursor(hub: string, cursor: Cursor): Promise<void> {
  await getDb()
    .insert(jobState)
    .values({ key: `sync:cursor:${hub}`, value: cursor })
    .onConflictDoUpdate({
      target: jobState.key,
      set: { value: cursor, updatedAt: new Date() },
    });
}

async function localDeviceId(): Promise<string> {
  const rows = await getDb().select({ id: syncDevice.id }).from(syncDevice).limit(1);
  if (!rows[0]) throw new Error("no sync_device row — has migration 0054 run?");
  return rows[0].id;
}

/**
 * This install's own stable identity, or null when it has none.
 *
 * The throwing form above is right for the sync loop, which cannot work without
 * an identity. Job ownership is different: it is read before every scheduled
 * run, and an install with no `sync_device` row must fall back to the old
 * behavior rather than fail the job. Same row, softer contract.
 *
 * NOTE this is the install's OWN id, which is a different id space from
 * `sync_peers.device_id` (that one is minted by a hub when a device is added
 * and is never reconciled back). See the header of src/lib/job-owners.ts.
 */
export async function readLocalDeviceId(): Promise<string | null> {
  try {
    return await localDeviceId();
  } catch {
    return null;
  }
}

// Original local writes not yet pushed. Foreign-origin ops (echoes we applied)
// are excluded from push — the hub already has them.
async function unpushedOps(afterSeq: number): Promise<SyncOp[]> {
  const rows = await getDb()
    .select()
    .from(syncOps)
    .where(and(gt(syncOps.seq, afterSeq), isNull(syncOps.originDeviceId)))
    .orderBy(asc(syncOps.seq))
    .limit(PUSH_BATCH);
  // Same rule as the hub's pull batch (ADR-206 addendum 7): never split one
  // transaction's ops (same `at`) across batches — the hub applies a batch's
  // items deletes as ONE statement, so an FK-linked delete family must travel
  // whole. Bounded by RUN_EXTEND_CAP.
  if (rows.length === PUSH_BATCH) {
    const last = rows[rows.length - 1];
    const run = await getDb()
      .select()
      .from(syncOps)
      .where(
        and(gt(syncOps.seq, last.seq), eq(syncOps.at, last.at), isNull(syncOps.originDeviceId))
      )
      .orderBy(asc(syncOps.seq))
      .limit(RUN_EXTEND_CAP);
    rows.push(...run);
  }
  return trimBatchToBytes(
    rows.map((r) => ({
      seq: r.seq,
      deviceId: r.deviceId,
      originDeviceId: r.originDeviceId,
      ownerId: r.ownerId,
      at: r.at.toISOString(),
      tbl: r.tbl,
      rowId: r.rowId,
      kind: r.kind as SyncOp["kind"],
      changed: r.changed as Record<string, unknown>,
      schemaVer: r.schemaVer,
    })),
    envInt("LEDGR_SYNC_MAX_PUSH_BYTES", PUSH_MAX_BYTES)
  );
}

async function pendingCount(afterSeq: number): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<string>`count(*)::text` })
    .from(syncOps)
    .where(and(gt(syncOps.seq, afterSeq), isNull(syncOps.originDeviceId)));
  return Number(rows[0]?.n ?? 0);
}

type PushGuard = {
  mode: SyncMode;
  maxFirstPush: number;
  confirmLargePush: boolean;
  skewWarnMs: number;
  skewHoldMs: number;
  // ADR-210: the "continuous" cadence interval (the loop's pull window), and
  // how long every automatic hub must be failing before the owner is asked
  // about an emergency hub.
  continuousMs: number;
  fallbackPromptMs: number;
};

// One full exchange with one hub: push until drained, pull until drained.
// Throws on any transport/HTTP failure so the caller can record it per hub.
// Guardrails 1-3 all act at the same point: deciding what `ops` to send.
// Pulling is never gated by any of them (holding a push cannot corrupt the
// hub; holding a pull would just leave this peer stale).
//
// ADR-210: `opts.pull` is the fallback-trust gate. When false we push and
// deliberately do NOT pull — the hub is told so with `pull: false`, which
// keeps it from serving (and charging us for) a batch we would discard, and
// keeps its record of what we have pulled truthful. Guard state is read and
// written PER HUB, so one hub's hold or bad clock never gates another's push.
type ExchangeResult = {
  // True when both halves ran to completion inside the bounded loop — the
  // "brought up to speed" test the approval clear depends on.
  drained: boolean;
  // Changes this hub refused to apply and parked (ADR-241). Zero on a healthy
  // exchange; anything above it is a change that hub will never have.
  parkedOps: number;
  pendingOps: number;
  holdReason: HoldReason | null;
  heldOpsCount: number | null;
  skewMs: number | null;
};

async function exchangeWith(
  hub: HubConfig,
  deviceId: string,
  guard: PushGuard,
  opts: { pull: boolean }
): Promise<ExchangeResult> {
  const rt = hubRuntime(hub.url);
  const schemaVer = latestSchemaVer();
  let cursor = await readCursor(hub.url);
  let drained = false;
  let parkedOps = 0;
  let holdReason: HoldReason | null = null;
  let heldOpsCount: number | null = null;
  // Bounded loop: worst case both sides hold deep backlogs; each round moves
  // at least one batch, and the caller reruns on the next tick anyway.
  for (let round = 0; round < 20; round++) {
    // candidateOps is what would be sent absent any guard; selectPushOps
    // (pure) decides whether it actually goes out. Cheap enough to always
    // fetch — pull-only skips it outright since it can never be used.
    const pending = await pendingCount(cursor.push);
    const candidateOps = guard.mode === "pull-only" ? [] : await unpushedOps(cursor.push);
    // The gate is spent by a push the hub ACCEPTED, never by one it refused.
    // pushSelectionForHub commits `firstPushDone` optimistically, so an
    // exchange that then failed (HTTP 413, a dropped connection) used to burn
    // the owner's one-shot "Send anyway" without a single op landing, and the
    // hold came back on the next restart with the permission already gone.
    // Held here and committed below, after the hub answers OK.
    const priorFirstPushDone = rt.firstPushDone;
    const sel = pushSelectionForHub(shared.hubRuntime, hub.url, {
      mode: guard.mode,
      candidateOps,
      pendingCount: pending,
      maxFirstPush: guard.maxFirstPush,
      confirmLargePush: guard.confirmLargePush,
      skewWarnMs: guard.skewWarnMs,
      skewHoldMs: guard.skewHoldMs,
    });
    const firstPushDoneAfter = sel.firstPushDoneAfter;
    rt.firstPushDone = priorFirstPushDone;
    holdReason = sel.holdReason;
    heldOpsCount = sel.heldOpsCount;
    if (sel.holdReason === "first_push_size") {
      log.warn("first push held: pending oplog exceeds the first-push limit", {
        hub: hub.url,
        pending: sel.heldOpsCount,
        maxFirstPush: guard.maxFirstPush,
      });
    }
    const ops = sel.ops;

    const res = await fetch(`${hub.url.replace(/\/$/, "")}/api/machine/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${hub.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deviceId,
        schemaVer,
        sinceSeq: cursor.pull,
        ops,
        // Additive and optional: omitted on the ordinary pulling path, so an
        // older hub is byte-for-byte unaffected.
        ...(opts.pull ? {} : { pull: false }),
      }),
    });
    if (res.status === 409) {
      const detail = (await res.json().catch(() => ({}))) as { localVer?: string };
      throw new Error(
        `schema version mismatch: hub has ${detail.localVer ?? "?"}, this peer has ${schemaVer}`
      );
    }
    if (res.status === 403) {
      // The hub-side belt-and-suspenders (a pull_only device that somehow
      // sent ops anyway). Never expected given the checks above, but surface
      // it rather than retry the same rejected push forever.
      const detail = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(detail.error ?? "hub refused this device's ops (pull-only)");
    }
    if (res.status === 410) {
      // The staleness refusal (ADR-208): this peer's pull cursor predates
      // the hub's oldest retained op, so anything it would pull is a
      // permanently partial stream. The hub applied our push before
      // refusing (pushApplied), so advance the push cursor — otherwise the
      // next tick re-sends the same ops forever — but NEVER the pull
      // cursor: staying put is what keeps the refusal firing until the
      // owner re-fills, instead of quietly resuming past a hole.
      const detail = (await res.json().catch(() => ({}))) as { pushApplied?: boolean };
      if (detail.pushApplied && ops.length > 0) {
        cursor = { ...cursor, push: ops[ops.length - 1].seq };
        await writeCursor(hub.url, cursor);
      }
      throw new Error(
        "too far behind this hub: ops this peer never pulled have been pruned. " +
          "Re-fill required: stop the supervisor, then `npm run local:restore -- --from-url <hub db url>`."
      );
    }
    if (!res.ok) throw new Error(`sync exchange failed: HTTP ${res.status}`);
    // Accepted. Only now is the first-push gate spent.
    rt.firstPushDone = firstPushDoneAfter;
    const data = (await res.json()) as {
      ops: SyncOp[];
      cursor: number;
      hasMore: boolean;
      serverTime?: string;
      // ADR-241, additive: changes this hub could not apply and has parked.
      // Absent from a hub that predates the change, which reads as none.
      parked?: { kind: string; table: string; id: string | null; error: string }[];
    };
    if (data.parked?.length) {
      // Not an exception: the rest of the batch landed and the cursor may
      // advance. It must still be impossible to miss, because a parked change
      // is one this hub will never have.
      parkedOps += data.parked.length;
      log.warn("hub could not apply some changes; they were parked, not re-sent", {
        hub: hub.url,
        parked: data.parked.length,
        first: data.parked[0],
      });
    }
    // Belt and suspenders for a hub that predates `pull: false` and answered
    // with ops anyway: on a push-only round we never apply them, because the
    // pull cursor deliberately does not advance and we would re-apply the
    // same batch every round forever.
    if (opts.pull && data.ops.length > 0) {
      await applySyncOps(data.ops);
    }
    if (data.serverTime) {
      const skewMs = Date.parse(data.serverTime) - Date.now();
      if (Number.isFinite(skewMs)) rt.skewMs = skewMs;
    }
    cursor = {
      push: ops.length > 0 ? ops[ops.length - 1].seq : cursor.push,
      // A push-only round must never advance the pull cursor: we did not read
      // those ops, and pretending we did is how a peer silently skips a hole.
      pull: opts.pull ? Number(data.cursor ?? cursor.pull) : cursor.pull,
    };
    await writeCursor(hub.url, cursor);
    // "The push side sent everything it was willing to send this round."
    // Not `ops.length < PUSH_BATCH`: a byte-trimmed batch is under the count
    // cap and still has more behind it, and calling that drained would report
    // a backlog as caught up. ops.length === 0 keeps a pull-only or held peer
    // finishing in one round, exactly as before.
    const pushDone = ops.length === 0 || ops.length >= pending;
    if ((!opts.pull || !data.hasMore) && pushDone) {
      drained = true;
      break;
    }
  }
  return {
    drained,
    parkedOps,
    pendingOps: await pendingCount(cursor.push),
    holdReason,
    heldOpsCount,
    skewMs: rt.skewMs,
  };
}

// One round over the WHOLE hub list (ADR-210 replaced first-success-wins).
//
// The old walk returned on the first hub that succeeded, which is failover —
// and is exactly why an archive hub received nothing as long as the primary
// was up. Now every hub due on its own cadence gets an exchange: pushing to
// all of them, pulling only from the ones trust allows.
async function exchange(
  hubs: HubConfig[],
  deviceId: string,
  guard: PushGuard,
  approval: FallbackApproval | null,
  // Highest local-origin oplog seq. Compared against a hub's push cursor to
  // answer "do we have anything to send this hub?" without a round trip, which
  // is what an "only when there are changes" hub is scheduled on (ADR-240).
  maxLocalSeq: number
): Promise<void> {
  const now = Date.now();
  // Forget the runtime state of hubs no longer configured, so a hub that is
  // removed and re-added starts clean (fresh first-push gate, due at once)
  // rather than inheriting a schedule and guard state from its last life.
  const configured = new Set(hubs.map((hh) => hh.url));
  for (const url of Object.keys(shared.hubRuntime)) {
    if (!configured.has(url)) delete shared.hubRuntime[url];
  }
  // Rebuild the per-hub view to the CURRENT list (it is GUI-editable between
  // ticks), carrying prior results forward by url so a hub that succeeded
  // earlier keeps its lastSyncAt while another is being attempted.
  const prior = new Map(status.hubs.map((h) => [h.url, h]));
  status.hubs = hubs.map((h) => {
    const rt = hubRuntime(h.url);
    return {
      ...(prior.get(h.url) ?? {
        lastSyncAt: null,
        lastError: null,
        holdReason: null,
        heldOpsCount: null,
        behindOps: null,
      }),
      url: h.url,
      cadence: hubCadence(h),
      fallback: hubFallback(h),
      onChange: hubOnChange(h),
      nextDueAt: rt.nextDueAt > now ? new Date(rt.nextDueAt).toISOString() : null,
      pulling: shouldPullFrom(h, approval?.url ?? null),
      skewMs: rt.skewMs,
    } as HubStatus;
  });

  // Did an AUTOMATIC hub complete a fully drained exchange this round? That —
  // not merely "answered" — is what clears a fallback approval, so a
  // recovering primary is brought up to speed before we stop leaning on the
  // backup (Brandon, 2026-08-23).
  let automaticDrained = false;
  let automaticAttempted = false;
  let firstHealthyIndex = -1;
  // Asked-and-failed is offline; never-asked is not. See resolveSyncState.
  let readAttempted = false;

  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i];
    const rt = hubRuntime(hub.url);
    const isAutomatic = hubFallback(hub) === "automatic";
    const cadence = effectiveCadence(hub, approval);
    const cadenceMs = cadenceIntervalMs(cadence, guard.continuousMs);
    // Honor a cadence the owner changed since this hub was last scheduled,
    // without dragging a failing hub's backoff back down to its cadence.
    const retryFloorMs =
      rt.consecutiveFails > 0
        ? nextDueAfter({
            now: 0,
            ok: false,
            cadenceMs,
            retryMs: guard.continuousMs,
            fails: rt.consecutiveFails,
          })
        : 0;
    rt.nextDueAt = clampNextDue(rt.nextDueAt, now, cadenceMs, retryFloorMs);
    // The cadence is the fastest this hub is contacted. Nothing overrides it
    // but the owner's own check-in button, which zeroes the due time above.
    if (rt.nextDueAt > now) continue;
    // "Only when there are changes" (ADR-252): the round is due, so now decide
    // whether there is anything worth waking this hub for. One cheap LOCAL
    // read decides it; nothing is sent over the wire to find out there was
    // nothing to send. A fresh process has `lastExchangeAt` at 0, so it always
    // exchanges once on startup, which is what it did before this gate too.
    if (hubOnChange(hub)) {
      const cursor = await readCursor(hub.url);
      const skip = quietSkip({
        onChange: true,
        hasLocalChanges: cursor.push < maxLocalSeq,
        consecutiveFails: rt.consecutiveFails,
        msSinceLastExchange: now - rt.lastExchangeAt,
        livenessFloorMs: maxSafeGapMs(),
      });
      if (skip) continue;
    }
    rt.lastExchangeAt = now;
    const pull = shouldPullFrom(hub, approval?.url ?? null);
    if (isAutomatic) automaticAttempted = true;
    if (pull) readAttempted = true;
    try {
      const r = await exchangeWith(hub, deviceId, guard, { pull });
      rt.consecutiveFails = 0;
      rt.nextDueAt = nextDueAfter({ now, ok: true, cadenceMs, retryMs: guard.continuousMs });
      status.hubs[i] = {
        ...status.hubs[i],
        lastSyncAt: new Date().toISOString(),
        lastError: null,
        nextDueAt: new Date(rt.nextDueAt).toISOString(),
        holdReason: r.holdReason,
        heldOpsCount: r.heldOpsCount,
        skewMs: r.skewMs,
        behindOps: r.pendingOps,
      };
      if (isAutomatic && r.drained) automaticDrained = true;
      if (pull && firstHealthyIndex < 0) firstHealthyIndex = i;
      // The blended top-level reading follows the highest-priority hub we
      // actually pulled from — that is what "am I reading fresh data" means.
      if (firstHealthyIndex === i) {
        status.activeHubIndex = i;
        status.pendingOps = r.pendingOps;
        status.holdReason = r.holdReason;
        status.heldOpsCount = r.heldOpsCount;
        status.skewMs = r.skewMs;
        status.skewWarn =
          r.skewMs !== null &&
          classifySkew(r.skewMs, guard.skewWarnMs, guard.skewHoldMs) !== "ok";
        status.lastSyncAt = new Date().toISOString();
        status.lastError = null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rt.consecutiveFails += 1;
      rt.nextDueAt = nextDueAfter({
        now,
        ok: false,
        cadenceMs,
        retryMs: guard.continuousMs,
        fails: rt.consecutiveFails,
      });
      status.hubs[i] = {
        ...status.hubs[i],
        lastError: message,
        nextDueAt: new Date(rt.nextDueAt).toISOString(),
      };
      status.lastError = message;
      log.warn("hub exchange failed", {
        hub: hub.url,
        automatic: isAutomatic,
        error: message,
        // How many times running, and how long we wait now — so the backoff is
        // readable in the log instead of inferred from timestamps.
        consecutiveFails: rt.consecutiveFails,
        retryInMs: rt.nextDueAt - now,
      });
    }
  }

  // The failing clock only moves on rounds where an automatic hub was
  // actually attempted, so a daily hub that is simply not due yet never reads
  // as "failing".
  if (automaticDrained) {
    shared.automaticFailingSince = null;
    if (approval) {
      log.info("automatic hub caught up; clearing the fallback approval", {
        approvedHub: approval.url,
      });
      await writeFallbackApproval(null);
      status.fallbackApproval = null;
    }
  } else if (automaticAttempted) {
    shared.automaticFailingSince ??= now;
  }

  const emergency = hubs.filter((h) => hubFallback(h) === "prompt");
  if (
    shouldPromptFallback({
      automaticFailingSince: shared.automaticFailingSince,
      now,
      thresholdMs: guard.fallbackPromptMs,
      hasEmergency: emergency.length > 0,
      approvedUrl: approval?.url ?? null,
    })
  ) {
    // Priority ordering: offer the first emergency hub in list order.
    const candidate = emergency[0];
    const candidateStatus = status.hubs.find((h) => h.url === candidate.url);
    status.fallbackPrompt = {
      url: candidate.url,
      cadence: hubCadence(candidate),
      automaticErrors: hubs
        .filter((h) => hubFallback(h) === "automatic")
        .map((h) => ({
          url: h.url,
          error: status.hubs.find((s2) => s2.url === h.url)?.lastError ?? null,
        })),
      failingForMs: now - (shared.automaticFailingSince ?? now),
      lastSyncAt: candidateStatus?.lastSyncAt ?? null,
      behindOps: candidateStatus?.behindOps ?? null,
    };
  } else {
    status.fallbackPrompt = null;
  }

  // Offline means a hub we are allowed to READ from was ASKED and did not
  // answer: pushing to an archive while every readable hub is down still
  // leaves this peer stale, and saying otherwise is the silent misreport
  // Principle 9 forbids. A hub that was not due was never asked, which is a
  // different fact and no longer reported as the same one.
  status.state = resolveSyncState({
    readHealthy: firstHealthyIndex >= 0,
    readAttempted,
    everSynced: !!status.lastSyncAt,
    holdReason: status.holdReason,
    pendingOps: status.pendingOps,
  });
}

/**
 * Start the loop. One fast timer carries both cadences: every
 * PUSH_DEBOUNCE_MS it checks whether new local ops exist (the "push soon
 * after a write" behavior, detected by watching max(seq) — no app hook
 * needed, the triggers already made the oplog the write signal), and at
 * least every PULL_MS it exchanges regardless, so remote edits land within
 * the pull window.
 */
export function startSyncLoop(): void {
  if (shared.loopArmed) return;
  // Armed when the supervisor configured hubs via env, OR on any
  // supervisor-managed peer at all (LEDGR_SUPERVISOR_DIR) — the hub list is
  // GUI-editable now (ADR-209), so a peer whose first hub is added from
  // Build → Network must already have the loop ticking. A tick with an empty
  // effective list does nothing but one cheap local job_state read. Cloud
  // deploys set neither, so hubs stay passive (decision 11).
  const envArmed =
    parseHubs(process.env.LEDGR_SYNC_HUBS).length > 0 && !!process.env.LEDGR_SYNC_TOKEN;
  if (!envArmed && !process.env.LEDGR_SUPERVISOR_DIR) return;
  shared.loopArmed = true;

  const pushDebounceMs = envInt("LEDGR_SYNC_PUSH_DEBOUNCE_MS", 2000);
  const pullMs = envInt("LEDGR_SYNC_PULL_MS", 10000);
  const guard: PushGuard = {
    mode: parseSyncMode(process.env.LEDGR_SYNC_MODE),
    maxFirstPush: envInt("LEDGR_SYNC_MAX_FIRST_PUSH", 500),
    confirmLargePush: /^(1|true)$/i.test(process.env.LEDGR_SYNC_CONFIRM_LARGE_PUSH ?? ""),
    skewWarnMs: envInt("LEDGR_SYNC_SKEW_WARN_MS", 5000),
    skewHoldMs: envInt("LEDGR_SYNC_SKEW_HOLD_MS", 60000),
    continuousMs: pullMs,
    // 15 minutes (Brandon, 2026-08-23): long enough that a network blip, a
    // laptop lid or a cold start never nags; short enough that a real outage
    // surfaces while the owner is still at the desk.
    fallbackPromptMs: envInt("LEDGR_SYNC_FALLBACK_PROMPT_MS", 15 * 60 * 1000),
  };

  let deviceId: string | null = null;
  let lastSeenSeq = -1;
  let lastFullExchange = 0;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      deviceId ??= await localDeviceId();
      // Re-read every tick so the /build/updates toggle and the Network
      // page's hub edits take effect on the next exchange, not the next
      // restart.
      guard.mode = await readSyncMode();
      const anyFirstPushDone = Object.values(shared.hubRuntime).some((r) => r.firstPushDone);
      const storedConfirm = !anyFirstPushDone && (await readStoredConfirmLargePush());
      guard.confirmLargePush = effectiveConfirmLargePush(
        storedConfirm,
        process.env.LEDGR_SYNC_CONFIRM_LARGE_PUSH
      );
      const hubs = await readSyncHubs();
      if (hubs.length === 0) return;
      const approval = await readFallbackApproval(hubs.map((h) => h.url));
      status.fallbackApproval = approval;
      const head = await getDb()
        .select({ max: sql<string>`coalesce(max(${syncOps.seq}), 0)::text` })
        .from(syncOps)
        .where(isNull(syncOps.originDeviceId));
      const maxSeq = Number(head[0]?.max ?? 0);
      const due = Date.now() - lastFullExchange >= pullMs;
      const wrote = lastSeenSeq >= 0 && maxSeq > lastSeenSeq;
      // An owner-requested check-in overrides BOTH schedules: this outer gate,
      // and each hub's own cadence (a hub whose next-due is an hour out would
      // otherwise be skipped inside exchange()).
      const forced = shared.checkInRequestedAt !== null;
      if (forced) {
        shared.checkInRequestedAt = null;
        for (const rt of Object.values(shared.hubRuntime)) rt.nextDueAt = 0;
      }
      if (due || wrote || forced || lastSeenSeq < 0) {
        await exchange(hubs, deviceId, guard, approval, maxSeq);
        lastFullExchange = Date.now();
      }
      // One-shot: the stored release did its job the moment the first push
      // went through; clear it so it can never release a future process's
      // held push (a bad restore, for instance) by leftover accident.
      if (storedConfirm && Object.values(shared.hubRuntime).some((r) => r.firstPushDone)) {
        await writeStoredConfirmLargePush(false);
      }
      lastSeenSeq = maxSeq;
    } catch (err) {
      status.state = "offline";
      status.lastError = err instanceof Error ? err.message : String(err);
      log.warn("sync tick failed", { error: status.lastError });
    } finally {
      running = false;
    }
  };

  log.info("sync loop armed", { envArmed, pushDebounceMs, pullMs });
  const timer = setInterval(() => void tick(), pushDebounceMs);
  // Never hold the process open just to sync; the app server does that.
  timer.unref?.();
  void tick();
}
