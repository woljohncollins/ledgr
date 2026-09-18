// Ask the OS for free TCP ports, for tests that must bind something.
//
// Why: verify-sync and verify-pg-copy used hardcoded ports (55441/2 and
// 55443/4). When a postmaster leaked from a crashed run still held one, the
// suite did not fail fast — it wedged, because pg_ctl waits on a port that
// will never come up the way it expects (one CI run sat there for 77
// minutes). Hardcoded ports also mean the two suites can never run at the
// same time as each other, or as a second checkout of the repo.
//
// Node's own remedy: bind port 0 and read back what the OS handed out. All N
// sockets are held open simultaneously, so the ports are distinct, and only
// then released.
import { createServer } from "node:net";

/**
 * @param {number} n how many distinct free ports to hand back
 * @returns {Promise<number[]>}
 */
export async function freePorts(n) {
  // ponytail: TOCTOU by design — the ports are released before the caller
  // binds them, so something else could take one in between. That window is
  // microseconds against a fixed port's permanent collision, and the
  // alternative (handing the listening socket to Postgres) is not a thing
  // pg_ctl can accept. If it ever bites, retry the whole allocation.
  const servers = await Promise.all(
    Array.from({ length: n }, () =>
      new Promise((resolve, reject) => {
        const s = createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => resolve(s));
      })
    )
  );
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  return ports;
}
