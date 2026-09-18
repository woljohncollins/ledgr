CREATE TABLE "sync_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "sync_ops" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"origin_device_id" uuid,
	"owner_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"tbl" text NOT NULL,
	"row_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"changed" jsonb NOT NULL,
	"schema_ver" text NOT NULL,
	CONSTRAINT "sync_ops_kind_check" CHECK ("sync_ops"."kind" in ('insert', 'update', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "sync_peers" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_pushed_seq" bigint DEFAULT 0 NOT NULL,
	"last_pulled_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sync_schema_ver" (
	"ver" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sync_ops_tbl_row_idx" ON "sync_ops" USING btree ("tbl","row_id");--> statement-breakpoint
-- ── Hand-written from here down (drizzle-kit doesn't emit seeds/triggers) ──
-- Self-assign a device identity: every instance (prod Neon, Tyler's, local
-- peers) gets exactly one sync_device row the moment it migrates.
INSERT INTO "sync_device" ("id")
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM "sync_device");--> statement-breakpoint
-- The schema-version stamp the trigger writes onto every op. Any FUTURE
-- migration that changes a synced table's shape must UPDATE this row to its
-- own tag (see src/db/schema.ts syncSchemaVer).
INSERT INTO "sync_schema_ver" ("ver")
SELECT '0054_sync_spine'
WHERE NOT EXISTS (SELECT 1 FROM "sync_schema_ver");--> statement-breakpoint
-- One trigger function for all synced tables. Notes:
--  * changed = full row (insert/delete) or only-changed-fields (update),
--    diffed via to_jsonb(OLD)/to_jsonb(NEW); the generated `search` column is
--    stripped so ops stay small and never carry derived state.
--  * users sync ONLY the settings column (plan decision 14).
--  * owner_id comes from the row where it exists; relations/revisions look it
--    up through their item (a cascade delete after the item is already gone
--    finds no owner and logs nothing — correct, because the remote side's own
--    FK cascade repeats the cleanup). types are instance-global, so their ops
--    carry the instance's single owner.
--    ponytail: first-users-row owner for `types` assumes the single-user
--    instance; revisit if multi-user ever becomes real.
--  * row_id for `types` (text pk) is md5('types:'||key)::uuid — deterministic
--    everywhere; the real key travels in `changed`.
--  * origin_device_id reads the ledgr.sync_origin GUC (set per-transaction by
--    the apply layer on drivers with sessions) to mark echoes of foreign ops.
CREATE OR REPLACE FUNCTION sync_log_op() RETURNS trigger
LANGUAGE plpgsql AS $sync$
DECLARE
  v_row jsonb;
  v_changed jsonb;
  v_kind text;
  v_row_id uuid;
  v_owner uuid;
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
    v_changed := jsonb_build_object('settings', v_row -> 'settings');
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
$sync$;--> statement-breakpoint
-- Row-level AFTER triggers on exactly the v1 synced set (plan decision 14):
-- items, relations, types, revisions, dashboards, views, templates, and users
-- (settings changes only). UPDATE triggers are guarded WHEN (OLD.* IS
-- DISTINCT FROM NEW.*) so a no-op write logs nothing — that guard plus
-- idempotent apply is what terminates echo loops.
CREATE TRIGGER items_sync_id AFTER INSERT OR DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER items_sync_u AFTER UPDATE ON items
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER relations_sync_id AFTER INSERT OR DELETE ON relations
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER relations_sync_u AFTER UPDATE ON relations
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER types_sync_id AFTER INSERT OR DELETE ON types
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER types_sync_u AFTER UPDATE ON types
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER revisions_sync_id AFTER INSERT OR DELETE ON revisions
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER revisions_sync_u AFTER UPDATE ON revisions
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER dashboards_sync_id AFTER INSERT OR DELETE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER dashboards_sync_u AFTER UPDATE ON dashboards
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER views_sync_id AFTER INSERT OR DELETE ON views
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER views_sync_u AFTER UPDATE ON views
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER templates_sync_id AFTER INSERT OR DELETE ON templates
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER templates_sync_u AFTER UPDATE ON templates
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER users_sync_u AFTER UPDATE ON users
  FOR EACH ROW WHEN (OLD.settings IS DISTINCT FROM NEW.settings) EXECUTE FUNCTION sync_log_op();
