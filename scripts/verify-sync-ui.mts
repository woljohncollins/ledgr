// Verification for the phase-3 sync surfaces (ADR-206): the pure seams behind
// Synced-devices management, the /api/sync/status shape, and the nav pill's
// gate. All pure — no database — so verify-ci.mjs discovers and runs it.
//
// Run: npx tsx scripts/verify-sync-ui.mts
import { readFileSync } from "node:fs";
import { digestsMatch, hashToken } from "../src/lib/auth/machine";
import {
  buildSyncStatus,
  resolveSyncState,
  cadenceIntervalMs,
  clampNextDue,
  effectiveCadence,
  effectiveConfirmLargePush,
  effectiveFallbackApproval,
  effectiveHubs,
  effectiveSyncMode,
  getSyncStatus,
  checkFirstPush,
  classifySkew,
  hubCadence,
  hubFallback,
  hubListRefusal,
  nextDueAfter,
  parseHubs,
  parseSyncMode,
  pushSelectionForHub,
  selectPushOps,
  trimBatchToBytes,
  shouldPromptFallback,
  shouldPullFrom,
  CADENCE_PRESETS,
  CADENCE_WEEKLY_MINUTES,
  cadenceLabel,
  cadenceRefusal,
  CADENCE_CONTINUOUS,
  CADENCE_DAILY_MINUTES,
  CADENCE_DAILY_MS,
  MAX_RETRY_BACKOFF_MS,
  hubOnChange,
  maxSafeGapMinutes,
  maxSafeGapMs,
  quietSkip,
  type HubRuntime,
  type SyncStatus,
} from "../src/lib/sync/client";
import {
  cursorLag,
  deleteRefusal,
  generateSyncToken,
  pullOnlyRejectsPush,
} from "../src/lib/sync/peers";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// ── Device tokens (plan decision 15) ─────────────────────────────────────────

{
  const token = generateSyncToken();
  // 32 bytes → 43 base64url chars, no padding, URL-safe alphabet only.
  check("token is base64url with no padding", /^[A-Za-z0-9_-]+$/.test(token));
  check("token carries ~32 bytes of entropy", token.length >= 43, `len ${token.length}`);
  check("tokens are unique per mint", generateSyncToken() !== token);

  // Hash round-trip: what createPeer stores is what verifySyncDevice compares.
  const digest = hashToken(token);
  check("stored hash is a sha256 hex digest", /^[0-9a-f]{64}$/.test(digest));
  check("same token matches its stored hash", digestsMatch(hashToken(token), digest));
  check(
    "a different token never matches",
    !digestsMatch(hashToken(generateSyncToken()), digest)
  );
}

// ── Cursor lag (the "n ops behind" column) ───────────────────────────────────

check("lag = hub max seq minus pull cursor", cursorLag(100, 40) === 60);
check("fully caught up reads 0", cursorLag(75, 75) === 0);
check("a cursor ahead of the read max never goes negative", cursorLag(40, 100) === 0);
check("a never-synced peer is behind by the whole oplog", cursorLag(12, 0) === 12);

// ── Peer lifecycle (delete requires revoked) ─────────────────────────────────

check("deleting a live device is refused", typeof deleteRefusal(false) === "string");
check("deleting a revoked device is allowed", deleteRefusal(true) === null);

// ── Guardrail 1: pull-only ───────────────────────────────────────────────────

check("full sync mode is the default", parseSyncMode(undefined) === "full");
check("unrecognized env falls back to full", parseSyncMode("nonsense") === "full");
check("pull-only is recognized", parseSyncMode("pull-only") === "pull-only");

check(
  "hub refuses a non-empty push from a pull-only device",
  pullOnlyRejectsPush(true, 3) === true
);
check(
  "hub allows an empty push (pull) from a pull-only device",
  pullOnlyRejectsPush(true, 0) === false
);
check("hub allows any push from a full device", pullOnlyRejectsPush(false, 500) === false);

{
  // The client's own decision never sends ops in pull-only mode, no matter
  // how big the backlog or how done firstPushDone already is.
  const sel = selectPushOps({
    mode: "pull-only",
    candidateOps: [],
    pendingCount: 999999,
    firstPushDone: false,
    maxFirstPush: 500,
    confirmLargePush: false,
    skewMs: null,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  });
  check(
    "pull-only mode sends zero ops regardless of backlog",
    sel.ops.length === 0 && sel.holdReason === null
  );
}

// ── Guardrail 2: first-push size guard ───────────────────────────────────────

const fpBase = { firstPushDone: false, maxFirstPush: 500, confirmLargePush: false };

check(
  "just under the limit pushes",
  checkFirstPush({ ...fpBase, pendingCount: 499 }).hold === false
);
check(
  "exactly at the limit pushes (only EXCEEDING holds)",
  checkFirstPush({ ...fpBase, pendingCount: 500 }).hold === false
);
check(
  "just over the limit holds",
  checkFirstPush({ ...fpBase, pendingCount: 501 }).hold === true
);
check(
  "a held check does not consume the one-shot gate",
  checkFirstPush({ ...fpBase, pendingCount: 501 }).done === false
);
check(
  "a passed check consumes the one-shot gate",
  checkFirstPush({ ...fpBase, pendingCount: 499 }).done === true
);
check(
  "confirmLargePush releases an over-limit push",
  checkFirstPush({ ...fpBase, pendingCount: 100000, confirmLargePush: true }).hold === false
);
check(
  "once firstPushDone, a huge backlog is never gated again (a busy spoke isn't throttled)",
  checkFirstPush({ ...fpBase, pendingCount: 100000, firstPushDone: true }).hold === false
);
check(
  "the held reason names the release path",
  /maxFirstPush/.test((checkFirstPush({ ...fpBase, pendingCount: 501 }) as { reason: string }).reason) &&
    /confirmLargePush/.test((checkFirstPush({ ...fpBase, pendingCount: 501 }) as { reason: string }).reason)
);

