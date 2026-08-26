-- An Account holds at most one active Workspace admin grant. Report the offending Accounts by id
-- instead of failing with a bare duplicate-key error on the index created below.
DO $$
DECLARE
	offending text;
BEGIN
	SELECT string_agg(user_id::text, ', ' ORDER BY user_id)
	INTO offending
	FROM (
		SELECT "user_id"
		FROM "workspace_admin_grants"
		WHERE "revoked_at" IS NULL
		GROUP BY "user_id"
		HAVING count(*) > 1
	) AS duplicates;

	IF offending IS NOT NULL THEN
		RAISE EXCEPTION 'Accounts hold more than one active Workspace admin grant: %', offending
			USING HINT = 'Revoke the redundant grants so that every Account keeps exactly one, then re-run the migration.';
	END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_admin_grants_active_user_unique" ON "workspace_admin_grants" USING btree ("user_id") WHERE "workspace_admin_grants"."revoked_at" is null;
