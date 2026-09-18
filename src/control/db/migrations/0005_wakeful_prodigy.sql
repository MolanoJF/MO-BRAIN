CREATE TABLE "agent_run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "agent_run_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" text,
	"stop_reason" text,
	"http_status" integer
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" text,
	"model" text NOT NULL,
	"harness_version" text NOT NULL,
	"budget_usd" text NOT NULL,
	"cost_usd" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"num_turns" integer DEFAULT 0 NOT NULL,
	"failure_class" text,
	"failure_detail" jsonb,
	"diff_summary" jsonb,
	"heads_before" jsonb,
	"heads_after" jsonb,
	"reverted_at" timestamp with time zone,
	"revert_commit" text,
	"token_revoked_at" timestamp with time zone,
	CONSTRAINT "agent_failure_class_valid" CHECK ("agent_runs"."failure_class" is null or "agent_runs"."failure_class" in (
    'budget_exceeded','agent_failed','infra_failed','timeout','refused'))
);
--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT "run_classification_valid";--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "operation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "server_client_id" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "job_type" text DEFAULT 'gbrain_command' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "agent_prompt" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "agent_model" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "agent_max_tokens" integer;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "agent_budget_usd" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "agent_harness_version" text;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_usage" ADD CONSTRAINT "agent_run_usage_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_run_id_schedule_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_seq_uq" ON "agent_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_usage_run_seq_uq" ON "agent_run_usage" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_runs_org_idx" ON "agent_runs" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "run_classification_valid" CHECK ("schedule_runs"."classification" is null or "schedule_runs"."classification" in (
    'ok','failed','blocked','conflict','lock_lost','timeout','cancelled','refused',
    'budget_exceeded','agent_failed','infra_failed'));--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "job_type_valid" CHECK ("schedules"."job_type" in ('gbrain_command','agent_prompt'));--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "shape_matches_job_type" CHECK ((
    "schedules"."job_type" = 'agent_prompt' and "schedules"."operation" is null
      and "schedules"."agent_prompt" is not null and "schedules"."agent_model" is not null
      and "schedules"."agent_max_tokens" is not null and "schedules"."agent_budget_usd" is not null
      and "schedules"."agent_harness_version" is not null
  ) or (
    "schedules"."job_type" = 'gbrain_command' and "schedules"."operation" is not null
      and "schedules"."agent_prompt" is null and "schedules"."agent_model" is null
      and "schedules"."agent_max_tokens" is null and "schedules"."agent_budget_usd" is null
      and "schedules"."agent_harness_version" is null
  ));