{
  // selectPushOps end-to-end: a first over-limit round holds and does NOT
  // consume the gate; a second round with the same backlog (simulating the
  // owner having raised confirmLargePush) pushes and DOES consume it; a
  // third round with an even bigger backlog is not gated (second push rule).
  const candidateOps = [{ seq: 1 } as never];
  const round1 = selectPushOps({
    mode: "full",
    candidateOps,
    pendingCount: 600,
    firstPushDone: false,
    maxFirstPush: 500,
    confirmLargePush: false,
    skewMs: null,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  });
  check(
    "round 1: an oversized first push holds and reports the count",
    round1.ops.length === 0 && round1.holdReason === "first_push_size" && round1.heldOpsCount === 600
  );
  const round2 = selectPushOps({
    mode: "full",
    candidateOps,
    pendingCount: 600,
    firstPushDone: round1.firstPushDoneAfter,
    maxFirstPush: 500,
    confirmLargePush: true,
    skewMs: null,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  });
  check(
    "round 2: confirmLargePush releases it and the gate is now consumed",
    round2.ops === candidateOps && round2.firstPushDoneAfter === true
  );
  const round3 = selectPushOps({
    mode: "full",
    candidateOps,
    pendingCount: 5_000_000,
    firstPushDone: round2.firstPushDoneAfter,
    maxFirstPush: 500,
    confirmLargePush: false,
    skewMs: null,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  });
  check(
    "round 3 (the SECOND real push): never gated even at a much bigger size",
    round3.ops === candidateOps && round3.holdReason === null
  );
}

// ── Guardrail 3: clock-skew detection ────────────────────────────────────────

check("well within thresholds classifies ok", classifySkew(1000, 5000, 60000) === "ok");
check("at the warn threshold classifies warn", classifySkew(5000, 5000, 60000) === "warn");
check("just under warn classifies ok", classifySkew(4999, 5000, 60000) === "ok");
check("between warn and hold classifies warn", classifySkew(30000, 5000, 60000) === "warn");
check("at the hold threshold classifies hold", classifySkew(60000, 5000, 60000) === "hold");
check("over the hold threshold classifies hold", classifySkew(120000, 5000, 60000) === "hold");
check(
  "negative skew (hub behind spoke) classifies the same as positive",
  classifySkew(-70000, 5000, 60000) === "hold" && classifySkew(-1000, 5000, 60000) === "ok"
);

{
  // A hold-level skew withholds push but is independent of firstPushDone —
  // it can trip on the 100th push, not just the first.
  const sel = selectPushOps({
    mode: "full",
    candidateOps: [{ seq: 1 } as never],
    pendingCount: 1,
    firstPushDone: true,
    maxFirstPush: 500,
    confirmLargePush: false,
    skewMs: 90000,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  });
  check(
    "a clock-skew hold withholds push even after the first-push gate is long done",
    sel.ops.length === 0 && sel.holdReason === "clock_skew" && sel.firstPushDoneAfter === true
  );
}

// ── Hub-list parsing = the nav pill's server gate ────────────────────────────

check("no env → no hubs (pill unmounted)", parseHubs(undefined).length === 0);
check("empty env → no hubs", parseHubs("").length === 0);
check("whitespace/empty entries are dropped", parseHubs(" , ,").length === 0);
{
  const hubs = parseHubs(" https://a.example , https://b.example ,, ");
  check(
    "ordered hub list parses trimmed",
    hubs.length === 2 && hubs[0] === "https://a.example" && hubs[1] === "https://b.example"
  );
}

// ── /api/sync/status response shapes ─────────────────────────────────────────

const base: SyncStatus = {
  state: "synced",
  pendingOps: 0,
  activeHubIndex: 0,
  lastSyncAt: "2026-08-22T10:00:00.000Z",
  lastError: null,
  holdReason: null,
  heldOpsCount: null,
  skewMs: null,
  skewWarn: false,
  hubs: [],
  fallbackPrompt: null,
  fallbackApproval: null,
};

// buildSyncStatus takes the CONFIGURED list since ADR-210, so the shape is
// right for a hub added between ticks (config known, no attempt yet).
const h = (url: string) => ({ url });

{
  const disabled = buildSyncStatus([], base, 0, "full");
  check("disabled shape is exactly {enabled: false}",
    disabled.enabled === false && Object.keys(disabled).length === 1
  );
}

{
  const s = buildSyncStatus([h("h1"), h("h2")], base, 0, "full");
  check(
    "enabled shape carries state/pendingOps/hub/mode fields",
    s.enabled === true &&
      s.state === "synced" &&
      s.pendingOps === 0 &&
      s.activeHubIndex === 0 &&
      s.hubCount === 2 &&
      s.mode === "full" &&
      s.lastSyncAt === base.lastSyncAt &&
      s.lastError === null
  );
}

{
  // Unpushed local writes between loop runs flip a stale "synced" to pending.
  const s = buildSyncStatus([h("h1")], base, 3, "full");
  check(
    "on-demand pendingOps overrides the loop's stale count",
    s.enabled === true && s.pendingOps === 3 && s.state === "pending"
  );
}

{
  // Offline stays offline no matter the backlog; the count still reports.
  const s = buildSyncStatus([h("h1")], { ...base, state: "offline", lastError: "x" }, 7, "full");
  check(
    "offline is not masked by the pending flip",
    s.enabled === true && s.state === "offline" && s.pendingOps === 7
  );
}

