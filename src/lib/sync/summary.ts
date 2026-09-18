// The one sentence at the top of Build → Network.
//
// WHY THIS EXISTS. The page grew correctly and got dense: ADR-209 put sync
// here, ADR-210 added per-hub cadence and fallback trust, ADR-212 added the
// addresses, ADR-213 added retention. Every part earned its place, and the
// result answers the system's questions. But the owner's questions are simpler
// than the system's: *is my stuff safe, is everything talking, and what do I do
// if not?* A status grid makes the reader assemble that answer from parts. This
// assembles it for them, and it is deliberately ONE sentence plus, when
// something is wrong, ONE action.
//
// The existing pill and dot grammar stays exactly as it is. It becomes
// decoration on the sentence rather than the message itself.
//
// Pure on purpose (exploration `sync-node-maturity.md` §2): the page passes in
// what it already read, so every state can be exercised in CI without a hub, a
// peer or a loop.
import type { FullSyncStatus, SyncStatus } from "@/lib/sync/client";

/** Same three-way tone the page's StatusDot already speaks. */
export type SummaryTone = "ok" | "warn" | "bad" | "info";

export type SyncSummary = {
  tone: SummaryTone;
  /** The answer, in one sentence. Never a fragment, never a status code. */
  headline: string;
  /** At most one more sentence of context. Empty string when none is needed. */
  detail: string;
  /**
   * The single thing to do about it, when there is one. `href` points at the
   * section of this page that carries the control, so the sentence and the fix
   * are never in two different places.
   */
  action: { label: string; href?: string } | null;
};

