CREATE TYPE "public"."computer_kind" AS ENUM('local', 'cloud');--> statement-breakpoint
CREATE TYPE "public"."sandbox_lifecycle" AS ENUM('unallocated', 'preparing', 'ready', 'releasing');--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"storage_uri" text NOT NULL,
	"lifecycle" "sandbox_lifecycle" DEFAULT 'unallocated' NOT NULL,
	"current_resource_name" text,
	"current_resource_uid" text,
	"current_operation_name" text,
	"environment_generation" bigint DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_environment_generation_nonnegative" CHECK ("sandboxes"."environment_generation" >= 0),
	CONSTRAINT "sandboxes_storage_uri_bounds" CHECK (char_length("sandboxes"."storage_uri") between 1 and 2048),
	CONSTRAINT "sandboxes_current_resource_name_bounds" CHECK ("sandboxes"."current_resource_name" is null or char_length("sandboxes"."current_resource_name") between 1 and 1024),
	CONSTRAINT "sandboxes_current_resource_uid_bounds" CHECK ("sandboxes"."current_resource_uid" is null or char_length("sandboxes"."current_resource_uid") between 1 and 128),
	CONSTRAINT "sandboxes_current_operation_name_bounds" CHECK ("sandboxes"."current_operation_name" is null or char_length("sandboxes"."current_operation_name") between 1 and 1024),
	CONSTRAINT "sandboxes_last_error_code_shape" CHECK ("sandboxes"."last_error_code" is null or ("sandboxes"."last_error_code" ~ '^[a-z][a-z0-9_]{0,127}$')),
	CONSTRAINT "sandboxes_last_error_pair" CHECK (("sandboxes"."last_error_code" is null) = ("sandboxes"."last_error_at" is null))
);
--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "kind" "computer_kind" DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_session_id_unique" ON "sandboxes" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_storage_uri_unique" ON "sandboxes" USING btree ("storage_uri");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_current_resource_name_unique" ON "sandboxes" USING btree ("current_resource_name") WHERE "sandboxes"."current_resource_name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_current_resource_uid_unique" ON "sandboxes" USING btree ("current_resource_uid") WHERE "sandboxes"."current_resource_uid" is not null;--> statement-breakpoint
CREATE INDEX "sandboxes_lifecycle_last_activity_idx" ON "sandboxes" USING btree ("lifecycle","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "computers_owner_account_id_cloud_unique" ON "computers" USING btree ("owner_account_id") WHERE "computers"."kind" = 'cloud';