{
  // A held push is not masked or upgraded by the pendingOps recompute either.
  const s = buildSyncStatus(
    [h("h1")],
    { ...base, state: "held", holdReason: "first_push_size", heldOpsCount: 600 },
    600,
    "full"
  );
  check(
    "held state carries its reason and count through untouched",
    s.enabled === true &&
      s.state === "held" &&
      s.holdReason === "first_push_size" &&
      s.heldOpsCount === 600
  );
}

{
  // Pull-only mode is reported even while otherwise fully synced.
  const s = buildSyncStatus([h("h1")], base, 0, "pull-only");
  check("pull-only mode is carried into the response", s.enabled === true && s.mode === "pull-only");
}

{
  // A warn-level skew surfaces even when nothing is held.
  const s = buildSyncStatus([h("h1")], { ...base, skewMs: 8000, skewWarn: true }, 0, "full");
  check(
    "skew fields surface even when the state is otherwise synced",
    s.enabled === true && s.state === "synced" && s.skewWarn === true && s.skewMs === 8000
  );
}

{
  // Skew can be negative (hub behind spoke) and still reports as-is.
  const s = buildSyncStatus([h("h1")], { ...base, skewMs: -75000, skewWarn: true }, 0, "full");
  check("negative skew round-trips through the status shape", s.enabled === true && s.skewMs === -75000);
}


// ── ADR-210: per-hub cadence and fallback trust ──────────────────────────────
//
// Two INDEPENDENT axes. Conflating them into one `role` enum was the first
// draft's mistake: a fast hub you would happily fall back to and a daily hub
// you want to be asked about are the common pair, but the axes are genuinely
// independent, so nothing here may derive one from the other.

// Parse tolerance: an entry stored before these fields existed reads as
// exactly what it was already doing.
check("a hub with no cadence reads continuous", hubCadence({}) === CADENCE_CONTINUOUS);
check("a hub with no fallback reads automatic", hubFallback({}) === "automatic");
check("garbage cadence is not obeyed", hubCadence({ cadence: "hourly" as never }) === CADENCE_CONTINUOUS);
check("garbage fallback is not obeyed", hubFallback({ fallback: "maybe" as never }) === "automatic");
check("daily is recognized", hubCadence({ cadence: "daily" }) === CADENCE_DAILY_MINUTES);
check("prompt is recognized", hubFallback({ fallback: "prompt" }) === "prompt");

{
  // The axes must not be derived from each other — the whole point of two
  // fields. A daily AUTOMATIC hub and a continuous ASK-FIRST hub are both
  // legal and must survive a round trip.
  const stored = [
    { url: "https://a", token: "t", cadence: CADENCE_DAILY_MINUTES, fallback: "automatic" },
    { url: "https://b", token: "t", cadence: CADENCE_CONTINUOUS, fallback: "prompt" },
  ];
  const hubs = effectiveHubs(stored, undefined, undefined);
  check(
    "daily + automatic survives (cadence does not imply trust)",
    hubCadence(hubs[0]) === CADENCE_DAILY_MINUTES && hubFallback(hubs[0]) === "automatic"
  );
  check(
    "continuous + prompt survives (trust does not imply cadence)",
    hubCadence(hubs[1]) === CADENCE_CONTINUOUS && hubFallback(hubs[1]) === "prompt"
  );
}

{
  // An old stored entry (no axes at all) normalizes to the prior behavior.
  const hubs = effectiveHubs([{ url: "https://a", token: "t" }], undefined, undefined);
  check(
    "a pre-ADR-210 stored hub normalizes to continuous + automatic",
    hubs.length === 1 && hubs[0].cadence === CADENCE_CONTINUOUS && hubs[0].fallback === "automatic"
  );
}

{
  // Env-configured hubs are automatic and continuous: that is what they did
  // before the axes existed, and a config file cannot express anything else.
  const hubs = effectiveHubs(undefined, "https://a,https://b", "tok");
  check(
    "env hubs are continuous + automatic",
    hubs.length === 2 && hubs.every((x) => x.cadence === CADENCE_CONTINUOUS && x.fallback === "automatic")
  );
}

check("continuous cadence is the loop's own pull window", cadenceIntervalMs(CADENCE_CONTINUOUS, 10000) === 10000);
check("daily cadence is 24h", cadenceIntervalMs(CADENCE_DAILY_MINUTES, 10000) === CADENCE_DAILY_MS);

// ── The cadence ladder (ADR-221) ────────────────────────────────────────────
//
// The enum became an interval, so the tolerance and the guardrail are the two
// things worth pinning. The guardrail is the important one: it is what keeps a
// dropdown from walking the owner into the ADR-208 refusal, which is a full
// re-fill rather than an error message.

check("the ladder is the ordinary one, ordered, no duplicates",
  JSON.stringify(CADENCE_PRESETS.map((p) => p.minutes)) ===
    JSON.stringify([0, 1, 5, 15, 60, 1440, 10080]));

check("every preset the picker offers is one the guardrail accepts",
  CADENCE_PRESETS.every((p) => cadenceRefusal(p.minutes) === null));

check("a minute is a minute", cadenceIntervalMs(1, 10000) === 60000);
check("a cadence shorter than the loop's own window cannot outpace it",
  cadenceIntervalMs(1, 90000) === 90000);

// The rule: you must be able to MISS ONE and still be inside the window the
// hub keeps history for. Weekly against the default 14 days is the boundary,
// which is why the ladder stops there.
check("weekly is allowed against the default window", cadenceRefusal(CADENCE_WEEKLY_MINUTES) === null);
check("a fortnight is refused, and says why",
  (cadenceRefusal(CADENCE_WEEKLY_MINUTES * 2) ?? "").includes("full copy of everything"));
