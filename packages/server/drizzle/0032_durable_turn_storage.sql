CREATE TYPE "public"."runtime_durable_work_kind" AS ENUM('session-message', 'turn-report');--> statement-breakpoint
CREATE TYPE "public"."runtime_durable_work_status" AS ENUM('accepted', 'running', 'succeeded', 'retryable', 'failed', 'dead-letter');--> statement-breakpoint
CREATE TABLE "runtime_durable_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_computer_id" uuid NOT NULL,
	"kind" "runtime_durable_work_kind" NOT NULL,
	"record_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "runtime_durable_work_status" NOT NULL,
	"attempts" integer NOT NULL,
	"accepted_at" bigint NOT NULL,
	"next_attempt_at" bigint,
	"last_error" jsonb,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runtime_durable_work_key_shape" CHECK ("runtime_durable_work"."record_key" ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
	CONSTRAINT "runtime_durable_work_attempts_nonnegative" CHECK ("runtime_durable_work"."attempts" >= 0),
	CONSTRAINT "runtime_durable_work_accepted_at_nonnegative" CHECK ("runtime_durable_work"."accepted_at" >= 0),
	CONSTRAINT "runtime_durable_work_updated_at_nonnegative" CHECK ("runtime_durable_work"."updated_at" >= 0),
	CONSTRAINT "runtime_durable_work_next_attempt_nonnegative" CHECK ("runtime_durable_work"."next_attempt_at" is null or "runtime_durable_work"."next_attempt_at" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runtime_durable_work" ADD CONSTRAINT "runtime_durable_work_workspace_computer_id_account_computers_id_fk" FOREIGN KEY ("workspace_computer_id") REFERENCES "public"."account_computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_durable_work_scope_key_unique" ON "runtime_durable_work" USING btree ("workspace_computer_id","kind","record_key");--> statement-breakpoint
CREATE INDEX "runtime_durable_work_scope_status_idx" ON "runtime_durable_work" USING btree ("workspace_computer_id","kind","status");