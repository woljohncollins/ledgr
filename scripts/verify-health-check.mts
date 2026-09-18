// Slice 37 verification: the weekly health check (PRD §6.2). The pure alert
// evaluator is proven against synthetic snapshots (the DB/errors/graph/stale-
// cron rules, and the "unconfigured stays quiet" posture); then runHealthCheck
// runs against live Neon under a throwaway owner with a stub sender (no VAPID,
// no network) — injecting reports so the unhealthy/healthy branches are
// deterministic — and gatherHealth is called for real to confirm the shape.
// Run: npx tsx scripts/verify-health-check.mts
// Safe to delete once the slice is closed.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { users, pushSubscriptions, jobState } = await import("../src/db/schema");
const {
  evaluateHealth,
  buildAlertMessage,
  runHealthCheck,
  getHealthCheckState,
  HEALTH_CHECK_JOB_KEY,
  ERROR_WINDOW_DAYS,
} = await import("../src/lib/health-check");
const { gatherHealth } = await import("../src/lib/health");
const { NOTIFICATION_CENTER_ENABLED } = await import("../src/lib/notifications-enabled");
type HealthReport = import("../src/lib/health").HealthReport;
type PushSender = import("../src/lib/push/types").PushSender;
type PushMessage = import("../src/lib/push/types").PushMessage;
type PushSubscriptionRecord = import("../src/lib/push/types").PushSubscriptionRecord;
const { eq } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const NOW = new Date("2026-06-14T12:00:00Z");
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

// A fully-green snapshot: DB up, every configured job fresh, no errors, Graph
// either unconfigured or ok. Tests override one field at a time.
function baseReport(): HealthReport {
  return {
    status: "ok",
    checks: {
      database: { ok: true, latencyMs: 5 },
      lastExportAt: iso(6),
      lastExportRunAt: iso(6),
      lastExportRemaining: 0,
      lastCalendarSyncAt: iso(3),
      lastCalendarRunAt: iso(3),
      tasksAdapter: "native",
      transcription: "none",
      lastTodoistSyncAt: iso(2),
      lastTodoistRunAt: iso(2),
      lastEmailImportAt: iso(1),
      lastEmailRunAt: iso(1),
      lastAgendaNotifyAt: iso(10),
      lastPrepNotifyAt: iso(1),
      lastRelatednessRunAt: iso(20),
      mcp: { configured: true, hasToken: true, ownerResolves: true },
      graph: { configured: true, ok: true },
      github: { configured: true, ok: true, repo: "strategicli/ledgr" },
      healthCheck: { lastRunAt: null, lastSuccessAt: null, lastAlertAt: null, alerts: [] },
      schema: { state: "current", pending: [], total: 60 },
      sync: { enabled: false },
      errors: { last24h: 0 },
    },
    timestamp: NOW.toISOString(),
  };
}

// --- 1. pure evaluator: the green case ------------------------------------
check("a fully-green report yields zero alerts", evaluateHealth(baseReport(), 0, NOW).length === 0);

// --- 2. DB down is critical ------------------------------------------------
{
  const r = baseReport();
  r.checks.database = { ok: false, detail: "database unreachable" };
  const a = evaluateHealth(r, 0, NOW);
  check("DB down produces a critical 'database' alert", a.length === 1 && a[0].code === "database" && a[0].severity === "critical");
}

// --- 3. captured errors over the window -----------------------------------
{
  const a = evaluateHealth(baseReport(), 3, NOW);
  check("recent errors produce a warn 'errors' alert", a.length === 1 && a[0].code === "errors" && a[0].severity === "warn");
  check("error alert names the window in days", a[0].message.includes(`${ERROR_WINDOW_DAYS} days`) && a[0].message.startsWith("3 errors"), a[0].message);
  const one = evaluateHealth(baseReport(), 1, NOW);
  check("error alert singularizes at count 1", one[0].message.startsWith("1 error captured"), one[0].message);
}

// --- 4. Graph token: configured+failing alerts; unconfigured stays quiet --
{
  const r = baseReport();
  r.checks.graph = { configured: true, ok: false, detail: "invalid_client" };
  check("a configured+failing Graph grant alerts", evaluateHealth(r, 0, NOW).some((x) => x.code === "graph"));
  const r2 = baseReport();
  r2.checks.graph = { configured: false };
  check("an unconfigured Graph registration is silent (Brandon-step, not a fault)", !evaluateHealth(r2, 0, NOW).some((x) => x.code === "graph"));
}