check("a narrower window tightens the refusal", cadenceRefusal(CADENCE_WEEKLY_MINUTES, 6) !== null);
check("a narrow window still allows a short cadence", cadenceRefusal(60, 6) === null);
// A WIDER window must not open a gap past weekly, because `hubCadence` clamps
// there on read: a picker that accepted what the reader silently rewrites is
// the quiet disagreement this guardrail exists to prevent.
check("a wider window never opens a gap past weekly",
  cadenceRefusal(CADENCE_WEEKLY_MINUTES, 90) === null &&
    cadenceRefusal(CADENCE_WEEKLY_MINUTES + 1, 90) !== null);
check("the refusal names the longest gap that is actually safe",
  (cadenceRefusal(CADENCE_WEEKLY_MINUTES * 2) ?? "").includes("7 days"));
check("continuous is never refused, whatever the window", cadenceRefusal(CADENCE_CONTINUOUS, 1) === null);

// Tolerance, in both directions: an entry stored before ADR-221 reads as what
// it was doing, and an entry from a LATER version that somehow exceeds the cap
// is clamped rather than obeyed (never refused at read time, because refusing
// to read is refusing to sync).
check("a stored \"continuous\" still reads continuous", hubCadence({ cadence: "continuous" }) === CADENCE_CONTINUOUS);
check("a stored number reads as itself", hubCadence({ cadence: 15 }) === 15);
check("a fractional stored value is floored, not rejected", hubCadence({ cadence: 15.9 }) === 15);
check("a stored value beyond the cap is clamped to weekly",
  hubCadence({ cadence: 999_999 }) === CADENCE_WEEKLY_MINUTES);
check("a negative stored value reads continuous, never backwards", hubCadence({ cadence: -5 }) === CADENCE_CONTINUOUS);

check("every preset reads back as a sentence, not a number",
  CADENCE_PRESETS.every((p) => cadenceLabel(p.minutes) === p.label));
check("an off-ladder value still reads as a sentence", cadenceLabel(120) === "Every 2 hours");

// The one validation: with every hub set to ask first, the instance never
// syncs unattended — a silently-not-syncing peer wearing a "synced" face.
check("an empty hub list is fine (that just means no syncing)", hubListRefusal([]) === null);
check(
  "one automatic hub satisfies the rule",
  hubListRefusal([{ fallback: "automatic" }, { fallback: "prompt" }]) === null
);
check(
  "an all-prompt list is refused",
  typeof hubListRefusal([{ fallback: "prompt" }, { fallback: "prompt" }]) === "string"
);
check(
  "a list defaulting to automatic (no field) is not refused",
  hubListRefusal([{}]) === null
);

// Pushing is always allowed; PULLING is what trust gates.
check(
  "an automatic hub is pulled from with no approval",
  shouldPullFrom({ url: "https://a", fallback: "automatic" }, null) === true
);
check(
  "an emergency hub is NOT pulled from without approval",
  shouldPullFrom({ url: "https://b", fallback: "prompt" }, null) === false
);
check(
  "an approval unlocks pulling from exactly that hub",
  shouldPullFrom({ url: "https://b", fallback: "prompt" }, "https://b") === true
);
check(
  "an approval for one hub does not unlock another",
  shouldPullFrom({ url: "https://c", fallback: "prompt" }, "https://b") === false
);

// Cadence promotion lives on the APPROVAL, never on the config, so it reverts
// by itself when the approval clears (Brandon's requirement).
{
  const daily = { url: "https://b", cadence: "daily" as const };
  const approvedAt = "2026-08-23T00:00:00.000Z";
  check(
    "no approval leaves a daily hub daily",
    effectiveCadence(daily, null) === CADENCE_DAILY_MINUTES
  );
  check(
    "an approval WITHOUT promotion leaves the cadence alone",
    effectiveCadence(daily, { url: "https://b", promoteCadence: false, approvedAt }) === CADENCE_DAILY_MINUTES
  );
  check(
    "an approval WITH promotion makes it continuous",
    effectiveCadence(daily, { url: "https://b", promoteCadence: true, approvedAt }) === CADENCE_CONTINUOUS
  );
  check(
    "a promotion for another hub does not promote this one",
    effectiveCadence(daily, { url: "https://z", promoteCadence: true, approvedAt }) === CADENCE_DAILY_MINUTES
  );
}

// A failed exchange retries on the normal pull window: a daily hub that
// errors must not disappear for 24 hours.
{
  const now = 1_000_000;
  check(
    "a successful daily exchange waits the full day",
    nextDueAfter({ now, ok: true, cadenceMs: CADENCE_DAILY_MS, retryMs: 10000 }) ===
      now + CADENCE_DAILY_MS
  );
  check(
    "a FAILED daily exchange retries on the pull window, not tomorrow",
    nextDueAfter({ now, ok: false, cadenceMs: CADENCE_DAILY_MS, retryMs: 10000 }) === now + 10000
  );
  check(
    "a continuous hub never waits longer than its cadence on failure",
    nextDueAfter({ now, ok: false, cadenceMs: 10000, retryMs: 60000 }) === now + 10000
  );
}

