CREATE TYPE "public"."slack_route_kind" AS ENUM('default', 'explicit');--> statement-breakpoint
CREATE TYPE "public"."slack_installation_status" AS ENUM('active', 'reauthorization_required', 'disabled');--> statement-breakpoint
CREATE TABLE "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" "slack_installation_status" DEFAULT 'active' NOT NULL,
	"external_app_id" text NOT NULL,
	"external_team_id" text NOT NULL,
	"external_enterprise_id" text,
	"external_bot_id" text NOT NULL,
	"external_team_name" text,
	"bot_display_name" text,
	"bot_avatar_url" text,
	"credential_schema_version" bigint,
	"credential_generation" bigint DEFAULT 0 NOT NULL,
	"encrypted_credential" text,
	"granted_capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"replacement_slack_installation_id" uuid,
	"observed_connected_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_installations_credential_generation_nonnegative" CHECK ("slack_installations"."credential_generation" >= 0),
	CONSTRAINT "slack_installations_active_shape" CHECK ("slack_installations"."status" not in ('active', 'reauthorization_required') or (
        "slack_installations"."credential_schema_version" is not null and
        "slack_installations"."credential_generation" >= 1 and "slack_installations"."encrypted_credential" is not null and
        "slack_installations"."activated_at" is not null and "slack_installations"."disabled_at" is null
      )),
	CONSTRAINT "slack_installations_disabled_secret_shape" CHECK ("slack_installations"."status" <> 'disabled' or (
        "slack_installations"."encrypted_credential" is null and "slack_installations"."disabled_at" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "im_bindings_active_binding_shape";--> statement-breakpoint
DROP INDEX "im_bindings_slack_app_team_current_unique";--> statement-breakpoint
ALTER TABLE "im_bindings" ADD COLUMN "slack_installation_id" uuid;--> statement-breakpoint
ALTER TABLE "im_bindings" ADD COLUMN "slack_route_kind" "slack_route_kind";--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_replacement_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("replacement_slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installations_app_team_current_unique" ON "slack_installations" USING btree ("external_app_id","external_team_id") WHERE "slack_installations"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installations_workspace_current_unique" ON "slack_installations" USING btree ("workspace_id") WHERE "slack_installations"."status" <> 'disabled';--> statement-breakpoint
CREATE INDEX "slack_installations_workspace_id_idx" ON "slack_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "slack_installations_app_team_idx" ON "slack_installations" USING btree ("external_app_id","external_team_id");--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
UPDATE "im_bindings"
SET
	"status" = 'disabled',
	"encrypted_credential" = NULL,
	"encrypted_setup_context" = NULL,
	"setup_owner_instance_id" = NULL,
	"setup_owner_heartbeat_at" = NULL,
	"setup_expires_at" = NULL,
	"connection_owner_instance_id" = NULL,
	"connection_lease_expires_at" = NULL,
	"disabled_at" = COALESCE("disabled_at", now()),
	"last_error_code" = COALESCE("last_error_code", 'SLACK_CONFIGURATION_REQUIRED'),
	"updated_at" = now()
WHERE "provider" = 'slack'
	AND "status" <> 'disabled'
	AND (
		"status" not in ('active', 'reauthorization_required')
		OR "external_app_id" IS NULL
		OR "external_team_id" IS NULL
		OR "external_bot_id" IS NULL
		OR "credential_schema_version" IS NULL
		OR "credential_generation" < 1
		OR "encrypted_credential" IS NULL
		OR "activated_at" IS NULL
	);--> statement-breakpoint
INSERT INTO "slack_installations" (
	"id",
	"workspace_id",
	"status",
	"external_app_id",
	"external_team_id",
	"external_enterprise_id",
	"external_bot_id",
	"external_team_name",
	"bot_display_name",
	"bot_avatar_url",
	"credential_schema_version",
	"credential_generation",
	"encrypted_credential",
	"granted_capabilities",
	"observed_connected_at",
	"observed_at",
	"activated_at",
	"last_error_code",
	"created_at",
	"updated_at"
)
SELECT
	gen_random_uuid(),
	"agents"."workspace_id",
	CASE
		WHEN "im_bindings"."status" = 'reauthorization_required' THEN 'reauthorization_required'::"slack_installation_status"
		ELSE 'active'::"slack_installation_status"
	END,
	"im_bindings"."external_app_id",
	"im_bindings"."external_team_id",
	"im_bindings"."external_enterprise_id",
	"im_bindings"."external_bot_id",
	"im_bindings"."external_team_name",
	"im_bindings"."bot_display_name",
	"im_bindings"."bot_avatar_url",
	"im_bindings"."credential_schema_version",
	"im_bindings"."credential_generation",
	"im_bindings"."encrypted_credential",
	"im_bindings"."granted_capabilities",
	"im_bindings"."observed_connected_at",
	"im_bindings"."observed_at",
	"im_bindings"."activated_at",
	"im_bindings"."last_error_code",
	"im_bindings"."created_at",
	"im_bindings"."updated_at"
FROM "im_bindings"
INNER JOIN "agents" ON "agents"."id" = "im_bindings"."agent_id"
INNER JOIN (
	SELECT DISTINCT ON ("agents"."workspace_id")
		"im_bindings"."id"
	FROM "im_bindings"
	INNER JOIN "agents" ON "agents"."id" = "im_bindings"."agent_id"
	WHERE "im_bindings"."provider" = 'slack'
		AND "im_bindings"."status" in ('active', 'reauthorization_required')
		AND "im_bindings"."external_app_id" IS NOT NULL
		AND "im_bindings"."external_team_id" IS NOT NULL
	ORDER BY "agents"."workspace_id",
		CASE WHEN "im_bindings"."status" = 'active' THEN 0 ELSE 1 END,
		"im_bindings"."created_at" ASC,
		"im_bindings"."id" ASC
) AS "chosen" ON "chosen"."id" = "im_bindings"."id";--> statement-breakpoint
UPDATE "im_bindings"
SET
	"slack_installation_id" = "slack_installations"."id",
	"slack_route_kind" = CASE
		WHEN "im_bindings"."id" = "first_route"."binding_id" THEN 'default'::"slack_route_kind"
		ELSE 'explicit'::"slack_route_kind"
	END,
	"encrypted_credential" = NULL,
	"updated_at" = now()
FROM "slack_installations"
INNER JOIN (
	SELECT DISTINCT ON ("slack_installations"."id")
		"slack_installations"."id" AS "installation_id",
		"im_bindings"."id" AS "binding_id"
	FROM "slack_installations"
	INNER JOIN "im_bindings"
		ON "im_bindings"."provider" = 'slack'
		AND "im_bindings"."status" in ('active', 'reauthorization_required')
		AND "im_bindings"."external_app_id" = "slack_installations"."external_app_id"
		AND "im_bindings"."external_team_id" = "slack_installations"."external_team_id"
	ORDER BY "slack_installations"."id",
		CASE WHEN "im_bindings"."status" = 'active' THEN 0 ELSE 1 END,
		"im_bindings"."created_at" ASC,
		"im_bindings"."id" ASC
) AS "first_route" ON "first_route"."installation_id" = "slack_installations"."id"
WHERE "im_bindings"."provider" = 'slack'
	AND "im_bindings"."status" in ('active', 'reauthorization_required')
	AND "im_bindings"."external_app_id" = "slack_installations"."external_app_id"
	AND "im_bindings"."external_team_id" = "slack_installations"."external_team_id";--> statement-breakpoint
UPDATE "im_bindings"
SET
	"status" = 'disabled',
	"encrypted_credential" = NULL,
	"encrypted_setup_context" = NULL,
	"setup_owner_instance_id" = NULL,
	"setup_owner_heartbeat_at" = NULL,
	"setup_expires_at" = NULL,
	"connection_owner_instance_id" = NULL,
	"connection_lease_expires_at" = NULL,
	"slack_route_kind" = NULL,
	"disabled_at" = COALESCE("disabled_at", now()),
	"last_error_code" = COALESCE("last_error_code", 'SLACK_CONFIGURATION_REQUIRED'),
	"updated_at" = now()
WHERE "provider" = 'slack'
	AND "status" <> 'disabled'
	AND "slack_installation_id" IS NULL;--> statement-breakpoint
UPDATE "im_bindings"
SET
	"encrypted_credential" = NULL,
	"updated_at" = now()
WHERE "provider" = 'slack'
	AND "status" = 'disabled'
	AND "encrypted_credential" IS NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "im_bindings"
		WHERE "provider" = 'slack'
			AND "status" IN ('active', 'reauthorization_required')
			AND (
				"encrypted_credential" IS NOT NULL
				OR "slack_installation_id" IS NULL
				OR "slack_route_kind" IS NULL
			)
	) THEN
		RAISE EXCEPTION 'Slack installation cutover left a current Slack route with credentials or without an installation';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "slack_installations"
		WHERE "status" <> 'disabled'
			AND "encrypted_credential" IS NULL
	) THEN
		RAISE EXCEPTION 'Slack installation cutover created a current installation without credentials';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "slack_installations"
		INNER JOIN "im_bindings" ON "im_bindings"."slack_installation_id" = "slack_installations"."id"
		INNER JOIN "agents" ON "agents"."id" = "im_bindings"."agent_id"
		WHERE "im_bindings"."status" <> 'disabled'
			AND "agents"."workspace_id" <> "slack_installations"."workspace_id"
	) THEN
		RAISE EXCEPTION 'Slack installation cutover created a cross-workspace route';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "im_bindings_slack_installation_default_unique" ON "im_bindings" USING btree ("slack_installation_id") WHERE "im_bindings"."provider" = 'slack' and "im_bindings"."status" <> 'disabled' and "im_bindings"."slack_route_kind" = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX "im_bindings_slack_installation_agent_current_unique" ON "im_bindings" USING btree ("slack_installation_id","agent_id") WHERE "im_bindings"."provider" = 'slack' and "im_bindings"."status" <> 'disabled';--> statement-breakpoint
