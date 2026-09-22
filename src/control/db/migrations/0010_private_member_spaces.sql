ALTER TABLE "organizations" ADD COLUMN "private_spaces_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "owner_membership_id" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_membership_id_memberships_id_fk" FOREIGN KEY ("owner_membership_id") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_owner_membership_uq" ON "spaces" USING btree ("organization_id","owner_membership_id") WHERE "owner_membership_id" is not null;
