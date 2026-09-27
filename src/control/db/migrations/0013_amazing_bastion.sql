CREATE TABLE "space_grants" (
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"space_id" text NOT NULL,
	"access" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_grants_pk" PRIMARY KEY("membership_id","space_id"),
	CONSTRAINT "space_grant_access_valid" CHECK ("space_grants"."access" in ('read','write'))
);
--> statement-breakpoint
ALTER TABLE "brains" ADD COLUMN "schema_pack" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "verify_status" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "verify_message" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "private_spaces_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "owner_membership_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invite_placeholder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_grants_org_idx" ON "space_grants" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_membership_id_memberships_id_fk" FOREIGN KEY ("owner_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_owner_membership_uq" ON "spaces" USING btree ("organization_id","owner_membership_id") WHERE "spaces"."owner_membership_id" is not null;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connection_verify_status_valid" CHECK ("connections"."verify_status" in ('ok','partial','failed') or "connections"."verify_status" is null);