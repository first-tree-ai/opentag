CREATE TYPE "public"."agent_receive_mode" AS ENUM('all_message', 'mention_only');--> statement-breakpoint
CREATE TYPE "public"."im_author_kind" AS ENUM('human', 'bot', 'system');--> statement-breakpoint
CREATE TYPE "public"."im_delivery_attention" AS ENUM('direct', 'ambient');--> statement-breakpoint
CREATE TYPE "public"."im_delivery_state" AS ENUM('pending', 'accepted', 'terminal_rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."im_message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."im_message_operation" AS ENUM('created', 'edited', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."im_outbound_operation" AS ENUM('send', 'reply', 'react');--> statement-breakpoint
CREATE TYPE "public"."im_outbound_state" AS ENUM('prepared', 'succeeded', 'deterministic_failed', 'credential_failed', 'transient_failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."feishu_setup_intent" AS ENUM('create', 'reauthorize', 'replace');--> statement-breakpoint
CREATE TYPE "public"."feishu_setup_state" AS ENUM('awaiting_user', 'validating', 'succeeded', 'failed', 'expired', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."im_conversation_kind" AS ENUM('channel', 'dm', 'group_dm');--> statement-breakpoint
CREATE TYPE "public"."im_provider" AS ENUM('feishu', 'slack');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('provisioning', 'active', 'reauthorization_required', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('channel', 'thread', 'internal');--> statement-breakpoint
CREATE TABLE "im_message_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"attention" "im_delivery_attention" NOT NULL,
	"state" "im_delivery_state" DEFAULT 'pending' NOT NULL,
	"placement_generation" bigint NOT NULL,
	"dispatch_request_id" uuid,
	"dispatch_input_hash" text,
	"dispatch_payload" jsonb,
	"input_hash" text,
	"turn_id" text,
	"report_owner_instance_id" uuid,
	"result_hash" text,
	"turn_report" jsonb,
	"reported_at" timestamp with time zone,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"reason" text,
	"last_error_code" text,
	CONSTRAINT "im_message_deliveries_dispatch_shape" CHECK (("im_message_deliveries"."dispatch_request_id" is null and "im_message_deliveries"."dispatch_input_hash" is null and "im_message_deliveries"."dispatch_payload" is null)
        or ("im_message_deliveries"."dispatch_request_id" is not null and "im_message_deliveries"."dispatch_input_hash" is not null
          and ("im_message_deliveries"."dispatch_payload" is not null or "im_message_deliveries"."state" = 'accepted'))),
	CONSTRAINT "im_message_deliveries_custody_shape" CHECK (("im_message_deliveries"."state" = 'accepted' and "im_message_deliveries"."input_hash" is not null and "im_message_deliveries"."turn_id" is not null and "im_message_deliveries"."report_owner_instance_id" is not null and "im_message_deliveries"."accepted_at" is not null)
        or ("im_message_deliveries"."state" <> 'accepted' and "im_message_deliveries"."turn_id" is null and "im_message_deliveries"."report_owner_instance_id" is null and "im_message_deliveries"."reported_at" is null and "im_message_deliveries"."turn_report" is null and "im_message_deliveries"."result_hash" is null)),
	CONSTRAINT "im_message_deliveries_report_shape" CHECK (("im_message_deliveries"."reported_at" is null and "im_message_deliveries"."turn_report" is null)
        or ("im_message_deliveries"."reported_at" is not null and "im_message_deliveries"."turn_report" is not null and "im_message_deliveries"."result_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "im_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider_event_id" text,
	"channel_id" text NOT NULL,
	"external_message_id" text NOT NULL,
	"provider_revision_key" text NOT NULL,
	"operation" "im_message_operation" NOT NULL,
	"direction" "im_message_direction" NOT NULL,
	"thread_key" text,
	"reply_to_external_id" text,
	"author_kind" "im_author_kind" NOT NULL,
	"author_external_id" text NOT NULL,
	"author_display_name" text,
	"content" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_outbound_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"expected_latest_im_message_id" uuid NOT NULL,
	"admitted_credential_generation" bigint NOT NULL,
	"operation" "im_outbound_operation" NOT NULL,
	"payload_hash" text NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"state" "im_outbound_state" NOT NULL,
	"provider_message_id" text,
	"result_code" text,
	"retry_after_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" "im_provider" NOT NULL,
	"status" "integration_status" DEFAULT 'provisioning' NOT NULL,
	"external_app_id" text,
	"external_team_id" text,
	"external_enterprise_id" text,
	"external_bot_id" text,
	"external_team_brand" text,
	"external_team_name" text,
	"bot_display_name" text,
	"bot_avatar_url" text,
	"credential_schema_version" bigint,
	"credential_generation" bigint DEFAULT 0 NOT NULL,
	"encrypted_credential" text,
	"granted_capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"setup_attempt_id" uuid,
	"setup_intent" "feishu_setup_intent",
	"setup_state" "feishu_setup_state",
	"setup_owner_instance_id" uuid,
	"setup_owner_heartbeat_at" timestamp with time zone,
	"encrypted_setup_context" text,
	"setup_expires_at" timestamp with time zone,
	"replacement_integration_id" uuid,
	"connection_owner_instance_id" uuid,
	"connection_fencing_epoch" bigint DEFAULT 0 NOT NULL,
	"connection_lease_expires_at" timestamp with time zone,
	"observed_connected_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_credential_generation_nonnegative" CHECK ("integrations"."credential_generation" >= 0),
	CONSTRAINT "integrations_connection_epoch_nonnegative" CHECK ("integrations"."connection_fencing_epoch" >= 0),
	CONSTRAINT "integrations_active_binding_shape" CHECK ("integrations"."status" not in ('active', 'reauthorization_required') or (
        "integrations"."external_app_id" is not null and
        ("integrations"."provider" = 'feishu' or "integrations"."external_team_id" is not null) and
        "integrations"."external_bot_id" is not null and "integrations"."credential_schema_version" is not null and
        "integrations"."credential_generation" >= 1 and "integrations"."encrypted_credential" is not null and
        "integrations"."activated_at" is not null and "integrations"."disabled_at" is null
      )),
	CONSTRAINT "integrations_disabled_secret_shape" CHECK ("integrations"."status" <> 'disabled' or (
        "integrations"."encrypted_credential" is null and "integrations"."encrypted_setup_context" is null and
        "integrations"."setup_owner_instance_id" is null and "integrations"."connection_owner_instance_id" is null and
        "integrations"."connection_lease_expires_at" is null and "integrations"."disabled_at" is not null
      )),
	CONSTRAINT "integrations_setup_owner_shape" CHECK (("integrations"."setup_owner_instance_id" is null and "integrations"."setup_owner_heartbeat_at" is null and
        "integrations"."encrypted_setup_context" is null and "integrations"."setup_expires_at" is null)
        or ("integrations"."setup_attempt_id" is not null and "integrations"."setup_intent" is not null and
        "integrations"."setup_state" is not null and "integrations"."setup_owner_instance_id" is not null and
        "integrations"."setup_owner_heartbeat_at" is not null and "integrations"."encrypted_setup_context" is not null and
        "integrations"."setup_expires_at" is not null)),
	CONSTRAINT "integrations_connection_owner_shape" CHECK (("integrations"."connection_owner_instance_id" is null and "integrations"."connection_lease_expires_at" is null)
        or ("integrations"."provider" = 'feishu' and "integrations"."connection_owner_instance_id" is not null and
        "integrations"."connection_lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "session_placements" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"computer_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_placements_generation_positive" CHECK ("session_placements"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"conversation_kind" "im_conversation_kind" NOT NULL,
	"kind" "session_kind" NOT NULL,
	"thread_key" text,
	"created_by_session_id" uuid,
	"ended_at" timestamp with time zone,
	"revision" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_shape_check" CHECK (("sessions"."kind" = 'channel' and "sessions"."thread_key" is null and "sessions"."created_by_session_id" is null)
        or ("sessions"."kind" = 'thread' and "sessions"."thread_key" is not null and "sessions"."created_by_session_id" is null)
        or ("sessions"."kind" = 'internal' and "sessions"."created_by_session_id" is not null)),
	CONSTRAINT "sessions_revision_positive" CHECK ("sessions"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "receive_mode" "agent_receive_mode" DEFAULT 'all_message' NOT NULL;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_message_id_im_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."im_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_message_deliveries" ADD CONSTRAINT "im_message_deliveries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_messages" ADD CONSTRAINT "im_messages_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_outbound_requests" ADD CONSTRAINT "im_outbound_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_outbound_requests" ADD CONSTRAINT "im_outbound_requests_expected_latest_im_message_id_im_messages_id_fk" FOREIGN KEY ("expected_latest_im_message_id") REFERENCES "public"."im_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_replacement_integration_id_integrations_id_fk" FOREIGN KEY ("replacement_integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_session_id_sessions_id_fk" FOREIGN KEY ("created_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_deliveries_message_session_unique" ON "im_message_deliveries" USING btree ("message_id","session_id");--> statement-breakpoint
CREATE INDEX "im_message_deliveries_pending_idx" ON "im_message_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_deliveries_dispatch_request_unique" ON "im_message_deliveries" USING btree ("dispatch_request_id") WHERE "im_message_deliveries"."dispatch_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_deliveries_turn_id_unique" ON "im_message_deliveries" USING btree ("turn_id") WHERE "im_message_deliveries"."turn_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "im_messages_provider_event_unique" ON "im_messages" USING btree ("integration_id","provider_event_id") WHERE "im_messages"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "im_messages_semantic_revision_unique" ON "im_messages" USING btree ("integration_id","channel_id","external_message_id","provider_revision_key");--> statement-breakpoint
CREATE INDEX "im_messages_scope_occurred_idx" ON "im_messages" USING btree ("integration_id","channel_id","thread_key","occurred_at");--> statement-breakpoint
CREATE INDEX "im_messages_external_occurred_idx" ON "im_messages" USING btree ("integration_id","channel_id","external_message_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_agent_current_unique" ON "integrations" USING btree ("agent_id") WHERE "integrations"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_feishu_app_current_unique" ON "integrations" USING btree ("external_app_id") WHERE "integrations"."provider" = 'feishu' and "integrations"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_slack_app_team_current_unique" ON "integrations" USING btree ("external_app_id","external_team_id") WHERE "integrations"."provider" = 'slack' and "integrations"."status" <> 'disabled';--> statement-breakpoint
CREATE INDEX "session_placements_computer_id_idx" ON "session_placements" USING btree ("computer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_channel_unique" ON "sessions" USING btree ("integration_id","channel_id") WHERE "sessions"."kind" = 'channel' and "sessions"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_thread_unique" ON "sessions" USING btree ("integration_id","channel_id","thread_key") WHERE "sessions"."kind" = 'thread' and "sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_integration_scope_idx" ON "sessions" USING btree ("integration_id","channel_id","thread_key");