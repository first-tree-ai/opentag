-- The Agent list asks "which Turns are accepted but unreported?" for every Agent it shows, twice: once for
-- the working window and once for anything older that a Computer still owes a report for. Without an index
-- for that predicate the two reads join every Session of the binding to reach an answer, which cost 100,001
-- probes for one hot Agent in the 100k-row benchmark and kept the hot list at 161.85 ms.
--
-- The rows covered here are exactly the Turns awaiting a report, so the index is small and shrinks as reports
-- arrive; it is not a history. `accepted_at` leads because both reads range-filter it, `id` keeps the
-- deduplication order deterministic, and `session_id` lets the Agent join stay index-only.
CREATE INDEX "im_message_deliveries_unreported_accepted_idx" ON "im_message_deliveries" USING btree ("accepted_at","id","session_id") WHERE "im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."reported_at" is null;
