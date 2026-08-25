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