/** Rounded, human. "2 minutes ago", "yesterday", never "1756132800000". */
export function agoPhrase(iso: string | null, now: Date): string {
  if (!iso) return "not yet";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "not yet";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "moments ago";
  if (mins === 1) return "a minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours === 1) return "an hour ago";
  // 24h is "yesterday", not "24 hours ago": this is a point in the past, not a
  // duration, and a person crossing a day boundary says the day.
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Which hubs are actually in trouble, as opposed to merely not due yet.
 *
 * This distinction is the one the old blended state got wrong: a hub on a daily
 * cadence is not "offline" for the 23 hours it is not due. Only a hub that was
 * ATTEMPTED and failed counts against us.
 */
function failingHubs(status: SyncStatus): { url: string; error: string }[] {
  return status.hubs.flatMap((h) => (h.lastError ? [{ url: h.url, error: h.lastError }] : []));
}

/** Bare host, for a sentence. A full URL in prose reads like a config file. */
export function hubName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * The answer, assembled. Ordered worst-first: the reader should meet the thing
 * that needs them before the thing that is fine.
 */
export function summarizeSync(opts: {
  sync: FullSyncStatus;
  now: Date;
  /** Devices syncing FROM here that need attention (ADR-213 warn/lapsed). */
  devicesNeedingAttention?: number;
  /**
   * Live devices that PUSH into this copy — the inbound half.
   *
   * `sync.enabled` only ever measured the outbound half (does this copy send
   * its changes anywhere?), which made a hub read as an island: the cloud copy
   * announced "this device is not syncing with anything" while a local peer was
   * actively pushing into it every ten seconds. Sync has two directions and the
   * headline has to know about both, or the copy that RECEIVES everything is
   * the one that claims to be alone.
   */
  inboundDevices?: number;
  /** Jobs whose owner has gone missing (see src/lib/job-owners.ts). */
  jobWarnings?: string[];
}): SyncSummary {
  const { sync, now } = opts;
  const inbound = opts.inboundDevices ?? 0;

  // No outbound copies. That is two different situations, and only one of them
  // is "alone": a cloud copy that every other device pushes INTO sends its
  // changes nowhere and is still the busiest node on the network.
  if (!sync.enabled) {
    if (inbound > 0) {
      return {
        tone: "ok",
        headline: `${inbound} ${plural(inbound, "device sends", "devices send")} changes here.`,
        detail:
          "This copy receives from them and sends to nothing, which is what a main copy looks like. Everything written on any of them arrives here.",
        action: { label: "See which", href: "#devices" },
      };
    }
    // Genuinely one machine, no copies. A legitimate, common state and not a
    // fault, so saying "offline" about it would be a lie.
    return {
      tone: "info",
      headline: "This device is not syncing with anything.",
      detail:
        "Everything you write stays here. Add another copy to keep your work in more than one place.",
      action: { label: "Add a copy", href: "#hubs" },
    };
  }

  // 1. A decision is waiting on the owner. Nothing outranks being asked.
  if (sync.fallbackPrompt) {
    const mins = Math.round(sync.fallbackPrompt.failingForMs / 60_000);
    return {
      tone: "warn",
      headline: "Ledgr needs you to decide something.",
      detail: `Nothing has answered for ${mins} ${plural(mins, "minute", "minutes")}. Your changes are safe, but nothing new from your other devices is arriving.`,
      action: { label: "See the decision", href: "#decision" },
    };
  }

  // 2. Running on a backup: working, but not the normal arrangement, and the
  // owner should know without having to notice a dot.
  if (sync.fallbackApproval) {
    return {
      tone: "warn",
      headline: `Working from a backup copy (${hubName(sync.fallbackApproval.url)}).`,
      detail:
        "This clears itself as soon as your usual copy is caught up again. Nothing is lost either way.",
      action: null,
    };
  }

  // 3. A held push. Changes exist here and are deliberately not leaving.
  if (sync.state === "held") {
    if (sync.holdReason === "clock_skew") {
      return {
        tone: "bad",
        headline: "This device's clock is too far out to sync safely.",
        detail:
          "Receiving still works, but nothing is being sent, because Ledgr could not tell which edit is newer. Fix the clock and restart.",
        action: { label: "See the details", href: "#state" },
      };
    }
    const n = sync.heldOpsCount ?? sync.pendingOps;
    return {
      tone: "warn",
      headline: `${n} ${plural(n, "change is", "changes are")} waiting for your go-ahead.`,
      detail:
        "That is more than Ledgr sends without asking, which is the guard against a bad restore looking like thousands of edits.",
      action: { label: "Review and send", href: "#state" },
    };
  }

  // 4. Genuinely unreachable: something was tried and failed.
  const failing = failingHubs(sync);
  if (sync.state === "offline" || failing.length === sync.hubs.length) {
    if (failing.length === 0) {
      // Nothing failed and nothing is due. Saying "offline" here was the exact
      // misreport the sync-state bug produced on the daily-cadence hub.
      return {
        tone: "ok",
        headline: "Everything is in step.",
        detail: `Nothing is due to sync right now. Last exchange ${agoPhrase(sync.lastSyncAt, now)}.`,
        action: null,
      };
    }
    const one = failing.length === 1;
    return {
      tone: "bad",
      // Never sentence-initial: a hostname cannot be capitalised, and
      // "Hub.example.com is not answering" is worse than the wording it fixes.
      headline: one
        ? `Ledgr cannot reach ${hubName(failing[0].url)}.`
        : "None of your other copies are answering.",
      detail:
        "Your work is safe here and will send itself when the connection comes back. If this lasts more than an hour, check the internet on this machine.",
      action: { label: "See what it said", href: "#hubs" },
    };
  }

  // 5. Some copies reachable, some not. Partial is its own answer.
  if (failing.length > 0) {
    return {
      tone: "warn",
      headline: `${failing.length} of your ${sync.hubs.length} copies ${plural(failing.length, "is", "are")} not answering.`,
      detail: `The rest are up to date. Last exchange ${agoPhrase(sync.lastSyncAt, now)}.`,
      action: { label: "See which", href: "#hubs" },
    };
  }

  // 6. Working, with changes still on their way out. Not a problem, but the
  // honest word is "sending", not "synced".
  if (sync.state === "pending" && sync.pendingOps > 0) {
    return {
      tone: "ok",
      headline: `Sending ${sync.pendingOps} ${plural(sync.pendingOps, "change", "changes")} to your other devices.`,
      detail: `Last exchange ${agoPhrase(sync.lastSyncAt, now)}.`,
      action: null,
    };
  }

  // 7. Fine. Say something a person can act on ("my last edit got out") rather
  // than a word that only means something to us.
  const attention = opts.devicesNeedingAttention ?? 0;
  const jobs = opts.jobWarnings ?? [];
  if (jobs.length > 0) {
    return {
      tone: "warn",
      headline: "Syncing normally, but scheduled work needs a look.",
      detail: jobs[0],
      action: { label: "Fix it", href: "/build/jobs#scheduled-work" },
    };
  }
  if (attention > 0) {
    return {
      tone: "warn",
      headline: "Syncing normally, but a device needs a look.",
      detail: `${attention} ${plural(attention, "device has", "devices have")} been away long enough that coming back is about to get harder.`,
      action: { label: "See which", href: "#devices" },
    };
  }
  // Both directions in one sentence when both exist: an owner looking at a copy
  // in the middle of the network should not have to scroll to learn that things
  // arrive here as well as leave.
  const inboundClause = inbound
    ? ` ${inbound} ${plural(inbound, "device also sends", "devices also send")} changes here.`
    : "";
  return {
    tone: "ok",
    headline: "Everything is syncing normally.",
    detail:
      (sync.mode === "pull-only"
        ? `This device only receives; it never sends. Last change arrived ${agoPhrase(sync.lastSyncAt, now)}.`
        : `Your last change reached your other devices ${agoPhrase(sync.lastSyncAt, now)}.`) +
      inboundClause,
    action: null,
  };
}
