CREATE TABLE "upgrade_checklist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"gbrain_version" text NOT NULL,
	"item_key" text NOT NULL,
	"prompt" text NOT NULL,
	"why" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "upgrade_checklist_state_valid" CHECK ("upgrade_checklist_items"."state" in ('pending','acknowledged','declined'))
);
--> statement-breakpoint
CREATE TABLE "upgrade_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"step" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	CONSTRAINT "upgrade_event_level_valid" CHECK ("upgrade_events"."level" in ('info','warn','error'))
);
--> statement-breakpoint
CREATE TABLE "upgrade_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"snapshot_id" text,
	"journal_path" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"doctor_baseline" jsonb,
	"doctor_after" jsonb,
	"failure_reason" text,
	"created_by" text,
	CONSTRAINT "upgrade_run_state_valid" CHECK ("upgrade_runs"."state" in (
  'planned','preflight_ok','quiesced','snapshot_taken','swapped','migrated',
  'playbooks_applied','gated_ok','completed','failed',
  'rolling_back','rolled_back','rollback_failed'))
);
--> statement-breakpoint
ALTER TABLE "upgrade_checklist_items" ADD CONSTRAINT "upgrade_checklist_items_run_id_upgrade_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."upgrade_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upgrade_events" ADD CONSTRAINT "upgrade_events_run_id_upgrade_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."upgrade_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upgrade_checklist_run_key_uq" ON "upgrade_checklist_items" USING btree ("run_id","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "upgrade_events_run_seq_uq" ON "upgrade_events" USING btree ("run_id","seq");