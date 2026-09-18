// Verification for the sync spine (plans/local-hub-idea-to-cutover.html,
// phase 1). Two tiers:
//
//   (a) PURE — always runs: the merge engine's locked rules (per-field LWW
//       convergence from both application orders, the body-conflict
//       revisions+flag behavior, relation set-op idempotence, double-apply
//       no-op, owner-scope refusal, the version gate). No database.
//
//   (b) INTEGRATION — two real Postgres databases, migrated from ./drizzle,
//       written concurrently (same item, same field, same body, offline
//       style), then converged through the real engine+apply both directions.
//       Asserts identical converged state and that a further exchange round
//       produces zero new effective ops (echo terminates). Uses
//       SYNC_TEST_DB_A / SYNC_TEST_DB_B when set (two EMPTY databases);
//       otherwise spins two ephemeral clusters via the embedded-postgres
//       devDependency (which also pre-proves the phase-2 local-runtime
//       dependency). If neither is possible it skips tier (b) loudly.
//
// Run: npx tsx scripts/verify-sync.mts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirBestEffort } from "../supervisor/rm-dir.mjs";
import { freePorts } from "./lib/free-port.mjs";
import {
  cmpStamp,
  mergeOps,
  opFieldKeys,
  stableStringify,
  versionGate,
  type LocalState,
  type SyncOp,
  type WriteAction,
} from "../src/lib/sync/engine";
import { applySyncOps, passageBodyFromAction, planActions, type SyncDb } from "../src/lib/sync/apply";
import {
  cursorTooStale,
  dedupePushedOps,
  pruneSyncOps,
  SYNC_OPS_RETENTION_DAYS,
  SYNC_PRUNED_THROUGH_KEY,
  holdState,
  parseHoldMode,
  effectiveGraceDays,
  HOLD_GRACE_DAYS_DEFAULT,
} from "../src/lib/sync/peers";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// ── Tier (a): the pure engine ────────────────────────────────────────────────

const DEV_A = "aaaaaaaa-0000-4000-8000-000000000001";
const DEV_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OWNER = "00000000-0000-4000-8000-00000000000a";
const ITEM = "11111111-0000-4000-8000-000000000001";

let seqCounter = 1;
function op(partial: Partial<SyncOp> & Pick<SyncOp, "tbl" | "rowId" | "kind" | "changed">): SyncOp {
  return {
    seq: seqCounter++,
    deviceId: DEV_A,
    originDeviceId: null,
    ownerId: OWNER,
    at: "2026-08-22T10:00:00.000+00:00",
    schemaVer: "test",
    ...partial,
  };
}

function freshState(row: Record<string, unknown> | null, fields = {}): LocalState {
  return {
    ownerIds: new Set([OWNER]),
    rows: new Map(row ? [[`items:${ITEM}`, { row, fields }]] : []),
    relationByKey: new Map(),
  };
}

function applyToRow(row: Record<string, unknown>, actions: WriteAction[]): Record<string, unknown> {
  let out = { ...row };
  for (const a of actions) if (a.kind === "update") out = { ...out, ...a.fields };
  return out;
}

// (1) per-field LWW converges from both application orders
{
  const opA = op({ tbl: "items", rowId: ITEM, kind: "update", changed: { title: "from A" }, deviceId: DEV_A, at: "2026-08-22T10:00:01+00:00" });
  const opB = op({ tbl: "items", rowId: ITEM, kind: "update", changed: { title: "from B" }, deviceId: DEV_B, at: "2026-08-22T10:00:02+00:00" });
  const base = { id: ITEM, title: "start", properties: null };
  const r1 = mergeOps([opA, opB], freshState({ ...base }));
  const r2 = mergeOps([opB, opA], freshState({ ...base }));
  const t1 = applyToRow(base, r1.actions).title;
  const t2 = applyToRow(base, r2.actions).title;
  check("LWW converges from both orders", t1 === "from B" && t2 === "from B", `${t1} / ${t2}`);
  check("the losing order applies the winner only once", r2.actions.length === 1);
}

// (2) LWW timestamp tie breaks deterministically on device id
{
  const same = "2026-08-22T10:00:01+00:00";
  check(
    "timestamp tie breaks on device id",
    cmpStamp({ at: same, deviceId: DEV_B }, { at: same, deviceId: DEV_A }) > 0
  );
}

// (3) body conflict: losing FOREIGN body snapshots to revisions + flag
{
  const bodyLocal = { format: "markdown", text: "local version" };
  const bodyForeign = { format: "markdown", text: "foreign version" };
  const state = freshState(
    { id: ITEM, body: bodyLocal, properties: {} },
    { body: { at: "2026-08-22T10:00:05+00:00", deviceId: DEV_B } }
  );
  const { actions } = mergeOps(
    [op({ tbl: "items", rowId: ITEM, kind: "update", changed: { body: bodyForeign }, deviceId: DEV_A, at: "2026-08-22T10:00:01+00:00" })],
    state
  );
  const snap = actions.find((a) => a.kind === "snapshot_revision");
  const upd = actions.find((a) => a.kind === "update");
  check("losing foreign body is snapshotted", !!snap && stableStringify((snap as { body: unknown }).body) === stableStringify(bodyForeign));
  check("losing foreign body is NOT applied", !upd || !("body" in (upd as { fields: object }).fields));
  check(
    "body conflict sets the check-revisions flag",
    !!upd && ((upd as { fields: { properties?: { syncBodyMerged?: boolean } } }).fields.properties?.syncBodyMerged === true)
  );
}

// (4) body conflict: losing LOCAL body snapshots, foreign applies
{
  const bodyLocal = { format: "markdown", text: "local version" };
  const bodyForeign = { format: "markdown", text: "foreign version" };
  const state = freshState(
    { id: ITEM, body: bodyLocal, properties: {} },
    { body: { at: "2026-08-22T10:00:01+00:00", deviceId: DEV_B } }
  );
  const { actions } = mergeOps(
    [op({ tbl: "items", rowId: ITEM, kind: "update", changed: { body: bodyForeign }, deviceId: DEV_A, at: "2026-08-22T10:00:09+00:00" })],
    state
  );
  const snap = actions.find((a) => a.kind === "snapshot_revision");
  const upd = actions.find((a) => a.kind === "update");
  check("losing local body is snapshotted", !!snap && stableStringify((snap as { body: unknown }).body) === stableStringify(bodyLocal));
  check(
    "winning foreign body applies with the flag",
    !!upd &&
      stableStringify((upd as { fields: { body?: unknown } }).fields.body) === stableStringify(bodyForeign) &&
      (upd as { fields: { properties?: { syncBodyMerged?: boolean } } }).fields.properties?.syncBodyMerged === true
  );
}

