// Verification for the answer-first sentence at the top of Build → Network.
//
// PURE by construction: `summarizeSync` takes the status the page already read
// and returns text, so every state the owner can land in is exercised here with
// no hub, no peer and no loop.
//
// The point of the suite is not that the strings match; it is that the SENTENCE
// TELLS THE TRUTH in each state. Two failures matter most, both of which the old
// status grid actually committed:
//
//   - calling a copy that is merely NOT DUE YET "offline" (observed on the daily
//     cadence hub, and the reason the state row is corrected in the page too)
//   - saying "synced" while something needs the owner's attention
//
// Run: npx tsx scripts/verify-sync-summary.mts
import assert from "node:assert/strict";
import { agoPhrase, hubName, summarizeSync } from "@/lib/sync/summary";
import { CADENCE_CONTINUOUS, CADENCE_DAILY_MINUTES } from "@/lib/sync/client";
import type { FullSyncStatus, HubStatus, SyncStatus } from "@/lib/sync/client";

let checks = 0;
function ok(what: string, fn: () => void) {
  fn();
  checks += 1;
  console.log(`  ✓ ${what}`);
}

const NOW = new Date("2026-08-25T12:00:00Z");
const MIN = 60_000;
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function hub(over: Partial<HubStatus> = {}): HubStatus {
  return {
    url: "https://study-pc.example.com",
    cadence: CADENCE_CONTINUOUS,
    fallback: "automatic",
    onChange: false,
    lastSyncAt: ago(2 * MIN),
    lastError: null,
    nextDueAt: null,
    pulling: true,
    holdReason: null,
    heldOpsCount: null,
    skewMs: null,
    behindOps: 0,
    ...over,
  };
}

function status(over: Partial<SyncStatus> = {}): FullSyncStatus {
  const base: SyncStatus = {
    state: "synced",
    pendingOps: 0,
    activeHubIndex: 0,
    lastSyncAt: ago(2 * MIN),
    lastError: null,
    holdReason: null,
    heldOpsCount: null,
    skewMs: null,
    skewWarn: false,
    hubs: [hub()],
    fallbackPrompt: null,
    fallbackApproval: null,
    ...over,
  };
  return { enabled: true, hubCount: base.hubs.length, mode: "full", ...base };
}

const sum = (sync: FullSyncStatus, extra = {}) => summarizeSync({ sync, now: NOW, ...extra });

console.log("The answer-first sync sentence\n");

// ── Shape rules that hold in EVERY state ────────────────────────────────────

ok("every state produces a real sentence, never a status code", () => {
  const states: FullSyncStatus[] = [
    { enabled: false },
    status(),
    status({ state: "pending", pendingOps: 4 }),
    status({ state: "held", holdReason: "first_push_size", heldOpsCount: 900 }),
    status({ state: "held", holdReason: "clock_skew", skewMs: 90_000 }),
    status({ state: "offline", hubs: [hub({ lastError: "ECONNREFUSED" })] }),
    status({ state: "offline", hubs: [hub({ nextDueAt: ago(-MIN * 600) })] }),
    status({
      hubs: [hub(), hub({ url: "https://two.example.com", lastError: "timeout" })],
    }),
    status({
      fallbackPrompt: {
        url: "https://backup.example.com",
        cadence: CADENCE_DAILY_MINUTES,
        automaticErrors: [{ url: "https://study-pc.example.com", error: "timeout" }],
        failingForMs: 20 * MIN,
        lastSyncAt: ago(60 * MIN),
        behindOps: 3,
      },
    }),
    status({
      fallbackApproval: {
        url: "https://backup.example.com",
        promoteCadence: false,
        approvedAt: ago(5 * MIN),
      },
    }),
  ];
  for (const s of states) {
    const r = sum(s);
    assert.ok(r.headline.length > 10, `too short: "${r.headline}"`);
    assert.ok(/[.!]$/.test(r.headline), `not a sentence: "${r.headline}"`);
    assert.ok(r.headline[0] === r.headline[0].toUpperCase(), `not capitalised: "${r.headline}"`);
    if (r.detail) assert.ok(/[.!]$/.test(r.detail), `detail is not a sentence: "${r.detail}"`);
    assert.ok(["ok", "warn", "bad", "info"].includes(r.tone));
  }
});

