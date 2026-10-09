CREATE TABLE "slack_working_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"credential_generation" bigint NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"working" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_before_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_id" uuid,
	"claim_expires_at" timestamp with time zone,
	"failures" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_working_turns" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"phase" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_installations" ADD COLUMN "working_status_not_before_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_working_targets" ADD CONSTRAINT "slack_working_targets_binding_id_im_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."im_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_working_targets" ADD CONSTRAINT "slack_working_targets_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_working_turns" ADD CONSTRAINT "slack_working_turns_delivery_id_im_message_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."im_message_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_working_turns" ADD CONSTRAINT "slack_working_turns_target_id_slack_working_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."slack_working_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_working_targets_due_idx" ON "slack_working_targets" USING btree ("disabled","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_working_targets_thread_unique" ON "slack_working_targets" USING btree ("installation_id","channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "slack_working_turns_target_idx" ON "slack_working_turns" USING btree ("target_id");