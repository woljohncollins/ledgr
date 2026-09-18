// The pure merge (sync spine, plans/local-hub-idea-to-cutover.html). No I/O:
// a batch of foreign ops + a snapshot of local state in, a deterministic list
// of write actions out. The impure twin (apply.ts) gathers the state and
// executes the actions; verify-sync.mts hammers this file directly.
//
// Merge rules (locked in the plan's "Hard-to-reverse decisions" — do not
// redesign here):
//  * Per-field last-writer-wins, compared by (at, device-id tiebreak).
//  * items.body special-case: the LOSING body of a true conflict is
//    snapshotted to revisions and the item gets a "merged offline, check
//    revisions" flag under properties (syncBodyMerged).
//  * relations are set ops: insert if absent, delete if present, keyed by the
//    (source_id, target_id, role) natural key, idempotent.
//  * Deletes of soft-delete tables arrive as ordinary field updates
//    (deleted_at); a kind:"delete" op is a real hard delete (relations rows,
//    the 30-day purge).
//  * Applying the same batch twice is a no-op: actions are emitted only when
//    a value actually changes, and the state map is updated in place as
//    actions are produced.
//  * Owner scope: ops whose owner_id isn't in the instance's owner set are
//    refused, never applied.
//
// Everything row-shaped in here is the POSTGRES rendering: snake_case column
// names and jsonb-normalized values (both op.changed and LocalRow.row come
// from to_jsonb), so equality is a canonical-JSON compare, not a drizzle-vs-
// wire guessing game.

export type SyncOpKind = "insert" | "update" | "delete";

export type SyncOp = {
  seq: number;
  deviceId: string;
  originDeviceId?: string | null;
  ownerId: string;
  at: string; // ISO timestamptz, as Postgres renders it
  tbl: string;
  rowId: string;
  kind: SyncOpKind;
  changed: Record<string, unknown>;
  schemaVer: string;
};

// The last local write we know about for one field of one row: when and by
// which device (origin device when the local write was itself an applied
// foreign op). This is what per-field LWW compares against.
export type FieldStamp = { at: string; deviceId: string };

export type LocalRow = {
  // Current row as Postgres jsonb (to_jsonb, snake_case), or null when absent.
  row: Record<string, unknown> | null;
  // field -> latest local op stamp for that field (from the local oplog).
  fields: Record<string, FieldStamp>;
  // items only: canonical-JSON strings of bodies already in revisions for this
  // item, so a losing body is never snapshotted twice (double-apply no-op).
  revisionBodies?: string[];
};

export type LocalState = {
  // The instance's owner set (users.id values). Ops outside it are refused.
  ownerIds: ReadonlySet<string>;
  // `${tbl}:${op.rowId}` -> local row state. For `types`, apply keys these by
  // the same md5-derived rowId the trigger writes.
  rows: Map<string, LocalRow>;
  // relations natural key `${source_id}|${target_id}|${role}` -> local row id.
  relationByKey: Map<string, string>;
};

export type WriteAction =
  | { kind: "insert"; tbl: string; ownerId: string; origin: string; row: Record<string, unknown> }
  | {
      kind: "update";
      tbl: string;
      ownerId: string;
      origin: string;
      pkCol: string;
      pkVal: string;
      fields: Record<string, unknown>;
    }
  | { kind: "delete"; tbl: string; ownerId: string; origin: string; pkCol: string; pkVal: string }
  | { kind: "snapshot_revision"; ownerId: string; origin: string; itemId: string; body: unknown };

// The v1 synced set (plan decision 14) and each table's primary-key column.
export const SYNCED_TABLES: Record<string, { pk: string }> = {
  items: { pk: "id" },
  relations: { pk: "id" },
  types: { pk: "key" },
  revisions: { pk: "id" },
  dashboards: { pk: "id" },
  views: { pk: "id" },
  templates: { pk: "id" },
  users: { pk: "id" },
  // The roster (ADR-220). Safe to merge by the ordinary field-level rule
  // BECAUSE of the key: each install only ever writes its own row, so two
  // installs never contend for one. That property is what earned it a table
  // rather than a key in users.settings, which is one field to this merge.
  installs: { pk: "id" },
};

// The version gate /api/machine/sync applies FIRST: peers exchange ops only
// when both run the same bundled migration journal tag. Factored out so the
// verify script can test it with no route in the loop.
export function versionGate(localVer: string, remoteVer: string): boolean {
  return localVer === remoteVer;
}