// (5) a plain forward body edit from the SAME device is no conflict
{
  const state = freshState(
    { id: ITEM, body: { format: "markdown", text: "v1" }, properties: {} },
    { body: { at: "2026-08-22T10:00:01+00:00", deviceId: DEV_A } }
  );
  const { actions } = mergeOps(
    [op({ tbl: "items", rowId: ITEM, kind: "update", changed: { body: { format: "markdown", text: "v2" } }, deviceId: DEV_A, at: "2026-08-22T10:00:02+00:00" })],
    state
  );
  check(
    "same-device body edit applies with no snapshot and no flag",
    actions.length === 1 && actions[0].kind === "update" && !("properties" in (actions[0] as { fields: object }).fields)
  );
}

// (6) relations are idempotent set ops
{
  const REL = "22222222-0000-4000-8000-000000000001";
  const edge = { id: REL, source_id: ITEM, target_id: OWNER, role: "related", match_state: "confirmed", home: false };
  const state: LocalState = { ownerIds: new Set([OWNER]), rows: new Map(), relationByKey: new Map() };
  const ins = op({ tbl: "relations", rowId: REL, kind: "insert", changed: edge });
  const r1 = mergeOps([ins], state);
  const r2 = mergeOps([ins], state);
  check("relation insert-if-absent inserts once", r1.actions.length === 1 && r2.actions.length === 0);
  // A concurrent create of the SAME edge under a different uuid is absorbed.
  const REL2 = "22222222-0000-4000-8000-000000000002";
  const r3 = mergeOps([op({ tbl: "relations", rowId: REL2, kind: "insert", changed: { ...edge, id: REL2 }, deviceId: DEV_B })], state);
  check("same natural key under a different uuid is absorbed", r3.actions.length === 0);
  const del = op({ tbl: "relations", rowId: REL, kind: "delete", changed: edge, deviceId: DEV_B });
  const r4 = mergeOps([del], state);
  const r5 = mergeOps([del], state);
  check("relation delete-if-present deletes once", r4.actions.length === 1 && r5.actions.length === 0);
}

// (7) double-apply of a whole batch is a no-op
{
  const state = freshState(null);
  const batch = [
    op({ tbl: "items", rowId: ITEM, kind: "insert", changed: { id: ITEM, owner_id: OWNER, title: "new", properties: null } }),
    op({ tbl: "items", rowId: ITEM, kind: "update", changed: { title: "edited" }, at: "2026-08-22T10:00:03+00:00" }),
  ];
  const r1 = mergeOps(batch, state);
  const r2 = mergeOps(batch, state);
  check("double-apply is a no-op", r1.actions.length === 2 && r2.actions.length === 0, `${r1.actions.length} then ${r2.actions.length}`);
}

// (8) owner scope: foreign owners are refused
{
  const state = freshState(null);
  const bad = op({ tbl: "items", rowId: ITEM, kind: "insert", changed: { id: ITEM, title: "x" }, ownerId: "99999999-0000-4000-8000-000000000009" });
  const { actions, rejected } = mergeOps([bad], state);
  check("ops outside the owner set are rejected, never applied", actions.length === 0 && rejected.length === 1);
}

// (9) unknown tables are refused
{
  const state = freshState(null);
  const { actions, rejected } = mergeOps([op({ tbl: "error_log", rowId: ITEM, kind: "insert", changed: { id: ITEM } })], state);
  check("non-synced tables are rejected", actions.length === 0 && rejected.length === 1);
}

// (10) the version gate
check("version gate refuses a mismatch", !versionGate("0054_sync_spine", "0053_person_image"));
check("version gate passes a match", versionGate("0054_sync_spine", "0054_sync_spine"));

// (11) hard delete is idempotent
{
  const state = freshState({ id: ITEM, title: "x", properties: null });
  const del = op({ tbl: "items", rowId: ITEM, kind: "delete", changed: { id: ITEM, title: "x" } });
  const r1 = mergeOps([del], state);
  const r2 = mergeOps([del], state);
  check("hard delete applies once", r1.actions.length === 1 && r1.actions[0].kind === "delete" && r2.actions.length === 0);
}

// (12) which applied actions need their passage edges rebuilt. The filter is
// what keeps a 500-op batch from doing 500 needless reconciles, so it has to
// be exactly the body-carrying writes and nothing else.
{
  const ins = (row: Record<string, unknown>): WriteAction => ({
    kind: "insert", tbl: "items", ownerId: OWNER, origin: "d", row,
  });
  const upd = (fields: Record<string, unknown>): WriteAction => ({
    kind: "update", tbl: "items", ownerId: OWNER, origin: "d", pkCol: "id", pkVal: ITEM, fields,
  });
  check(
    "an insert carrying a body derives",
    passageBodyFromAction(ins({ id: ITEM, body: { format: "markdown", text: "x" } }))?.itemId === ITEM
  );
  check("an insert with no body does not", passageBodyFromAction(ins({ id: ITEM, body: null })) === null);
  check(
    "an update touching body derives, with the MERGED value",
    JSON.stringify(passageBodyFromAction(upd({ body: { format: "markdown", text: "won" } }))?.body) ===
      JSON.stringify({ format: "markdown", text: "won" })
  );
  check(
    "a body cleared to null still derives (its edges must go)",
    passageBodyFromAction(upd({ body: null }))?.itemId === ITEM
  );
  check("a title-only update does not", passageBodyFromAction(upd({ title: "t" })) === null);
  check(
    "a soft-delete stamp does not",
    passageBodyFromAction(upd({ deleted_at: "2026-08-23T00:00:00Z" })) === null
  );
  check(
    "a non-items table never does",
    passageBodyFromAction({
      kind: "update", tbl: "types", ownerId: OWNER, origin: "d", pkCol: "key", pkVal: "note",
      fields: { body: { text: "not an item" } },
    }) === null
  );
  check(
    "a hard delete does not (the cascade takes its edges)",
    passageBodyFromAction({ kind: "delete", tbl: "items", ownerId: OWNER, origin: "d", pkCol: "id", pkVal: ITEM }) === null
  );
}

