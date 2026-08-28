-- Bind Account and Workspace one to one, in both directions, so that `workspace_id = ?` means
-- "belongs to this Account" for every management read.
--
-- Legacy databases can break either direction, because 0016 backfilled one grant per active admin
-- membership: an Account that administered several Teams now holds several Workspaces, and a Team with
-- several admins is now a Workspace with several Admins. This migration resolves the first case where
-- doing so provably loses nothing, and refuses the rest by naming the rows a human has to decide about.

-- An Account that holds several Workspaces keeps the one the compatibility resolver already selects, in
-- the same order `/me` publishes: setup-completed first, then earliest grant, then Workspace UUID. What
-- that Account sees therefore does not change. The redundant grant is only revoked when its Workspace
-- holds no active Agent and no live enrollment, so this can move nothing and orphan nothing; a redundant
-- Workspace with resources in it falls through to the guard below.
WITH ranked AS (
	SELECT
		"workspace_admin_grants"."id",
		"workspace_admin_grants"."user_id",
		"workspace_admin_grants"."workspace_id",
		row_number() OVER (
			PARTITION BY "workspace_admin_grants"."user_id"
			ORDER BY
				("workspaces"."setup_completed_at" IS NULL),
				"workspace_admin_grants"."granted_at",
				"workspaces"."id"
		) AS rank
	FROM "workspace_admin_grants"
	INNER JOIN "workspaces" ON "workspaces"."id" = "workspace_admin_grants"."workspace_id"
	WHERE "workspace_admin_grants"."revoked_at" IS NULL
)
UPDATE "workspace_admin_grants"
SET "revoked_by_user_id" = "workspace_admin_grants"."user_id", "revoked_at" = now()
FROM ranked
WHERE ranked."id" = "workspace_admin_grants"."id"
	AND ranked.rank > 1
	AND NOT EXISTS (
		SELECT 1 FROM "agents"
		WHERE "agents"."workspace_id" = ranked."workspace_id" AND "agents"."status" <> 'deleted'
	)
	AND NOT EXISTS (
		SELECT 1 FROM "workspace_computers"
		WHERE "workspace_computers"."workspace_id" = ranked."workspace_id"
			AND "workspace_computers"."revoked_at" IS NULL
	);--> statement-breakpoint
-- Whatever the step above could not resolve without moving resources is reported by Workspace, so the
-- upgrade says which scopes are contested instead of failing with a bare duplicate-key error.
DO $$
DECLARE
	offending text;
BEGIN
	SELECT string_agg(format('%s (account %s)', workspace_id, user_id), ', ' ORDER BY user_id, workspace_id)
	INTO offending
	FROM (
		SELECT "user_id", "workspace_id"
		FROM "workspace_admin_grants"
		WHERE "revoked_at" IS NULL
			AND "user_id" IN (
				SELECT "user_id" FROM "workspace_admin_grants"
				WHERE "revoked_at" IS NULL GROUP BY "user_id" HAVING count(*) > 1
			)
	) AS duplicates;

	IF offending IS NOT NULL THEN
		RAISE EXCEPTION 'Accounts still hold more than one active Workspace admin grant: %', offending
			USING HINT = 'Each of these Workspaces holds Agents or live enrollments, so pick the one the Account keeps and move or revoke the rest by hand, then re-run the migration.';
	END IF;
END
$$;--> statement-breakpoint
-- A Workspace with several Admins is split one Workspace per Admin before this migration runs. That is
-- an operational task rather than an automatic one: an Agent whose creator did not enroll the Computer it
-- runs on needs a second enrollment of that Computer, and the host has to run `computer connect` again
-- for it, which a migration cannot do on the operator's behalf.
DO $$
DECLARE
	offending text;
BEGIN
	SELECT string_agg(format('%s (%s admins)', workspace_id, admins), ', ' ORDER BY workspace_id)
	INTO offending
	FROM (
		SELECT "workspace_id", count(*) AS admins
		FROM "workspace_admin_grants"
		WHERE "revoked_at" IS NULL
		GROUP BY "workspace_id"
		HAVING count(*) > 1
	) AS duplicates;

	IF offending IS NOT NULL THEN
		RAISE EXCEPTION 'Workspaces hold more than one active Admin: %', offending
			USING HINT = 'Split each of these one Workspace per Admin, moving agents by created_by_user_id and workspace_computers by enrolled_by_user_id in a single statement so the composite foreign key holds, then re-run the migration.';
	END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_admin_grants_active_user_unique" ON "workspace_admin_grants" USING btree ("user_id") WHERE "workspace_admin_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_admin_grants_active_workspace_unique" ON "workspace_admin_grants" USING btree ("workspace_id") WHERE "workspace_admin_grants"."revoked_at" is null;
