CREATE TABLE "im_feedback_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"feedback_revision" bigint NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"actor_account_id" uuid,
	"actor_provider_id" text,
	"actor_display_name" text NOT NULL,
	"binding_generation" bigint NOT NULL,
	"session_id" uuid NOT NULL,
	"placement_generation" bigint NOT NULL,
	"environment_generation" bigint,
	"resource_uid" text,
	"report_hash" text,
	"idempotency_key" text NOT NULL,
	"result_delivery_id" uuid,
	"result_code" text,
	"confirmed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "im_feedback_actions_kind" CHECK ("im_feedback_actions"."kind" in ('retry_task','save_release','discard')),
	CONSTRAINT "im_feedback_actions_state" CHECK ("im_feedback_actions"."state" in ('confirmed','submitting','checking','succeeded','failed','stale')),
	CONSTRAINT "im_feedback_actions_actor" CHECK ("im_feedback_actions"."actor_account_id" is not null or ("im_feedback_actions"."kind" = 'retry_task' and "im_feedback_actions"."actor_provider_id" is not null)),
	CONSTRAINT "im_feedback_actions_bounds" CHECK (length("im_feedback_actions"."actor_display_name") between 1 and 255 and length("im_feedback_actions"."idempotency_key") between 1 and 255 and "im_feedback_actions"."feedback_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "im_feedback_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_generation" bigint NOT NULL,
	"provider" text NOT NULL,
	"installation_id" uuid,
	"message_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"turn_id" text,
	"placement_generation" bigint NOT NULL,
	"channel_id" text NOT NULL,
	"input_external_id" text NOT NULL,
	"thread_key" text,
	"sender_external_id" text NOT NULL,
	"card_owner_delivery_id" uuid NOT NULL,
	"sandbox_id" uuid,
	"environment_generation" bigint,
	"resource_uid" text,
	"state" text NOT NULL,
	"error_code" text,
	"effects" text,
	"report_hash" text,
	"desired_reaction" text DEFAULT 'none' NOT NULL,
	"applied_reaction" text,
	"revision" bigint DEFAULT 1 NOT NULL,
	"applied_revision" bigint DEFAULT 0 NOT NULL,
	"card_revision" bigint DEFAULT 0 NOT NULL,
	"card_state" text DEFAULT 'none' NOT NULL,
	"card_message_id" text,
	"provider_request_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"send_started_at" timestamp with time zone,
	"reconciliation_cursor" text,
	"claim_id" uuid,
	"claim_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"actions_expire_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "im_feedback_targets_state" CHECK ("im_feedback_targets"."state" in ('queued','working','completed','failed','workspace_blocked','retry_queued','resolved','stale')),
	CONSTRAINT "im_feedback_targets_reactions" CHECK ("im_feedback_targets"."desired_reaction" in ('working','none','warning') and ("im_feedback_targets"."applied_reaction" is null or "im_feedback_targets"."applied_reaction" in ('working','none','warning'))),
	CONSTRAINT "im_feedback_targets_card_state" CHECK ("im_feedback_targets"."card_state" in ('none','pending','sending','sent','send_unknown','blocked')),
	CONSTRAINT "im_feedback_targets_effects" CHECK ("im_feedback_targets"."effects" is null or "im_feedback_targets"."effects" in ('not_started','may_have_occurred','completed')),
	CONSTRAINT "im_feedback_targets_provider" CHECK ("im_feedback_targets"."provider" in ('slack','feishu') and ("im_feedback_targets"."provider" <> 'slack' or "im_feedback_targets"."installation_id" is not null)),
	CONSTRAINT "im_feedback_targets_versions" CHECK ("im_feedback_targets"."binding_generation" >= 1 and "im_feedback_targets"."placement_generation" >= 1 and "im_feedback_targets"."revision" >= 1 and "im_feedback_targets"."applied_revision" >= 0 and "im_feedback_targets"."card_revision" >= 0 and "im_feedback_targets"."attempt_count" >= 0),
	CONSTRAINT "im_feedback_targets_bounds" CHECK (length("im_feedback_targets"."channel_id") between 1 and 255 and length("im_feedback_targets"."input_external_id") between 1 and 255 and length("im_feedback_targets"."sender_external_id") between 1 and 255 and ("im_feedback_targets"."error_code" is null or "im_feedback_targets"."error_code" ~ '^[a-zA-Z0-9_]{1,128}$'))
);
--> statement-breakpoint
DROP INDEX "im_message_deliveries_message_session_unique";--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "attempt_ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD COLUMN "retry_of_delivery_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "im_feedback_actions_identity_unique" ON "im_feedback_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "im_feedback_actions_revision_unique" ON "im_feedback_actions" USING btree ("feedback_id","feedback_revision");--> statement-breakpoint
CREATE INDEX "im_feedback_actions_result_idx" ON "im_feedback_actions" USING btree ("state","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "im_feedback_targets_delivery_unique" ON "im_feedback_targets" USING btree ("delivery_id","binding_id","binding_generation");--> statement-breakpoint
CREATE INDEX "im_feedback_targets_card_owner_idx" ON "im_feedback_targets" USING btree ("card_owner_delivery_id","id");--> statement-breakpoint
CREATE INDEX "im_feedback_targets_message_idx" ON "im_feedback_targets" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "im_feedback_targets_due_idx" ON "im_feedback_targets" USING btree ("next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "im_feedback_targets_account_agent_idx" ON "im_feedback_targets" USING btree ("account_id","agent_id","created_at","id");--> statement-breakpoint
CREATE INDEX "im_feedback_targets_retention_idx" ON "im_feedback_targets" USING btree ("settled_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_deliveries_message_session_attempt_unique" ON "im_message_deliveries" USING btree ("message_id","session_id","attempt_ordinal");--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_attempt_shape" CHECK (("im_message_deliveries"."attempt_ordinal" = 0 and "im_message_deliveries"."retry_of_delivery_id" is null) or ("im_message_deliveries"."attempt_ordinal" between 1 and 3 and "im_message_deliveries"."retry_of_delivery_id" is not null));