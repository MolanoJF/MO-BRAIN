CREATE TABLE "claim_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"write_space_id" text NOT NULL,
	"read_space_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"harness" text NOT NULL,
	"client_name" text NOT NULL,
	"gbrain_client_id" text,
	"profile" text NOT NULL,
	"token_ttl" integer NOT NULL,
	"budget_usd_per_day" text,
	"bound_slug_prefixes" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"provisioned_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_state_valid" CHECK ("connections"."state" in ('pending','active','revoked'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
ALTER TABLE "claim_links" ADD CONSTRAINT "claim_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_links" ADD CONSTRAINT "claim_links_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_write_space_id_spaces_id_fk" FOREIGN KEY ("write_space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_links_membership_idx" ON "claim_links" USING btree ("membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_org_client_name_uq" ON "connections" USING btree ("organization_id","client_name");--> statement-breakpoint
CREATE INDEX "connections_membership_idx" ON "connections" USING btree ("membership_id");