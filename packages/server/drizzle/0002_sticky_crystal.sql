CREATE TYPE "public"."agent_runtime_provider" AS ENUM('codex', 'claude-code');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"manager_user_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"runtime_provider" "agent_runtime_provider" NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_revision_positive" CHECK ("agents"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_team_name_active_unique" ON "agents" USING btree ("team_id",lower("name")) WHERE "agents"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "agents_team_id_idx" ON "agents" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "agents_manager_user_id_idx" ON "agents" USING btree ("manager_user_id");--> statement-breakpoint
CREATE INDEX "agents_computer_id_idx" ON "agents" USING btree ("computer_id");