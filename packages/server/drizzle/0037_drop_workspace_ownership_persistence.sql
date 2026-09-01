-- Contract migration: drop management Workspace persistence and the thin legacy Computer identity
-- table, then rename the Account-owned Computer projection into its final name. Fail-closed: every
-- legacy identity that the drop destroys must be provably redundant against the canonical Account
-- model, otherwise the transaction aborts and nothing is dropped.
DO $$
BEGIN
	LOCK TABLE
		"workspaces",
		"workspace_admin_grants",
		"admin_invitations",
		"workspace_computers",
		"workspace_computer_credentials",
		"computers",
		"account_computers",
		"computer_credentials",
		"computer_connect_codes",
		"agents",
		"slack_installations",
		"session_placements",
		"session_cli_proofs"
	IN SHARE ROW EXCLUSIVE MODE;

	-- Every legacy Workspace enrollment and every Account Computer must pair exactly one-to-one on
	-- the same id; an unpaired row on either side means the drop would destroy unmirrored identity.
	IF EXISTS (
		SELECT 1
		FROM "workspace_computers" AS "legacy"
		FULL OUTER JOIN "account_computers" AS "canonical" ON "canonical"."id" = "legacy"."id"
		WHERE "legacy"."id" IS NULL OR "canonical"."id" IS NULL
	) THEN
		RAISE EXCEPTION 'Workspace ownership contract migration found an unpaired Computer row';
	END IF;

	-- Paired rows must agree on owning Account and current installation identity.
	IF EXISTS (
		SELECT 1
		FROM "workspace_computers" AS "legacy"
		INNER JOIN "account_computers" AS "canonical" ON "canonical"."id" = "legacy"."id"
		WHERE "canonical"."owner_account_id" IS DISTINCT FROM "legacy"."enrolled_by_user_id"
			OR "canonical"."current_installation_id" IS DISTINCT FROM "legacy"."computer_id"
	) THEN
		RAISE EXCEPTION 'Workspace ownership contract migration found a Computer whose owner or installation identity diverges';
	END IF;

	-- Every legacy credential must survive with identical id, Computer binding, secret hash, and
	-- issue/revocation audit fields.
	IF EXISTS (
		SELECT 1
		FROM "workspace_computer_credentials" AS "legacy"
		LEFT JOIN "computer_credentials" AS "canonical" ON "canonical"."id" = "legacy"."id"
		WHERE "canonical"."id" IS NULL
			OR "canonical"."computer_id" IS DISTINCT FROM "legacy"."workspace_computer_id"
			OR "canonical"."secret_hash" IS DISTINCT FROM "legacy"."secret_hash"
			OR "canonical"."issued_by_user_id" IS DISTINCT FROM "legacy"."issued_by_user_id"
			OR "canonical"."issued_at" IS DISTINCT FROM "legacy"."issued_at"
			OR "canonical"."revoked_by_user_id" IS DISTINCT FROM "legacy"."revoked_by_user_id"
			OR "canonical"."revoked_at" IS DISTINCT FROM "legacy"."revoked_at"
	) THEN
		RAISE EXCEPTION 'Workspace ownership contract migration found a legacy Computer credential without an identical canonical credential';
	END IF;

	-- A Slack installation's legacy scope must be its owning Agent's scope.
	IF EXISTS (
		SELECT 1
		FROM "slack_installations" AS "installation"
		INNER JOIN "agents" AS "agent" ON "agent"."id" = "installation"."agent_id"
		WHERE "installation"."workspace_id" IS DISTINCT FROM "agent"."workspace_id"
	) THEN
		RAISE EXCEPTION 'Workspace ownership contract migration found a Slack installation whose Workspace disagrees with its Agent';
	END IF;

	-- A repair connect code must name a target Computer inside its own legacy scope; the consumed
	-- pairing is already enforced by the composite foreign key.
	IF EXISTS (
		SELECT 1
		FROM "computer_connect_codes" AS "code"
		INNER JOIN "workspace_computers" AS "legacy" ON "legacy"."id" = "code"."target_computer_id"
		WHERE "code"."workspace_id" IS DISTINCT FROM "legacy"."workspace_id"
	) THEN
		RAISE EXCEPTION 'Workspace ownership contract migration found a connect code whose target Computer is outside its Workspace';
	END IF;
