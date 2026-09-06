CREATE INDEX "feishu_inbound_receipts_retention_idx" ON "feishu_inbound_receipts" USING btree ("received_at","id") WHERE "feishu_inbound_receipts"."status" in ('processed', 'failed');--> statement-breakpoint
CREATE INDEX "im_message_deliveries_expiry_idx" ON "im_message_deliveries" USING btree ("expires_at","id") WHERE "im_message_deliveries"."state" = 'pending' and "im_message_deliveries"."reason" is null;--> statement-breakpoint
CREATE INDEX "im_message_deliveries_retention_idx" ON "im_message_deliveries" USING btree ("expires_at","id") WHERE ("im_message_deliveries"."state" in ('expired', 'terminal_rejected')
          or ("im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."reported_at" is not null)
          or ("im_message_deliveries"."state" = 'steered' and "im_message_deliveries"."steered_at" is not null));--> statement-breakpoint
CREATE INDEX "im_messages_retention_idx" ON "im_messages" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "slack_webhook_receipts_retention_idx" ON "slack_webhook_receipts" USING btree ("received_at","id") WHERE "slack_webhook_receipts"."status" in ('processed', 'failed');