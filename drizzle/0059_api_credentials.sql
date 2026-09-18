CREATE TABLE "api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_key_id_uq" ON "api_credentials" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "api_credentials_owner_idx" ON "api_credentials" USING btree ("owner_id");