// Repeated failure backs off (ADR-239). One change the hub could never accept,
// re-sent every 10 seconds, was ~8,600 requests a day — enough on its own to
// hold a serverless hub's database awake around the clock.
{
  const now = 1_000_000;
  const CADENCE_HOURLY_MS = 60 * 60 * 1000;
  const failAt = (fails: number, cadenceMs = 10000) =>
    nextDueAfter({ now, ok: false, cadenceMs, retryMs: 10000, fails }) - now;
  check("the first failure still retries on the pull window", failAt(1) === 10000);
  check("the second failure waits twice as long", failAt(2) === 20000);
  check("the fourth waits eight times as long", failAt(4) === 80000);
  check("the backoff stops at the cap", failAt(30) === MAX_RETRY_BACKOFF_MS);
  check(
    "an hourly hub backs off no further than its own cadence",
    failAt(30, CADENCE_HOURLY_MS) === CADENCE_HOURLY_MS
  );
  check(
    "a success clears the backoff",
    nextDueAfter({ now, ok: true, cadenceMs: 10000, retryMs: 10000, fails: 30 }) === now + 10000
  );
  // The clamp must not undo the backoff: a continuous hub's cadence is 10s, so
  // clamping to the cadence alone would erase every retry gap above it.
  const backedOff = now + MAX_RETRY_BACKOFF_MS;
  check(
    "clampNextDue honors a retry floor above the cadence",
    clampNextDue(backedOff, now, 10000, MAX_RETRY_BACKOFF_MS) === backedOff
  );
  check(
    "clampNextDue still pulls back a stale cadence when nothing is failing",
    clampNextDue(now + CADENCE_DAILY_MS, now, 10000) === now + 10000
  );
}

// "Only when there are changes" (ADR-252, replacing ADR-240's reading of the
// same flag). The cadence is the FASTEST a hub is contacted; this gate decides
// whether a due round is worth making at all, so a quiet stretch is silent.
{
  check("the flag is off unless explicitly set", hubOnChange({}) === false);
  check("a non-boolean never turns it on", hubOnChange({ onChange: "yes" as never }) === false);
  check("an explicit true turns it on", hubOnChange({ onChange: true }) === true);

  // The one number behind both the picker's ceiling and the gate's backstop.
  check("the safe gap is half the hub's retention window", maxSafeGapMinutes(14) === 7 * 1440);
  check("and never longer than the weekly preset", maxSafeGapMinutes(60) === 10_080);
  check("in ms for the loop", maxSafeGapMs(14) === 7 * 24 * 60 * 60 * 1000);

  const base = {
    onChange: true,
    hasLocalChanges: false,
    consecutiveFails: 0,
    msSinceLastExchange: 60_000,
    livenessFloorMs: maxSafeGapMs(),
  };
  check("nothing to send means nothing to say", quietSkip(base) === true);
  check(
    "changes waiting are always sent on the next due round",
    quietSkip({ ...base, hasLocalChanges: true }) === false
  );
  check(
    "a hub without the flag keeps its cadence as a fixed schedule",
    quietSkip({ ...base, onChange: false }) === false
  );
  // A broken hub that is never contacted can never come back, and would report
  // itself fine while doing nothing. Its retries are already spaced by the
  // ADR-239 backoff, so let them through.
  check(
    "a failing hub is retried even with nothing to send",
    quietSkip({ ...base, consecutiveFails: 1 }) === false
  );
  // The backstop: silence past the safe gap ages this peer out of the hub's
  // retention window (ADR-208), which costs a full re-fill instead of a
  // catch-up. A fortnight away is the ordinary case that would hit it.
  check(
    "silence at the safe gap breaks the quiet",
    quietSkip({ ...base, msSinceLastExchange: maxSafeGapMs() }) === false
  );
  check(
    "just inside the safe gap stays quiet",
    quietSkip({ ...base, msSinceLastExchange: maxSafeGapMs() - 1 }) === true
  );
  // A fresh process has no in-memory last-exchange time, so it always checks in
  // once on startup rather than trusting a gap it cannot measure.
  check("a restart checks in once", quietSkip({ ...base, msSinceLastExchange: Date.now() }) === false);
}

// A schedule already written must not outlive the cadence that wrote it.
//
// Caught live on the dev rig 2026-08-23: a hub was set to `daily`, which wrote
// a due time ~24h out, then switched back to `continuous`. The stale due time
// won, so the hub was skipped every round for a day — and because the hub in
// question was the only AUTOMATIC one, the fallback approval it was supposed
// to clear stayed in force. Silently skipping the primary is the Principle 9
// shape this whole ADR exists to avoid, so it gets its own guard.
{
  const now = 1_000_000_000;
  const dailyDue = now + CADENCE_DAILY_MS;
  check(
    "switching daily → continuous makes the hub due within the new interval",
    clampNextDue(dailyDue, now, 10_000) === now + 10_000
  );
  check(
    "a due time inside the current cadence is left alone",
    clampNextDue(now + 3_000, now, 10_000) === now + 3_000
  );
  check(
    "a hub already overdue stays overdue (never pushed into the future)",
    clampNextDue(now - 5_000, now, 10_000) === now - 5_000
  );
  check(
    "a daily hub that is legitimately scheduled a day out keeps that schedule",
    clampNextDue(dailyDue, now, CADENCE_DAILY_MS) === dailyDue
  );
  check(
    "a never-scheduled hub (0) is due immediately",
    clampNextDue(0, now, CADENCE_DAILY_MS) === 0
  );
}

