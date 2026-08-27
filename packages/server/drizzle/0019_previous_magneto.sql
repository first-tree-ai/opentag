ALTER TABLE "im_message_deliveries" DROP CONSTRAINT "im_message_deliveries_custody_shape";--> statement-breakpoint
ALTER TABLE "im_message_deliveries" DROP CONSTRAINT "im_message_deliveries_dispatch_shape";--> statement-breakpoint
ALTER TYPE "public"."im_delivery_state" RENAME TO "im_delivery_state_old";--> statement-breakpoint
CREATE TYPE "public"."im_delivery_state" AS ENUM('pending', 'accepted', 'steered', 'terminal_rejected', 'expired');--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ALTER COLUMN "state" TYPE "public"."im_delivery_state" USING "state"::text::"public"."im_delivery_state";--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ALTER COLUMN "state" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."im_delivery_state_old";--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "steer_target_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "steered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_steer_target_delivery_id_im_message_deliveries_id_fk" FOREIGN KEY ("steer_target_delivery_id") REFERENCES "public"."im_message_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "im_message_deliveries_steer_target_idx" ON "im_message_deliveries" USING btree ("steer_target_delivery_id");--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_dispatch_shape" CHECK (("im_message_deliveries"."dispatch_request_id" is null and "im_message_deliveries"."dispatch_input_hash" is null and "im_message_deliveries"."dispatch_payload" is null)
        or ("im_message_deliveries"."dispatch_request_id" is not null and "im_message_deliveries"."dispatch_input_hash" is not null
          and ("im_message_deliveries"."dispatch_payload" is not null or "im_message_deliveries"."state" = 'accepted')));--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_custody_shape" CHECK (("im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."input_hash" is not null and "im_message_deliveries"."turn_id" is not null
          and "im_message_deliveries"."report_owner_instance_id" is not null and "im_message_deliveries"."accepted_at" is not null
          and "im_message_deliveries"."steer_target_delivery_id" is null and "im_message_deliveries"."steered_at" is null)
        or ("im_message_deliveries"."state" = 'steered' and "im_message_deliveries"."input_hash" is not null and "im_message_deliveries"."steer_target_delivery_id" is not null
          and "im_message_deliveries"."steered_at" is not null and "im_message_deliveries"."turn_id" is null and "im_message_deliveries"."report_owner_instance_id" is null
          and "im_message_deliveries"."accepted_at" is null and "im_message_deliveries"."reported_at" is null and "im_message_deliveries"."turn_report" is null
          and "im_message_deliveries"."result_hash" is null)
        or ("im_message_deliveries"."state" not in ('accepted', 'steered') and "im_message_deliveries"."input_hash" is null and "im_message_deliveries"."turn_id" is null
          and "im_message_deliveries"."report_owner_instance_id" is null and "im_message_deliveries"."accepted_at" is null and "im_message_deliveries"."steered_at" is null
          and "im_message_deliveries"."reported_at" is null and "im_message_deliveries"."turn_report" is null and "im_message_deliveries"."result_hash" is null));
