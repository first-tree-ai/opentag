ALTER TABLE "im_message_deliveries" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "report_owner_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "result_hash" text;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "turn_report" jsonb;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "last_error_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_deliveries_turn_id_unique" ON "im_message_deliveries" USING btree ("turn_id") WHERE "im_message_deliveries"."turn_id" is not null;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_custody_shape" CHECK (("im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."input_hash" is not null and "im_message_deliveries"."turn_id" is not null and "im_message_deliveries"."report_owner_instance_id" is not null and "im_message_deliveries"."accepted_at" is not null)
        or ("im_message_deliveries"."state" <> 'accepted' and "im_message_deliveries"."turn_id" is null and "im_message_deliveries"."report_owner_instance_id" is null and "im_message_deliveries"."reported_at" is null and "im_message_deliveries"."turn_report" is null and "im_message_deliveries"."result_hash" is null));--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_report_shape" CHECK (("im_message_deliveries"."reported_at" is null and "im_message_deliveries"."turn_report" is null)
        or ("im_message_deliveries"."reported_at" is not null and "im_message_deliveries"."turn_report" is not null and "im_message_deliveries"."result_hash" is not null));