// (13, ADR-206 addendum 7) the batch execution plan: items deletes leave the
// in-order stream and group per origin into one multi-row statement, because
// items.parent_id is a restricting FK and the hub's row triggers log a
// one-statement family delete in arbitrary order (parent-first wedged the
// dev rig). Everything else keeps its order.
{
  const del = (pkVal: string, origin = "d1"): WriteAction => ({
    kind: "delete", tbl: "items", ownerId: OWNER, origin, pkCol: "id", pkVal,
  });
  const relDel: WriteAction = { kind: "delete", tbl: "relations", ownerId: OWNER, origin: "d1", pkCol: "id", pkVal: ITEM };
  const upd: WriteAction = { kind: "update", tbl: "items", ownerId: OWNER, origin: "d1", pkCol: "id", pkVal: ITEM, fields: { title: "t" } };
  const plan = planActions([upd, del("p"), relDel, del("c"), del("x", "d2")]);
  check(
    "items deletes leave the stream; other actions keep their order",
    plan.stream.length === 2 && plan.stream[0] === upd && plan.stream[1] === relDel
  );
  check(
    "items deletes group per origin, first-seen order kept",
    JSON.stringify(plan.itemsDeletes) ===
      JSON.stringify([{ origin: "d1", ids: ["p", "c"] }, { origin: "d2", ids: ["x"] }])
  );
  const applySrc = readFileSync("src/lib/sync/apply.ts", "utf8");
  check(
    "apply wires the plan and runs items deletes as one statement",
    applySrc.includes("planActions(") && applySrc.includes("where items.id = any(")
  );
}

// (14) the staleness refusal decision (ADR-208). The bug this guards: the
// route served `seq > sinceSeq` with no oldest-retained comparison, so a
// peer whose cursor pointed into pruned territory received a partial stream
// and reported synced. Reintroducing that (weakening cursorTooStale or
// unwiring it from the route) fails these checks.
{
  check("a cursor below prunedThrough is stale", cursorTooStale(5, 10));
  check("a cursor at prunedThrough is fine (needs only ops above it)", !cursorTooStale(10, 10));
  check("a cursor past prunedThrough is fine", !cursorTooStale(11, 10));
  check("cursor 0 is a fresh fill, never stale", !cursorTooStale(0, 10));
  check("a hub that never pruned refuses nobody", !cursorTooStale(5, 0));
}

// (15) push dedupe (same ADR): a re-delivered batch must be dropped, not
// re-applied — each re-apply's row writes had their triggers log fresh hub
// ops, growing the oplog without bound.
{
  const ops = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
  check("already-pushed ops are dropped", JSON.stringify(dedupePushedOps(ops, 2)) === JSON.stringify([{ seq: 3 }]));
  check("a fresh device drops nothing", dedupePushedOps(ops, 0).length === 3);
  check("a fully re-delivered batch drops everything", dedupePushedOps(ops, 3).length === 0);
}

// (16) structural: the decision functions above only guard anything if the
// route and client actually call them. Source-level, so a refactor that
// silently unwires either fails here rather than in production.
{
  const route = readFileSync("src/app/api/machine/sync/route.ts", "utf8");
  check("the sync route wires cursorTooStale + readPrunedThrough", route.includes("cursorTooStale(") && route.includes("readPrunedThrough("));
  check("the sync route wires the push dedupe", route.includes("dedupePushedOps("));
  check("the sync route refuses staleness with 410", /status:\s*410/.test(route));
  const client = readFileSync("src/lib/sync/client.ts", "utf8");
  check("the sync client handles the 410 refusal", client.includes("res.status === 410"));
  check("the sync client never advances the pull cursor on 410", client.includes("NEVER the pull"));
}

// (17) users.settings merges PER KEY (ADR-226).
//
// The regression this locks down cost a live job assignment. `settings` is one
// jsonb column holding every preference, so whole-blob LWW meant any settings
// write carried the writer's entire view and, on arrival, reverted every key the
// writer had not yet pulled. The assigned machine stamps its last run into
// `settings.jobOwners` after every run, so an hourly peer was doing exactly that
// on a schedule — undoing the cloud's assignment with nothing in any log.
{
  const USER = OWNER;
  const settingsState = (
    settings: Record<string, unknown>,
    fields: Record<string, { at: string; deviceId: string }> = {}
  ): LocalState => ({
    ownerIds: new Set([OWNER]),
    rows: new Map([[`users:${USER}`, { row: { id: USER, settings }, fields }]]),
    relationByKey: new Map(),
  });
  const settingsOp = (settings: Record<string, unknown>, o: Partial<SyncOp> = {}) =>
    op({ tbl: "users", rowId: USER, kind: "update", changed: { settings }, ...o });

  check(
    "a settings op stamps its keys, not the column",
    JSON.stringify(opFieldKeys("users", { settings: { accent: "#dc2626", jobOwners: {} } })) ===
      JSON.stringify(["settings.accent", "settings.jobOwners"])
  );
  check(
    "every other table keeps stamping plain columns",
    JSON.stringify(opFieldKeys("items", { title: "x", body: null })) ===
      JSON.stringify(["title", "body"])
  );

  // THE BUG, as the two writes that produced it: the cloud names a machine for
  // the backup; the peer changes an unrelated preference from a copy of settings
  // that predates it. Both must survive, in either arrival order.
  const owners = { export: { deviceId: "dev-pc", label: "BrandonECC" } };
  const fromCloud = settingsOp(
    { jobOwners: owners },
    { deviceId: DEV_A, at: "2026-08-22T10:00:01+00:00" }
  );
  const fromPeer = settingsOp(
    { accent: "#0d9488" },
    { deviceId: DEV_B, at: "2026-08-22T10:00:02+00:00" }
  );
  for (const [order, ops] of [
    ["assignment first", [fromCloud, fromPeer]],
    ["preference first", [fromPeer, fromCloud]],
  ] as const) {
    const base = { accent: "#2563eb", jobOwners: {}, textSize: "base" };
    const { actions } = mergeOps([...ops], settingsState({ ...base }));
    const merged = actions.reduce<Record<string, unknown>>(
      (acc, a) => (a.kind === "update" ? { ...acc, ...(a.fields.settings as object) } : acc),
      {}
    );
    check(
      `both keys survive (${order})`,
      stableStringify(merged.jobOwners) === stableStringify(owners) &&
        merged.accent === "#0d9488" &&
        merged.textSize === "base",
      JSON.stringify(merged)
    );
  }

  // The same key genuinely contested is still LWW, and a stale arrival is left
  // on the floor rather than rewritten.
  {
    const { actions } = mergeOps(
      [settingsOp({ accent: "#older" }, { deviceId: DEV_A, at: "2026-08-22T09:00:00+00:00" })],
      settingsState(
        { accent: "#newer" },
        { "settings.accent": { at: "2026-08-22T10:00:00+00:00", deviceId: DEV_B } }
      )
    );
    check("a stale key loses and writes nothing", actions.length === 0);
  }
  {
    const { actions } = mergeOps(
      [settingsOp({ accent: "#newer" }, { deviceId: DEV_A, at: "2026-08-22T11:00:00+00:00" })],
      settingsState(
        { accent: "#older" },
        { "settings.accent": { at: "2026-08-22T10:00:00+00:00", deviceId: DEV_B } }
      )
    );
    check(
      "a fresher key wins",
      actions.length === 1 &&
        (actions[0] as unknown as { fields: { settings: { accent: string } } }).fields.settings.accent ===
          "#newer"
    );
  }

  // A whole-blob op — what an oplog written before migration 0059 holds — must
  // still merge, just coarsely. Back-compat, not a special case.
  {
    const { actions } = mergeOps(
      [settingsOp({ accent: "#dc2626", textSize: "lg", jobOwners: {} })],
      settingsState({ accent: "#dc2626", textSize: "base", jobOwners: {} })
    );
    const fields = (actions[0] as unknown as { fields: { settings: Record<string, unknown> } }).fields;
    check(
      "a legacy whole-blob op still merges",
      actions.length === 1 &&
        fields.settings.textSize === "lg" &&
        fields.settings.accent === "#dc2626"
    );
  }

  // Idempotence, the property every other table already has here.
  {
    const state = settingsState({ accent: "#dc2626" });
    const one = settingsOp({ accent: "#0d9488" }, { at: "2026-08-22T11:00:00+00:00" });
    const first = mergeOps([one], state);
    const again = mergeOps([one], state);
    check(
      "applying a settings op twice is a no-op",
      first.actions.length === 1 && again.actions.length === 0
    );
  }

  // Structural: the merge above only means anything if the TRIGGER sends the
  // changed keys. A migration that went back to shipping the whole blob would
  // pass every check above and silently restore the bug.
  {
    const sql = readFileSync("drizzle/0060_users_settings_perkey.sql", "utf8");
    check(
      "the trigger diffs settings against OLD rather than sending the blob",
      sql.includes("jsonb_each(coalesce(v_row -> 'settings'") &&
        sql.includes("to_jsonb(OLD) -> 'settings'")
    );
  }
}