// The prompt threshold: 15 minutes by default, and none of the three other
// preconditions may be skipped.
{
  const fifteen = 15 * 60 * 1000;
  const now = 100 * 60 * 1000;
  const base210 = {
    now,
    thresholdMs: fifteen,
    hasEmergency: true,
    approvedUrl: null as string | null,
  };
  check(
    "no failure means no prompt",
    shouldPromptFallback({ ...base210, automaticFailingSince: null }) === false
  );
  check(
    "a 30-second blip does not prompt",
    shouldPromptFallback({ ...base210, automaticFailingSince: now - 30_000 }) === false
  );
  check(
    "failing just under the threshold does not prompt",
    shouldPromptFallback({ ...base210, automaticFailingSince: now - fifteen + 1 }) === false
  );
  check(
    "failing at the threshold prompts",
    shouldPromptFallback({ ...base210, automaticFailingSince: now - fifteen }) === true
  );
  check(
    "no emergency hub means nothing to offer, so no prompt",
    shouldPromptFallback({
      ...base210,
      hasEmergency: false,
      automaticFailingSince: now - fifteen * 4,
    }) === false
  );
  check(
    "an existing approval is not re-asked",
    shouldPromptFallback({
      ...base210,
      approvedUrl: "https://b",
      automaticFailingSince: now - fifteen * 4,
    }) === false
  );
}

// A stored approval that no longer names a configured hub is not honored:
// removing a hub must not leave it silently approved.
{
  const stored = { url: "https://b", promoteCadence: true, approvedAt: "2026-08-23T00:00:00.000Z" };
  check(
    "an approval for a configured hub reads back",
    effectiveFallbackApproval(stored, ["https://a", "https://b"])?.url === "https://b"
  );
  check(
    "an approval for a removed hub is dropped",
    effectiveFallbackApproval(stored, ["https://a"]) === null
  );
  check("nothing stored means no approval", effectiveFallbackApproval(undefined, ["https://a"]) === null);
  check(
    "promoteCadence defaults to false rather than true",
    effectiveFallbackApproval({ url: "https://a", approvedAt: "x" }, ["https://a"])
      ?.promoteCadence === false
  );
}

// ── The recorded trap: guard state is PER HUB, not per process ──────────────
//
// The first-push size guard and the learned clock skew used to be single
// global readings. A slow emergency hub with a day of ops queued would trip a
// hold that then blocked the healthy mirror hub too — one bad uplink taking
// the good one down with it. pushSelectionForHub is what the loop calls, so
// collapsing that state back to one flag fails right here.
{
  const ops = [{ seq: 1 }, { seq: 2 }] as never[];
  const runtime: Record<string, HubRuntime> = {
    // The healthy mirror has already pushed once this process.
    "https://mirror": { firstPushDone: true, skewMs: 0, nextDueAt: 0, consecutiveFails: 0, lastExchangeAt: 0 },
    // The emergency archive has not, and has a day of ops queued.
    "https://archive": { firstPushDone: false, skewMs: 0, nextDueAt: 0, consecutiveFails: 0, lastExchangeAt: 0 },
  };
  const common = {
    mode: "full" as const,
    candidateOps: ops,
    maxFirstPush: 500,
    confirmLargePush: false,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  };
  const archive = pushSelectionForHub(runtime, "https://archive", {
    ...common,
    pendingCount: 900,
  });
  const mirror = pushSelectionForHub(runtime, "https://mirror", {
    ...common,
    pendingCount: 900,
  });
  check(
    "the emergency hub's first push is held on its own backlog",
    archive.holdReason === "first_push_size" && archive.ops.length === 0
  );
  check(
    "the healthy mirror still sends while the other hub is held",
    mirror.holdReason === null && mirror.ops.length === 2
  );
  check(
    "a held hub does not mark itself pushed",
    runtime["https://archive"].firstPushDone === false
  );
  check(
    "holding one hub never clears another's flag",
    runtime["https://mirror"].firstPushDone === true
  );
}

{
  // Same isolation for clock skew: a hub whose clock is wrong holds only its
  // own push.
  const runtime: Record<string, HubRuntime> = {
    "https://good": { firstPushDone: true, skewMs: 200, nextDueAt: 0, consecutiveFails: 0, lastExchangeAt: 0 },
    "https://badclock": { firstPushDone: true, skewMs: 300_000, nextDueAt: 0, consecutiveFails: 0, lastExchangeAt: 0 },
  };
  const common = {
    mode: "full" as const,
    candidateOps: [{ seq: 1 }] as never[],
    pendingCount: 1,
    maxFirstPush: 500,
    confirmLargePush: false,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  };
  check(
    "a hub with a bad clock holds its own push",
    pushSelectionForHub(runtime, "https://badclock", common).holdReason === "clock_skew"
  );
  check(
    "the hub with a good clock is unaffected by the other's skew",
    pushSelectionForHub(runtime, "https://good", common).ops.length === 1
  );
}

{
  // An unknown hub starts fresh rather than inheriting anyone's state.
  const runtime: Record<string, HubRuntime> = {
    "https://old": { firstPushDone: true, skewMs: 0, nextDueAt: 0, consecutiveFails: 0, lastExchangeAt: 0 },
  };
  const sel = pushSelectionForHub(runtime, "https://new", {
    mode: "full",
    candidateOps: [{ seq: 1 }] as never[],
    pendingCount: 900,
    maxFirstPush: 500,
    confirmLargePush: false,
    skewWarnMs: 5000,
    skewHoldMs: 60000,
  });
  check(
    "a newly added hub gets its own first-push gate, not the neighbor's",
    sel.holdReason === "first_push_size"
  );
}

// ── The status shape carries the new per-hub and decision fields ────────────
{
  const s2 = buildSyncStatus(
    [
      { url: "https://a", cadence: CADENCE_CONTINUOUS, fallback: "automatic" },
      { url: "https://b", cadence: CADENCE_DAILY_MINUTES, fallback: "prompt" },
    ],
    base,
    0,
    "full",
    { "https://a": 0, "https://b": 42 }
  );
  check(
    "every configured hub appears with its axes, in list order",
    s2.enabled === true &&
      s2.hubs.length === 2 &&
      s2.hubs[0].url === "https://a" &&
      s2.hubs[1].cadence === CADENCE_DAILY_MINUTES &&
      s2.hubs[1].fallback === "prompt"
  );
  check(
    "an automatic hub reads as pulling and an emergency hub does not",
    s2.enabled === true && s2.hubs[0].pulling === true && s2.hubs[1].pulling === false
  );
  check(
    "the freshness gap per hub comes through",
    s2.enabled === true && s2.hubs[1].behindOps === 42
  );
}

