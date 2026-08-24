-- Repair the Team that completed onboarding before setup_completed_at existed.
-- The Agent UUID scopes this to the verified Staging Team and is a no-op elsewhere.
UPDATE "teams"
SET
	"setup_completed_at" = CURRENT_TIMESTAMP,
	"updated_at" = CURRENT_TIMESTAMP
WHERE
	"setup_completed_at" IS NULL
	AND "id" = (
		SELECT "team_id"
		FROM "agents"
		WHERE "id" = '6eb89d85-0f12-4962-8465-518071f1d3e9'
		LIMIT 1
	);
