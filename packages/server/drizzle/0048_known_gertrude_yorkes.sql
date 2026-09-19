CREATE TYPE "public"."skill_source" AS ENUM('web_upload', 'cli_upload', 'agent_upload');--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" "skill_source" NOT NULL,
	"object_key" text NOT NULL,
	"archive_sha256" text NOT NULL,
	"archive_bytes" integer NOT NULL,
	"file_count" integer NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files_truncated" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_name_format" CHECK ("agent_skills"."name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "agent_skills_name_length" CHECK (char_length("agent_skills"."name") between 1 and 64),
	CONSTRAINT "agent_skills_description_bounds" CHECK (char_length("agent_skills"."description") between 1 and 1024),
	CONSTRAINT "agent_skills_sha256_format" CHECK ("agent_skills"."archive_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_skills_archive_bytes_bounds" CHECK ("agent_skills"."archive_bytes" between 1 and 16777216),
	CONSTRAINT "agent_skills_file_count_bounds" CHECK ("agent_skills"."file_count" between 1 and 1000),
	CONSTRAINT "agent_skills_revision_positive" CHECK ("agent_skills"."revision" >= 1),
	CONSTRAINT "agent_skills_object_key_bounds" CHECK (char_length("agent_skills"."object_key") between 1 and 1024)
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_agent_name_unique" ON "agent_skills" USING btree ("agent_id",lower("name"));--> statement-breakpoint
CREATE INDEX "agent_skills_agent_id_idx" ON "agent_skills" USING btree ("agent_id");