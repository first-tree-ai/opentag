CREATE TYPE "public"."session_message_outcome" AS ENUM('unknown', 'accepted', 'unreachable', 'rejected');--> statement-breakpoint
CREATE TABLE "session_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_session_id" uuid NOT NULL,
	"target_session_id" uuid NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"last_outcome" "session_message_outcome" DEFAULT 'unknown' NOT NULL,
	"last_error_code" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_messages_content_hash_shape" CHECK ("session_messages"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_messages_content_bounds" CHECK (octet_length("session_messages"."content") between 1 and 16384),
	CONSTRAINT "session_messages_error_code_shape" CHECK ("session_messages"."last_error_code" is null or ("session_messages"."last_error_code" ~ '^[a-z][a-z0-9_]{0,127}$')),
	CONSTRAINT "session_messages_attempt_count_nonnegative" CHECK ("session_messages"."attempt_count" >= 0),
	CONSTRAINT "session_messages_attempt_shape" CHECK (("session_messages"."attempt_count" = 0 and "session_messages"."last_attempt_at" is null)
        or ("session_messages"."attempt_count" > 0 and "session_messages"."last_attempt_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_shape_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_model" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_max_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_target_session_id_sessions_id_fk" FOREIGN KEY ("target_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_messages_target_created_idx" ON "session_messages" USING btree ("target_session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "session_messages_source_created_idx" ON "session_messages" USING btree ("source_session_id","created_at","id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_runtime_max_duration_valid" CHECK ("sessions"."runtime_max_duration_ms" is null or ("sessions"."runtime_max_duration_ms" > 0 and "sessions"."runtime_max_duration_ms" <= 86400000));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_runtime_model_bounds" CHECK ("sessions"."runtime_model" is null or octet_length("sessions"."runtime_model") between 1 and 128);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_runtime_reasoning_effort_bounds" CHECK ("sessions"."runtime_reasoning_effort" is null or octet_length("sessions"."runtime_reasoning_effort") between 1 and 64);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_shape_check" CHECK (("sessions"."kind" = 'channel' and "sessions"."thread_key" is null and "sessions"."created_by_session_id" is null and "sessions"."runtime_model" is null and "sessions"."runtime_reasoning_effort" is null and "sessions"."runtime_max_duration_ms" is null)
        or ("sessions"."kind" = 'thread' and "sessions"."thread_key" is not null and "sessions"."created_by_session_id" is null and "sessions"."runtime_model" is null and "sessions"."runtime_reasoning_effort" is null and "sessions"."runtime_max_duration_ms" is null)
        or ("sessions"."kind" = 'internal' and "sessions"."created_by_session_id" is not null));