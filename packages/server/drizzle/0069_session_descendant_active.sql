-- The internal-Session page ordered a Session's descendants by activity and then asked `sessions` whether
-- each candidate had ended. With 90,000 ended descendants that paged through history: the plan probed
-- `sessions` 90,021 times to find the 21 rows one page needed, because the closure row carried no activity
-- state and the ordering index could not exclude ended children.
--
-- `descendant_active` is that state, defined as `descendant.ended_at is null`. The closure is now written
-- by the same transaction that ends a Session (`services/sessions/session-closure.ts`), so the partial
-- activity indexes below hold active rows only and a first page reads exactly the rows it returns.
--
-- Order matters for a rolling deployment: the column is added and derived from the current `sessions`
-- state before the partial indexes exist, so no intermediate state has an index that disagrees with the
-- rows. Reads that arrive from an older binary keep their `sessions.ended_at is null` join predicate, so a
-- row this migration or a later ended writer has not touched yet can never surface an ended Session; the
-- backfill and the validation below cover the rows written before the new binaries are live.
ALTER TABLE "session_descendants" ADD COLUMN "descendant_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "session_descendants" AS "link"
SET "descendant_active" = ("session"."ended_at" IS NULL)
FROM "sessions" AS "session"
WHERE "session"."id" = "link"."descendant_session_id"
  AND "link"."descendant_active" IS DISTINCT FROM ("session"."ended_at" IS NULL);--> statement-breakpoint
-- Fail the migration instead of shipping indexes that disagree with the Sessions they describe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "session_descendants" AS "link"
    INNER JOIN "sessions" AS "session" ON "session"."id" = "link"."descendant_session_id"
    WHERE "link"."descendant_active" IS DISTINCT FROM ("session"."ended_at" IS NULL)
  ) THEN
    RAISE EXCEPTION 'session_descendants.descendant_active disagrees with sessions.ended_at';
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX "session_descendants_ancestor_activity_active_idx" ON "session_descendants" USING btree ("ancestor_session_id","last_message_created_at","last_message_id","descendant_session_id") WHERE "session_descendants"."descendant_active";--> statement-breakpoint
CREATE INDEX "session_descendants_ancestor_depth_activity_active_idx" ON "session_descendants" USING btree ("ancestor_session_id","depth","last_message_created_at","last_message_id","descendant_session_id") WHERE "session_descendants"."descendant_active";--> statement-breakpoint
-- The partial indexes supersede these: every read that ordered by activity filters to active descendants,
-- and an unfiltered activity order has no caller. Keeping both would double the write cost of every
-- closure insert and activity update for no reader.
DROP INDEX "session_descendants_ancestor_activity_idx";--> statement-breakpoint
DROP INDEX "session_descendants_ancestor_depth_activity_idx";
