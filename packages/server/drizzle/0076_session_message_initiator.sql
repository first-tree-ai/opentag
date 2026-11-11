ALTER TABLE "session_messages" ADD COLUMN "initiator_session_id" uuid;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "forward_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "legacy_local_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_im_binding_live_created_idx" ON "sessions" USING btree ("im_binding_id","created_at","id") WHERE "sessions"."ended_at" is null;