// ── Tier (b): two real databases, offline edits, convergence ────────────────

type Peer = {
  name: string;
  db: SyncDb;
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  deviceId: string;
  cursors: Map<string, number>;
  end: () => Promise<void>;
};

async function makePeer(name: string, url: string): Promise<Peer> {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });
  const dev = await pool.query("select id from sync_device limit 1");
  return {
    name,
    db: db as unknown as SyncDb,
    query: (text, params) => pool.query(text, params as never[]),
    deviceId: String(dev.rows[0].id),
    cursors: new Map(),
    end: () => pool.end(),
  };
}

async function readWireOps(p: Peer, sinceSeq: number, excludeOrigin: string): Promise<SyncOp[]> {
  const res = await p.query(
    `select seq, device_id, origin_device_id, owner_id, at, tbl, row_id, kind, changed, schema_ver
     from sync_ops where seq > $1 and (origin_device_id is null or origin_device_id <> $2)
     order by seq`,
    [sinceSeq, excludeOrigin]
  );
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    deviceId: String(r.device_id),
    originDeviceId: r.origin_device_id ? String(r.origin_device_id) : null,
    ownerId: String(r.owner_id),
    at: (r.at as Date).toISOString(),
    tbl: String(r.tbl),
    rowId: String(r.row_id),
    kind: r.kind as SyncOp["kind"],
    changed: r.changed as Record<string, unknown>,
    schemaVer: String(r.schema_ver),
  }));
}

// One direction of the real exchange: from's ops applied onto to, through the
// real engine+apply. `transactions` picks the driver shape: true is the
// node-postgres path (one transaction, SET LOCAL), false is what neon-http
// gets (statement by statement, the origin carried inside each statement).
async function exchangeOnce(from: Peer, to: Peer, transactions = true): Promise<number> {
  const since = to.cursors.get(from.name) ?? 0;
  const ops = await readWireOps(from, since, to.deviceId);
  if (ops.length === 0) return 0;
  const res = await applySyncOps(ops, { db: to.db, transactions });
  to.cursors.set(from.name, ops[ops.length - 1].seq);
  return res.actions;
}

async function opCount(p: Peer): Promise<number> {
  const r = await p.query("select count(*)::int as n from sync_ops");
  return Number(r.rows[0].n);
}

