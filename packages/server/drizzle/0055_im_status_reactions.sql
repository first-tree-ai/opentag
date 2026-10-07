ALTER TABLE "im_message_deliveries" ADD COLUMN "status_reaction_desired" text;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "status_reaction_applied" text;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "status_reaction_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "status_reaction_attempts" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "im_message_deliveries_status_reaction_idx" ON "im_message_deliveries" USING btree ("status_reaction_retry_at") WHERE "im_message_deliveries"."status_reaction_desired" is not null
        and "im_message_deliveries"."status_reaction_desired" is distinct from "im_message_deliveries"."status_reaction_applied";