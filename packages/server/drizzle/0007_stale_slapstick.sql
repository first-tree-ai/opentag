CREATE TYPE "public"."agent_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
DROP INDEX "agents_team_name_active_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "status" "agent_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
UPDATE "agents" SET "status" = 'deleted' WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_team_name_active_unique" ON "agents" USING btree ("team_id",lower("name")) WHERE "agents"."status" <> 'deleted';--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "deleted_at";
