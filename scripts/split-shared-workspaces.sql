-- Split every Workspace that holds several Admins into one Workspace per Admin.
--
-- A one-off operational task, run once against a deployed database before migration 0024, which refuses
-- to create its indexes while any Workspace still has more than one Admin. It is deliberately not a
-- migration: the step it cannot perform is on the operator's side, described under "After this runs".
--
-- Nothing is deleted and no id changes. Agents keep their ids, so IM bindings, Sessions, message history
-- and session placements all follow untouched: im_bindings references agent_id, and session_placements
-- references the enrollment id, and neither is rewritten here.
--
--   psql "$DATABASE_URL" -f scripts/split-shared-workspaces.sql
--
-- Take a database snapshot first. Review the report the final SELECT prints before committing.

BEGIN;

-- The Admin holding the earliest grant keeps the original Workspace, matching the order
-- resolveCompatibilityWorkspaceId already uses, so that Account sees no change at all. Every other Admin
-- gets a new Workspace that copies setup_completed_at, without which they would be sent back through
-- onboarding by WorkspaceSetupGate.
CREATE TEMP TABLE split_plan ON COMMIT DROP AS
WITH shared AS (
	SELECT workspace_id
	FROM workspace_admin_grants
	WHERE revoked_at IS NULL
	GROUP BY workspace_id
	HAVING count(*) > 1
),
ranked AS (
	SELECT
		g.id AS grant_id,
		g.user_id,
		g.workspace_id AS source_workspace_id,
		row_number() OVER (PARTITION BY g.workspace_id ORDER BY g.granted_at, g.user_id) AS rank
	FROM workspace_admin_grants g
	INNER JOIN shared ON shared.workspace_id = g.workspace_id
	WHERE g.revoked_at IS NULL
)
SELECT
	ranked.grant_id,
	ranked.user_id,
	ranked.source_workspace_id,
	CASE WHEN ranked.rank = 1 THEN ranked.source_workspace_id ELSE gen_random_uuid() END AS target_workspace_id,
	ranked.rank
FROM ranked;

INSERT INTO workspaces (id, name, display_name, setup_completed_at, created_at, updated_at)
SELECT
	p.target_workspace_id,
	'workspace-' || p.target_workspace_id,
	left(coalesce(u.display_name, 'Account') || '''s Workspace', 120),
	w.setup_completed_at,
	now(),
	now()
FROM split_plan p
INNER JOIN workspaces w ON w.id = p.source_workspace_id
INNER JOIN users u ON u.id = p.user_id
WHERE p.rank > 1;

UPDATE workspace_admin_grants g
SET workspace_id = p.target_workspace_id
FROM split_plan p
WHERE g.id = p.grant_id AND p.rank > 1;

-- An Agent whose creator did not enroll the Computer it runs on would otherwise be separated from its
-- enrollment. Give that Account its own enrollment of the same physical Computer, which the schema
-- already allows: workspace_computers is unique on (workspace_id, computer_id), not on computer_id.
-- These rows carry no credential, which is what the operator step below is for.
-- Deleted Agents are included: agents_workspace_enrollment_fk does not exempt them, so one left behind
-- on an enrollment that moves would break the composite key.
CREATE TEMP TABLE rehomed_enrollments ON COMMIT DROP AS
WITH stranded AS (
	SELECT DISTINCT
		a.created_by_user_id,
		a.workspace_computer_id AS source_enrollment_id,
		a.workspace_id AS source_workspace_id
	FROM agents a
	INNER JOIN workspace_computers wc ON wc.id = a.workspace_computer_id
	INNER JOIN split_plan p ON p.source_workspace_id = a.workspace_id AND p.user_id = a.created_by_user_id
	WHERE wc.enrolled_by_user_id <> a.created_by_user_id
)
SELECT
	s.created_by_user_id,
	s.source_enrollment_id,
	gen_random_uuid() AS target_enrollment_id,
	p.target_workspace_id
FROM stranded s
INNER JOIN split_plan p ON p.user_id = s.created_by_user_id AND p.source_workspace_id = s.source_workspace_id;

INSERT INTO workspace_computers (
	id, workspace_id, computer_id, display_name, platform, arch, client_version,
	enrolled_by_user_id, enrolled_at, updated_at
)
SELECT
	r.target_enrollment_id,
	r.target_workspace_id,
	wc.computer_id,
	wc.display_name,
	wc.platform,
	wc.arch,
	wc.client_version,
	r.created_by_user_id,
	now(),
	now()
FROM rehomed_enrollments r
INNER JOIN workspace_computers wc ON wc.id = r.source_enrollment_id;

-- Enrollments and Agents move in one statement. agents_workspace_enrollment_fk is a composite key over
-- (workspace_id, workspace_computer_id) and is not deferrable, so two separate UPDATEs would expose a
-- state it rejects. A data-modifying CTE is a single statement, and the constraint is checked once at
-- the end of it.
-- The rehomed enrollment is matched per Agent, on the enrollment that Agent actually sits on, because one
-- Account can hold both an Agent that needs rehoming and an Agent that does not.
WITH moved_enrollments AS (
	UPDATE workspace_computers wc
	SET workspace_id = p.target_workspace_id
	FROM split_plan p
	WHERE p.source_workspace_id = wc.workspace_id
		AND p.user_id = wc.enrolled_by_user_id
		AND p.rank > 1
	RETURNING wc.id
)
UPDATE agents a
SET
	workspace_id = p.target_workspace_id,
	workspace_computer_id = coalesce(
		(
			SELECT r.target_enrollment_id
			FROM rehomed_enrollments r
			WHERE r.created_by_user_id = a.created_by_user_id
				AND r.source_enrollment_id = a.workspace_computer_id
		),
		a.workspace_computer_id
	)
FROM split_plan p
WHERE p.source_workspace_id = a.workspace_id
	AND p.user_id = a.created_by_user_id;

-- Connect codes are short-lived and cheap to reissue, so an outstanding one is revoked rather than
-- reasoned about. A consumed code is history and stays where it is.
UPDATE computer_connect_codes c
SET revoked_by_user_id = c.issued_by_user_id, revoked_at = now()
FROM split_plan p
WHERE c.workspace_id = p.source_workspace_id
	AND c.consumed_at IS NULL
	AND c.revoked_at IS NULL;

SELECT
	p.user_id AS account,
	p.target_workspace_id AS workspace,
	p.rank = 1 AS kept_original,
	(SELECT count(*) FROM agents a WHERE a.workspace_id = p.target_workspace_id AND a.status <> 'deleted') AS agents,
	(SELECT count(*) FROM workspace_computers wc
		WHERE wc.workspace_id = p.target_workspace_id AND wc.revoked_at IS NULL) AS enrollments,
	(SELECT count(*) FROM rehomed_enrollments r WHERE r.target_workspace_id = p.target_workspace_id)
		AS needs_reconnect
FROM split_plan p
ORDER BY p.source_workspace_id, p.rank;

COMMIT;

-- After this runs
--
-- Every row in the report with needs_reconnect > 0 has an enrollment carrying no credential, because a
-- credential is a secret the host holds and this script cannot mint one the daemon knows. Run
-- `opentag computer connect` again on each of those hosts, as the Account named in that row, before
-- expecting its Agents to come back online. Every other Account keeps working without touching anything.
--
-- Then run migration 0024, which resolves any remaining redundant empty Workspace and creates the two
-- indexes that keep this shape from returning.
