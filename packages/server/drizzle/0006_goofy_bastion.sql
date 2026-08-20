ALTER TYPE "public"."integration_status" RENAME TO "im_binding_status";--> statement-breakpoint
ALTER TABLE "integrations" RENAME TO "im_bindings";--> statement-breakpoint
ALTER TABLE "im_messages" RENAME COLUMN "integration_id" TO "im_binding_id";--> statement-breakpoint
ALTER TABLE "im_bindings" RENAME COLUMN "replacement_integration_id" TO "replacement_im_binding_id";--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "integration_id" TO "im_binding_id";--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_credential_generation_nonnegative";--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_connection_epoch_nonnegative";--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_active_binding_shape";--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_disabled_secret_shape";--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_setup_owner_shape";--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_connection_owner_shape";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_manager_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_computer_id_computers_id_fk";
--> statement-breakpoint
ALTER TABLE "im_messages" DROP CONSTRAINT "im_messages_integration_id_integrations_id_fk";
--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "integrations_replacement_integration_id_integrations_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_integration_id_integrations_id_fk";
--> statement-breakpoint
DROP INDEX "integrations_agent_current_unique";--> statement-breakpoint
DROP INDEX "integrations_feishu_app_current_unique";--> statement-breakpoint
DROP INDEX "integrations_slack_app_team_current_unique";--> statement-breakpoint
DROP INDEX "sessions_integration_scope_idx";--> statement-breakpoint
DROP INDEX "im_messages_provider_event_unique";--> statement-breakpoint
DROP INDEX "im_messages_semantic_revision_unique";--> statement-breakpoint
DROP INDEX "im_messages_scope_occurred_idx";--> statement-breakpoint
DROP INDEX "im_messages_external_occurred_idx";--> statement-breakpoint
DROP INDEX "sessions_active_channel_unique";--> statement-breakpoint
DROP INDEX "sessions_active_thread_unique";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "receive_mode" SET DEFAULT 'mention_only';--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_id_owner_user_id_unique" UNIQUE("id","owner_user_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manager_membership_fk" FOREIGN KEY ("team_id","manager_user_id") REFERENCES "public"."memberships"("team_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_manager_computer_owner_fk" FOREIGN KEY ("computer_id","manager_user_id") REFERENCES "public"."computers"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_messages" ADD CONSTRAINT "im_messages_im_binding_id_im_bindings_id_fk" FOREIGN KEY ("im_binding_id") REFERENCES "public"."im_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_replacement_im_binding_id_im_bindings_id_fk" FOREIGN KEY ("replacement_im_binding_id") REFERENCES "public"."im_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_im_binding_id_im_bindings_id_fk" FOREIGN KEY ("im_binding_id") REFERENCES "public"."im_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "im_bindings_agent_current_unique" ON "im_bindings" USING btree ("agent_id") WHERE "im_bindings"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX "im_bindings_feishu_app_current_unique" ON "im_bindings" USING btree ("external_app_id") WHERE "im_bindings"."provider" = 'feishu' and "im_bindings"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX "im_bindings_slack_app_team_current_unique" ON "im_bindings" USING btree ("external_app_id","external_team_id") WHERE "im_bindings"."provider" = 'slack' and "im_bindings"."status" <> 'disabled';--> statement-breakpoint
CREATE INDEX "sessions_im_binding_scope_idx" ON "sessions" USING btree ("im_binding_id","channel_id","thread_key");--> statement-breakpoint
CREATE UNIQUE INDEX "im_messages_provider_event_unique" ON "im_messages" USING btree ("im_binding_id","provider_event_id") WHERE "im_messages"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "im_messages_semantic_revision_unique" ON "im_messages" USING btree ("im_binding_id","channel_id","external_message_id","provider_revision_key");--> statement-breakpoint
CREATE INDEX "im_messages_scope_occurred_idx" ON "im_messages" USING btree ("im_binding_id","channel_id","thread_key","occurred_at");--> statement-breakpoint
CREATE INDEX "im_messages_external_occurred_idx" ON "im_messages" USING btree ("im_binding_id","channel_id","external_message_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_channel_unique" ON "sessions" USING btree ("im_binding_id","channel_id") WHERE "sessions"."kind" = 'channel' and "sessions"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_thread_unique" ON "sessions" USING btree ("im_binding_id","channel_id","thread_key") WHERE "sessions"."kind" = 'thread' and "sessions"."ended_at" is null;--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_credential_generation_nonnegative" CHECK ("im_bindings"."credential_generation" >= 0);--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_connection_epoch_nonnegative" CHECK ("im_bindings"."connection_fencing_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_active_binding_shape" CHECK ("im_bindings"."status" not in ('active', 'reauthorization_required') or (
        "im_bindings"."external_app_id" is not null and
        ("im_bindings"."provider" = 'feishu' or "im_bindings"."external_team_id" is not null) and
        "im_bindings"."external_bot_id" is not null and "im_bindings"."credential_schema_version" is not null and
        "im_bindings"."credential_generation" >= 1 and "im_bindings"."encrypted_credential" is not null and
        "im_bindings"."activated_at" is not null and "im_bindings"."disabled_at" is null
      ));--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_disabled_secret_shape" CHECK ("im_bindings"."status" <> 'disabled' or (
        "im_bindings"."encrypted_credential" is null and "im_bindings"."encrypted_setup_context" is null and
        "im_bindings"."setup_owner_instance_id" is null and "im_bindings"."connection_owner_instance_id" is null and
        "im_bindings"."connection_lease_expires_at" is null and "im_bindings"."disabled_at" is not null
      ));--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_setup_owner_shape" CHECK (("im_bindings"."setup_owner_instance_id" is null and "im_bindings"."setup_owner_heartbeat_at" is null and
        "im_bindings"."encrypted_setup_context" is null and "im_bindings"."setup_expires_at" is null)
        or ("im_bindings"."setup_attempt_id" is not null and "im_bindings"."setup_intent" is not null and
        "im_bindings"."setup_state" is not null and "im_bindings"."setup_owner_instance_id" is not null and
        "im_bindings"."setup_owner_heartbeat_at" is not null and "im_bindings"."encrypted_setup_context" is not null and
        "im_bindings"."setup_expires_at" is not null));--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_connection_owner_shape" CHECK (("im_bindings"."connection_owner_instance_id" is null and "im_bindings"."connection_lease_expires_at" is null)
        or ("im_bindings"."provider" = 'feishu' and "im_bindings"."connection_owner_instance_id" is not null and
        "im_bindings"."connection_lease_expires_at" is not null));
