CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_files" (
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "skill_files_skill_id_path_pk" PRIMARY KEY("skill_id","path"),
	CONSTRAINT "skill_files_sha256_shape" CHECK ("skill_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_files_size_non_negative" CHECK ("skill_files"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"skill_md" text NOT NULL,
	"digest" text NOT NULL,
	"archive_key" text NOT NULL,
	"archive_bytes" integer NOT NULL,
	"archive_sha256" text NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"updated_by_kind" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_shape" CHECK ("skills"."name" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "skills_digest_shape" CHECK ("skills"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skills_archive_sha256_shape" CHECK ("skills"."archive_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skills_counts_non_negative" CHECK ("skills"."archive_bytes" >= 0 and "skills"."total_bytes" >= 0),
	CONSTRAINT "skills_file_count_positive" CHECK ("skills"."file_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_account_id_users_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skills_skill_id_idx" ON "agent_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_name_unique" ON "skills" USING btree ("owner_account_id","name");