// "Is this instance current?" — the two independent axes an instance can fall
// behind on, and the one place that answers both.
//
// Ledgr is one codebase deployed as several single-tenant instances. How a given
// instance receives a change depends on where its Vercel project points:
//
//   • A SOURCE instance deploys from the shared repo itself (Brandon's, Tyler's).
//     Code arrives on its own the moment anyone pushes — it is never behind.
//   • A SATELLITE instance deploys from a FORK (Michelle's, Miles's). Code
//     arrives only when that fork is synced with upstream, which is what the
//     Update button on /build/updates does.
//
// SCHEMA is the axis that catches everyone, source instances included: there is
// no migrate-on-deploy (runbook.md §1a), so a push carrying a migration updates
// the code on every instance while each database stays where it was. That is the
// documented failure mode in COLLAB.md — deployed code its schema cannot answer.
// This module detects it from the migration journal bundled with the running
// code versus what the database has actually applied, so it needs no network and
// works on every instance, configured or not.
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { createLogger, isDebugMode } from "@/lib/log";
import { getCodeStatus, type CodeStatus } from "@/lib/github/client";
import { githubSlugOf, readUpdatePolicySync } from "@/lib/update-policy";
import journal from "../../drizzle/meta/_journal.json";

const log = createLogger("updates");

type JournalEntry = { idx: number; when: number; tag: string };

// The journal ships INSIDE the deployed bundle (a static JSON import, not a
// filesystem read), so it always describes the migrations the running code
// expects — which is exactly the comparison worth making.
const ENTRIES: JournalEntry[] = (journal.entries as JournalEntry[]) ?? [];

export type SchemaState = "current" | "pending" | "empty" | "unknown";

export type SchemaStatus = {
  state: SchemaState;
  // Migration tags the running code carries that this database has not applied.
  pending: string[];
  // Total migrations the running code knows about.
  total: number;
  // Only set when state is "unknown" (the check itself failed).
  detail?: string;
};

/**
 * Pure: which journal entries a database hasn't applied yet.
 *
 * Mirrors the migrator's own rule rather than inventing a second one — Drizzle
 * applies every entry whose `when` is newer than the newest applied timestamp,
 * which is why a renumbered migration with an older `when` is silently skipped
 * (the trap COLLAB.md hit during the PJ chunk). `appliedMax` of null means the
 * migrations table doesn't exist at all: a database nothing has ever run.
 *
 * Exported so the verify script can exercise it without a database.
 */
export function pendingMigrations(
  entries: { when: number; tag: string }[],
  appliedMax: number | null
): string[] {
  if (appliedMax === null) return entries.map((e) => e.tag);
  return entries.filter((e) => e.when > appliedMax).map((e) => e.tag);
}

/**
 * Compare the running code's migration journal against this instance's database.
 * Never throws: a failed check reports "unknown" so the page still renders (the
 * health-check posture — a broken canary is not a broken page).
 */
export async function getSchemaStatus(): Promise<SchemaStatus> {
  const total = ENTRIES.length;
  try {
    const db = getDb();
    const reg = await db.execute(
      sql`select to_regclass('drizzle.__drizzle_migrations') as reg`
    );
    const present = (reg.rows[0] as { reg: string | null } | undefined)?.reg;
    if (!present) {
      return { state: "empty", pending: ENTRIES.map((e) => e.tag), total };
    }
    // created_at is a bigint of epoch ms, matching the journal's `when`. Cast to
    // text so it survives the driver without precision loss, then Number() it.
    const res = await db.execute(
      sql`select coalesce(max(created_at), 0)::text as max from drizzle.__drizzle_migrations`
    );
    const appliedMax = Number((res.rows[0] as { max: string } | undefined)?.max ?? 0);
    const pending = pendingMigrations(ENTRIES, appliedMax);
    return { state: pending.length > 0 ? "pending" : "current", pending, total };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("schema status check failed", { message });
    return {
      state: "unknown",
      pending: [],
      total,
      detail: isDebugMode() ? message : "could not read migration state",
    };
  }
}