{
  // A pending decision survives into the response, with its evidence, and the
  // backup's freshness gap is filled in from the cursors.
  const prompt = {
    url: "https://b",
    cadence: CADENCE_DAILY_MINUTES,
    automaticErrors: [{ url: "https://a", error: "fetch failed" }],
    failingForMs: 20 * 60 * 1000,
    lastSyncAt: "2026-08-22T10:00:00.000Z",
    behindOps: null,
  };
  const s2 = buildSyncStatus(
    [
      { url: "https://a", fallback: "automatic" },
      { url: "https://b", fallback: "prompt" },
    ],
    { ...base, state: "offline", fallbackPrompt: prompt },
    5,
    "full",
    { "https://b": 42 }
  );
  check(
    "the pending fallback decision reaches the client with its evidence",
    s2.enabled === true &&
      s2.fallbackPrompt?.url === "https://b" &&
      s2.fallbackPrompt.automaticErrors[0].error === "fetch failed" &&
      s2.fallbackPrompt.behindOps === 42
  );
  check(
    "an approved hub reads back through the status shape",
    buildSyncStatus(
      [{ url: "https://b", fallback: "prompt" }],
      {
        ...base,
        fallbackApproval: { url: "https://b", promoteCadence: true, approvedAt: "x" },
      },
      0,
      "full"
    ).enabled === true
  );
}

{
  // An emergency hub becomes readable the moment an approval names it, with
  // no config change — the approval is the only difference.
  const hubs = [{ url: "https://b", fallback: "prompt" as const }];
  const approved = buildSyncStatus(
    hubs,
    { ...base, fallbackApproval: { url: "https://b", promoteCadence: false, approvedAt: "x" } },
    0,
    "full"
  );
  check(
    "approval alone flips an emergency hub to pulling",
    approved.enabled === true && approved.hubs[0].pulling === true
  );
}

// ── The effective push mode: a stored override beats the env default ────────
//
// LEDGR_SYNC_MODE used to be the only source, which meant arming a spoke took
// a config-file edit and a restart. The override lives in job_state (outside
// the synced set, so it can never replicate to another peer) and the loop
// re-reads it per tick.
{
  check("a stored override wins over the env default", effectiveSyncMode("pull-only", "full") === "pull-only");
  check("the other direction too", effectiveSyncMode("full", "pull-only") === "full");
  check("no override falls back to the env value", effectiveSyncMode(undefined, "pull-only") === "pull-only");
  check("garbage in the override is ignored, not obeyed", effectiveSyncMode("yolo", "pull-only") === "pull-only");
  check("nothing anywhere means full (the shipped default)", effectiveSyncMode(null, undefined) === "full");
}

// ── Releasing a held first push: either source releases, stored is bool-true ─
{
  check("a stored release flag releases", effectiveConfirmLargePush(true, undefined));
  check("the env var releases as before", effectiveConfirmLargePush(undefined, "true") && effectiveConfirmLargePush(false, "1"));
  check("nothing set holds", !effectiveConfirmLargePush(undefined, undefined));
  check("garbage in the store never releases", !effectiveConfirmLargePush("yes", "0") && !effectiveConfirmLargePush(1, undefined));
}

// ── The effective hub list: stored wins, even empty (ADR-209) ───────────────
//
// The env pair (LEDGR_SYNC_HUBS + one LEDGR_SYNC_TOKEN) is only the initial
// value; the Network page edits a job_state list carrying a token PER hub.
// An empty STORED list means "the owner removed every hub", never "fall back
// to config" — otherwise removing the last hub would silently resurrect it.
{
  const stored = [{ url: "https://a.example", token: "ta" }];
  check(
    "a stored hub list wins over env",
    JSON.stringify(effectiveHubs(stored, "https://env.example", "tenv")) ===
      // The ADR-210 axes are filled in on read, so the stored entry comes back
      // normalized rather than byte-identical.
      JSON.stringify([
        { url: "https://a.example", token: "ta", cadence: CADENCE_CONTINUOUS, fallback: "automatic", onChange: false },
      ])
  );
  check(
    "an EMPTY stored list means no hubs, not env fallback",
    effectiveHubs([], "https://env.example", "tenv").length === 0
  );
  check(
    "no stored list falls back to env, same token on each",
    JSON.stringify(effectiveHubs(undefined, "https://a.example, https://b.example", "t1")) ===
      JSON.stringify([
        { url: "https://a.example", token: "t1", cadence: CADENCE_CONTINUOUS, fallback: "automatic", onChange: false },
        { url: "https://b.example", token: "t1", cadence: CADENCE_CONTINUOUS, fallback: "automatic", onChange: false },
      ])
  );
  check("env hubs without a token arm nothing", effectiveHubs(undefined, "https://a.example", undefined).length === 0);
  check(
    "malformed stored entries are dropped, not obeyed",
    effectiveHubs([{ url: "https://a.example" }, { token: "x" }, null, "junk"], undefined, undefined).length === 0
  );
}

