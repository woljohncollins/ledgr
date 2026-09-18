// Tier-1 guardrail tests against a RUNNING Ledgr instance's /api/machine/sync.
//
// Why local rather than against the production hub: the hub half of sync is the
// same code on every peer, so a local instance proves the same guarantees with
// no production exposure at all. Nothing here touches a remote host.
//
// What it proves, none of which had ever run outside the pure suites:
//   1. a pull_only device's push is refused with 403 BEFORE any op is applied
//   2. the same device's PULL still works while its push is refused
//   3. a schema-version mismatch is refused with 409 carrying both versions
//   4. a revoked device is refused
//   5. a garbage token is refused
//
// It registers its own throwaway devices and deletes them at the end, and the
// op it offers to push is an update to a row it creates and removes itself.
//
// NOTE this file must never contain the literal name of the database
// connection env var — verify-ci.mjs would classify it as backend-needing.
// It IS backend-and-server-needing (hence the -live suffix, like
// verify-updates-live.mts), so it stays a manual step either way.
//
// Point it at a local peer (its own app URL and its own cluster):
//   PEER_URL=http://localhost:3000 PEER_DB=postgresql://postgres:postgres@127.0.0.1:5433/ledgr \
//     npx tsx scripts/verify-sync-guards-live.mts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { latestSchemaVer } from "../src/lib/sync/version";

const PEER_URL = process.env.PEER_URL ?? "http://localhost:3000";
const PEER_DB = process.env.PEER_DB;
if (!PEER_DB) {
  console.error("set PEER_DB to the peer's local connection string");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = new pg.Client({ connectionString: PEER_DB });
await db.connect();

const mint = async (opts: { pullOnly: boolean; revoked?: boolean }) => {
  const token = randomBytes(32).toString("base64url");
  const deviceId = randomUUID();
  await db.query(
    `insert into sync_peers (device_id, name, token_hash, pull_only, revoked)
     values ($1, $2, $3, $4, $5)`,
    [
      deviceId,
      `GUARD TEST ${opts.pullOnly ? "pull-only" : "full"}${opts.revoked ? " revoked" : ""}`,
      createHash("sha256").update(token).digest("hex"),
      opts.pullOnly,
      opts.revoked ?? false,
    ]
  );
  return { token, deviceId };
};

const owner = (await db.query(`select id from users limit 1`)).rows[0].id;
// The endpoint gates on latestSchemaVer(), which reads the BUNDLED drizzle
// journal, not the sync_schema_ver row — so read it the same way or every
// request would 409 for the wrong reason.
const schemaVer = latestSchemaVer();

// A row of our own to offer as the pushed change, so a guard failure cannot
// touch anything real.
const probeId = randomUUID();
await db.query(
  `insert into items (id, owner_id, type, title) values ($1, $2, 'note', 'GUARD TEST probe')`,
  [probeId, owner]
);

const post = async (token: string, body: unknown) => {
  const res = await fetch(`${PEER_URL}/api/machine/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON body is a finding in itself; status still tells us what we need
  }
  return { status: res.status, json };
};

const pushOp = (deviceId: string) => ({
  seq: 1,
  deviceId,
  originDeviceId: null,
  ownerId: owner,
  at: new Date().toISOString(),
  tbl: "items",
  rowId: probeId,
  kind: "update" as const,
  changed: { title: "GUARD TEST pushed title" },
  schemaVer,
});

try {
  // ── 1 + 2: pull_only refuses the push, and still serves the pull ──────────
  const ro = await mint({ pullOnly: true });
  const refused = await post(ro.token, {
    deviceId: ro.deviceId,
    schemaVer,
    sinceSeq: 0,
    ops: [pushOp(ro.deviceId)],
  });
  check("a pull_only device's push is refused with 403", refused.status === 403, `HTTP ${refused.status}`);
  const title = (await db.query(`select title from items where id = $1`, [probeId])).rows[0].title;
  check(
    "the refused push applied NOTHING (the row is untouched)",
    title === "GUARD TEST probe",
    String(title)
  );

  const pulled = await post(ro.token, { deviceId: ro.deviceId, schemaVer, sinceSeq: 0, ops: [] });
  check(
    "the same pull_only device can still PULL (a held device is never stranded)",
    pulled.status === 200,
    `HTTP ${pulled.status}`
  );
  check(
    "the pull response carries ops and the hub's serverTime (skew input)",
    Array.isArray(pulled.json.ops) && typeof pulled.json.serverTime === "string"
  );

  // ── 3: version gate ──────────────────────────────────────────────────────
  const stale = await post(ro.token, {
    deviceId: ro.deviceId,
    schemaVer: "0001_ancient_history",
    sinceSeq: 0,
    ops: [],
  });
  check("a schema-version mismatch is refused with 409", stale.status === 409, `HTTP ${stale.status}`);
  check(
    "the 409 names both versions, so the stale side can act on it",
    JSON.stringify(stale.json).includes(schemaVer) &&
      JSON.stringify(stale.json).includes("0001_ancient_history"),
    JSON.stringify(stale.json).slice(0, 120)
  );

  // ── 4: revoked ───────────────────────────────────────────────────────────
  const dead = await mint({ pullOnly: false, revoked: true });
  const revoked = await post(dead.token, {
    deviceId: dead.deviceId,
    schemaVer,
    sinceSeq: 0,
    ops: [],
  });
  check("a revoked device is refused", revoked.status === 401 || revoked.status === 403, `HTTP ${revoked.status}`);

  // ── 5: garbage token ─────────────────────────────────────────────────────
  const bogus = await post("not-a-real-token", { deviceId: randomUUID(), schemaVer, sinceSeq: 0, ops: [] });
  check("an unknown token is refused", bogus.status === 401, `HTTP ${bogus.status}`);
} finally {
  await db.query(`delete from sync_peers where name like 'GUARD TEST%'`);
  await db.query(`delete from items where id = $1`, [probeId]);
  await db.query(`delete from sync_ops where row_id = $1`, [probeId]);
  await db.end();
}

console.log(failures === 0 ? "\nAll guard checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