// ── Instance identity ────────────────────────────────────────────────────────

export type SelfUpdateMode = "off" | "safe" | "on";

export type InstanceIdentity = {
  // The commit this deploy was built from. Null in local dev (no Vercel env).
  sha: string | null;
  shortSha: string | null;
  // owner/repo this Vercel project deploys from — a fork for a satellite.
  deployRepo: string | null;
  // The shared repo every instance ultimately tracks.
  upstreamRepo: string;
  branch: string;
  // True when this deploy builds from a fork rather than the shared repo, which
  // is what makes "pull the latest" a meaningful action here at all.
  isSatellite: boolean;
  // Whether this instance is allowed to update ITSELF from the UI, and how
  // carefully. See LEDGR_SELF_UPDATE in .env.example.
  selfUpdate: SelfUpdateMode;
  vercelEnv: string | null;
  // Set by the local-peer supervisor (LH2, ADR-206): the data dir where an
  // update-requested signal file can be written. Null everywhere else, which
  // is what keeps the local apply path fail-closed.
  supervisorDir: string | null;
  // A supervised local peer (not a Vercel deploy, and a supervisor told the app
  // where its data dir is). Its "am I behind?" is answered against the branch
  // the supervisor follows, whatever repo that is — even the shared one, which
  // used to make the page call a local peer a "source" that updates itself.
  isLocalPeer: boolean;
};


function normalizeMode(raw: string | undefined): SelfUpdateMode {
  if (raw === "on" || raw === "safe") return raw;
  return "off";
}

/**
 * Who am I and where did my code come from? Reads Vercel's system environment
 * variables, so a satellite needs no extra configuration to be identified — the
 * fork it deploys from is already known to the platform running it.
 */
export function getInstanceIdentity(): InstanceIdentity {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.LEDGR_BUILD_SHA || null;
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;
  const vercelEnv = process.env.VERCEL_ENV ?? null;
  const supervisorDir = process.env.LEDGR_SUPERVISOR_DIR || null;
  const isLocalPeer = !vercelEnv && !!supervisorDir;
  // A local peer's repo and branch are whatever its update policy says today
  // (the file the Updates page and the tray edit), not what its env said at
  // start. Env stays as the fallback for a service that has not written one.
  const policy = isLocalPeer ? readUpdatePolicySync(supervisorDir) : null;
  const policyRepo = policy?.repo ? githubSlugOf(policy.repo) : null;
  const deployRepo =
    policyRepo ||
    process.env.LEDGR_UPDATE_REPO ||
    (owner && slug ? `${owner}/${slug}` : null);
  const sharedRepo = process.env.GITHUB_REPO || "strategicli/ledgr";
  // A local peer is compared within the repo it follows; everyone else within
  // the shared one (a synced fork's commits are upstream's own commits).
  const upstreamRepo = isLocalPeer && deployRepo ? deployRepo : sharedRepo;
  const branch = policy?.branch || process.env.GITHUB_BRANCH || "main";
  return {
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    deployRepo,
    upstreamRepo,
    branch,
    isSatellite:
      !!deployRepo && deployRepo.toLowerCase() !== sharedRepo.toLowerCase(),
    selfUpdate: normalizeMode(process.env.LEDGR_SELF_UPDATE),
    vercelEnv,
    supervisorDir,
    isLocalPeer,
  };
}

// ── The combined answer ──────────────────────────────────────────────────────

// HOW an allowed update is applied. "github-merge" is the satellite path
// (merge upstream into the fork, Vercel redeploys); "supervisor-signal" is the
// local-peer path (write <supervisorDir>/update-requested, the supervisor
// pulls/builds/migrates/swaps — the local half of ADR-194). Null whenever
// canApply is false.
export type ApplyStrategy = "github-merge" | "supervisor-signal" | null;

export type UpdateReport = {
  instance: InstanceIdentity;
  code: CodeStatus;
  schema: SchemaStatus;
  // Can the owner press the button right now, and if not, why not? Resolved
  // here so the page and the route can never disagree about it.
  canApply: boolean;
  blockedReason: string | null;
  strategy: ApplyStrategy;
};

