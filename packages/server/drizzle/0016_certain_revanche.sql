CREATE TABLE "computer_connect_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_workspace_computer_id" uuid,
	"consumed_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "computer_connect_codes_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "computer_connect_codes_expiry" CHECK ("computer_connect_codes"."expires_at" > "computer_connect_codes"."created_at"),
	CONSTRAINT "computer_connect_codes_consumption_pair" CHECK (("computer_connect_codes"."consumed_workspace_computer_id" is null) = ("computer_connect_codes"."consumed_at" is null)),
	CONSTRAINT "computer_connect_codes_revocation_pair" CHECK (("computer_connect_codes"."revoked_by_user_id" is null) = ("computer_connect_codes"."revoked_at" is null)),
	CONSTRAINT "computer_connect_codes_terminal_state" CHECK (not ("computer_connect_codes"."consumed_at" is not null and "computer_connect_codes"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "workspace_computer_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_computer_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_computer_credentials_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "workspace_computer_credentials_revocation_pair" CHECK (("workspace_computer_credentials"."revoked_by_user_id" is null) = ("workspace_computer_credentials"."revoked_at" is null)),
	CONSTRAINT "workspace_computer_credentials_revoked_after_issued" CHECK ("workspace_computer_credentials"."revoked_at" is null or "workspace_computer_credentials"."revoked_at" >= "workspace_computer_credentials"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_computers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"platform" "computer_platform" NOT NULL,
	"arch" text NOT NULL,
	"client_version" text NOT NULL,
	"enrolled_by_user_id" uuid NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"current_instance_id" uuid,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_computers_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_computers_revocation_pair" CHECK (("workspace_computers"."revoked_by_user_id" is null) = ("workspace_computers"."revoked_at" is null)),
	CONSTRAINT "workspace_computers_revoked_after_enrolled" CHECK ("workspace_computers"."revoked_at" is null or "workspace_computers"."revoked_at" >= "workspace_computers"."enrolled_at")
);
--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_workspace_id_teams_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_workspace_enrollment_fk" FOREIGN KEY ("workspace_id","consumed_workspace_computer_id") REFERENCES "public"."workspace_computers"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_computer_credentials" ADD CONSTRAINT "workspace_computer_credentials_workspace_computer_id_workspace_computers_id_fk" FOREIGN KEY ("workspace_computer_id") REFERENCES "public"."workspace_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_computer_credentials" ADD CONSTRAINT "workspace_computer_credentials_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_computer_credentials" ADD CONSTRAINT "workspace_computer_credentials_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_computers" ADD CONSTRAINT "workspace_computers_workspace_id_teams_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_computers" ADD CONSTRAINT "workspace_computers_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_computers" ADD CONSTRAINT "workspace_computers_enrolled_by_user_id_users_id_fk" FOREIGN KEY ("enrolled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_computers" ADD CONSTRAINT "workspace_computers_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "workspace_computers" (
	"workspace_id",
	"computer_id",
	"display_name",
	"platform",
	"arch",
	"client_version",
	"enrolled_by_user_id",
	"enrolled_at",
	"revoked_by_user_id",
	"revoked_at",
	"last_seen_at",
	"updated_at"
)
SELECT
	pairs.workspace_id,
	pairs.computer_id,
	computers.display_name,
	computers.platform,
	computers.arch,
	computers.client_version,
	computers.owner_user_id,
	computers.created_at,
	CASE WHEN pairs.has_live_reference THEN NULL ELSE computers.owner_user_id END,
	CASE WHEN pairs.has_live_reference THEN NULL ELSE now() END,
	computers.last_seen_at,
	computers.updated_at
FROM (
	SELECT workspace_id, computer_id, bool_or(has_live_reference) AS has_live_reference
	FROM (
		SELECT agents.team_id AS workspace_id, agents.computer_id, agents.status <> 'deleted' AS has_live_reference
		FROM agents
		UNION ALL
		SELECT
			agents.team_id AS workspace_id,
			session_placements.computer_id,
			sessions.ended_at IS NULL AS has_live_reference
		FROM session_placements
		INNER JOIN sessions ON sessions.id = session_placements.session_id
		INNER JOIN im_bindings ON im_bindings.id = sessions.im_binding_id
		INNER JOIN agents ON agents.id = im_bindings.agent_id
	) AS enrollment_references
	GROUP BY workspace_id, computer_id
) AS pairs
INNER JOIN computers ON computers.id = pairs.computer_id;--> statement-breakpoint
CREATE INDEX "computer_connect_codes_workspace_created_idx" ON "computer_connect_codes" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_computer_credentials_active_enrollment_unique" ON "workspace_computer_credentials" USING btree ("workspace_computer_id") WHERE "workspace_computer_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_computer_credentials_enrollment_issued_idx" ON "workspace_computer_credentials" USING btree ("workspace_computer_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_computers_active_workspace_computer_unique" ON "workspace_computers" USING btree ("workspace_id","computer_id") WHERE "workspace_computers"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_computers_active_workspace_idx" ON "workspace_computers" USING btree ("workspace_id") WHERE "workspace_computers"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_computers_computer_id_idx" ON "workspace_computers" USING btree ("computer_id");
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_manager_computer_owner_fk";
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "teams"
		WHERE NOT EXISTS (
			SELECT 1 FROM "memberships"
			WHERE "memberships"."team_id" = "teams"."id"
				AND "memberships"."role" = 'admin'
				AND "memberships"."status" = 'active'
		)
	) THEN
		RAISE EXCEPTION 'Workspace cutover requires at least one active Admin per legacy Team';
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "workspace_admin_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_admin_grants_revocation_pair" CHECK (("workspace_admin_grants"."revoked_by_user_id" is null) = ("workspace_admin_grants"."revoked_at" is null)),
	CONSTRAINT "workspace_admin_grants_revoked_after_granted" CHECK ("workspace_admin_grants"."revoked_at" is null or "workspace_admin_grants"."revoked_at" >= "workspace_admin_grants"."granted_at")
);
--> statement-breakpoint
CREATE TABLE "admin_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "admin_invitations_expiry" CHECK ("admin_invitations"."expires_at" > "admin_invitations"."created_at"),
	CONSTRAINT "admin_invitations_acceptance_pair" CHECK (("admin_invitations"."accepted_by_user_id" is null) = ("admin_invitations"."accepted_at" is null)),
	CONSTRAINT "admin_invitations_revocation_pair" CHECK (("admin_invitations"."revoked_by_user_id" is null) = ("admin_invitations"."revoked_at" is null)),
	CONSTRAINT "admin_invitations_terminal_state" CHECK (not ("admin_invitations"."accepted_at" is not null and "admin_invitations"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "account_cli_login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "account_cli_login_codes_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "account_cli_login_codes_expiry" CHECK ("account_cli_login_codes"."expires_at" > "account_cli_login_codes"."created_at")
);
--> statement-breakpoint
ALTER TABLE "teams" RENAME TO "workspaces";
--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "team_id" TO "workspace_id";
--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "manager_user_id" TO "created_by_user_id";
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "workspace_computer_id" uuid;
--> statement-breakpoint
ALTER TABLE "session_placements" ADD COLUMN "workspace_computer_id" uuid;
--> statement-breakpoint
INSERT INTO "workspace_admin_grants" ("workspace_id", "user_id", "granted_by_user_id", "granted_at")
SELECT "team_id", "user_id", "user_id", "created_at"
FROM "memberships"
WHERE "role" = 'admin' AND "status" = 'active';
--> statement-breakpoint
UPDATE "agents"
SET "workspace_computer_id" = (
	SELECT "workspace_computers"."id"
	FROM "workspace_computers"
	WHERE "workspace_computers"."workspace_id" = "agents"."workspace_id"
		AND "workspace_computers"."computer_id" = "agents"."computer_id"
	ORDER BY ("workspace_computers"."revoked_at" IS NULL) DESC,
		"workspace_computers"."enrolled_at" DESC,
		"workspace_computers"."id" ASC
	LIMIT 1
);
--> statement-breakpoint
UPDATE "session_placements"
SET "workspace_computer_id" = (
	SELECT "workspace_computers"."id"
	FROM "sessions"
	INNER JOIN "im_bindings" ON "im_bindings"."id" = "sessions"."im_binding_id"
	INNER JOIN "agents" ON "agents"."id" = "im_bindings"."agent_id"
	INNER JOIN "workspace_computers" ON "workspace_computers"."workspace_id" = "agents"."workspace_id"
		AND "workspace_computers"."computer_id" = "session_placements"."computer_id"
	WHERE "workspace_computers"."workspace_id" = "agents"."workspace_id"
		AND "sessions"."id" = "session_placements"."session_id"
	ORDER BY ("workspace_computers"."revoked_at" IS NULL) DESC,
		"workspace_computers"."enrolled_at" DESC,
		"workspace_computers"."id" ASC
	LIMIT 1
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "agents" WHERE "workspace_computer_id" IS NULL) THEN
		RAISE EXCEPTION 'Workspace cutover could not map every Agent to an enrollment';
	END IF;
	IF EXISTS (SELECT 1 FROM "session_placements" WHERE "workspace_computer_id" IS NULL) THEN
		RAISE EXCEPTION 'Workspace cutover could not map every Session placement to an enrollment';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "agents"
		INNER JOIN "workspace_computers" ON "workspace_computers"."id" = "agents"."workspace_computer_id"
		WHERE "workspace_computers"."workspace_id" <> "agents"."workspace_id"
	) THEN
		RAISE EXCEPTION 'Workspace cutover found a cross-Workspace Agent enrollment';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "session_placements"
		INNER JOIN "sessions" ON "sessions"."id" = "session_placements"."session_id"
		INNER JOIN "im_bindings" ON "im_bindings"."id" = "sessions"."im_binding_id"
		INNER JOIN "agents" ON "agents"."id" = "im_bindings"."agent_id"
		INNER JOIN "workspace_computers" ON "workspace_computers"."id" = "session_placements"."workspace_computer_id"
		WHERE "workspace_computers"."workspace_id" <> "agents"."workspace_id"
	) THEN
		RAISE EXCEPTION 'Workspace cutover found a cross-Workspace Session placement';
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "workspace_computer_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "session_placements" ALTER COLUMN "workspace_computer_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_manager_membership_fk";
--> statement-breakpoint
ALTER TABLE "computer_connect_codes" DROP CONSTRAINT "computer_connect_codes_workspace_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_computers" DROP CONSTRAINT "workspace_computers_workspace_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "session_placements" DROP CONSTRAINT "session_placements_computer_id_computers_id_fk";
--> statement-breakpoint
ALTER TABLE "computers" DROP CONSTRAINT "computers_id_owner_user_id_unique";
--> statement-breakpoint
ALTER TABLE "computers" DROP CONSTRAINT "computers_owner_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "agents_team_name_active_unique";
--> statement-breakpoint
DROP INDEX "agents_team_id_idx";
--> statement-breakpoint
DROP INDEX "agents_manager_user_id_idx";
--> statement-breakpoint
DROP INDEX "agents_computer_id_idx";
--> statement-breakpoint
DROP INDEX "teams_name_unique";
--> statement-breakpoint
DROP INDEX "computers_owner_user_id_idx";
--> statement-breakpoint
DROP INDEX "session_placements_computer_id_idx";
--> statement-breakpoint
DROP INDEX "agents_creation_intent_unique";
--> statement-breakpoint
ALTER TABLE "workspace_admin_grants" ADD CONSTRAINT "workspace_admin_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_admin_grants" ADD CONSTRAINT "workspace_admin_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_admin_grants" ADD CONSTRAINT "workspace_admin_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_admin_grants" ADD CONSTRAINT "workspace_admin_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_cli_login_codes" ADD CONSTRAINT "account_cli_login_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_cli_login_codes" ADD CONSTRAINT "account_cli_login_codes_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_enrollment_fk" FOREIGN KEY ("workspace_id","workspace_computer_id") REFERENCES "public"."workspace_computers"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_computers" ADD CONSTRAINT "workspace_computers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_workspace_computer_id_workspace_computers_id_fk" FOREIGN KEY ("workspace_computer_id") REFERENCES "public"."workspace_computers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_admin_grants_active_workspace_user_unique" ON "workspace_admin_grants" USING btree ("workspace_id","user_id") WHERE "workspace_admin_grants"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "workspace_admin_grants_active_user_workspace_idx" ON "workspace_admin_grants" USING btree ("user_id","workspace_id") WHERE "workspace_admin_grants"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "workspace_admin_grants_workspace_granted_idx" ON "workspace_admin_grants" USING btree ("workspace_id","granted_at");
--> statement-breakpoint
CREATE INDEX "admin_invitations_workspace_created_idx" ON "admin_invitations" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX "account_cli_login_codes_user_created_idx" ON "account_cli_login_codes" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_name_unique" ON "workspaces" USING btree (lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_name_active_unique" ON "agents" USING btree ("workspace_id",lower("name")) WHERE "agents"."status" <> 'deleted';
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_creation_intent_unique" ON "agents" USING btree ("workspace_id","creation_intent_id") WHERE "agents"."creation_intent_id" is not null;
--> statement-breakpoint
CREATE INDEX "agents_workspace_id_idx" ON "agents" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "agents_created_by_user_id_idx" ON "agents" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "agents_workspace_computer_id_idx" ON "agents" USING btree ("workspace_computer_id");
--> statement-breakpoint
CREATE INDEX "session_placements_workspace_computer_id_idx" ON "session_placements" USING btree ("workspace_computer_id");
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "computer_id";
--> statement-breakpoint
ALTER TABLE "session_placements" DROP COLUMN "computer_id";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "owner_user_id";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "display_name";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "platform";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "arch";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "client_version";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "current_instance_id";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "connected_at";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "last_seen_at";
--> statement-breakpoint
ALTER TABLE "computers" DROP COLUMN "updated_at";
--> statement-breakpoint
ALTER TABLE "memberships" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invitation_redemptions" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invitations" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connect_codes" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP TABLE "memberships" CASCADE;
--> statement-breakpoint
DROP TABLE "invitation_redemptions" CASCADE;
--> statement-breakpoint
DROP TABLE "invitations" CASCADE;
--> statement-breakpoint
DROP TABLE "connect_codes" CASCADE;
--> statement-breakpoint
DROP TYPE "public"."membership_role";
--> statement-breakpoint
DROP TYPE "public"."membership_status";
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "workspaces"
		WHERE NOT EXISTS (
			SELECT 1 FROM "workspace_admin_grants"
			WHERE "workspace_admin_grants"."workspace_id" = "workspaces"."id"
				AND "workspace_admin_grants"."revoked_at" IS NULL
		)
	) THEN
		RAISE EXCEPTION 'Workspace cutover produced a Workspace without an active Admin';
	END IF;
	IF EXISTS (SELECT 1 FROM "workspace_computer_credentials") THEN
		RAISE EXCEPTION 'Workspace cutover must not synthesize machine credentials';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "workspace_computers"
		WHERE "current_instance_id" IS NOT NULL OR "connected_at" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'Workspace cutover must not synthesize online presence';
	END IF;
END $$;
