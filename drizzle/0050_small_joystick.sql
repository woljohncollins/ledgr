ALTER TABLE "types" ADD COLUMN "listen_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "types" ADD COLUMN "listen_open_in_edge" boolean DEFAULT false NOT NULL;