/**
 * Decide whether self-update is allowed for the update actually on offer.
 *
 * The rule that matters: code reaching an instance ahead of its schema is the
 * one way this button can leave someone worse off than not pressing it. So in
 * "safe" mode an update carrying migrations is refused and handed back to a
 * builder; in "on" mode it is allowed, because that mode is only correct when
 * the instance migrates during its build (npm run build:satellite).
 */
// A LOCAL PEER (LH2, ADR-206): not a Vercel deploy at all, and a supervisor told
// the app where its signal dir is. Both must hold: a Vercel deploy with a stray
// LEDGR_SUPERVISOR_DIR must never take the signal path, and a local `next start`
// without a supervisor has nothing to signal.
export function isLocalPeerInstance(instance: InstanceIdentity): boolean {
  return !instance.vercelEnv && !!instance.supervisorDir;
}

export function resolveApplicability(
  instance: InstanceIdentity,
  code: CodeStatus
): { canApply: boolean; blockedReason: string | null; strategy: ApplyStrategy } {
  if (code.state !== "behind") {
    return { canApply: false, blockedReason: null, strategy: null };
  }
  // A LOCAL PEER (LH2, ADR-206): not a Vercel deploy at all, and a supervisor
  // told the app where its signal dir is. Both conditions must hold — a Vercel
  // deploy with a stray LEDGR_SUPERVISOR_DIR must never take this path, and a
  // local `next start` without a supervisor has nothing to signal.
  const isLocalPeer = isLocalPeerInstance(instance);
  // Fail CLOSED, on both paths: permission is granted only by a mode we
  // recognize, never by the absence of a mode we refuse. getInstanceIdentity
  // already normalizes an unknown value to "off", but this gate is what stands
  // between an update and someone's working instance, so it does not lean on a
  // caller having normalized anything first.
  const modeAllows = instance.selfUpdate === "safe" || instance.selfUpdate === "on";
  if (isLocalPeer) {
    if (!modeAllows) {
      return {
        canApply: false,
        blockedReason: "Self-update is turned off for this instance.",
        strategy: null,
      };
    }
    // "safe" keeps its meaning here for consistency, though the supervisor's
    // apply path migrates before the swap, so it normally runs with "on".
    if (instance.selfUpdate === "safe" && code.touchesSchema) {
      return {
        canApply: false,
        blockedReason:
          "This update changes the database, so it needs a builder to migrate first.",
        strategy: null,
      };
    }
    return { canApply: true, blockedReason: null, strategy: "supervisor-signal" };
  }
  if (!instance.isSatellite) {
    return {
      canApply: false,
      blockedReason: "This instance deploys from the shared repo, so it updates itself.",
      strategy: null,
    };
  }
  if (!modeAllows) {
    return {
      canApply: false,
      blockedReason: "Self-update is turned off for this instance.",
      strategy: null,
    };
  }
  if (instance.selfUpdate === "safe" && code.touchesSchema) {
    return {
      canApply: false,
      blockedReason:
        "This update changes the database, so it needs a builder to migrate first.",
      strategy: null,
    };
  }
  return { canApply: true, blockedReason: null, strategy: "github-merge" };
}

/** Everything /build/updates and /api/updates render, gathered once. */
export async function getUpdateReport(): Promise<UpdateReport> {
  const instance = getInstanceIdentity();
  const [code, schema] = await Promise.all([
    // A satellite AND a local peer can both be behind upstream; only a Vercel
    // deploy of the upstream repo itself is a "source" that updates on push.
    // (Bug, 2026-09-11: passing isSatellite alone read every hub as a source,
    // so the Update button never rendered on the machine the button was for.)
    getCodeStatus(
      instance.sha,
      instance.upstreamRepo,
      instance.branch,
      instance.isSatellite || isLocalPeerInstance(instance)
    ),
    getSchemaStatus(),
  ]);
  const { canApply, blockedReason, strategy } = resolveApplicability(instance, code);
  return { instance, code, schema, canApply, blockedReason, strategy };
}