// --- 5. stalled vs never-ran vs fresh integrations ------------------------
{
  // Calendar ran before but its last clean success is 40h old (budget 36h).
  const stale = baseReport();
  stale.checks.lastCalendarSyncAt = iso(40);
  stale.checks.lastCalendarRunAt = iso(1); // still attempting, but failing partway
  check("a stalled-but-attempting calendar sync alerts", evaluateHealth(stale, 0, NOW).some((x) => x.code === "calendar"));

  // Never configured: both canaries null -> no alert.
  const never = baseReport();
  never.checks.lastCalendarSyncAt = null;
  never.checks.lastCalendarRunAt = null;
  check("a never-run (unconfigured) integration stays quiet", !evaluateHealth(never, 0, NOW).some((x) => x.code === "calendar"));

  // Ran recently and cleanly -> no alert.
  check("a fresh integration does not alert", !evaluateHealth(baseReport(), 0, NOW).some((x) => x.code === "calendar"));

  // Export budget is 48h: 50h stale alerts, 40h does not.
  const expStale = baseReport();
  expStale.checks.lastExportAt = iso(50);
  check("export stale past its 48h budget alerts", evaluateHealth(expStale, 0, NOW).some((x) => x.code === "export"));
  const expFresh = baseReport();
  expFresh.checks.lastExportAt = iso(40);
  check("export within its 48h budget does not alert", !evaluateHealth(expFresh, 0, NOW).some((x) => x.code === "export"));
}

// --- 5b. the Monday false-alarm regression (2026-07-28) -------------------
// Every weekly run from 2026-07-13 to 2026-07-27 pushed calendar+email+agenda
// warnings at Brandon's phone with nothing actually wrong. Cause: commit
// e3bc4c1 (2026-07-11) made both Graph syncs weekday-shaped, and the budgets
// here still encoded the old round-the-clock cadences. This replays the real
// worst-case Monday gaps the live schedules allow; it fails if anyone retimes a
// workflow without retiming its budget.
{
  // Health check runs Mon ~13:00 UTC. Newest possible calendar success is
  // Sun 13:00 UTC (the single weekend pull) = 24h back.
  const mondayCalendar = baseReport();
  mondayCalendar.checks.lastCalendarSyncAt = iso(24);
  mondayCalendar.checks.lastCalendarRunAt = iso(24);
  check(
    "the calendar's worst legal gap (Sun→Mon, 24h) does not alert",
    !evaluateHealth(mondayCalendar, 0, NOW).some((x) => x.code === "calendar")
  );

  // Email runs weekdays only, so the newest possible success on a Monday is
  // Fri 22:00 UTC = 63h back. This is the one that fired with certainty.
  const mondayEmail = baseReport();
  mondayEmail.checks.lastEmailImportAt = iso(63);
  mondayEmail.checks.lastEmailRunAt = iso(63);
  check(
    "the email import's worst legal gap (Fri→Mon, 63h) does not alert",
    !evaluateHealth(mondayEmail, 0, NOW).some((x) => x.code === "email")
  );

  // A genuinely dead weekday sync must still be caught — the fix widened the
  // budgets, it must not have blinded them.
  const reallyDead = baseReport();
  reallyDead.checks.lastEmailImportAt = iso(96);
  reallyDead.checks.lastCalendarSyncAt = iso(96);
  const deadAlerts = evaluateHealth(reallyDead, 0, NOW);
  check(
    "a truly stalled sync (96h) still alerts on both codes",
    deadAlerts.some((x) => x.code === "email") && deadAlerts.some((x) => x.code === "calendar")
  );

  // The paused agenda push (ADR-130) froze lastAgendaNotifyAt on 2026-06-29 and
  // alerted forever after. While the center is paused it must be silent at any
  // age; when re-enabled, the 48h budget applies again.
  const pausedAgenda = baseReport();
  pausedAgenda.checks.lastAgendaNotifyAt = iso(24 * 30);
  check(
    NOTIFICATION_CENTER_ENABLED
      ? "with the notification center live, a stale agenda push alerts"
      : "a paused agenda push (ADR-130) never alerts, however stale",
    evaluateHealth(pausedAgenda, 0, NOW).some((x) => x.code === "agenda") === NOTIFICATION_CENTER_ENABLED
  );
}

