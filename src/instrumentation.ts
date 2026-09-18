// Next.js instrumentation hook: runs once per server process start. The only
// job here is arming the sync loop on local peers (plan decision 11 — the
// loop lives in the app process, no second daemon). Guarded twice: nodejs
// runtime only (never edge/build), and only when LEDGR_SYNC_HUBS names hubs
// OR this is a supervisor-managed peer (LEDGR_SUPERVISOR_DIR) whose hub list
// may live in job_state instead (GUI-added, ADR-209). Cloud deploys set
// neither, so the cloud hub and any instance not opted into sync start
// nothing.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.LEDGR_SYNC_HUBS && !process.env.LEDGR_SUPERVISOR_DIR) return;
  const { startSyncLoop } = await import("@/lib/sync/client");
  startSyncLoop();
}
