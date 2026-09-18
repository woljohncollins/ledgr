ALTER TABLE "sync_peers" ADD COLUMN "hold_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_peers" ADD COLUMN "grace_days" integer;