// --- 6. severity ordering + message builder -------------------------------
{
  const r = baseReport();
  r.checks.database = { ok: false, detail: "x" };
  const a = evaluateHealth(r, 2, NOW); // database (critical) + errors (warn)
  check("critical alerts sort ahead of warnings", a[0].code === "database" && a[1].code === "errors");
  const msg = buildAlertMessage(a);
  check("a critical alert titles 'Ledgr needs attention'", msg.title === "Ledgr needs attention");
  check("alert message click target is Today", msg.url === "/" && msg.tag === "ledgr-health");
  const warnOnly = buildAlertMessage(evaluateHealth(baseReport(), 1, NOW));
  check("a warn-only alert titles 'Ledgr health check'", warnOnly.title === "Ledgr health check");
  // >3 alerts get a "+N more" suffix.
  const many: import("../src/lib/health-check").HealthAlert[] = [
    { code: "a", severity: "warn", message: "A." },
    { code: "b", severity: "warn", message: "B." },
    { code: "c", severity: "warn", message: "C." },
    { code: "d", severity: "warn", message: "D." },
  ];
  check("more than three alerts collapse with '+N more'", buildAlertMessage(many).body.includes("(+1 more)"), buildAlertMessage(many).body);
}

// --- stub sender -----------------------------------------------------------
class StubSender implements PushSender {
  calls: { endpoint: string; message: PushMessage }[] = [];
  async send(sub: PushSubscriptionRecord, message: PushMessage) {
    this.calls.push({ endpoint: sub.endpoint, message });
    return { ok: true as const, status: 201 };
  }
}

const db = getDb();
const [tempUser] = await db
  .insert(users)
  .values({ email: `verify-health-${Date.now()}@example.invalid` })
  .returning({ id: users.id });
const ownerId = tempUser.id;

try {
  // a live subscription so the unhealthy path has something to deliver to
  await db.insert(pushSubscriptions).values({
    ownerId,
    endpoint: `https://push.example/${ownerId}/H`,
    p256dh: "k",
    auth: "a",
  });

  // --- 7. runHealthCheck: unhealthy injected report delivers + records ----
  const unhealthy = baseReport();
  unhealthy.checks.database = { ok: false, detail: "down" };
  const sender = new StubSender();
  const res1 = await runHealthCheck(ownerId, sender, { now: NOW, report: unhealthy, recentErrorCount: 0 });
  check("unhealthy run returns the critical alert", res1.alerts.some((a) => a.code === "database"));
  check("unhealthy run pushes to the live subscription", sender.calls.length === 1 && sender.calls[0].message.title === "Ledgr needs attention");
  check("unhealthy run reports a delivery tally", res1.delivered?.sent === 1, JSON.stringify(res1.delivered));
  const canary1 = await getHealthCheckState();
  check("canary records lastAlertAt and the alerts", !!canary1.lastAlertAt && canary1.alerts.some((a) => a.code === "database"));
  check("canary leaves lastSuccessAt null on an alerting run", canary1.lastSuccessAt === null);

  // --- 8. runHealthCheck: healthy injected report is silent + green -------
  const senderG = new StubSender();
  const res2 = await runHealthCheck(ownerId, senderG, { now: NOW, report: baseReport(), recentErrorCount: 0 });
  check("healthy run yields no alerts", res2.alerts.length === 0);
  check("healthy run sends no push", senderG.calls.length === 0 && res2.delivered === null);
  const canary2 = await getHealthCheckState();
  check("canary stamps lastSuccessAt and clears alerts on a green run", !!canary2.lastSuccessAt && canary2.alerts.length === 0);
  check("canary retains lastAlertAt from the earlier alerting run", !!canary2.lastAlertAt);

  // --- 9. null sender still evaluates + records (VAPID unset path) ---------
  const res3 = await runHealthCheck(ownerId, null, { now: NOW, report: unhealthy, recentErrorCount: 5 });
  check("a null sender still produces alerts", res3.alerts.length >= 1);
  check("a null sender reports no delivery", res3.delivered === null);
  check("errors injected alongside DB-down both alert", res3.alerts.some((a) => a.code === "database") && res3.alerts.some((a) => a.code === "errors"));

  // --- 10. gatherHealth returns a well-formed live snapshot ---------------
  const live = await gatherHealth();
  check("gatherHealth reports DB ok against live Neon", live.checks.database.ok === true);
  check("gatherHealth carries the new healthCheck canary", !!live.checks.healthCheck && Array.isArray(live.checks.healthCheck.alerts));
  check("gatherHealth status is 'ok' with the DB up", live.status === "ok");
  check("gatherHealth still exposes the prior canaries (mcp/graph)", "mcp" in live.checks && "graph" in live.checks);
} finally {
  await db.delete(jobState).where(eq(jobState.key, HEALTH_CHECK_JOB_KEY));
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.ownerId, ownerId));
  await db.delete(users).where(eq(users.id, ownerId));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
