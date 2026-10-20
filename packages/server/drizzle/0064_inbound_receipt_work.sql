ALTER TABLE "feishu_inbound_receipts" ADD COLUMN "work_payload" jsonb;--> statement-breakpoint
ALTER TABLE "feishu_inbound_receipts" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feishu_inbound_receipts" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_webhook_receipts" ADD COLUMN "work_payload" jsonb;--> statement-breakpoint
ALTER TABLE "slack_webhook_receipts" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_webhook_receipts" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "feishu_inbound_receipts_work_idx" ON "feishu_inbound_receipts" USING btree ("next_attempt_at","id") WHERE "feishu_inbound_receipts"."work_payload" is not null and "feishu_inbound_receipts"."status" in ('processing', 'failed');--> statement-breakpoint
CREATE INDEX "slack_webhook_receipts_work_idx" ON "slack_webhook_receipts" USING btree ("next_attempt_at","id") WHERE "slack_webhook_receipts"."work_payload" is not null and "slack_webhook_receipts"."status" in ('processing', 'failed');--> statement-breakpoint
ALTER TABLE "feishu_inbound_receipts" ADD CONSTRAINT "feishu_inbound_receipts_work_bounded" CHECK ("feishu_inbound_receipts"."work_payload" is null or octet_length("feishu_inbound_receipts"."work_payload"::text) <= 2097152);--> statement-breakpoint
ALTER TABLE "feishu_inbound_receipts" ADD CONSTRAINT "feishu_inbound_receipts_work_shape" CHECK (
      ("feishu_inbound_receipts"."work_payload" is null and "feishu_inbound_receipts"."lease_expires_at" is null and "feishu_inbound_receipts"."next_attempt_at" is null)
      or ("feishu_inbound_receipts"."work_payload" is not null and "feishu_inbound_receipts"."status" = 'processing' and "feishu_inbound_receipts"."lease_expires_at" is not null and "feishu_inbound_receipts"."next_attempt_at" is not null)
      or ("feishu_inbound_receipts"."work_payload" is not null and "feishu_inbound_receipts"."status" = 'failed' and "feishu_inbound_receipts"."lease_expires_at" is null and "feishu_inbound_receipts"."next_attempt_at" is not null)
    );--> statement-breakpoint
ALTER TABLE "slack_webhook_receipts" ADD CONSTRAINT "slack_webhook_receipts_work_bounded" CHECK ("slack_webhook_receipts"."work_payload" is null or octet_length("slack_webhook_receipts"."work_payload"::text) <= 2097152);--> statement-breakpoint
ALTER TABLE "slack_webhook_receipts" ADD CONSTRAINT "slack_webhook_receipts_work_shape" CHECK (
      ("slack_webhook_receipts"."work_payload" is null and "slack_webhook_receipts"."lease_expires_at" is null and "slack_webhook_receipts"."next_attempt_at" is null)
      or ("slack_webhook_receipts"."work_payload" is not null and "slack_webhook_receipts"."status" = 'processing' and "slack_webhook_receipts"."lease_expires_at" is not null and "slack_webhook_receipts"."next_attempt_at" is not null)
      or ("slack_webhook_receipts"."work_payload" is not null and "slack_webhook_receipts"."status" = 'failed' and "slack_webhook_receipts"."lease_expires_at" is null and "slack_webhook_receipts"."next_attempt_at" is not null)
    );