// Directory removal that survives Windows' asynchronous handle release.
//
// Every caller here removes a directory whose files were open moments ago:
// an embedded-postgres cluster we just stopped, or a build directory the app
// process was serving from until stopApp(). On POSIX that is free — you can
// unlink a file another process still holds. On Windows you cannot, and the
// handles are released asynchronously after the process exits, so a removal
// issued immediately loses a race and throws EPERM (or EBUSY/ENOTEMPTY).
//
// `force: true` does NOT cover this: it only swallows ENOENT. The remedy is
// Node's own maxRetries/retryDelay, which retries with a linear backoff and
// is a no-op on platforms that never hit the error.
//
// Kept in its own module rather than supervisor/lib.mjs, which is documented
// as side-effect free.
import { rmSync } from "node:fs";

// 20 tries with a 100ms linear backoff: ~21s worst case. Measured need, not a
// guess: a stopped postmaster's handles outlived a 2.75s budget on this
// machine, leaving a temp cluster directory behind. Nothing waits on these
// removals (the supervisor starts the new app BEFORE it prunes), so a long
// tail costs patience only in the rare case where something is really stuck.
const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 100;

/** Remove `dir` recursively, retrying past Windows handle-release races. */
export function rmDirRetry(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: MAX_RETRIES, retryDelay: RETRY_DELAY_MS });
}

/**
 * Best-effort variant for teardown paths where a directory left behind is
 * waste, not a failure: an ephemeral temp cluster after every assertion has
 * already run, or an old build that the next prune will retry. Returns the
 * error instead of throwing so the caller can report it without dying.
 */
export function rmDirBestEffort(dir) {
  try {
    rmDirRetry(dir);
    return null;
  } catch (err) {
    return err;
  }
}
