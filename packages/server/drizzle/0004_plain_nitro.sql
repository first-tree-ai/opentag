CREATE TYPE "public"."agent_receive_mode" AS ENUM('all_message', 'mention_only');--> statement-breakpoint
CREATE TYPE "public"."im_author_kind" AS ENUM('human', 'bot', 'system');--> statement-breakpoint
CREATE TYPE "public"."im_delivery_attention" AS ENUM('direct', 'ambient');--> statement-breakpoint
CREATE TYPE "public"."im_delivery_state" AS ENUM('pending', 'accepted', 'terminal_rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."im_message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."im_message_operation" AS ENUM('created', 'edited', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."im_outbound_operation" AS ENUM('send', 'reply', 'react');--> statement-breakpoint
CREATE TYPE "public"."im_outbound_state" AS ENUM('prepared', 'succeeded', 'deterministic_failed', 'credential_failed', 'transient_failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."im_resource_availability" AS ENUM('available', 'unavailable', 'too_large', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."im_resource_kind" AS ENUM('image', 'file', 'audio', 'video');--> statement-breakpoint
CREATE TYPE "public"."feishu_setup_intent" AS ENUM('create', 'reauthorize', 'replace');--> statement-breakpoint
CREATE TYPE "public"."feishu_setup_state" AS ENUM('awaiting_user', 'validating', 'succeeded', 'failed', 'expired', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."im_conversation_kind" AS ENUM('channel', 'dm', 'group_dm');--> statement-breakpoint
CREATE TYPE "public"."im_provider" AS ENUM('feishu', 'slack');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('channel', 'thread', 'internal');--> statement-breakpoint
CREATE TABLE "im_message_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"message_revision" bigint NOT NULL,
	"session_id" uuid NOT NULL,
	"attention" "im_delivery_attention" NOT NULL,
	"state" "im_delivery_state" DEFAULT 'pending' NOT NULL,
	"placement_generation" bigint NOT NULL,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "im_message_deliveries_revision_positive" CHECK ("im_message_deliveries"."message_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "im_message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"message_id" uuid,
	"revision_key" text NOT NULL,
	"operation" "im_message_operation" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_message_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"message_revision" bigint NOT NULL,
	"provider_resource_key" text NOT NULL,
	"kind" "im_resource_kind" NOT NULL,
	"filename" text,
	"media_type" text,
	"size_bytes" bigint,
	"ordinal" bigint NOT NULL,
	"availability" "im_resource_availability" DEFAULT 'available' NOT NULL,
	CONSTRAINT "im_message_resources_ordinal_range" CHECK ("im_message_resources"."ordinal" >= 0 and "im_message_resources"."ordinal" < 16),
	CONSTRAINT "im_message_resources_size_limit" CHECK ("im_message_resources"."size_bytes" is null or "im_message_resources"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "im_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"current_revision" bigint NOT NULL,
	"current_revision_key" text NOT NULL,
	"direction" "im_message_direction" NOT NULL,
	"thread_key" text,
	"reply_to_external_id" text,
	"author_kind" "im_author_kind" NOT NULL,
	"author_external_id" text NOT NULL,
	"author_display_name" text,
	"content" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "im_messages_current_revision_positive" CHECK ("im_messages"."current_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "im_outbound_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"expected_latest_im_message_id" uuid NOT NULL,
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
CREATE TABLE "feishu_connection_leases" (
	"integration_id" uuid PRIMARY KEY NOT NULL,
	"holder_instance_id" uuid NOT NULL,
	"fencing_epoch" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"observed_connected_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_integration_identities" (
	"integration_id" uuid PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"tenant_key" text,
	"bot_open_id" text NOT NULL,
	"tenant_brand" text
);
--> statement-breakpoint
CREATE TABLE "feishu_setup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"intent" "feishu_setup_intent" NOT NULL,
	"state" "feishu_setup_state" NOT NULL,
	"owner_instance_id" uuid NOT NULL,
	"owner_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"encrypted_qr_context" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" "im_conversation_kind" NOT NULL,
	"display_name" text,
	"detached_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"integration_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" bigint NOT NULL,
	"generation" bigint NOT NULL,
	"encrypted_payload" text NOT NULL,
	"granted_capabilities" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_credentials_schema_version_positive" CHECK ("integration_credentials"."schema_version" >= 1),
	CONSTRAINT "integration_credentials_generation_positive" CHECK ("integration_credentials"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" "im_provider" NOT NULL,
	"ready_at" timestamp with time zone,
	"reauthorization_required" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_integration_identities" (
	"integration_id" uuid PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"team_id" text NOT NULL,
	"enterprise_id" text,
	"bot_user_id" text NOT NULL
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
	"conversation_id" uuid NOT NULL,
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
ALTER TABLE "im_message_events" ADD CONSTRAINT "im_message_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_message_events" ADD CONSTRAINT "im_message_events_message_id_im_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."im_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_message_resources" ADD CONSTRAINT "im_message_resources_message_id_im_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."im_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_messages" ADD CONSTRAINT "im_messages_conversation_id_im_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."im_conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_outbound_requests" ADD CONSTRAINT "im_outbound_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_outbound_requests" ADD CONSTRAINT "im_outbound_requests_expected_latest_im_message_id_im_messages_id_fk" FOREIGN KEY ("expected_latest_im_message_id") REFERENCES "public"."im_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_connection_leases" ADD CONSTRAINT "feishu_connection_leases_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_integration_identities" ADD CONSTRAINT "feishu_integration_identities_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_setup_attempts" ADD CONSTRAINT "feishu_setup_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_conversations" ADD CONSTRAINT "im_conversations_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_integration_identities" ADD CONSTRAINT "slack_integration_identities_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_conversation_id_im_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."im_conversations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_created_by_session_id_sessions_id_fk" FOREIGN KEY ("created_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_deliveries_message_revision_session_unique" ON "im_message_deliveries" USING btree ("message_id","message_revision","session_id");--> statement-breakpoint
CREATE INDEX "im_message_deliveries_pending_idx" ON "im_message_deliveries" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_events_integration_provider_unique" ON "im_message_events" USING btree ("integration_id","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "im_message_resources_message_revision_ordinal_unique" ON "im_message_resources" USING btree ("message_id","message_revision","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "im_messages_conversation_external_unique" ON "im_messages" USING btree ("conversation_id","external_message_id");--> statement-breakpoint
CREATE INDEX "im_messages_conversation_occurred_idx" ON "im_messages" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "im_outbound_requests_request_id_unique" ON "im_outbound_requests" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_integration_identities_app_id_unique" ON "feishu_integration_identities" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "feishu_setup_attempts_agent_id_idx" ON "feishu_setup_attempts" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_setup_attempts_agent_active_unique" ON "feishu_setup_attempts" USING btree ("agent_id") WHERE "feishu_setup_attempts"."state" in ('awaiting_user', 'validating');--> statement-breakpoint
CREATE UNIQUE INDEX "im_conversations_integration_external_unique" ON "im_conversations" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE INDEX "im_conversations_integration_id_idx" ON "im_conversations" USING btree ("integration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_agent_id_unique" ON "integrations" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_integration_identities_app_team_unique" ON "slack_integration_identities" USING btree ("app_id","team_id");--> statement-breakpoint
CREATE INDEX "slack_integration_identities_route_idx" ON "slack_integration_identities" USING btree ("app_id","team_id");--> statement-breakpoint
CREATE INDEX "session_placements_computer_id_idx" ON "session_placements" USING btree ("computer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_channel_unique" ON "sessions" USING btree ("conversation_id") WHERE "sessions"."kind" = 'channel' and "sessions"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_thread_unique" ON "sessions" USING btree ("conversation_id","thread_key") WHERE "sessions"."kind" = 'thread' and "sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_conversation_id_idx" ON "sessions" USING btree ("conversation_id");
