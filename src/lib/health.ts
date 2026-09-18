// Health gathering (slice 37): the structured health snapshot the `/health`
// route returns AND the weekly health-check scheduled task evaluates. Extracted
// from the route so there's one source of truth — the self-monitoring job reads
// the same canaries in-process rather than calling its own HTTP endpoint
// (cleaner than the PRD §6.2 "hits /health" phrasing, and it still works when
// routing itself is the problem).
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { hasActiveCredential } from "@/lib/auth/credentials";
import { hasScopedToken } from "@/lib/auth/machine";
import { resolveMcpOwner } from "@/lib/mcp/owner";
import { getCalendarState } from "@/lib/calendar/sync";
import { getEmailState } from "@/lib/email/sync";
import { getExportState } from "@/lib/export/engine";
import { getRelatednessState } from "@/lib/discovery/refresh";
import { checkGraphAuth, type GraphHealth } from "@/lib/graph/client";
import { checkGithub, type GithubHealth } from "@/lib/github/client";
import { getHealthCheckState, type HealthCheckCanary } from "@/lib/health-check";
import { getPushState } from "@/lib/push/notify";
import { gatherSyncStatus, type SyncState } from "@/lib/sync/client";
import { getTodoistState } from "@/lib/todoist/sync";
import { getSchemaStatus, type SchemaStatus } from "@/lib/updates";
import { tasksAdapter, type TasksAdapterId } from "@/lib/tasks/provider";
import { transcriptionAdapter, type TranscriptionAdapterId } from "@/lib/transcription/provider";
import { createLogger, isDebugMode } from "@/lib/log";

export type DatabaseCheck =
  | { ok: true; latencyMs: number }
  | { ok: false; detail: string };

export type ErrorsCheck = {
  last24h: number;
  recent?: { source: string; message: string; at: string }[];
} | null;

export type McpCanary = { configured: boolean; hasToken: boolean; ownerResolves: boolean };

// The hub/spoke sync canary (ADR-206 phase 3). {enabled: false} on any
// instance that isn't a sync spoke (the cloud hub, Tyler's) — cheap, env-only.
export type SyncCanary =
  | { enabled: false }
  | { enabled: true; state: SyncState; pendingOps: number; lastSyncAt: string | null };

export type HealthReport = {
  status: "ok" | "degraded";
  checks: {
    database: DatabaseCheck;
    lastExportAt: string | null;
    lastExportRunAt: string | null;
    lastExportRemaining: number | null;
    lastCalendarSyncAt: string | null;
    lastCalendarRunAt: string | null;
    // The active tasks adapter (ADR-081): "native" (default — Ledgr owns tasks,
    // no sync) or "todoist" (the optional sync). The lastTodoist* fields below
    // are only meaningful when the adapter is "todoist".
    tasksAdapter: TasksAdapterId;
    // The active transcription adapter (ADR-088): "none" (paste-only, the v1a
    // default) or "assemblyai" (audio upload → auto-transcribe enabled).
    transcription: TranscriptionAdapterId;
    lastTodoistSyncAt: string | null;
    lastTodoistRunAt: string | null;
    lastEmailImportAt: string | null;
    lastEmailRunAt: string | null;
    lastAgendaNotifyAt: string | null;
    lastPrepNotifyAt: string | null;
    // Last successful nightly relatedness-cache refresh (Discover, ADR-127).
    lastRelatednessRunAt: string | null;
    mcp: McpCanary;
    graph: GraphHealth;
    github: GithubHealth;
    healthCheck: HealthCheckCanary;
    // Migration currency (the /build/updates schema axis, surfaced here too so
    // a machine check can see a code-ahead-of-database gap).
    schema: SchemaStatus;
    sync: SyncCanary;
    errors: ErrorsCheck;
  };
  timestamp: string;
};

async function checkDatabase(): Promise<DatabaseCheck> {
  const started = Date.now();
  try {
    await getDb().execute(sql`select 1`);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    createLogger("health").error("database check failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      detail:
        isDebugMode() && err instanceof Error ? err.message : "database unreachable",
    };
  }
}

// Captured failures from the last 24h (the no-silent-failures surface,
// rule 9). Counts always; messages only in debug mode.
async function checkErrors(): Promise<ErrorsCheck> {
  try {
    const res = await getDb().execute(sql`
      select source, message, created_at
      from error_log
      where created_at > now() - interval '24 hours'
      order by created_at desc
    `);
    const all = res.rows as { source: string; message: string; created_at: string }[];
    const out: ErrorsCheck = { last24h: all.length };
    if (isDebugMode()) {
      out.recent = all.slice(0, 5).map((r) => ({
        source: r.source,
        message: r.message,
        at: new Date(r.created_at).toISOString(),
      }));
    }
    return out;
  } catch {
    // error_log being unreadable while select 1 works is strange enough to
    // surface as null rather than fail the whole check.
    return null;
  }
}

