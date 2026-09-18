// The roster's decisions: pure arithmetic and wording, no database.
//
// Split from installs.ts so `scripts/verify-installs.mts` can exercise all of it
// in CI, the same posture as snapshots-plan.ts and job-owners.ts.

/** One copy of Ledgr, as any other copy sees it. */
export type Install = {
  /** The install's own sync_device id. */
  id: string;
  label: string;
  kind: "cloud" | "local";
  appVersion: string | null;
  lastSeenAt: string | null;
  /** True for the copy rendering this. */
  isSelf: boolean;
};

/**
 * How long a copy may go unheard-from before the surfaces call it out.
 *
 * Every copy announces itself daily (from the purge job, which runs on every
 * instance by design), so three days is "something is wrong" rather than "it is
 * not due yet". Same threshold as job ownership, deliberately: an owner should
 * not have to hold two different ideas of "gone quiet".
 */
export const INSTALL_STALE_DAYS = 3;

export type InstallHealth = "here" | "quiet" | "gone" | "never";

export function installHealth(install: Install, now: Date): InstallHealth {
  if (install.isSelf) return "here";
  if (!install.lastSeenAt) return "never";
  const seen = Date.parse(install.lastSeenAt);
  if (!Number.isFinite(seen)) return "never";
  const days = (now.getTime() - seen) / 86_400_000;
  if (days < INSTALL_STALE_DAYS) return "here";
  return days < 30 ? "quiet" : "gone";
}

/** The health of a copy, in the words a person would use. */
export function installHealthLine(install: Install, now: Date): string {
  switch (installHealth(install, now)) {
    case "here":
      return install.isSelf ? "This is the copy you are looking at" : "Running normally";
    case "quiet":
      return "Has not been heard from in a few days";
    case "gone":
      return "Has not been heard from in over a month";
    default:
      return "Has never checked in";
  }
}

/**
 * Copies whose build differs from this one's.
 *
 * Deliberately not "behind": this copy cannot tell which build is newer without
 * a commit graph it does not have. "Different" is what it actually knows, and
 * saying more than it knows is the failure this project keeps catching.
 */
export function installsOnAnotherBuild(installs: Install[]): Install[] {
  const self = installs.find((i) => i.isSelf);
  if (!self?.appVersion) return [];
  return installs.filter((i) => !i.isSelf && i.appVersion && i.appVersion !== self.appVersion);
}

/**
 * Labels claimed by more than one copy.
 *
 * The collision guard. The setup wizard asks for a name rather than silently
 * taking the hostname, precisely so two machines do not answer to one word, and
 * the label is editable afterwards. But nothing can PREVENT it across installs
 * that have never met, so it is detected and shown instead.
 */
export function duplicateLabels(installs: Install[]): string[] {
  // Compared case- and space-insensitively, but REPORTED as the owner typed it:
  // telling someone two copies are called "cloud" when they named them "Cloud"
  // makes them hunt for a name that is not on screen.
  const seen = new Map<string, { label: string; n: number }>();
  for (const i of installs) {
    const key = i.label.trim().toLowerCase();
    const hit = seen.get(key);
    if (hit) hit.n += 1;
    else seen.set(key, { label: i.label.trim(), n: 1 });
  }
  return [...seen.values()].filter((v) => v.n > 1).map((v) => v.label);
}

/** A machine name that cannot be mistaken for a missing one. */
export function normalizeLabel(raw: unknown, fallback = "This machine"): string {
  const s = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return s ? s.slice(0, 60) : fallback;
}

/** What is wrong with a name the owner typed, or null when it is fine. */
export function labelProblem(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "Give this machine a name.";
  if (s.length > 60) return "That name is too long (60 characters at most).";
  return null;
}
