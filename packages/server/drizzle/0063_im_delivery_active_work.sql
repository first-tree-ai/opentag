CREATE INDEX IF NOT EXISTS "im_delivery_work_idx" ON "im_message_deliveries" USING btree ("next_attempt_at","id") WHERE (((("im_message_deliveries"."state" = 'pending' and "im_message_deliveries"."reason" is null)
    or ("im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."reported_at" is null)
    or ("im_message_deliveries"."state" = 'expired' and "im_message_deliveries"."dispatch_request_id" is not null)) or (("im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."reported_at" is null)
    or ("im_message_deliveries"."state" in ('pending', 'expired') and "im_message_deliveries"."dispatch_request_id" is not null)
    or ("im_message_deliveries"."state" = 'pending' and "im_message_deliveries"."last_error_code" like 'IM_DELIVERY_CLAIM_%'))) is true);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'im_delivery_work_idx'::regclass
      AND indrelid = 'im_message_deliveries'::regclass
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'im_delivery_work_idx is not ready and valid; repair the prebuilt index before retrying migration';
  END IF;
END $$;
