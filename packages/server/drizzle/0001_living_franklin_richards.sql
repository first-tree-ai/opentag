CREATE TYPE "public"."computer_platform" AS ENUM('darwin', 'linux', 'win32');--> statement-breakpoint
CREATE TABLE "computers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"platform" "computer_platform" NOT NULL,
	"arch" text NOT NULL,
	"client_version" text NOT NULL,
	"current_instance_id" uuid,
	"connected_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computers_owner_user_id_idx" ON "computers" USING btree ("owner_user_id");