END $$;
--> statement-breakpoint
-- Account-scoped Agent identity constraints replace the Workspace-scoped ones. The legacy creation
-- intent index releases its name first; both replacements fail the transaction on duplicate data.
DROP INDEX "agents_creation_intent_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_account_name_active_unique" ON "agents" USING btree ("created_by_user_id",lower("name")) WHERE "agents"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "agents_creation_intent_unique" ON "agents" USING btree ("created_by_user_id","creation_intent_id") WHERE "agents"."creation_intent_id" is not null;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_computer_matches_enrollment";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_computer_pair";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_workspace_enrollment_fk";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_issued_by_account_pair";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_consumed_computer_identity";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_consumed_computer_pair";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_consumption_pair";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_workspace_enrollment_fk";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_issued_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "session_cli_proofs" DROP CONSTRAINT "session_cli_proofs_computer_matches_enrollment";--> statement-breakpoint
ALTER TABLE "session_cli_proofs" DROP CONSTRAINT "session_cli_proofs_workspace_computer_id_workspace_computers_id_fk";--> statement-breakpoint
ALTER TABLE "session_placements" DROP CONSTRAINT "session_placements_computer_matches_enrollment";--> statement-breakpoint
ALTER TABLE "session_placements" DROP CONSTRAINT "session_placements_workspace_computer_id_workspace_computers_id_fk";--> statement-breakpoint
ALTER TABLE "slack_installations" DROP CONSTRAINT "slack_installations_workspace_id_workspaces_id_fk";--> statement-breakpoint
DROP INDEX "agents_workspace_name_active_unique";--> statement-breakpoint
DROP INDEX "agents_workspace_id_idx";--> statement-breakpoint
DROP INDEX "agents_workspace_computer_id_idx";--> statement-breakpoint
DROP INDEX "computer_connect_codes_workspace_created_idx";--> statement-breakpoint
DROP INDEX "session_placements_workspace_computer_id_idx";--> statement-breakpoint
DROP INDEX "slack_installations_workspace_id_idx";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "workspace_computer_id";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP COLUMN "issued_by_user_id";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP COLUMN "consumed_workspace_computer_id";--> statement-breakpoint
ALTER TABLE "session_cli_proofs" DROP COLUMN "workspace_computer_id";--> statement-breakpoint
ALTER TABLE "session_placements" DROP COLUMN "workspace_computer_id";--> statement-breakpoint
ALTER TABLE "slack_installations" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "runtime_durable_work" DROP CONSTRAINT "runtime_durable_work_workspace_computer_id_account_computers_id_fk";--> statement-breakpoint
ALTER TABLE "runtime_durable_work" RENAME COLUMN "workspace_computer_id" TO "computer_id";--> statement-breakpoint
ALTER TABLE "runtime_durable_work" ADD CONSTRAINT "runtime_durable_work_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_consumption_pair" CHECK (("computer_connect_codes"."consumed_computer_id" is null) = ("computer_connect_codes"."consumed_at" is null));--> statement-breakpoint
CREATE INDEX "computer_connect_codes_issued_by_account_created_idx" ON "computer_connect_codes" USING btree ("issued_by_account_id","created_at");--> statement-breakpoint
-- Drop the management Workspace tables and the legacy credential shadows.
DROP TABLE "workspace_computer_credentials";--> statement-breakpoint
DROP TABLE "workspace_admin_grants";--> statement-breakpoint
DROP TABLE "admin_invitations";--> statement-breakpoint
DROP TABLE "workspace_computers";--> statement-breakpoint
DROP TABLE "workspaces";--> statement-breakpoint
-- The thin legacy identity table releases the final Computer table name.
ALTER TABLE "account_computers" DROP CONSTRAINT "account_computers_current_installation_id_computers_id_fk";--> statement-breakpoint
DROP TABLE "computers";--> statement-breakpoint
ALTER TABLE "account_computers" RENAME TO "computers";--> statement-breakpoint
ALTER TABLE "computers" RENAME CONSTRAINT "account_computers_pkey" TO "computers_pkey";--> statement-breakpoint
ALTER TABLE "computers" RENAME CONSTRAINT "account_computers_owner_account_id_users_id_fk" TO "computers_owner_account_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "agents_computer_id_account_computers_id_fk" TO "agents_computer_id_computers_id_fk";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" RENAME CONSTRAINT "computer_connect_codes_target_computer_id_account_computers_id_fk" TO "computer_connect_codes_target_computer_id_computers_id_fk";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" RENAME CONSTRAINT "computer_connect_codes_consumed_computer_id_account_computers_id_fk" TO "computer_connect_codes_consumed_computer_id_computers_id_fk";--> statement-breakpoint
ALTER TABLE "computer_credentials" RENAME CONSTRAINT "computer_credentials_computer_id_account_computers_id_fk" TO "computer_credentials_computer_id_computers_id_fk";--> statement-breakpoint
ALTER TABLE "session_cli_proofs" RENAME CONSTRAINT "session_cli_proofs_computer_id_account_computers_id_fk" TO "session_cli_proofs_computer_id_computers_id_fk";--> statement-breakpoint
ALTER TABLE "session_placements" RENAME CONSTRAINT "session_placements_computer_id_account_computers_id_fk" TO "session_placements_computer_id_computers_id_fk";--> statement-breakpoint
ALTER INDEX "account_computers_owner_account_id_idx" RENAME TO "computers_owner_account_id_idx";--> statement-breakpoint
DROP INDEX "account_computers_current_installation_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "computers_current_installation_id_unique" ON "computers" USING btree ("current_installation_id");