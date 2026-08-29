-- Backfill account-owned Computer projections from Workspace enrollments.
-- Data-only: target columns stay nullable until the constraint migration.
DO $$
BEGIN
	LOCK TABLE
		"computer_connect_codes",
		"workspace_computers",
		"workspace_computer_credentials",
		"account_computers",
		"computer_credentials",
		"agents",
		"session_placements",
		"session_cli_proofs",
		"slack_installations",
		"im_bindings"
	IN SHARE ROW EXCLUSIVE MODE;

	IF EXISTS (
		SELECT 1
		FROM "account_computers" AS "account_computer"
		WHERE NOT EXISTS (
			SELECT 1
			FROM "workspace_computers" AS "workspace_computer"
			WHERE "workspace_computer"."id" = "account_computer"."id"
		)
	) THEN
		RAISE EXCEPTION 'Account Computer backfill found a target Computer that does not match a Workspace enrollment';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "account_computers" AS "account_computer"
		INNER JOIN "workspace_computers" AS "workspace_computer" ON "workspace_computer"."id" = "account_computer"."id"
		WHERE "account_computer"."owner_account_id" IS DISTINCT FROM "workspace_computer"."enrolled_by_user_id"
			OR "account_computer"."current_installation_id" IS DISTINCT FROM "workspace_computer"."computer_id"
	) THEN
		RAISE EXCEPTION 'Account Computer backfill found a Computer whose owner or installation does not match the enrollment';
	END IF;

	INSERT INTO "account_computers" (
		"id",
		"owner_account_id",
		"current_installation_id",
		"display_name",
		"platform",
		"arch",
		"client_version",
		"current_instance_id",
		"connected_at",
		"last_seen_at",
		"created_at",
		"updated_at"
	)
	SELECT
		"workspace_computer"."id",
		"workspace_computer"."enrolled_by_user_id",
		"workspace_computer"."computer_id",
		"workspace_computer"."display_name",
		"workspace_computer"."platform",
		"workspace_computer"."arch",
		"workspace_computer"."client_version",
		"workspace_computer"."current_instance_id",
		"workspace_computer"."connected_at",
		"workspace_computer"."last_seen_at",
		"workspace_computer"."enrolled_at",
		"workspace_computer"."updated_at"
	FROM "workspace_computers" AS "workspace_computer"
	WHERE NOT EXISTS (
		SELECT 1
		FROM "account_computers" AS "account_computer"
		WHERE "account_computer"."id" = "workspace_computer"."id"
	);

	IF EXISTS (
		SELECT 1
		FROM "workspace_computers" AS "workspace_computer"
		WHERE NOT EXISTS (
			SELECT 1
			FROM "account_computers" AS "account_computer"
			WHERE "account_computer"."id" = "workspace_computer"."id"
		)
	) THEN
		RAISE EXCEPTION 'Account Computer backfill could not project every Workspace enrollment';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "computer_credentials" AS "computer_credential"
		WHERE NOT EXISTS (
			SELECT 1
			FROM "workspace_computer_credentials" AS "workspace_credential"
			WHERE "workspace_credential"."id" = "computer_credential"."id"
		)
	) THEN
		RAISE EXCEPTION 'Computer credential backfill found a target credential that does not match a Workspace enrollment credential';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "computer_credentials" AS "computer_credential"
		INNER JOIN "workspace_computer_credentials" AS "workspace_credential"
			ON "workspace_credential"."id" = "computer_credential"."id"
		WHERE "computer_credential"."computer_id" IS DISTINCT FROM "workspace_credential"."workspace_computer_id"
			OR "computer_credential"."secret_hash" IS DISTINCT FROM "workspace_credential"."secret_hash"
			OR "computer_credential"."issued_by_user_id" IS DISTINCT FROM "workspace_credential"."issued_by_user_id"
			OR "computer_credential"."issued_at" IS DISTINCT FROM "workspace_credential"."issued_at"
			OR "computer_credential"."revoked_by_user_id" IS DISTINCT FROM "workspace_credential"."revoked_by_user_id"
			OR "computer_credential"."revoked_at" IS DISTINCT FROM "workspace_credential"."revoked_at"
	) THEN
		RAISE EXCEPTION 'Computer credential backfill found a credential whose identity or audit history does not match the enrollment credential';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "workspace_computer_credentials" AS "workspace_credential"
		INNER JOIN "computer_credentials" AS "computer_credential"
			ON "computer_credential"."secret_hash" = "workspace_credential"."secret_hash"
		WHERE "computer_credential"."id" IS DISTINCT FROM "workspace_credential"."id"
	) THEN
		RAISE EXCEPTION 'Computer credential backfill found a credential hash that belongs to a different credential';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "workspace_computer_credentials" AS "workspace_credential"
		INNER JOIN "computer_credentials" AS "computer_credential"
			ON "computer_credential"."computer_id" = "workspace_credential"."workspace_computer_id"
			AND "computer_credential"."revoked_at" IS NULL
			AND "workspace_credential"."revoked_at" IS NULL
		WHERE "computer_credential"."id" IS DISTINCT FROM "workspace_credential"."id"
	) THEN
		RAISE EXCEPTION 'Computer credential backfill found a conflicting active credential for a Computer';
	END IF;

	INSERT INTO "computer_credentials" (
		"id",
		"computer_id",
		"secret_hash",
		"issued_by_user_id",
		"issued_at",
		"revoked_by_user_id",
		"revoked_at"
	)
	SELECT
		"workspace_credential"."id",
		"workspace_credential"."workspace_computer_id",
		"workspace_credential"."secret_hash",
		"workspace_credential"."issued_by_user_id",
		"workspace_credential"."issued_at",
		"workspace_credential"."revoked_by_user_id",
		"workspace_credential"."revoked_at"
	FROM "workspace_computer_credentials" AS "workspace_credential"
	WHERE NOT EXISTS (
		SELECT 1
		FROM "computer_credentials" AS "computer_credential"
		WHERE "computer_credential"."id" = "workspace_credential"."id"
	);

	IF EXISTS (
		SELECT 1
		FROM "workspace_computer_credentials" AS "workspace_credential"
		WHERE NOT EXISTS (
			SELECT 1
			FROM "computer_credentials" AS "computer_credential"
			WHERE "computer_credential"."id" = "workspace_credential"."id"
		)
	) THEN
		RAISE EXCEPTION 'Computer credential backfill could not project every Workspace enrollment credential';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "agents"
		WHERE "computer_id" IS NOT NULL
			AND "computer_id" IS DISTINCT FROM "workspace_computer_id"
	) THEN
		RAISE EXCEPTION 'Agent Computer backfill found an Agent whose Computer does not match its enrollment';
	END IF;

	UPDATE "agents"
	SET "computer_id" = "workspace_computer_id"
	WHERE "computer_id" IS NULL;

	IF EXISTS (
		SELECT 1
		FROM "agents"
		WHERE "computer_id" IS DISTINCT FROM "workspace_computer_id"
	) THEN
		RAISE EXCEPTION 'Agent Computer backfill could not project every Agent enrollment';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "session_placements"
		WHERE "computer_id" IS NOT NULL
			AND "computer_id" IS DISTINCT FROM "workspace_computer_id"
	) THEN
		RAISE EXCEPTION 'Session placement backfill found a placement whose Computer does not match its enrollment';
	END IF;

	UPDATE "session_placements"
	SET "computer_id" = "workspace_computer_id"
	WHERE "computer_id" IS NULL;

	IF EXISTS (
		SELECT 1
		FROM "session_placements"
		WHERE "computer_id" IS DISTINCT FROM "workspace_computer_id"
	) THEN
		RAISE EXCEPTION 'Session placement backfill could not project every Session placement';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "session_cli_proofs"
		WHERE "computer_id" IS NOT NULL
			AND "computer_id" IS DISTINCT FROM "workspace_computer_id"
	) THEN
		RAISE EXCEPTION 'Session CLI proof backfill found a proof whose Computer does not match its enrollment';
	END IF;

	UPDATE "session_cli_proofs"
	SET "computer_id" = "workspace_computer_id"
	WHERE "computer_id" IS NULL;

	IF EXISTS (
		SELECT 1
		FROM "session_cli_proofs"
		WHERE "computer_id" IS DISTINCT FROM "workspace_computer_id"
	) THEN
		RAISE EXCEPTION 'Session CLI proof backfill could not project every Session CLI proof';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "computer_connect_codes"
		WHERE (
			"mode" IS NOT NULL
			AND "mode" IS DISTINCT FROM 'create'::"computer_connect_code_mode"
		) OR "target_computer_id" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'Computer connect-code backfill found a repair-shaped code; historical codes must be create codes without a target Computer';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "computer_connect_codes"
		WHERE "issued_by_account_id" IS NOT NULL
			AND "issued_by_account_id" IS DISTINCT FROM "issued_by_user_id"
	) THEN
		RAISE EXCEPTION 'Computer connect-code backfill found an issuing Account that does not match the issuing user';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "computer_connect_codes"
		WHERE "consumed_computer_id" IS NOT NULL
			AND "consumed_computer_id" IS DISTINCT FROM "consumed_workspace_computer_id"
	) THEN
		RAISE EXCEPTION 'Computer connect-code backfill found a consumed Computer that does not match the enrollment';
	END IF;

	UPDATE "computer_connect_codes"
	SET
		"issued_by_account_id" = "issued_by_user_id",
		"mode" = 'create',
		"consumed_computer_id" = "consumed_workspace_computer_id";

	IF EXISTS (
		SELECT 1
		FROM "slack_installations" AS "installation"
		WHERE NOT EXISTS (
			SELECT 1
			FROM "im_bindings" AS "binding"
			WHERE "binding"."provider" = 'slack'
				AND "binding"."slack_installation_id" = "installation"."id"
		)
	) THEN
		RAISE EXCEPTION 'Slack installation backfill found an installation with no Slack binding';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "slack_installations" AS "installation"
		INNER JOIN "im_bindings" AS "binding"
			ON "binding"."provider" = 'slack'
			AND "binding"."slack_installation_id" = "installation"."id"
		GROUP BY "installation"."id"
		HAVING count(DISTINCT "binding"."agent_id") > 1
	) THEN
		RAISE EXCEPTION 'Slack installation backfill found an installation bound to more than one Agent';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "slack_installations" AS "installation"
		INNER JOIN "im_bindings" AS "binding"
			ON "binding"."provider" = 'slack'
			AND "binding"."slack_installation_id" = "installation"."id"
		INNER JOIN "agents" AS "agent" ON "agent"."id" = "binding"."agent_id"
		WHERE "agent"."workspace_id" IS DISTINCT FROM "installation"."workspace_id"
	) THEN
		RAISE EXCEPTION 'Slack installation backfill found a binding whose Agent is not in the installation Workspace';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "slack_installations" AS "installation"
		INNER JOIN "im_bindings" AS "binding"
			ON "binding"."provider" = 'slack'
			AND "binding"."slack_installation_id" = "installation"."id"
		WHERE "installation"."agent_id" IS NOT NULL
			AND "installation"."agent_id" IS DISTINCT FROM "binding"."agent_id"
	) THEN
		RAISE EXCEPTION 'Slack installation backfill found an Agent owner that does not match the bound Agent';
	END IF;

	UPDATE "slack_installations" AS "installation"
	SET "agent_id" = "binding"."agent_id"
	FROM "im_bindings" AS "binding"
	WHERE "binding"."provider" = 'slack'
		AND "binding"."slack_installation_id" = "installation"."id"
		AND "installation"."agent_id" IS NULL;

	IF EXISTS (
		SELECT 1
		FROM "slack_installations"
		WHERE "agent_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Slack installation backfill could not project every installation owner';
	END IF;
END $$;