async function tableJson(p: Peer, tbl: string, orderBy: string): Promise<string> {
  const r = await p.query(`select to_jsonb(t) - 'search' as row from ${tbl} t order by ${orderBy}`);
  return stableStringify(r.rows.map((x) => x.row));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runIntegration(urlA: string, urlB: string): Promise<void> {
  const A = await makePeer("A", urlA);
  const B = await makePeer("B", urlB);
  try {
    check("each database self-assigned a distinct device id", A.deviceId !== B.deviceId);

    // Seed the shared owner on both (users rows don't sync; a spoke starts
    // from a restore/clone). Types + items flow through sync itself.
    for (const p of [A, B]) {
      await p.query(`insert into users (id, email) values ($1, 'sync-test@example.com')`, [OWNER]);
    }
    await A.query(`insert into types (key, label) values ('note', 'Note')`);
    await A.query(
      `insert into items (id, owner_id, type, title, body) values ($1, $2, 'note', 'hello', '{"format":"markdown","text":"v0"}')`,
      [ITEM, OWNER]
    );

    // Initial clone: A -> B.
    await exchangeOnce(A, B);
    check(
      "insert ops replicate a row byte-identically",
      (await tableJson(A, "items", "id")) === (await tableJson(B, "items", "id"))
    );
    const echo = await B.query(
      `select count(*)::int as n from sync_ops where origin_device_id = $1`,
      [A.deviceId]
    );
    check("applied foreign ops carry origin_device_id (GUC stamped)", Number(echo.rows[0].n) > 0);

    // Offline: both sides edit the same item — same field, same body — plus a
    // type rename on A (exercises the md5 rowId path for the text pk).
    await A.query(`update items set title = 'title from A', body = '{"format":"markdown","text":"body from A"}' where id = $1`, [ITEM]);
    await A.query(`update types set label = 'Note (renamed)' where key = 'note'`);
    await sleep(50); // B writes later — B must win LWW
    await B.query(`update items set title = 'title from B', body = '{"format":"markdown","text":"body from B"}' where id = $1`, [ITEM]);

    // Derived data (passage_refs) must follow a synced body. The apply path
    // writes item rows directly, so nothing calls item-mutations.ts and
    // nothing would rebuild these edges: that was silent drift on every peer
    // until 2026-08-23. passage_refs is deliberately NOT in the synced set,
    // so this is the receiving side deriving from the body it just merged.
    // Its own item, so it cannot perturb the LWW/revisions fixtures above.
    {
      const P = "33333333-0000-4000-8000-000000000004";
      await A.query(
        `insert into items (id, owner_id, type, title, body) values ($1, $2, 'note', 'passages',
           '{"format":"markdown","text":"see [Ps 23](ledgr://passage/1002003) and [again](ledgr://passage/1002003) and [range](ledgr://passage/2000001-2000005)"}')`,
        [P, OWNER]
      );
      await exchangeOnce(A, B);
      const rows = await B.query(
        `select start_ref, end_ref from passage_refs where source_item_id = $1 and role = 'passage' order by start_ref`,
        [P]
      );
      check(
        "a synced body rebuilds passage_refs on the RECEIVING peer",
        rows.rows.length === 2,
        `${rows.rows.length} edge(s)`
      );
      check(
        "the derived edges carry the body's own start/end refs, deduped",
        JSON.stringify(rows.rows.map((r: Record<string, unknown>) => [Number(r.start_ref), Number(r.end_ref)])) ===
          JSON.stringify([[1002003, 1002003], [2000001, 2000005]])
      );
      // Removing the links must remove the edges, or the index only ever grows.
      await A.query(
        `update items set body = '{"format":"markdown","text":"no passages here"}' where id = $1`,
        [P]
      );
      await exchangeOnce(A, B);
      const after = await B.query(
        `select count(*)::int as n from passage_refs where source_item_id = $1 and role = 'passage'`,
        [P]
      );
      check("clearing the links clears the derived edges", Number(after.rows[0].n) === 0);
    }

    // Concurrent same-edge creation with different uuids, plus a one-sided edge.
    const T2 = "33333333-0000-4000-8000-000000000003";
    await A.query(
      `insert into items (id, owner_id, type, title) values ($1, $2, 'note', 'target')`,
      [T2, OWNER]
    );
    await exchangeOnce(A, B); // B needs the target row before the edge test
    await exchangeOnce(B, A);
    await A.query(`insert into relations (id, source_id, target_id, role) values (gen_random_uuid(), $1, $2, 'related')`, [ITEM, T2]);
    await B.query(`insert into relations (id, source_id, target_id, role) values (gen_random_uuid(), $1, $2, 'related')`, [ITEM, T2]);
    await B.query(`insert into relations (id, source_id, target_id, role) values (gen_random_uuid(), $1, $2, 'tagged')`, [T2, ITEM]);

    // Converge: exchange both directions until quiet.
    let effective = -1;
    for (let round = 0; round < 8 && effective !== 0; round++) {
      effective = (await exchangeOnce(A, B)) + (await exchangeOnce(B, A));
    }
    check("exchange settles to zero effective ops", effective === 0);

    check(
      "items converge byte-identically",
      (await tableJson(A, "items", "id")) === (await tableJson(B, "items", "id"))
    );
    // Migrations seed the system types on EACH database independently (and
    // did so before 0054's triggers existed), so those rows' created_at is
    // honestly per-instance — a real spoke avoids even that by cloning from a
    // hub restore. Everything else about types must converge, and the row
    // that flowed through sync converges byte-identically.
    {
      const typesSans = async (p: Peer) =>
        stableStringify(
          (await p.query(`select to_jsonb(t) - 'created_at' as row from types t order by key`)).rows.map((x) => x.row)
        );
      check("types converge (modulo migration-seeded created_at)", (await typesSans(A)) === (await typesSans(B)));
      const noteRow = async (p: Peer) =>
        stableStringify((await p.query(`select to_jsonb(t) as row from types t where key = 'note'`)).rows[0]?.row);
      check("the synced type row converges byte-identically", (await noteRow(A)) === (await noteRow(B)));
      const label = await B.query(`select label from types where key = 'note'`);
      check("the type rename reached the peer (md5 rowId path)", label.rows[0]?.label === "Note (renamed)");
    }

    const itemA = (await A.query(`select title, body, properties from items where id = $1`, [ITEM])).rows[0];
    check("the later writer wins the contested field", itemA.title === "title from B", String(itemA.title));
    check(
      "the later body wins",
      stableStringify(itemA.body) === stableStringify({ format: "markdown", text: "body from B" })
    );
    check(
      "the merged item carries the check-revisions flag",
      (itemA.properties as { syncBodyMerged?: boolean } | null)?.syncBodyMerged === true
    );
    for (const p of [A, B]) {
      const revs = await p.query(
        `select count(*)::int as n from revisions where item_id = $1 and body @> '{"text":"body from A"}'`,
        [ITEM]
      );
      check(`the losing body is in revisions on ${p.name}`, Number(revs.rows[0].n) >= 1);
    }

    // relations converge as a SET (membership; uuids may differ for the
    // concurrently-created edge — the engine's documented set semantics).
    const relSet = async (p: Peer) =>
      stableStringify(
        (
          await p.query(
            `select source_id, target_id, role, match_state, home from relations order by source_id, target_id, role`
          )
        ).rows
      );
    check("relations converge as a set", (await relSet(A)) === (await relSet(B)));
    const relCount = await A.query(`select count(*)::int as n from relations`);
    check("the concurrent same edge exists exactly once", Number(relCount.rows[0].n) === 2, `n=${relCount.rows[0].n}`);

    // Hard delete propagates and stays idempotent.
    await A.query(`delete from relations where role = 'tagged'`);
    let more = -1;
    for (let round = 0; round < 6 && more !== 0; round++) {
      more = (await exchangeOnce(A, B)) + (await exchangeOnce(B, A));
    }
    check("hard delete converges", (await relSet(A)) === (await relSet(B)) && more === 0);

    // Echo termination: further rounds must move NOTHING — no actions applied
    // and no unbounded oplog growth on either side.
    const beforeA = await opCount(A);
    const beforeB = await opCount(B);
    const extra = (await exchangeOnce(A, B)) + (await exchangeOnce(B, A)) + (await exchangeOnce(A, B)) + (await exchangeOnce(B, A));
    check("post-convergence rounds apply zero actions", extra === 0);
    check(
      "the oplog stops growing (echo terminates)",
      (await opCount(A)) === beforeA && (await opCount(B)) === beforeB
    );

    // ── Per-key settings, end to end (ADR-226) ─────────────────────────────
    //
    // The live failure this closes: the cloud names a machine for a job while a
    // peer, whose copy of settings is up to an hour old, saves an unrelated
    // preference. Under whole-blob LWW the peer's later write reverted the
    // assignment and nothing anywhere said so. Both halves are proved here
    // because the pure merge is only half the fix — the trigger has to send the
    // changed keys for the stamps to mean anything.
    {
      const jobOwners = { export: { deviceId: A.deviceId, label: "PeerA" } };
      await A.query(`update users set settings = $1 where id = $2`, [
        JSON.stringify({ accent: "#2563eb", jobOwners: {} }),
        OWNER,
      ]);
      await B.query(`update users set settings = $1 where id = $2`, [
        JSON.stringify({ accent: "#2563eb", jobOwners: {} }),
        OWNER,
      ]);
      const before = await opCount(A);
      await A.query(`update users set settings = $1 where id = $2`, [
        JSON.stringify({ accent: "#2563eb", jobOwners }),
        OWNER,
      ]);
      const logged = await A.query(
        `select changed from sync_ops where tbl = 'users' order by seq desc limit 1`
      );
      const changed = (logged.rows[0]?.changed ?? {}) as { settings?: Record<string, unknown> };
      check(
        "a settings write logs only the key that moved",
        (await opCount(A)) === before + 1 &&
          JSON.stringify(Object.keys(changed.settings ?? {})) === JSON.stringify(["jobOwners"]),
        JSON.stringify(changed)
      );

      // B, still unaware, changes a different preference LATER — the exact
      // shape that used to win the whole blob and undo the assignment.
      await sleep(50);
      await B.query(`update users set settings = $1 where id = $2`, [
        JSON.stringify({ accent: "#0d9488", jobOwners: {} }),
        OWNER,
      ]);
      await exchangeOnce(A, B);
      await exchangeOnce(B, A);
      const settingsOf = async (p: Peer) => {
        const r = await p.query(`select settings from users where id = $1`, [OWNER]);
        return r.rows[0].settings as { accent?: string; jobOwners?: unknown };
      };
      const sa = await settingsOf(A);
      const sb = await settingsOf(B);
      check(
        "the assignment survives an unrelated preference written later elsewhere",
        stableStringify(sa.jobOwners) === stableStringify(jobOwners) &&
          stableStringify(sb.jobOwners) === stableStringify(jobOwners),
        `A=${stableStringify(sa.jobOwners)} B=${stableStringify(sb.jobOwners)}`
      );
      check(
        "and the preference survives too, on both copies",
        sa.accent === "#0d9488" && sb.accent === "#0d9488",
        `A=${sa.accent} B=${sb.accent}`
      );
    }

    // ── Sessionless apply still stamps the origin (ADR-248) ────────────────
    // The cloud runs neon-http, which has no session, so `SET LOCAL
    // ledgr.sync_origin` never reached the oplog trigger there: every applied
    // write was logged as the cloud's OWN, and the next body from the same
    // peer then read as a two-device conflict — a junk revision plus a
    // syncBodyMerged flag on every single synced save. Sequential edits on one
    // device must cross a sessionless apply leaving neither behind.
    {
      const N = "55555555-0000-4000-8000-000000000001";
      await A.query(
        `insert into items (id, owner_id, type, title, body) values ($1, $2, 'note', 'origin probe', $3)`,
        [N, OWNER, JSON.stringify({ format: "markdown", text: "draft 1" })]
      );
      await exchangeOnce(A, B, false);
      for (const text of ["draft 2", "draft 3", "draft 4"]) {
        await A.query(`update items set body = $2 where id = $1`, [
          N,
          JSON.stringify({ format: "markdown", text }),
        ]);
        await exchangeOnce(A, B, false);
      }
      const ops = await B.query(
        `select count(*)::int as n from sync_ops
         where row_id = $1 and origin_device_id is distinct from $2`,
        [N, A.deviceId]
      );
      check(
        "a sessionless apply stamps origin_device_id on every op it writes",
        Number(ops.rows[0].n) === 0,
        `${ops.rows[0].n} op(s) on B carry the wrong origin`
      );
      const noise = await B.query(
        `select (select count(*)::int from revisions where item_id = $1) as revs,
                (select properties ->> 'syncBodyMerged' from items where id = $1) as flag`,
        [N]
      );
      check(
        "sequential edits on one device leave no phantom conflict behind",
        Number(noise.rows[0].revs) === 0 && noise.rows[0].flag === null,
        `revisions=${noise.rows[0].revs} syncBodyMerged=${noise.rows[0].flag}`
      );
      const body = await B.query(`select body ->> 'text' as t from items where id = $1`, [N]);
      check("and the last edit is what landed", body.rows[0]?.t === "draft 4", `${body.rows[0]?.t}`);
      await A.query(`delete from items where id = $1`, [N]);
      await exchangeOnce(A, B, false);
    }

    // ── FK-inversion family delete (ADR-206 addendum 7) ────────────────────
    // The hub hard-deletes a parent and its child in ONE statement; its row
    // triggers log the two delete ops in arbitrary order (the dev rig caught
    // parent first, child second, same `at`). Replayed as separate
    // statements, the parent's delete violates items_parent_id_items_id_fk,
    // the batch transaction rolls back, the cursor never advances, and the
    // peer retries forever. The plan's one-statement items delete must apply
    // this cleanly.
    {
      const P2 = "44444444-0000-4000-8000-000000000001";
      const C2 = "44444444-0000-4000-8000-000000000002";
      await A.query(
        `insert into items (id, owner_id, type, title) values ($1, $2, 'note', 'family parent')`,
        [P2, OWNER]
      );
      await A.query(
        `insert into items (id, owner_id, type, title, parent_id) values ($1, $2, 'note', 'family child', $3)`,
        [C2, OWNER, P2]
      );
      await exchangeOnce(A, B);
      const have = await B.query(`select count(*)::int as n from items where id in ($1,$2)`, [P2, C2]);
      check("fixture: the FK-linked family replicated to B", Number(have.rows[0].n) === 2);
      const at = new Date().toISOString();
      const mk = (rowId: string, seq: number): SyncOp => ({
        seq,
        deviceId: A.deviceId,
        originDeviceId: null,
        ownerId: OWNER,
        at,
        tbl: "items",
        rowId,
        kind: "delete",
        changed: { id: rowId },
        schemaVer: "test",
      });
      let applied = 0;
      let error = "";
      try {
        applied = (await applySyncOps([mk(P2, 900001), mk(C2, 900002)], { db: B.db, transactions: true })).actions;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const left = await B.query(`select count(*)::int as n from items where id in ($1,$2)`, [P2, C2]);
      check(
        "a parent-before-child delete pair applies without an FK wedge",
        error === "" && applied === 2 && Number(left.rows[0].n) === 0,
        error || `applied=${applied}`
      );
      // Bring A level again so later fixtures stay symmetric.
      await A.query(`delete from items where id in ($1, $2)`, [C2, P2]);
      await exchangeOnce(A, B);
    }

    // ── Retention prune (the daily purge's oplog cleanup) ──────────────────
    // Destructive to A's oplog, so it runs LAST. Ops are back-dated past the
    // floor; the cursor half of the rule is what the checks actually move.
    await A.query(
      `update sync_ops set at = now() - make_interval(days => $1)`,
      [SYNC_OPS_RETENTION_DAYS + 1]
    );
    const aged = await opCount(A);
    check("prune fixture: A holds back-dated ops", aged > 1, `n=${aged}`);

    // A registered device that has never pulled pins the whole log.
    await A.query(
      `insert into sync_peers (device_id, name, token_hash) values ($1, 'never-synced', 'x')`,
      [B.deviceId]
    );
    const pinned = await pruneSyncOps({ db: A.db });
    check(
      "a peer at cursor 0 pins the whole oplog",
      pinned.syncOpsPruned === 0 && (await opCount(A)) === aged
    );

    // Cursor advanced into the middle: everything at or below it goes, the
    // tail the peer hasn't pulled stays.
    const midRow = await A.query(`select seq from sync_ops order by seq offset $1 limit 1`, [
      Math.floor(aged / 2),
    ]);
    const mid = Number(midRow.rows[0].seq);
    await A.query(`update sync_peers set last_pulled_seq = $1 where device_id = $2`, [
      mid,
      B.deviceId,
    ]);
    const partial = await pruneSyncOps({ db: A.db });
    const remaining = await A.query(`select min(seq)::int as lo, count(*)::int as n from sync_ops`);
    check(
      "pulled ops are pruned and unpulled ops are kept",
      partial.syncOpsPruned > 0 &&
        Number(remaining.rows[0].n) === aged - partial.syncOpsPruned &&
        Number(remaining.rows[0].lo) > mid,
      `pruned=${partial.syncOpsPruned} lo=${remaining.rows[0].lo} mid=${mid}`
    );

    // ADR-208: the prune records the highest seq it deleted, which is the
    // boundary the staleness refusal compares peer cursors against.
    const pt = await A.query(`select (value->>'seq')::int as seq from job_state where key = $1`, [
      SYNC_PRUNED_THROUGH_KEY,
    ]);
    check(
      "the prune records prunedThrough at the highest deleted seq",
      Number(pt.rows[0]?.seq) === mid,
      `prunedThrough=${pt.rows[0]?.seq} expected=${mid}`
    );

    // Revoked devices don't hold history: the cursor guard falls away and the
    // time floor alone applies (the no-peers case prod runs today).
    await A.query(`update sync_peers set revoked = true`);
    await pruneSyncOps({ db: A.db });
    check("a revoked peer no longer pins the oplog", (await opCount(A)) === 0);
    const pt2 = await A.query(`select (value->>'seq')::int as seq from job_state where key = $1`, [
      SYNC_PRUNED_THROUGH_KEY,
    ]);
    check(
      "prunedThrough advances monotonically as later prunes delete deeper",
      Number(pt2.rows[0]?.seq) > mid,
      `prunedThrough=${pt2.rows[0]?.seq} mid=${mid}`
    );

    // The floor is absolute: a fresh op survives even with nobody to serve.
    await A.query(`delete from sync_peers`);
    await A.query(`update items set title = 'retention probe' where id = $1`, [ITEM]);
    const young = await opCount(A);
    const kept = await pruneSyncOps({ db: A.db });
    check(
      "ops inside the retention window are never pruned",
      young > 0 && kept.syncOpsPruned === 0 && (await opCount(A)) === young,
      `young=${young}`
    );
  } finally {
    await A.end();
    await B.end();
  }
}

async function tierB(): Promise<void> {
  const envA = process.env.SYNC_TEST_DB_A;
  const envB = process.env.SYNC_TEST_DB_B;
  if (envA && envB) {
    console.log("\nTier (b): using SYNC_TEST_DB_A / SYNC_TEST_DB_B");
    await runIntegration(envA, envB);
    return;
  }
  // No env: spin two ephemeral clusters with the embedded-postgres devDep.
  let EmbeddedPostgres: new (opts: object) => {
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
  };
  try {
    EmbeddedPostgres = (await import("embedded-postgres")).default;
  } catch {
    console.log(
      "\nSKIP  tier (b): embedded-postgres unavailable and SYNC_TEST_DB_A/B unset.\n" +
        "      Run with two empty local databases: SYNC_TEST_DB_A=postgres://… SYNC_TEST_DB_B=postgres://… npx tsx scripts/verify-sync.mts"
    );
    return;
  }
  console.log("\nTier (b): spinning two ephemeral embedded-postgres clusters…");
  const dirs = [mkdtempSync(join(tmpdir(), "ledgr-sync-a-")), mkdtempSync(join(tmpdir(), "ledgr-sync-b-"))];
  // OS-assigned, never hardcoded: a leaked postmaster from a crashed run
  // holding a fixed port wedged this suite instead of failing it (one CI run
  // sat there 77 minutes), and fixed ports also stop two cluster suites from
  // ever running at once.
  const ports = await freePorts(2);
  const clusters = dirs.map(
    (databaseDir, i) =>
      new EmbeddedPostgres({
        databaseDir,
        user: "postgres",
        password: "postgres",
        port: ports[i],
        persistent: false,
        // Windows initdb inherits the OS locale and would produce a WIN1252
        // cluster with libc collation, which cannot store the arrows, curly
        // quotes and em dashes that real Ledgr bodies (and this suite's own
        // fixtures) contain. The three runtime cluster sites force this; a
        // test cluster that does not is testing a database the app never
        // runs on. Kept identical to them on purpose, and verify-setup.mts
        // asserts that every cluster-creating file carries these flags.
        initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=en-US", "--locale=C"],
      })
  );
  try {
    try {
      for (const c of clusters) {
        await c.initialise();
        await c.start();
        await c.createDatabase("ledgr");
      }
    } catch (err) {
      // A cluster that can't even start is an environment problem (missing
      // platform binaries, a held port), not a sync regression — skip loudly.
      // Anything AFTER this point (migrate, the exchange) is a real failure.
      console.log(
        `SKIP  tier (b): embedded-postgres could not start (${err instanceof Error ? err.message : err})`
      );
      return;
    }
    await runIntegration(
      `postgresql://postgres:postgres@localhost:${ports[0]}/ledgr`,
      `postgresql://postgres:postgres@localhost:${ports[1]}/ledgr`
    );
  } finally {
    for (const c of clusters) {
      try {
        await c.stop();
      } catch {
        // best-effort teardown
      }
    }
    // Best-effort: on Windows the postmaster we just stopped releases its
    // handles asynchronously, so an immediate recursive remove loses the
    // race and throws EPERM. Every assertion has already run by here, so a
    // temp directory we cannot delete yet is noise in %TEMP%, not a sync
    // regression — reporting it and exiting on the real result beats
    // crashing a green suite in its teardown.
    for (const d of dirs) {
      const err = rmDirBestEffort(d);
      if (err) console.log(`NOTE  temp cluster dir left behind (still in use): ${d}`);
    }
  }
}

await tierB();

// ── Retention holds, per device (ADR-213) ───────────────────────────────────
//
// The bind this fixes: pruneSyncOps keeps every op above min(last_pulled_seq)
// across non-revoked peers, so a peer merely ASLEEP pinned the oplog forever,
// while revoking — the only way to free the floor — is also what destroys that
// peer's ability to resume. hold_mode is the third option, and it governs
// RETENTION ONLY: access stays with `revoked` and `pullOnly`.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW - n * DAY);

// Parse tolerance, and the direction of the tolerance matters: an unreadable
// setting must fall back to the BOUNDED mode, never to an unbounded hold.
check("auto is the default mode", parseHoldMode(undefined) === "auto");
check("garbage reads as auto, never warm", parseHoldMode("forever") === "auto");
check("null reads as auto", parseHoldMode(null) === "auto");
check("warm is recognized", parseHoldMode("warm") === "warm");
check("cold is recognized", parseHoldMode("cold") === "cold");

check("no window set means the default", effectiveGraceDays(null) === HOLD_GRACE_DAYS_DEFAULT);
check("a set window is honored", effectiveGraceDays(60) === 60);
check("zero is not a window", effectiveGraceDays(0) === HOLD_GRACE_DAYS_DEFAULT);
check("a negative window is refused", effectiveGraceDays(-5) === HOLD_GRACE_DAYS_DEFAULT);
check("a fractional window floors", effectiveGraceDays(30.9) === 30);
check(
  "the default window matches the op retention window, so a sleeper gets exactly one",
  HOLD_GRACE_DAYS_DEFAULT === SYNC_OPS_RETENTION_DAYS
);

{
  // A device seen today: holds, no warning, nothing to say.
  const h = holdState({ mode: "auto", graceDays: null, lastSeenAt: daysAgo(0), createdAt: daysAgo(90), now: NOW });
  check("a device seen today holds the log", h.holds && !h.warn && !h.lapsed);
  check("and reports its full window remaining", h.daysLeft === 14);
}
{
  // 9 of 14 days: under 0.7, still quiet. A daily-syncing device must never nag.
  const h = holdState({ mode: "auto", graceDays: null, lastSeenAt: daysAgo(9), createdAt: daysAgo(90), now: NOW });
  check("9 days into a 14-day window does not warn yet", h.holds && !h.warn);
}
{
  // 10 of 14 days = 0.71 — the warning Brandon asked for.
  const h = holdState({ mode: "auto", graceDays: null, lastSeenAt: daysAgo(10), createdAt: daysAgo(90), now: NOW });
  check("10 days into a 14-day window warns", h.holds && h.warn && !h.lapsed);
  check("and says how long is left", h.daysLeft === 4);
}
{
  // Past the window: the hold is gone and the state SAYS so, which is the
  // whole point — the alternative is discovering it at an ADR-208 refusal.
  const h = holdState({ mode: "auto", graceDays: null, lastSeenAt: daysAgo(15), createdAt: daysAgo(90), now: NOW });
  check("past its window a device stops holding", !h.holds && h.lapsed);
  check("a lapsed device does not also 'warn' (it is past warning)", !h.warn);
  check("and reports zero days left", h.daysLeft === 0);
}
{
  // Exactly at the boundary counts as lapsed: >= is the same comparison the
  // SQL makes, so the UI can never claim a hold the prune has already dropped.
  const h = holdState({ mode: "auto", graceDays: null, lastSeenAt: daysAgo(14), createdAt: daysAgo(90), now: NOW });
  check("exactly at the window is lapsed, matching the SQL", h.lapsed && !h.holds);
}
{
  // The warning threshold is a FRACTION, so it still arrives usefully early on
  // a long window rather than always at 10 days.
  const long = holdState({ mode: "auto", graceDays: 60, lastSeenAt: daysAgo(30), createdAt: daysAgo(90), now: NOW });
  check("30 days into a 60-day window does not warn", long.holds && !long.warn);
  const later = holdState({ mode: "auto", graceDays: 60, lastSeenAt: daysAgo(45), createdAt: daysAgo(90), now: NOW });
  check("45 days into a 60-day window does warn", later.holds && later.warn);
  check("a per-device window is reported back", later.graceDays === 60);
}
{
  // "warm" is the owner's deliberate unbounded hold.
  const h = holdState({ mode: "warm", graceDays: null, lastSeenAt: daysAgo(400), createdAt: daysAgo(500), now: NOW });
  check("a warm device holds however long it has been away", h.holds && !h.lapsed);
  check("and never nags, because the owner already decided", !h.warn);
  check("with no countdown, because there is none", h.daysLeft === null);
}
{
  // "cold" is the owner releasing it now.
  const h = holdState({ mode: "cold", graceDays: null, lastSeenAt: daysAgo(0), createdAt: daysAgo(1), now: NOW });
  check("a cold device holds nothing even if it synced seconds ago", !h.holds);
  check("and is not described as lapsed — it was a choice, not a timeout", !h.lapsed);
}
{
  // THE SAME BUG IN DIFFERENT CLOTHES: a token minted and never used sits at
  // cursor 0, so before this it pinned the ENTIRE oplog indefinitely. Its
  // clock has to be created_at.
  const fresh = holdState({ mode: "auto", graceDays: null, lastSeenAt: null, createdAt: daysAgo(2), now: NOW });
  check("a device minted 2 days ago and never used still holds", fresh.holds);
  const stale = holdState({ mode: "auto", graceDays: null, lastSeenAt: null, createdAt: daysAgo(30), now: NOW });
  check(
    "a device minted 30 days ago and NEVER used stops holding (it pinned everything before)",
    !stale.holds && stale.lapsed
  );
}
{
  // Data we cannot reason about must not cause deletion.
  const h = holdState({ mode: "auto", graceDays: null, lastSeenAt: null, createdAt: null, now: NOW });
  check("a device with no timestamps at all is assumed to hold, not dropped", h.holds);
  const bad = holdState({ mode: "auto", graceDays: null, lastSeenAt: "not a date", createdAt: null, now: NOW });
  check("an unparseable timestamp is assumed to hold too", bad.holds);
}

// The prune SQL has to agree with the pure logic, or the UI promises a hold the
// prune has already released. These are text checks on the one statement.
{
  const peersSrc = readFileSync("src/lib/sync/peers.ts", "utf8");
  check(
    "the prune floor excludes cold devices",
    /hold_mode <> 'cold'/.test(peersSrc)
  );
  check(
    "the prune floor always keeps warm devices",
    /hold_mode = 'warm'/.test(peersSrc)
  );
  check(
    "the prune floor ages an auto device from last_seen_at, falling back to created_at",
    /coalesce\(last_seen_at, created_at\)/.test(peersSrc)
  );
  check(
    "the per-device window is honored in SQL, with the shared default",
    /coalesce\(grace_days, \$\{HOLD_GRACE_DAYS_DEFAULT\}\)/.test(peersSrc)
  );
  check(
    "revoked devices still never set the floor",
    /revoked = false/.test(peersSrc)
  );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