ok("no state explains itself in engineering vocabulary", () => {
  // The whole reason this function exists: the page used to answer in the
  // system's words. Any of these appearing means the sentence regressed.
  const banned =
    /\bops?\b|oplog|cursor|\bseq\b|\bhub\b|\bspoke\b|cadence|fallback trust|retention|pull-only|\bLWW\b|\bpush\b|prunedThrough/i;
  const states = [
    { enabled: false } as FullSyncStatus,
    status(),
    status({ state: "pending", pendingOps: 4 }),
    status({ state: "held", holdReason: "first_push_size", heldOpsCount: 900 }),
    status({ state: "held", holdReason: "clock_skew", skewMs: 90_000 }),
    status({ state: "offline", hubs: [hub({ lastError: "boom" })] }),
  ];
  for (const s of states) {
    const r = sum(s);
    for (const [field, text] of Object.entries({
      headline: r.headline,
      detail: r.detail,
      action: r.action?.label ?? "",
    })) {
      assert.ok(!banned.test(text), `${field} uses engineering vocabulary: "${text}"`);
    }
  }
});

ok("a warning or worse always offers exactly one action", () => {
  // A sentence that says something is wrong and stops there makes the reader
  // hunt. Except the two states where there is genuinely nothing to do.
  const needsAction = [
    status({ state: "held", holdReason: "first_push_size", heldOpsCount: 900 }),
    status({ state: "held", holdReason: "clock_skew", skewMs: 90_000 }),
    status({ state: "offline", hubs: [hub({ lastError: "boom" })] }),
    status({ hubs: [hub(), hub({ url: "https://two.example.com", lastError: "x" })] }),
  ];
  for (const s of needsAction) {
    const r = sum(s);
    assert.ok(r.action, `no action offered for "${r.headline}"`);
    assert.ok(r.action.href, `action has nowhere to go: "${r.action.label}"`);
  }
});

// ── The two failures that actually happened ─────────────────────────────────

ok("a copy that is merely NOT DUE is not called unreachable", () => {
  // The observed bug: with a once-a-day copy, the engine's blended state reads
  // "offline" for the 23 hours nothing is due, while the row beside it says
  // "synced 5 minutes ago". Nothing is unreachable; nothing was due.
  const r = sum(status({ state: "offline", hubs: [hub({ nextDueAt: ago(-20 * 60 * MIN) })] }));
  assert.equal(r.tone, "ok", `called a not-due copy a problem: "${r.headline}"`);
  assert.ok(!/answer/i.test(r.headline), `"${r.headline}"`);
  assert.match(r.detail, /due/i);
});

ok("an attempted-and-failed copy IS called unreachable, and named", () => {
  const r = sum(status({ state: "offline", hubs: [hub({ lastError: "ECONNREFUSED" })] }));
  assert.equal(r.tone, "bad");
  assert.match(r.headline, /study-pc.example.com/, "did not name the copy that is down");
  assert.match(r.detail, /safe/i, "did not reassure about the local data");
});

ok("normal never means normal while something needs a look", () => {
  const stale = sum(status(), { jobWarnings: ["Offline backup last ran 9 days ago on PC."] });
  assert.equal(stale.tone, "warn");
  assert.match(stale.detail, /9 days/);
  assert.equal(stale.action?.href, "/build/jobs#scheduled-work");

  const device = sum(status(), { devicesNeedingAttention: 2 });
  assert.equal(device.tone, "warn");
  assert.match(device.detail, /2 devices/);
});

// ── Ordering: the reader meets what needs them first ────────────────────────