// Canonical JSON: recursively key-sorted, so equality never depends on whether
// a value came from Postgres jsonb (sorted) or a JS literal (insertion order).
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function jsonEq(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

// ── users.settings is merged PER KEY, not as one blob (ADR-226) ─────────────
//
// `settings` is a single jsonb column carrying every per-owner preference, so
// per-field LWW made the whole blob one unit: an arriving op replaced every key
// with the writer's view, reverting anything the writer had not yet pulled. Job
// ownership lives in `settings.jobOwners` and the assigned machine stamps a run
// into it, so an hourly peer was reverting the cloud's other settings — and the
// cloud's assignment — on a schedule.
//
// So a settings op's stamped FIELDS are its top-level keys (`settings.jobOwners`,
// `settings.accent`, …), and the winners are merged into the local blob. The
// trigger sends only the keys that changed (migration 0059), which is what makes
// the stamps meaningful; a legacy op carrying the whole blob still merges
// correctly, just with every key stamped at once.
const SETTINGS_PREFIX = "settings.";

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The field names an op stamps. Shared by the merge and by apply's reading of
 * the LOCAL oplog, because a stamp written under one convention and read under
 * another is a silent LWW coin-flip.
 */
export function opFieldKeys(tbl: string, changed: Record<string, unknown>): string[] {
  if (tbl !== "users") return Object.keys(changed);
  const settings = plainObject(changed.settings);
  if (!settings) return Object.keys(changed);
  return Object.keys(settings).map((k) => SETTINGS_PREFIX + k);
}

// LWW comparison: positive when a beats b. Timestamps first, device id as the
// deterministic tiebreak (any total order works; string compare is one).
export function cmpStamp(a: FieldStamp, b: FieldStamp): number {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (ta !== tb) return ta - tb;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

// The device a write ORIGINATED on: relayed ops keep their original writer in
// origin_device_id (stamped by the relaying peer's trigger via the GUC).
function opDevice(op: SyncOp): string {
  return op.originDeviceId ?? op.deviceId;
}

function opStamp(op: SyncOp): FieldStamp {
  return { at: op.at, deviceId: opDevice(op) };
}

function stateKey(tbl: string, rowId: string): string {
  return `${tbl}:${rowId}`;
}

function relKey(row: Record<string, unknown>): string {
  return `${row.source_id}|${row.target_id}|${row.role}`;
}

export type MergeResult = {
  actions: WriteAction[];
  // Ops refused (owner outside the instance owner set, or an unknown table).
  rejected: SyncOp[];
};

/**
 * Merge a batch of foreign ops against local state. Deterministic and
 * order-independent for concurrent edits (per-field LWW), idempotent on
 * re-application (state is updated in place as actions are emitted, and no
 * action is emitted for a value already in place).
 */
export function mergeOps(ops: SyncOp[], state: LocalState): MergeResult {
  const actions: WriteAction[] = [];
  const rejected: SyncOp[] = [];

  for (const op of ops) {
    const table = SYNCED_TABLES[op.tbl];
    if (!table || !state.ownerIds.has(op.ownerId)) {
      rejected.push(op);
      continue;
    }
    if (op.tbl === "relations") {
      mergeRelationOp(op, state, actions);
      continue;
    }

    const key = stateKey(op.tbl, op.rowId);
    const local = state.rows.get(key) ?? { row: null, fields: {} };

    if (op.kind === "delete") {
      // Hard delete (purge). Soft deletes are just deleted_at updates.
      if (local.row) {
        actions.push({
          kind: "delete",
          tbl: op.tbl,
          ownerId: op.ownerId,
          origin: opDevice(op),
          pkCol: table.pk,
          pkVal: String(local.row[table.pk]),
        });
        state.rows.set(key, { ...local, row: null });
      }
      continue;
    }

    if (!local.row) {
      if (op.kind === "update") {
        // An update for a row we don't hold. Its insert op precedes it in the
        // originating device's stream, so this is transient ordering across
        // devices; skip rather than fabricate a partial row (NOT NULLs).
        continue;
      }
      const stamp = opStamp(op);
      const fields: Record<string, FieldStamp> = {};
      for (const f of opFieldKeys(op.tbl, op.changed)) fields[f] = stamp;
      actions.push({
        kind: "insert",
        tbl: op.tbl,
        ownerId: op.ownerId,
        origin: opDevice(op),
        row: op.changed,
      });
      state.rows.set(key, { ...local, row: { ...op.changed }, fields });
      continue;
    }

    if (op.tbl === "users") {
      mergeSettingsOp(op, state, key, local, actions);
      continue;
    }

    // Row present: per-field LWW, for updates AND for insert echoes /
    // concurrent creates of the same id.
    const fields: Record<string, unknown> = {};
    let bodyConflict = false;
    for (const [field, value] of Object.entries(op.changed)) {
      if (field === table.pk) continue;
      const cur = local.row[field];
      if (jsonEq(cur, value)) continue;
      const stamp = local.fields[field];
      const wins = !stamp || cmpStamp(opStamp(op), stamp) > 0;

      if (op.tbl === "items" && field === "body") {
        // A true conflict = both sides wrote the body and the last local
        // writer is a DIFFERENT device than the op's originator. The losing
        // version goes to revisions; the item gets the check-revisions flag.
        // ponytail: cross-device SEQUENTIAL edits between syncs also trip
        // this (no causality tracking without vector clocks/HLC) — the cost
        // is one extra revision + an advisory flag, which is the safe side.
        const conflict = cur != null && stamp != null && stamp.deviceId !== opDevice(op);
        const loser = wins ? cur : value;
        if (conflict) {
          const loserJson = stableStringify(loser);
          const seen = local.revisionBodies ?? [];
          if (!seen.includes(loserJson)) {
            actions.push({
              kind: "snapshot_revision",
              ownerId: op.ownerId,
              origin: opDevice(op),
              itemId: op.rowId,
              body: loser,
            });
            local.revisionBodies = [...seen, loserJson];
          }
          bodyConflict = true;
        }
        if (!wins) continue;
        fields[field] = value;
        local.fields[field] = opStamp(op);
        continue;
      }

      if (!wins) continue;
      fields[field] = value;
      local.fields[field] = opStamp(op);
    }

    if (bodyConflict) {
      // "Merged offline, check revisions" flag under properties, layered on
      // whatever properties value won this round.
      const base =
        (fields.properties !== undefined ? fields.properties : local.row.properties) ?? {};
      const flagged = { ...(base as Record<string, unknown>), syncBodyMerged: true };
      if (!jsonEq(flagged, local.row.properties)) fields.properties = flagged;
    }

    if (Object.keys(fields).length > 0) {
      actions.push({
        kind: "update",
        tbl: op.tbl,
        ownerId: op.ownerId,
        origin: opDevice(op),
        pkCol: table.pk,
        pkVal: String(local.row[table.pk]),
        fields,
      });
      state.rows.set(key, { ...local, row: { ...local.row, ...fields } });
    }
  }

  return { actions, rejected };
}

/**
 * A settings op: LWW each top-level key on its own, then write the merged blob.
 *
 * Writing the whole merged column rather than a jsonb patch keeps apply's
 * executor unchanged, and is equivalent — the merge base is the row we just
 * read, exactly as it is for every other field.
 */
function mergeSettingsOp(
  op: SyncOp,
  state: LocalState,
  key: string,
  local: LocalRow,
  actions: WriteAction[]
): void {
  const row = local.row;
  if (!row) return;
  const incoming = plainObject(op.changed.settings);
  if (!incoming) return; // nothing usable; never fabricate a settings blob
  const current = plainObject(row.settings) ?? {};
  const merged: Record<string, unknown> = { ...current };
  let changed = false;
  for (const [k, value] of Object.entries(incoming)) {
    if (jsonEq(current[k], value)) continue;
    const stamp = local.fields[SETTINGS_PREFIX + k];
    if (stamp && cmpStamp(opStamp(op), stamp) <= 0) continue;
    merged[k] = value;
    local.fields[SETTINGS_PREFIX + k] = opStamp(op);
    changed = true;
  }
  if (!changed) return;
  actions.push({
    kind: "update",
    tbl: "users",
    ownerId: op.ownerId,
    origin: opDevice(op),
    pkCol: "id",
    pkVal: String(row.id),
    fields: { settings: merged },
  });
  state.rows.set(key, { ...local, row: { ...row, settings: merged } });
}

// relations are a SET keyed by (source_id, target_id, role): two devices
// creating "the same" edge concurrently mint different uuids, so membership —
// not id — is what converges. insert-if-absent, delete-if-present, idempotent.
function mergeRelationOp(op: SyncOp, state: LocalState, actions: WriteAction[]): void {
  if (op.kind === "insert") {
    const nk = relKey(op.changed);
    if (state.relationByKey.has(nk)) return;
    actions.push({
      kind: "insert",
      tbl: "relations",
      ownerId: op.ownerId,
      origin: opDevice(op),
      row: op.changed,
    });
    state.relationByKey.set(nk, String(op.changed.id));
    state.rows.set(stateKey("relations", op.rowId), {
      row: { ...op.changed },
      fields: {},
    });
    return;
  }
  if (op.kind === "delete") {
    const nk = relKey(op.changed);
    const localId = state.relationByKey.get(nk);
    if (!localId) return;
    actions.push({
      kind: "delete",
      tbl: "relations",
      ownerId: op.ownerId,
      origin: opDevice(op),
      pkCol: "id",
      pkVal: localId,
    });
    state.relationByKey.delete(nk);
    state.rows.delete(stateKey("relations", op.rowId));
    return;
  }
  // update (match_state confirm, home flip): plain per-field LWW by row id.
  // ponytail: an update to an edge whose uuid diverged (concurrent create on
  // two devices) is skipped; the set semantics above keep membership right.
  const key = stateKey("relations", op.rowId);
  const local = state.rows.get(key);
  if (!local?.row) return;
  const fields: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(op.changed)) {
    if (field === "id") continue;
    const cur = local.row[field];
    if (stableStringify(cur ?? null) === stableStringify(value ?? null)) continue;
    const stamp = local.fields[field];
    if (stamp && cmpStamp(opStamp(op), stamp) <= 0) continue;
    fields[field] = value;
    local.fields[field] = opStamp(op);
  }
  if (Object.keys(fields).length > 0) {
    actions.push({
      kind: "update",
      tbl: "relations",
      ownerId: op.ownerId,
      origin: opDevice(op),
      pkCol: "id",
      pkVal: String(local.row.id),
      fields,
    });
    state.rows.set(key, { ...local, row: { ...local.row, ...fields } });
  }
}
