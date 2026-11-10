-- The Agent list asks "which Turns are accepted but unreported?" for every live channel or thread Session
-- of the Agents it shows. When `accepted_at` led `im_message_deliveries_unreported_accepted_idx`, a
-- Session-first probe had to walk every Account's unreported accepted Turns in the window (or fall back to
-- `im_message_deliveries_session_id_idx` across all historical reported Turns of a hot Session). Putting
-- `session_id` first lets each live Session probe only its own unreported Turns while `accepted_at` and
-- `id` keep the index covering for the working/stale window split and deterministic ordering.
DROP INDEX "im_message_deliveries_unreported_accepted_idx";--> statement-breakpoint
CREATE INDEX "im_message_deliveries_unreported_accepted_idx" ON "im_message_deliveries" USING btree ("session_id","accepted_at","id") WHERE "im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."reported_at" is null;
