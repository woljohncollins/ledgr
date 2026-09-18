// The impure thin layer around engine.ts: gather local state, run the pure
// merge, execute the resulting actions. Deliberately raw SQL throughout —
// rows travel as Postgres jsonb (to_jsonb, snake_case) so the engine compares
// like with like, and the executor never needs a per-table drizzle mapping.
import { sql, type SQL } from "drizzle-orm";
import { getDb, dbSupportsTransactions } from "@/db";
import {
  mergeOps,
  opFieldKeys,
  SYNCED_TABLES,
  stableStringify,
  type LocalRow,
  type LocalState,
  type SyncOp,
  type WriteAction,
} from "./engine";
import { replacePassageRefs } from "@/lib/passages/refs";

// The minimal db surface apply needs; both drizzle drivers satisfy it, and the
// verify suite passes its own node-postgres instances for the two-DB tier.
export type SyncDb = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
  transaction<T>(fn: (tx: SyncDb) => Promise<T>): Promise<T>;
};

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): ReturnType<typeof sql.identifier> {
  if (!IDENT.test(name)) throw new Error(`sync: refusing identifier "${name}"`);
  return sql.identifier(name);
}

// jsonb columns arrive as JS objects/arrays; stringify them so the pg driver
// doesn't render a JS array as a Postgres array literal. Scalars pass through
// and Postgres coerces the unknown-typed param from the column context.
function bind(value: unknown): unknown {
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

// uuid[] params as an explicit Postgres array literal — drizzle's sql template
// doesn't reliably map a JS array param across both drivers. Values are
// validated uuids, so the literal is injection-safe.
const UUID = /^[0-9a-f-]{36}$/i;
function uuidArray(ids: string[]): string {
  for (const id of ids) {
    if (!UUID.test(id)) throw new Error(`sync: refusing non-uuid id "${id}"`);
  }
  return `{${ids.join(",")}}`;
}

async function readLocalState(db: SyncDb, ops: SyncOp[]): Promise<LocalState> {
  const owners = await db.execute(sql`select id from users`);
  const state: LocalState = {
    ownerIds: new Set(owners.rows.map((r) => String(r.id))),
    rows: new Map(),
    relationByKey: new Map(),
  };

  // Group the batch's row ids per table.
  const byTbl = new Map<string, Set<string>>();
  for (const op of ops) {
    if (!SYNCED_TABLES[op.tbl]) continue;
    let set = byTbl.get(op.tbl);
    if (!set) byTbl.set(op.tbl, (set = new Set()));
    set.add(op.rowId);
  }

  for (const [tbl, idSet] of byTbl) {
    const ids = [...idSet];
    // Current rows, rendered as jsonb so they match op.changed byte-for-byte.
    // `types` has a text pk; its ops carry the md5-derived rowId the trigger
    // writes, so the lookup recomputes it in SQL.
    const rows =
      tbl === "types"
        ? await db.execute(
            sql`select md5('types:' || t.key)::uuid::text as row_id, to_jsonb(t) as row
                from types t where md5('types:' || t.key)::uuid = any(${uuidArray(ids)}::uuid[])`
          )
        : await db.execute(
            sql`select t.id::text as row_id, to_jsonb(t) - 'search' as row
                from ${ident(tbl)} t where t.id = any(${uuidArray(ids)}::uuid[])`
          );
    for (const r of rows.rows) {
      state.rows.set(`${tbl}:${r.row_id}`, {
        row: r.row as Record<string, unknown>,
        fields: {},
      });
    }
    for (const id of ids) {
      const key = `${tbl}:${id}`;
      if (!state.rows.has(key)) state.rows.set(key, { row: null, fields: {} });
    }

    // Per-field stamps from the local oplog: the latest local write per field
    // (origin device when that write was itself an applied foreign op).
    // ponytail: scans every op for the touched rows; bounded once the
    // retention prune lands (phase 3), fine for v1 batch sizes.
    const stamps = await db.execute(
      sql`select to_jsonb(o) as op from sync_ops o
          where o.tbl = ${tbl} and o.row_id = any(${uuidArray(ids)}::uuid[]) order by o.seq`
    );
    for (const s of stamps.rows) {
      const o = s.op as {
        row_id: string;
        at: string;
        device_id: string;
        origin_device_id: string | null;
        kind: string;
        changed: Record<string, unknown>;
      };
      const local = state.rows.get(`${tbl}:${o.row_id}`);
      if (!local) continue;
      const stamp = { at: o.at, deviceId: o.origin_device_id ?? o.device_id };
      for (const f of opFieldKeys(tbl, o.changed)) local.fields[f] = stamp;
    }
  }

  // relations set membership: resolve the natural keys the batch touches.
  const relOps = ops.filter((o) => o.tbl === "relations");
  if (relOps.length > 0) {
    const srcIds = [
      ...new Set(
        relOps
          .map((o) => o.changed.source_id)
          .filter((v): v is string => typeof v === "string")
      ),
    ];
    if (srcIds.length > 0) {
      const rels = await db.execute(
        sql`select to_jsonb(r) as row from relations r where r.source_id = any(${uuidArray(srcIds)}::uuid[])`
      );
      for (const r of rels.rows) {
        const row = r.row as Record<string, unknown>;
        state.relationByKey.set(`${row.source_id}|${row.target_id}|${row.role}`, String(row.id));
        const key = `relations:${row.id}`;
        const existing = state.rows.get(key);
        state.rows.set(key, { row, fields: existing?.fields ?? {} });
      }
    }
  }

  // Bodies already snapshotted, so a losing body never lands in revisions twice.
  const bodyItemIds = [
    ...new Set(ops.filter((o) => o.tbl === "items" && "body" in o.changed).map((o) => o.rowId)),
  ];
  if (bodyItemIds.length > 0) {
    const revs = await db.execute(
      sql`select item_id::text as item_id, body from revisions where item_id = any(${uuidArray(bodyItemIds)}::uuid[])`
    );
    const byItem = new Map<string, string[]>();
    for (const r of revs.rows) {
      const list = byItem.get(String(r.item_id)) ?? [];
      list.push(stableStringify(r.body));
      byItem.set(String(r.item_id), list);
    }
    for (const [itemId, bodies] of byItem) {
      const local = state.rows.get(`items:${itemId}`);
      if (local) (local as LocalRow).revisionBodies = bodies;
    }
  }

  return state;
}

// Carrying the origin INSIDE the statement, for drivers with no session
// (ADR-248). The oplog trigger stamps origin_device_id from the
// ledgr.sync_origin GUC, and `SET LOCAL` needs a session, which neon-http does
// not have — so on the cloud every applied write was logged as if the cloud
// itself had made it. That is not cosmetic: the merge reads those stamps back,
// so the NEXT body from the same peer looked like a two-device conflict,
// snapshotted the previous body into `revisions` and flagged the item
// syncBodyMerged. One note collected 37 revisions in an afternoon that way
// (2026-09-03), 133 sub-debounce revisions across 74 flagged items.
//
// A single statement is its own transaction, so a set_config(…, is_local)
// evaluated BY that statement still reaches the AFTER trigger that ends it. It
// has to sit somewhere the planner must evaluate: an unreferenced SELECT CTE is
// dropped, but a FROM item, a USING item and a RETURNING expression are not
// (all three verified against Neon before this landed). `origin` is undefined
// on the transactional path, where the caller has already SET LOCAL it.
function originFrom(origin: string | undefined, clause: "from" | "using") {
  if (origin === undefined) return sql``;
  const kw = clause === "from" ? sql` from ` : sql` using `;
  return sql`${kw}(select set_config('ledgr.sync_origin', ${origin}, true)) as _origin`;
}

function originReturning(origin: string | undefined) {
  if (origin === undefined) return sql``;
  return sql` returning (select set_config('ledgr.sync_origin', ${origin}, true)) as _origin`;
}

async function runAction(
  db: SyncDb,
  action: WriteAction,
  origin?: string
): Promise<void> {
  if (action.kind === "insert") {
    const cols = Object.keys(action.row);
    await db.execute(
      sql`insert into ${ident(action.tbl)} (${sql.join(cols.map(ident), sql`, `)})
          values (${sql.join(
            cols.map((c) => sql`${bind(action.row[c])}`),
            sql`, `
          )})
          on conflict do nothing${originReturning(origin)}`
    );
    return;
  }
  if (action.kind === "update") {
    const sets = Object.entries(action.fields).map(
      ([c, v]) => sql`${ident(c)} = ${bind(v)}`
    );
    await db.execute(
      sql`update ${ident(action.tbl)} set ${sql.join(sets, sql`, `)}${originFrom(origin, "from")}
          where ${ident(action.tbl)}.${ident(action.pkCol)} = ${action.pkVal}`
    );
    return;
  }
  if (action.kind === "delete") {
    await db.execute(
      sql`delete from ${ident(action.tbl)}${originFrom(origin, "using")}
          where ${ident(action.tbl)}.${ident(action.pkCol)} = ${action.pkVal}`
    );
    return;
  }
  // snapshot_revision: the losing side of a body conflict, forced into the
  // same revisions safety net every ordinary save uses.
  await db.execute(
    sql`insert into revisions (item_id, body)
        values (${action.itemId}, ${bind(action.body)})${originReturning(origin)}`
  );
}

/**
 * The item + body an action wrote, when the write could change that item's
 * passage edges: an insert carrying a body, or an update whose merged fields
 * include one. Anything else (a soft-delete stamp, a title edit, a non-items
 * table) yields null, so a 500-op batch only derives for the bodies in it.
 *
 * `fields` and `row` already hold the MERGED winning values, so the derived
 * edges match what the row will actually contain and no re-read is needed.
 */
export function passageBodyFromAction(
  action: WriteAction
): { itemId: string; body: unknown } | null {
  if (action.kind === "insert" && action.tbl === "items" && action.row.body != null) {
    return { itemId: String(action.row.id), body: action.row.body };
  }
  if (action.kind === "update" && action.tbl === "items" && "body" in action.fields) {
    return { itemId: action.pkVal, body: action.fields.body };
  }
  return null;
}

/** One change the hub could not apply, parked instead of re-tried forever
 * (ADR-241). Carries enough to identify the row without carrying its
 * contents: this travels back to the peer and into the error log. */
export type ParkedAction = {
  kind: string;
  table: string;
  id: string | null;
  error: string;
};
export type ApplyResult = { actions: number; rejected: number; parked: ParkedAction[] };

/** Which row an action targets, for a parked-change report. */
function actionTarget(a: WriteAction): { table: string; id: string | null } {
  if (a.kind === "snapshot_revision") return { table: "revisions", id: a.itemId };
  if (a.kind === "insert") return { table: a.tbl, id: null };
  return { table: a.tbl, id: a.pkVal };
}

// ── Batch execution plan (ADR-206 addendum 7) ───────────────────────────────
//
// items DELETE actions are pulled out of the in-order stream and executed as
// ONE multi-row statement per origin at the end of the batch. The reason is
// items.parent_id, the one restricting FK among the synced tables (everything
// else cascades FROM items): when the hub hard-deletes a parent and its
// children in one statement, its own FK check happens at end-of-statement, but
// the row-level triggers log one op per row in arbitrary physical order — the
// dev rig caught "delete parent (seq 25), delete child (seq 26)". Replaying
// those as separate statements fails the FK on the parent, the whole batch
// rolls back, the cursor never advances, and the peer retries the same batch
// forever: a hard wedge. One multi-row DELETE gets the same end-of-statement
// FK semantics the hub had, so within-statement trigger order stops mattering.
//
// Grouped per origin so the GUC stamping (and therefore echo suppression)
// stays per-writer. Accepted reordering ceiling: a hard-delete followed by a
// re-insert of the SAME uuid inside one batch would now execute insert-then-
// delete; no app path re-inserts a purged uuid, and uuids are never reused.
export type ItemsDeleteGroup = { origin: string; ids: string[] };
export type ActionPlan = { stream: WriteAction[]; itemsDeletes: ItemsDeleteGroup[] };

export function planActions(actions: WriteAction[]): ActionPlan {
  const stream: WriteAction[] = [];
  const groups = new Map<string, ItemsDeleteGroup>();
  for (const a of actions) {
    if (a.kind === "delete" && a.tbl === "items") {
      let g = groups.get(a.origin);
      if (!g) groups.set(a.origin, (g = { origin: a.origin, ids: [] }));
      g.ids.push(a.pkVal);
    } else {
      stream.push(a);
    }
  }
  return { stream, itemsDeletes: [...groups.values()] };
}

/**
 * Merge + execute a batch of foreign ops. Either way the oplog triggers see
 * ledgr.sync_origin set to the op's ORIGINAL writer, so origin_device_id is
 * stamped, push can exclude echoes, and the merge never mistakes a peer's own
 * earlier write for a competing local one. On drivers with sessions
 * (node-postgres) the whole batch runs in one transaction and each action SET
 * LOCALs the GUC; on neon-http (no session) each statement carries the
 * set_config itself — see originFrom/originReturning (ADR-248).
 */
export async function applySyncOps(
  ops: SyncOp[],
  opts: { db?: SyncDb; transactions?: boolean } = {}
): Promise<ApplyResult> {
  const db = opts.db ?? (getDb() as unknown as SyncDb);
  const useTx = opts.transactions ?? (opts.db ? false : dbSupportsTransactions());

  const state = await readLocalState(db, ops);
  const { actions, rejected } = mergeOps(ops, state);
  if (actions.length === 0) return { actions: 0, rejected: rejected.length, parked: [] };

  const plan = planActions(actions);

  const deleteItemsGroup = async (tgt: SyncDb, g: ItemsDeleteGroup, origin?: string) => {
    await tgt.execute(
      sql`delete from items${originFrom(origin, "using")}
          where items.id = any(${uuidArray(g.ids)}::uuid[])`
    );
  };

  // ADR-241. A change the hub can NEVER apply used to take the whole batch
  // down with it: the exchange returned an error, the peer's push cursor never
  // advanced, and the identical batch went back out on the next retry, forever.
  // On 2026-08-30 one such change ("delete the day_log type", which the hub's
  // own rows still referenced) did that 120 times in 24 minutes. Parking it
  // keeps the rest of the batch moving and hands the failure back to be shown.
  const parked: ParkedAction[] = [];
  const park = (a: WriteAction, err: unknown) => {
    const { table, id } = actionTarget(a);
    parked.push({
      kind: a.kind,
      table,
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  if (useTx) {
    // ponytail: the transactional path stays all-or-nothing, because a failed
    // statement has already poisoned the transaction and nothing after it can
    // run. Parking here needs a statement-level SAVEPOINT per action; add that
    // if a local-Postgres hub ever hits the same wall. The hub that hit it is
    // the cloud one, which takes the branch below.
    await db.transaction(async (tx) => {
      let origin: string | null = null;
      const setOrigin = async (next: string) => {
        if (next === origin) return;
        origin = next;
        await tx.execute(sql`select set_config('ledgr.sync_origin', ${next}, true)`);
      };
      for (const action of plan.stream) {
        await setOrigin(action.origin);
        await runAction(tx, action);
        // Derived data the row write cannot carry: passage_refs is outside
        // ADR-206's synced set and has no trigger, so a body arriving here
        // must rebuild its own edges or the peer's passage index silently
        // freezes. Inside the transaction, so the two commit together.
        const derived = passageBodyFromAction(action);
        if (derived) await replacePassageRefs(tx, derived.itemId, derived.body);
      }
      for (const g of plan.itemsDeletes) {
        await setOrigin(g.origin);
        await deleteItemsGroup(tx, g);
      }
    });
  } else {
    for (const action of plan.stream) {
      try {
        await runAction(db, action, action.origin);
        const derived = passageBodyFromAction(action);
        if (derived) await replacePassageRefs(db, derived.itemId, derived.body);
      } catch (err) {
        park(action, err);
      }
    }
    for (const g of plan.itemsDeletes) {
      try {
        await deleteItemsGroup(db, g, g.origin);
      } catch (err) {
        // The group is one statement, so one FK refusal parks the whole
        // family. Named by its first id, which is what a reader can look up.
        park(
          { kind: "delete", tbl: "items", ownerId: "", origin: g.origin, pkCol: "id", pkVal: g.ids[0] },
          err
        );
      }
    }
  }
  return { actions: actions.length - parked.length, rejected: rejected.length, parked };
}
