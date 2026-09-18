CREATE TABLE "installs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'local' NOT NULL,
	"app_version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installs_owner_idx" ON "installs" USING btree ("owner_id");--> statement-breakpoint
-- The roster is a SYNCED table (ADR-220), so it needs the same oplog triggers
-- every other synced table has. No change to sync_log_op() is required: the
-- function already derives the owner from an `owner_id` column and the row id
-- from an `id` column, which is exactly this table's shape.
CREATE TRIGGER installs_sync_id AFTER INSERT OR DELETE ON installs
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
CREATE TRIGGER installs_sync_u AFTER UPDATE ON installs
  FOR EACH ROW EXECUTE FUNCTION sync_log_op();--> statement-breakpoint
-- A synced table's SHAPE changed, so the wire stamp moves with it (the rule
-- recorded on sync_schema_ver in schema.ts). Peers refuse to exchange ops
-- across different stamps, which is the version gate doing its job: every peer
-- must take this update before sync between them resumes.
UPDATE "sync_schema_ver" SET "ver" = '0058_installs_roster';
