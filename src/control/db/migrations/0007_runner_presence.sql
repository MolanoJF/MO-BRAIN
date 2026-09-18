CREATE TABLE "runner_presence" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"harness_version" text NOT NULL
);
