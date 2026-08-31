CREATE TYPE "public"."slack_webhook_receipt_status" AS ENUM('processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "slack_webhook_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"credential_generation" bigint NOT NULL,
	"event_id" text NOT NULL,
	"status" "slack_webhook_receipt_status" DEFAULT 'processing' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempt_count" bigint DEFAULT 1 NOT NULL,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	CONSTRAINT "slack_webhook_receipts_generation_nonnegative" CHECK ("slack_webhook_receipts"."credential_generation" >= 1),
	CONSTRAINT "slack_webhook_receipts_event_id_bounded" CHECK (length("slack_webhook_receipts"."event_id") between 1 and 255),
	CONSTRAINT "slack_webhook_receipts_failure_shape" CHECK (("slack_webhook_receipts"."status" <> 'failed' and "slack_webhook_receipts"."last_error_code" is null and "slack_webhook_receipts"."last_error_at" is null)
        or ("slack_webhook_receipts"."status" = 'failed' and "slack_webhook_receipts"."last_error_code" is not null and "slack_webhook_receipts"."last_error_at" is not null)),
	CONSTRAINT "slack_webhook_receipts_processed_shape" CHECK (("slack_webhook_receipts"."status" = 'processed' and "slack_webhook_receipts"."processed_at" is not null)
        or ("slack_webhook_receipts"."status" <> 'processed'))
);
--> statement-breakpoint
ALTER TABLE "slack_webhook_receipts" ADD CONSTRAINT "slack_webhook_receipts_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_webhook_receipts_identity_unique" ON "slack_webhook_receipts" USING btree ("installation_id","credential_generation","event_id");--> statement-breakpoint
CREATE INDEX "slack_webhook_receipts_status_idx" ON "slack_webhook_receipts" USING btree ("status","received_at");