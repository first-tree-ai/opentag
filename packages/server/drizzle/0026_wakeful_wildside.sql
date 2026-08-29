CREATE TYPE "public"."computer_connect_code_mode" AS ENUM('create', 'repair');--> statement-breakpoint
CREATE TABLE "account_computers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"current_installation_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"platform" "computer_platform" NOT NULL,
	"arch" text NOT NULL,
	"client_version" text NOT NULL,
	"current_instance_id" uuid,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "computer_credentials_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "computer_credentials_revocation_pair" CHECK (("computer_credentials"."revoked_by_user_id" is null) = ("computer_credentials"."revoked_at" is null)),
	CONSTRAINT "computer_credentials_revoked_after_issued" CHECK ("computer_credentials"."revoked_at" is null or "computer_credentials"."revoked_at" >= "computer_credentials"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "computer_id" uuid;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD COLUMN "issued_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD COLUMN "mode" "computer_connect_code_mode";--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD COLUMN "target_computer_id" uuid;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD COLUMN "consumed_computer_id" uuid;--> statement-breakpoint
ALTER TABLE "session_cli_proofs" ADD COLUMN "computer_id" uuid;--> statement-breakpoint
ALTER TABLE "session_placements" ADD COLUMN "computer_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "account_computers" ADD CONSTRAINT "account_computers_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_computers" ADD CONSTRAINT "account_computers_current_installation_id_computers_id_fk" FOREIGN KEY ("current_installation_id") REFERENCES "public"."computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_credentials" ADD CONSTRAINT "computer_credentials_computer_id_account_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."account_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_credentials" ADD CONSTRAINT "computer_credentials_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_credentials" ADD CONSTRAINT "computer_credentials_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_computers_owner_account_id_idx" ON "account_computers" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "account_computers_current_installation_id_idx" ON "account_computers" USING btree ("current_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "computer_credentials_active_computer_unique" ON "computer_credentials" USING btree ("computer_id") WHERE "computer_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "computer_credentials_computer_issued_idx" ON "computer_credentials" USING btree ("computer_id","issued_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_computer_id_account_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."account_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_issued_by_account_id_users_id_fk" FOREIGN KEY ("issued_by_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_target_computer_id_account_computers_id_fk" FOREIGN KEY ("target_computer_id") REFERENCES "public"."account_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_consumed_computer_id_account_computers_id_fk" FOREIGN KEY ("consumed_computer_id") REFERENCES "public"."account_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_cli_proofs" ADD CONSTRAINT "session_cli_proofs_computer_id_account_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."account_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_computer_id_account_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."account_computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_computer_id_idx" ON "agents" USING btree ("computer_id");--> statement-breakpoint
CREATE INDEX "computer_connect_codes_target_computer_id_idx" ON "computer_connect_codes" USING btree ("target_computer_id");--> statement-breakpoint
CREATE INDEX "computer_connect_codes_consumed_computer_id_idx" ON "computer_connect_codes" USING btree ("consumed_computer_id");--> statement-breakpoint
CREATE INDEX "session_cli_proofs_computer_id_idx" ON "session_cli_proofs" USING btree ("computer_id");--> statement-breakpoint
CREATE INDEX "session_placements_computer_id_idx" ON "session_placements" USING btree ("computer_id");--> statement-breakpoint
CREATE INDEX "slack_installations_agent_id_idx" ON "slack_installations" USING btree ("agent_id");