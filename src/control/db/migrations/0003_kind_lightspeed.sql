CREATE TABLE "held_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"schedule_id" text,
	"run_id" text NOT NULL,
	"schedule_name" text NOT NULL,
	"report_path" text,
	"headline" text NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_into_run_id" text
);
--> statement-breakpoint
CREATE TABLE "schedule_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"schedule_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"detail" jsonb,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"slot" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"claimed_by" text,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"classification" text,
	"report_path" text,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_state_valid" CHECK ("schedule_runs"."state" in (
    'pending','running','succeeded','failed','blocked','cancelled',
    'lease_expired','skipped_overlap','skipped_catchup','held')),
	CONSTRAINT "run_classification_valid" CHECK ("schedule_runs"."classification" is null or "schedule_runs"."classification" in (
    'ok','failed','blocked','conflict','lock_lost','timeout','cancelled','refused'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text,
	"name" text NOT NULL,
	"preset" text,
	"operation" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"interval_seconds" integer,
	"anchor_at" timestamp with time zone,
	"calendar_hour" integer,
	"calendar_minute" integer,
	"calendar_days_of_week" jsonb,
	"slot_minute" integer,
	"gap_policy" text DEFAULT 'shift' NOT NULL,
	"ambiguous_policy" text DEFAULT 'first' NOT NULL,
	"catchup_policy" text DEFAULT 'skip' NOT NULL,
	"overlap_policy" text DEFAULT 'skip' NOT NULL,
	"misfire_grace_seconds" integer DEFAULT 120 NOT NULL,
	"report_policy" text DEFAULT 'always' NOT NULL,
	"notifies" boolean DEFAULT false NOT NULL,
	"timeout_seconds" integer DEFAULT 900 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"last_materialized_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_kind_valid" CHECK ("schedules"."kind" in ('interval','calendar')),
	CONSTRAINT "gap_policy_valid" CHECK ("schedules"."gap_policy" in ('shift','skip')),
	CONSTRAINT "ambiguous_policy_valid" CHECK ("schedules"."ambiguous_policy" in ('first','second','both')),
	CONSTRAINT "catchup_policy_valid" CHECK ("schedules"."catchup_policy" in ('skip','run_latest','run_all')),
	CONSTRAINT "overlap_policy_valid" CHECK ("schedules"."overlap_policy" in ('skip','queue','kill_previous')),
	CONSTRAINT "report_policy_valid" CHECK ("schedules"."report_policy" in ('always','on_change_or_failure','never')),
	CONSTRAINT "shape_matches_kind" CHECK ((
    "schedules"."kind" = 'interval' and "schedules"."interval_seconds" is not null and "schedules"."anchor_at" is not null
      and "schedules"."slot_minute" is null
  ) or (
    "schedules"."kind" = 'calendar' and "schedules"."calendar_hour" is not null and "schedules"."calendar_minute" is not null
      and "schedules"."slot_minute" is not null
  )),
	CONSTRAINT "slot_minute_assignable" CHECK ("schedules"."slot_minute" is null
    or "schedules"."slot_minute" in (5,10,15,20,25,30,35,40,45,50)),
	CONSTRAINT "timeout_bounded" CHECK ("schedules"."timeout_seconds" between 30 and 21600)
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "quiet_hours_start" integer DEFAULT 23 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "quiet_hours_end" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "held_notifications" ADD CONSTRAINT "held_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_notifications" ADD CONSTRAINT "held_notifications_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_alerts" ADD CONSTRAINT "schedule_alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_alerts" ADD CONSTRAINT "schedule_alerts_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "held_notifications_pending_idx" ON "held_notifications" USING btree ("organization_id","released_at");--> statement-breakpoint
CREATE INDEX "schedule_alerts_open_idx" ON "schedule_alerts" USING btree ("organization_id","acknowledged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_schedule_slot_uq" ON "schedule_runs" USING btree ("schedule_id","slot");--> statement-breakpoint
CREATE INDEX "schedule_runs_claimable_idx" ON "schedule_runs" USING btree ("state","fire_at");--> statement-breakpoint
CREATE INDEX "schedule_runs_lease_idx" ON "schedule_runs" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_org_name_uq" ON "schedules" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "schedules_enabled_idx" ON "schedules" USING btree ("enabled");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "quiet_hours_range" CHECK ("organizations"."quiet_hours_start" between 0 and 23
    and "organizations"."quiet_hours_end" between 0 and 23);