// ── The loop's status must live on globalThis, not in module scope ──────────
//
// The bug this guards (2026-08-22, first real spoke): /api/sync/status and
// /build/updates reported "Offline, never synced" while the database proved
// the peer was pulling. Next emits the instrumentation hook and the route
// handlers as separate server chunks, each carrying its own copy of
// src/lib/sync/client.ts, so the loop mutated one module instance's status
// object and every reader read another's, permanently at its defaults.
// A second instance can only see the loop's writes if the state lives
// somewhere both instances reach.
{
  const holder = (globalThis as { __ledgrSync?: { status: SyncStatus } }).__ledgrSync;
  check("the loop's status is held on globalThis, reachable from a second module instance", !!holder);
  if (holder) {
    // Mutating the holder is what the loop does; getSyncStatus is what a
    // route handler in the other chunk calls. They have to be the same object.
    const stamp = "2026-08-22T00:00:00.000Z";
    holder.status.lastSyncAt = stamp;
    check("getSyncStatus reads that same object, not a module-private copy", getSyncStatus().lastSyncAt === stamp);
    holder.status.lastSyncAt = null;
  }
  // getSyncStatus still hands out a COPY, so a reader cannot write the loop's
  // state by accident.
  check("getSyncStatus still returns a copy", getSyncStatus() !== getSyncStatus());
}

// ─────────────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} FAILURE${failures === 1 ? "" : "S"}`);
  process.exit(1);
}
// ── "Not due yet" is not "unreachable" (2026-08-25) ──────────────────────────
//
// A hub on the daily cadence is skipped before any attempt for 23h59m of every
// day. That used to read as "Offline (no hub reachable)" beside a green hub row
// saying "synced 5 minutes ago" — two conclusions from one healthy round, one of
// them false. These pin the four cases apart.
{
  const base = { holdReason: null, pendingOps: 0 };
  check(
    "a readable hub answered: synced",
    resolveSyncState({ ...base, readHealthy: true, readAttempted: true, everSynced: true }) ===
      "synced"
  );
  check(
    "asked and did not answer: offline",
    resolveSyncState({ ...base, readHealthy: false, readAttempted: true, everSynced: true }) ===
      "offline"
  );
  check(
    "nothing was DUE, and we have synced before: NOT offline",
    resolveSyncState({ ...base, readHealthy: false, readAttempted: false, everSynced: true }) ===
      "synced"
  );
  check(
    "never synced at all: offline, even with nothing due",
    resolveSyncState({ ...base, readHealthy: false, readAttempted: false, everSynced: false }) ===
      "offline"
  );
  check(
    "an idle round still reports work waiting rather than hiding it",
    resolveSyncState({
      holdReason: null,
      pendingOps: 4,
      readHealthy: false,
      readAttempted: false,
      everSynced: true,
    }) === "pending"
  );
  check(
    "a hold outranks both, idle or not",
    resolveSyncState({
      holdReason: "first_push_size",
      pendingOps: 9,
      readHealthy: true,
      readAttempted: true,
      everSynced: true,
    }) === "held"
  );
}

// -- Push batch byte cap (the HTTP 413 that stalled Brandon's hub, 2026-08-29) --

{
  // A 500-op batch of item bodies weighed 4.2 MB and every push came back
  // "413 Payload Too Large" forever, because the batch was capped by COUNT
  // only. `at` is what marks one local transaction, and a batch must never
  // split one.
  const op = (seq: number, at: string, size: number) =>
    ({
      seq,
      deviceId: "d",
      originDeviceId: null,
      ownerId: "o",
      at,
      tbl: "items",
      rowId: "r" + seq,
      kind: "update",
      changed: { body: "x".repeat(size) },
      schemaVer: "1",
    }) as unknown as Parameters<typeof trimBatchToBytes>[0][number];

  const heavy = [1, 2, 3, 4].map((i) => op(i, `t${i}`, 1000));
  check("a batch under the budget goes whole", trimBatchToBytes(heavy, 1_000_000).length === 4);
  check(
    "a batch over the budget is cut down",
    trimBatchToBytes(heavy, 2500).length === 2,
    `got ${trimBatchToBytes(heavy, 2500).length}`
  );

  // Three ops sharing one `at` are one transaction: the cut lands before them
  // or after them, never inside.
  const run = [op(1, "t1", 500), op(2, "t2", 900), op(3, "t2", 900), op(4, "t2", 900)];
  const cut = trimBatchToBytes(run, 1600);
  check("a same-at run is never split", cut.length === 1, `got ${cut.length}`);

  // The queue must always move. One op bigger than the whole budget still
  // ships rather than returning an empty batch and stalling forever.
  check(
    "an over-budget first run still ships",
    trimBatchToBytes([op(1, "t1", 5000), op(2, "t2", 10)], 100).length === 1
  );
  check("an empty batch stays empty", trimBatchToBytes([], 100).length === 0);
}

// -- The first-push gate is spent by an ACCEPTED push, never an attempted one --

{
  // Brandon clicked "Send anyway", every exchange then failed with HTTP 413,
  // and his one-shot permission was gone by the next restart with not one op
  // landed. pushSelectionForHub commits `firstPushDone` optimistically, so
  // exchangeWith must hold that commit until the hub has answered OK. Ordering
  // inside a network call has no pure seam, so this pins the source shape.
  const src = readFileSync("src/lib/sync/client.ts", "utf8");
  const restore = src.indexOf("rt.firstPushDone = priorFirstPushDone");
  const refused = src.indexOf("sync exchange failed: HTTP");
  const commit = src.indexOf("rt.firstPushDone = firstPushDoneAfter");
  check("the optimistic commit is rolled back before the request", restore > 0);
  check(
    "the gate is spent only after the refusal check has passed",
    refused > restore && commit > refused,
    `restore=${restore} refused=${refused} commit=${commit}`
  );
}

console.log("\nAll sync-ui checks passed.");
