CREATE TYPE "public"."feishu_inbound_receipt_status" AS ENUM('processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "feishu_inbound_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"im_binding_id" uuid NOT NULL,
	"credential_generation" bigint NOT NULL,
	"event_id" text NOT NULL,
	"status" "feishu_inbound_receipt_status" DEFAULT 'processing' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempt_count" bigint DEFAULT 1 NOT NULL,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	CONSTRAINT "feishu_inbound_receipts_generation_nonnegative" CHECK ("feishu_inbound_receipts"."credential_generation" >= 1),
	CONSTRAINT "feishu_inbound_receipts_event_id_bounded" CHECK (length("feishu_inbound_receipts"."event_id") between 1 and 512),
	CONSTRAINT "feishu_inbound_receipts_failure_shape" CHECK (("feishu_inbound_receipts"."status" <> 'failed' and "feishu_inbound_receipts"."last_error_code" is null and "feishu_inbound_receipts"."last_error_at" is null)
        or ("feishu_inbound_receipts"."status" = 'failed' and "feishu_inbound_receipts"."last_error_code" is not null and "feishu_inbound_receipts"."last_error_at" is not null)),
	CONSTRAINT "feishu_inbound_receipts_processed_shape" CHECK (("feishu_inbound_receipts"."status" = 'processed' and "feishu_inbound_receipts"."processed_at" is not null)
        or ("feishu_inbound_receipts"."status" <> 'processed'))
);
--> statement-breakpoint
ALTER TABLE "feishu_inbound_receipts" ADD CONSTRAINT "feishu_inbound_receipts_im_binding_id_im_bindings_id_fk" FOREIGN KEY ("im_binding_id") REFERENCES "public"."im_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_inbound_receipts_identity_unique" ON "feishu_inbound_receipts" USING btree ("im_binding_id","event_id");--> statement-breakpoint
CREATE INDEX "feishu_inbound_receipts_status_idx" ON "feishu_inbound_receipts" USING btree ("status","received_at");