// One read of every canary. `status` is "degraded" only when the DB is down —
// integrations being unconfigured or stalled must never make the app itself
// look unhealthy (Sunday-proof: the DB is what matters). The weekly health
// check layers its own, stricter alerting on top of this snapshot.
export async function gatherHealth(): Promise<HealthReport> {
  const database = await checkDatabase();

  let lastExportAt: string | null = null;
  let lastExportRunAt: string | null = null;
  let lastExportRemaining: number | null = null;
  let lastCalendarSyncAt: string | null = null;
  let lastCalendarRunAt: string | null = null;
  let lastTodoistSyncAt: string | null = null;
  let lastTodoistRunAt: string | null = null;
  let lastEmailImportAt: string | null = null;
  let lastEmailRunAt: string | null = null;
  let lastAgendaNotifyAt: string | null = null;
  let lastPrepNotifyAt: string | null = null;
  let lastRelatednessRunAt: string | null = null;
  let mcp: McpCanary = { configured: false, hasToken: false, ownerResolves: false };
  let healthCheck: HealthCheckCanary = { lastRunAt: null, lastSuccessAt: null, lastAlertAt: null, alerts: [] };
  let errors: ErrorsCheck = null;
  if (database.ok) {
    try {
      const state = await getExportState();
      lastExportAt = state?.lastSuccessAt ?? null;
      lastExportRunAt = state?.lastRunAt ?? null;
      lastExportRemaining = state?.lastResult?.remaining ?? null;
    } catch {
      // job_state being unreadable while select 1 works is strange enough
      // to surface as nulls rather than fail the whole check.
    }
    try {
      const cal = await getCalendarState();
      lastCalendarSyncAt = cal?.lastSuccessAt ?? null;
      lastCalendarRunAt = cal?.lastRunAt ?? null;
    } catch {
      // same posture as the export state read.
    }
    try {
      const td = await getTodoistState();
      lastTodoistSyncAt = td?.lastSuccessAt ?? null;
      lastTodoistRunAt = td?.lastRunAt ?? null;
    } catch {
      // same posture as the export state read.
    }
    try {
      const em = await getEmailState();
      lastEmailImportAt = em?.lastSuccessAt ?? null;
      lastEmailRunAt = em?.lastRunAt ?? null;
    } catch {
      // same posture as the export state read.
    }
    try {
      const push = await getPushState();
      lastAgendaNotifyAt = push.agenda?.lastSuccessAt ?? null;
      lastPrepNotifyAt = push.prep?.lastSuccessAt ?? null;
    } catch {
      // same posture as the export state read.
    }
    try {
      const rel = await getRelatednessState();
      lastRelatednessRunAt = rel?.lastRunAt ?? null;
    } catch {
      // same posture as the export state read.
    }
    try {
      // Either credential path counts as "a token exists" (ADR-224): the
      // static env entry, or a live minted credential carrying `mcp`.
      const hasToken =
        hasScopedToken("mcp") || (await hasActiveCredential("mcp"));
      const ownerResolves = !!(await resolveMcpOwner());
      mcp = { configured: hasToken && ownerResolves, hasToken, ownerResolves };
    } catch {
      // same posture as the export state read.
    }
    try {
      healthCheck = await getHealthCheckState();
    } catch {
      // same posture as the export state read.
    }
    errors = await checkErrors();
  }

  // App-only Graph token grant (slice 21): a failed grant is the secret-expiry
  // / consent-revocation canary for every unattended Graph job. `{configured:
  // false}` until the registration exists; it never changes overall status,
  // since Graph being down must not make the app itself look unhealthy.
  let graph: GraphHealth = { configured: false };
  try {
    graph = await checkGraphAuth();
  } catch {
    // checkGraphAuth swallows its own errors; this is belt-and-suspenders.
  }

  // GitHub canary (changelog + collab notes): a failed repo read is the
  // token-expiry / wrong-repo signal. Like Graph, it never changes overall
  // status — GitHub being down must not make the app itself look unhealthy.
  let github: GithubHealth = { configured: false };
  try {
    github = await checkGithub();
  } catch {
    // checkGithub swallows its own errors; belt-and-suspenders.
  }

  // Migration currency. getSchemaStatus never throws (it reports "unknown"),
  // and it degrades to "unknown" on its own when the DB is down.
  const schema = await getSchemaStatus();

  // Sync canary: env-only {enabled: false} on non-spokes; two small oplog
  // reads on a spoke. Never changes overall status — sync being behind must
  // not make the app itself look unhealthy (same posture as Graph/GitHub).
  let syncCheck: SyncCanary = { enabled: false };
  try {
    const s = await gatherSyncStatus();
    if (s.enabled) {
      syncCheck = {
        enabled: true,
        state: s.state,
        pendingOps: s.pendingOps,
        lastSyncAt: s.lastSyncAt,
      };
    }
  } catch {
    // same posture as the export state read.
  }

  return {
    status: database.ok ? "ok" : "degraded",
    checks: {
      database,
      lastExportAt,
      lastExportRunAt,
      lastExportRemaining,
      lastCalendarSyncAt,
      lastCalendarRunAt,
      tasksAdapter: tasksAdapter(),
      transcription: transcriptionAdapter(),
      lastTodoistSyncAt,
      lastTodoistRunAt,
      lastEmailImportAt,
      lastEmailRunAt,
      lastAgendaNotifyAt,
      lastPrepNotifyAt,
      lastRelatednessRunAt,
      mcp,
      graph,
      github,
      healthCheck,
      schema,
      sync: syncCheck,
      errors,
    },
    timestamp: new Date().toISOString(),
  };
}
