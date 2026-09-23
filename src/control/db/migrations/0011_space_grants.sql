CREATE TABLE "space_grants" (
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"space_id" text NOT NULL,
	"access" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_grants_pk" PRIMARY KEY("membership_id","space_id"),
	CONSTRAINT "space_grant_access_valid" CHECK ("space_grants"."access" in ('read','write'))
);--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_grants" ADD CONSTRAINT "space_grants_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_grants_org_idx" ON "space_grants" USING btree ("organization_id");--> statement-breakpoint
-- Backfill: the access every member had through a live connection becomes a
-- grant. Company Spaces only; a write anywhere beats a read.
INSERT INTO "space_grants" ("organization_id", "membership_id", "space_id", "access", "granted_by")
SELECT c."organization_id", c."membership_id", s."id",
       CASE WHEN bool_or(c."write_space_id" = s."id") THEN 'write' ELSE 'read' END,
       'migration:0011'
FROM "connections" c
JOIN "spaces" s
  ON s."organization_id" = c."organization_id"
 AND s."owner_membership_id" IS NULL
 AND (c."write_space_id" = s."id" OR c."read_space_ids" ? s."id")
WHERE c."state" IN ('pending', 'active')
GROUP BY c."organization_id", c."membership_id", s."id"
ON CONFLICT DO NOTHING;
