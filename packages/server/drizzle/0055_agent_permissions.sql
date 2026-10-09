CREATE TABLE "runtime_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_instance_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"im_binding_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"authority" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" text,
	"message_channel_id" text,
	"card_updated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_configs" ADD COLUMN "permissions" jsonb DEFAULT '{"approvalPolicy":"on-request","allowCommands":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_approvals" ADD CONSTRAINT "runtime_approvals_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_approvals" ADD CONSTRAINT "runtime_approvals_im_binding_id_im_bindings_id_fk" FOREIGN KEY ("im_binding_id") REFERENCES "public"."im_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_approvals_dispatch_idx" ON "runtime_approvals" USING btree ("server_instance_id","status","expires_at");
