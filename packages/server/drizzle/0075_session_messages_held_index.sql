-- Session messages the Server holds for a Local Client. The delivery sweep and the Computer recovery pass ask
-- for exactly these rows, and without this index the sweep scans the whole table: 1.2 to 2.1 s on 2 million rows.
--
-- Held rows settle within a day, so the index stays tiny. It is a plain build because startup migrations run in a
-- transaction: it blocks writes to session_messages while it scans, 1.9 s on those 2 million rows (2.6 GB).
CREATE INDEX "session_messages_held_idx" ON "session_messages" USING btree ("created_at","id") WHERE "session_messages"."last_outcome" = 'unknown' and "session_messages"."last_error_code" = 'delivery_held';