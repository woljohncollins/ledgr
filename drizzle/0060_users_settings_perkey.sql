-- Per-KEY settings ops (ADR-226).
--
-- `users.settings` is one jsonb column holding every per-owner preference, and
-- the sync merge is per-FIELD, so the whole blob was a single last-writer-wins
-- unit. Any settings write on any install therefore carried that install's
-- entire view of settings and, on arrival, replaced the other side's — silently
-- reverting every key the writer had not yet pulled.
--
-- Job ownership made that theoretical problem a live one. The slot lives in
-- `settings.jobOwners`, the assigned machine stamps `lastRunAt` into it after a
-- run, and a peer syncing hourly does that from an hour-old copy of every other
-- key. The owner would move a job in the cloud, change an unrelated setting on
-- the peer, and watch the assignment undo itself with nothing in any log.
--
-- The fix is here rather than in the merge alone: log only the top-level
-- settings keys that actually CHANGED. The engine then stamps and merges them
-- independently (`settings.<key>`), so two installs editing different
-- preferences both survive, and an install that rewrites a key with the value it
-- already had logs nothing for it at all.
--
-- Everything else about the function is unchanged; it is restated whole because
-- CREATE OR REPLACE FUNCTION has no other form.
CREATE OR REPLACE FUNCTION sync_log_op() RETURNS trigger
LANGUAGE plpgsql AS $sync$
DECLARE
  v_row jsonb;
  v_changed jsonb;
  v_kind text;
  v_row_id uuid;
  v_owner uuid;
  v_settings jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_kind := 'insert';
    v_row := to_jsonb(NEW) - 'search';
    v_changed := v_row;
  ELSIF TG_OP = 'UPDATE' THEN
    v_kind := 'update';
    v_row := to_jsonb(NEW) - 'search';
    SELECT coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) INTO v_changed
    FROM jsonb_each(v_row) n
    WHERE (to_jsonb(OLD) - 'search') -> n.key IS DISTINCT FROM n.value;
    IF v_changed = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
  ELSE
    v_kind := 'delete';
    v_row := to_jsonb(OLD) - 'search';
    v_changed := v_row;
  END IF;

  IF TG_TABLE_NAME = 'users' THEN
    -- Only the settings keys that moved. The trigger on this table fires on
    -- UPDATE alone (users_sync_u), so OLD is always available; the ELSE arm is
    -- defensive only.
    IF TG_OP = 'UPDATE' THEN
      SELECT coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) INTO v_settings
      FROM jsonb_each(coalesce(v_row -> 'settings', '{}'::jsonb)) n
      WHERE coalesce(to_jsonb(OLD) -> 'settings', '{}'::jsonb) -> n.key IS DISTINCT FROM n.value;
    ELSE
      v_settings := coalesce(v_row -> 'settings', '{}'::jsonb);
    END IF;
    IF v_settings = '{}'::jsonb THEN
      -- The diff walks NEW's keys, so only a REMOVED top-level key can land
      -- here (the trigger's WHEN clause already proved settings changed).
      -- Nothing in the app removes one — parseSettings always writes a
      -- complete blob — but if anything ever does, send the whole blob so the
      -- removal still travels. Coarser merge, never a lost change.
      v_settings := coalesce(v_row -> 'settings', '{}'::jsonb);
    END IF;
    v_changed := jsonb_build_object('settings', v_settings);
    v_owner := (v_row ->> 'id')::uuid;
  ELSIF v_row ? 'owner_id' THEN
    v_owner := (v_row ->> 'owner_id')::uuid;
  ELSIF TG_TABLE_NAME = 'relations' THEN
    SELECT owner_id INTO v_owner FROM items WHERE id = (v_row ->> 'source_id')::uuid;
  ELSIF TG_TABLE_NAME = 'revisions' THEN
    SELECT owner_id INTO v_owner FROM items WHERE id = (v_row ->> 'item_id')::uuid;
  ELSE
    SELECT id INTO v_owner FROM users ORDER BY created_at LIMIT 1;
  END IF;
  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_row ? 'id' THEN
    v_row_id := (v_row ->> 'id')::uuid;
  ELSE
    v_row_id := md5(TG_TABLE_NAME || ':' || (v_row ->> 'key'))::uuid;
  END IF;

  INSERT INTO sync_ops (device_id, origin_device_id, owner_id, tbl, row_id, kind, changed, schema_ver)
  VALUES (
    (SELECT id FROM sync_device LIMIT 1),
    nullif(current_setting('ledgr.sync_origin', true), '')::uuid,
    v_owner,
    TG_TABLE_NAME,
    v_row_id,
    v_kind,
    v_changed,
    (SELECT ver FROM sync_schema_ver LIMIT 1)
  );
  RETURN NULL;
END
$sync$;
