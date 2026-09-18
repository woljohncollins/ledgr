// The update policy, as the app reads and writes it.
//
// WHERE IT LIVES AND WHY: <supervisorDir>/update-policy.json, a file, not a
// job_state row. Snapshots and the sync mode keep their owner override in the
// database because only the app reads them. This one has two more readers with
// no database and no login: the local service itself (which polls for updates
// and must work when the app is down) and the tray icon's Settings tab (which
// exists so the owner can act while sitting at the machine, signed into
// nothing). A JSON file next to the other signal files is the one home all
// three can reach. Per-machine by nature, so it never syncs.
//
// supervisor/config.json's `update` and `branch` keys are only the INSTALL-TIME
// SEED: the service writes this file from them when it is missing, then re-reads
// the file every minute. The twin parser is parseUpdatePolicy in
// supervisor/lib.mjs; scripts/verify-update-policy.mts feeds one's output to
// the other so they cannot drift.

export type UpdatePolicy = {
  /** "auto": the service checks origin/<branch> on its own. "manual": only Update now. */
  mode: "auto" | "manual";
  everyMinutes: number;
  branch: string;
  /** Git remote URL for origin, or "" to leave the current remote alone. */
  repo: string;
  updatedAt: string | null;
};

export const POLICY_FILE = "update-policy.json";
export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 1440;

/** Tolerant parse, mirroring lib.mjs. Null when the text is not a policy. */
export function parseUpdatePolicy(text: string): UpdatePolicy | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const mode =
    o.mode === "auto" ? "auto" : o.mode === "manual" || o.mode === "prompted" ? "manual" : null;
  if (!mode) return null;
  const every = Number(o.everyMinutes);
  return {
    mode,
    everyMinutes: Number.isFinite(every) && every >= 1 ? Math.round(every) : 15,
    branch: typeof o.branch === "string" && o.branch.trim() ? o.branch.trim() : "main",
    repo: typeof o.repo === "string" ? o.repo.trim() : "",
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
  };
}

/** Validate a form submission. Returns the clean policy or the one sentence wrong with it. */
export function validatePolicyInput(
  body: unknown
): { ok: true; policy: Omit<UpdatePolicy, "updatedAt"> } | { ok: false; error: string } {
  const o = (body ?? {}) as Record<string, unknown>;
  if (o.mode !== "auto" && o.mode !== "manual") {
    return { ok: false, error: 'mode must be "auto" or "manual"' };
  }
  const every = Number(o.everyMinutes);
  if (!Number.isInteger(every) || every < MIN_EVERY_MINUTES || every > MAX_EVERY_MINUTES) {
    return { ok: false, error: `everyMinutes must be a whole number from ${MIN_EVERY_MINUTES} to ${MAX_EVERY_MINUTES}` };
  }
  const branch = typeof o.branch === "string" ? o.branch.trim() : "";
  if (!branch || /\s/.test(branch) || branch.includes("..")) {
    return { ok: false, error: "branch must be a single git branch name" };
  }
  const repo = typeof o.repo === "string" ? o.repo.trim() : "";
  if (repo && !/^(https?:\/\/|git@|ssh:\/\/)/.test(repo)) {
    return { ok: false, error: "repo must be a git URL (https://… or git@…), or empty" };
  }
  return { ok: true, policy: { mode: o.mode, everyMinutes: every, branch, repo } };
}

export function serializeUpdatePolicy(p: Omit<UpdatePolicy, "updatedAt"> & { updatedAt?: string | null }): string {
  return (
    JSON.stringify(
      {
        mode: p.mode,
        everyMinutes: p.everyMinutes,
        branch: p.branch,
        repo: p.repo,
        updatedAt: p.updatedAt ?? new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

/** owner/repo for a github.com remote URL, else null. */
export function githubSlugOf(repoUrl: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Synchronous read, for getInstanceIdentity (assembled in sync code paths).
 * Uses a lazy require so this module stays importable where node:fs is not,
 * and so src/lib/updates.ts keeps its static-import-only posture.
 */
export function readUpdatePolicySync(dir: string | null): UpdatePolicy | null {
  if (!dir) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("node:path") as typeof import("node:path");
    return parseUpdatePolicy(readFileSync(join(dir, POLICY_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Read the policy the service is following. Null when none is written yet or there is no service. */
export async function readUpdatePolicy(dir: string | null): Promise<UpdatePolicy | null> {
  if (!dir) return null;
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    return parseUpdatePolicy(await readFile(join(dir, POLICY_FILE), "utf8"));
  } catch {
    return null;
  }
}

export async function writeUpdatePolicy(
  dir: string,
  policy: Omit<UpdatePolicy, "updatedAt">
): Promise<UpdatePolicy> {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const updatedAt = new Date().toISOString();
  await writeFile(join(dir, POLICY_FILE), serializeUpdatePolicy({ ...policy, updatedAt }), "utf8");
  return { ...policy, updatedAt };
}
