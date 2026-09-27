ALTER TABLE "connections" ADD COLUMN "verify_status" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "verify_message" text;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connection_verify_status_valid" CHECK ("connections"."verify_status" in ('ok','partial','failed') or "connections"."verify_status" is null);