CREATE INDEX "im_bindings_slack_installation_id_idx" ON "im_bindings" USING btree ("slack_installation_id");--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_slack_route_fields" CHECK ("im_bindings"."provider" = 'slack' or (
        "im_bindings"."slack_installation_id" is null and "im_bindings"."slack_route_kind" is null
      ));--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_active_binding_shape" CHECK ("im_bindings"."status" not in ('active', 'reauthorization_required') or (
        "im_bindings"."external_app_id" is not null and
        ("im_bindings"."provider" = 'feishu' or "im_bindings"."external_team_id" is not null) and
        "im_bindings"."external_bot_id" is not null and "im_bindings"."credential_schema_version" is not null and
        "im_bindings"."credential_generation" >= 1 and
        "im_bindings"."activated_at" is not null and "im_bindings"."disabled_at" is null and
        (
          ("im_bindings"."provider" = 'feishu' and "im_bindings"."encrypted_credential" is not null and
            "im_bindings"."slack_installation_id" is null and "im_bindings"."slack_route_kind" is null) or
          ("im_bindings"."provider" = 'slack' and "im_bindings"."encrypted_credential" is null and
            "im_bindings"."slack_installation_id" is not null and "im_bindings"."slack_route_kind" is not null)
        )
      ));--> statement-breakpoint
DELETE FROM "slack_oauth_nonces" WHERE "intent" = 'replace';--> statement-breakpoint
ALTER TABLE "slack_oauth_nonces" DROP CONSTRAINT "slack_oauth_nonces_intent";--> statement-breakpoint
ALTER TABLE "slack_oauth_nonces" ADD CONSTRAINT "slack_oauth_nonces_intent" CHECK ("slack_oauth_nonces"."intent" in ('create', 'reauthorize'));
