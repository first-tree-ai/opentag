ALTER TABLE "users" ADD COLUMN "setup_completed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill Account onboarding from the earliest Workspace completion reachable through an Agent
-- this Account created, including deleted Agents. Grants never contribute. Retry-safe: already
-- populated Account rows are left unchanged.
DO $$
BEGIN
	LOCK TABLE "users", "agents", "workspaces" IN SHARE ROW EXCLUSIVE MODE;

	UPDATE "users" AS "account"
	SET "setup_completed_at" = "source"."setup_completed_at"
	FROM (
		SELECT
			"agent"."created_by_user_id" AS "account_id",
			min("workspace"."setup_completed_at") AS "setup_completed_at"
		FROM "agents" AS "agent"
		INNER JOIN "workspaces" AS "workspace" ON "workspace"."id" = "agent"."workspace_id"
		WHERE "workspace"."setup_completed_at" IS NOT NULL
		GROUP BY "agent"."created_by_user_id"
	) AS "source"
	WHERE "account"."id" = "source"."account_id"
		AND "account"."setup_completed_at" IS NULL;
END
$$;
