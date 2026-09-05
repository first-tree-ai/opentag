CREATE INDEX "im_message_deliveries_retention_idx" ON "im_message_deliveries" USING btree ("expires_at","id") WHERE ("im_message_deliveries"."state" in ('expired', 'terminal_rejected')
          or ("im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."reported_at" is not null)
          or ("im_message_deliveries"."state" = 'steered' and "im_message_deliveries"."steered_at" is not null));--> statement-breakpoint
CREATE INDEX "im_messages_retention_idx" ON "im_messages" USING btree ("occurred_at","id");