ok("a pending decision outranks everything else", () => {
  const r = sum(
    status({
      state: "held",
      holdReason: "first_push_size",
      heldOpsCount: 900,
      fallbackPrompt: {
        url: "https://backup.example.com",
        cadence: CADENCE_DAILY_MINUTES,
        automaticErrors: [],
        failingForMs: 20 * MIN,
        lastSyncAt: null,
        behindOps: null,
      },
    }),
    { jobWarnings: ["something"], devicesNeedingAttention: 3 }
  );
  assert.match(r.headline, /decide/i);
  assert.equal(r.action?.href, "#decision");
});

ok("a clock too far out is the worst ordinary state", () => {
  // It is the one where syncing is silently one-directional, so it reads red
  // rather than amber.
  const r = sum(status({ state: "held", holdReason: "clock_skew", skewMs: 120_000 }));
  assert.equal(r.tone, "bad");
  assert.match(r.headline, /clock/i);
});

// ── Not syncing is not a fault ──────────────────────────────────────────────

ok("a single-device install is told what that means, not warned about it", () => {
  const r = sum({ enabled: false });
  assert.equal(r.tone, "info");
  assert.match(r.detail, /stays here/i);
  assert.ok(r.action, "no way offered to add a second copy");
});

// THE BUG THIS PAIR EXISTS FOR: the cloud copy sends its changes nowhere, so
// `enabled` was false and the page announced "this device is not syncing with
// anything" while a local peer pushed into it every ten seconds. Sync has two
// directions; a headline that reads only the outbound one calls the busiest
// node on the network an island.
ok("a copy that only RECEIVES is not called an island", () => {
  const r = sum({ enabled: false }, { inboundDevices: 2 });
  assert.equal(r.tone, "ok");
  assert.match(r.headline, /2 devices send changes here/i);
  assert.doesNotMatch(`${r.headline} ${r.detail}`, /not syncing with anything|stays here/i);
  assert.equal(r.action?.href, "#devices");
});

ok("one inbound device is singular, and zero still reads as alone", () => {
  assert.match(sum({ enabled: false }, { inboundDevices: 1 }).headline, /1 device sends/i);
  assert.match(sum({ enabled: false }, { inboundDevices: 0 }).detail, /stays here/i);
});

ok("a copy in the middle reports both directions at once", () => {
  const r = sum(status(), { inboundDevices: 3 });
  assert.match(r.detail, /reached your other devices/i);
  assert.match(r.detail, /3 devices also send changes here/i);
});

ok("a receive-only device says so instead of claiming it sent anything", () => {
  const receiveOnly = status();
  assert.ok(receiveOnly.enabled, "fixture is not an enabled status");
  const r = summarizeSync({ sync: { ...receiveOnly, mode: "pull-only" }, now: NOW });
  assert.match(r.detail, /only receives/i);
});

// ── The helpers ─────────────────────────────────────────────────────────────

ok("agoPhrase reads like a person, at every scale", () => {
  assert.equal(agoPhrase(null, NOW), "not yet");
  assert.equal(agoPhrase("nonsense", NOW), "not yet");
  assert.equal(agoPhrase(ago(10_000), NOW), "moments ago");
  assert.equal(agoPhrase(ago(MIN), NOW), "a minute ago");
  assert.equal(agoPhrase(ago(5 * MIN), NOW), "5 minutes ago");
  assert.equal(agoPhrase(ago(60 * MIN), NOW), "an hour ago");
  assert.equal(agoPhrase(ago(5 * 60 * MIN), NOW), "5 hours ago");
  assert.equal(agoPhrase(ago(24 * 60 * MIN), NOW), "yesterday");
  assert.equal(agoPhrase(ago(4 * 24 * 60 * MIN), NOW), "4 days ago");
});

ok("hubName never puts a URL in the middle of a sentence", () => {
  assert.equal(hubName("https://study-pc.example.com:3000/x"), "study-pc.example.com");
  assert.equal(hubName("not a url"), "not a url");
});

console.log(`\n${checks} checks passed.`);
