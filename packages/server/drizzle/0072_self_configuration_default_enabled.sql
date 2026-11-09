-- Self-configuration is on by default, so an Agent can connect and authorize MCP Servers from the chat
-- without an operator. The owner can still turn it off on the Agent settings page.
--
-- The backfill does what an owner toggle does in AgentService.updateAgent: it bumps the Agent revision so
-- open settings forms see a conflict, and takes a fresh runtime config revision so the next Turn assembles a
-- new snapshot. The flag is part of agentConfigHash, so each existing Session starts a new provider
-- conversation on its next Turn. The database cannot tell an owner opt-out from the old default, so every
-- non-deleted Agent is turned on.
ALTER TABLE "agents" ALTER COLUMN "self_configuration_enabled" SET DEFAULT true;--> statement-breakpoint
WITH "flipped" AS (
  UPDATE "agents"
     SET "self_configuration_enabled" = true,
         "revision" = "revision" + 1,
         "updated_at" = now()
   WHERE "self_configuration_enabled" = false
     AND "status" <> 'deleted'
  RETURNING "id"
)
UPDATE "agent_runtime_configs"
   SET "revision" = nextval('runtime_config_revision_sequence'),
       "updated_at" = now()
  FROM "flipped"
 WHERE "agent_runtime_configs"."agent_id" = "flipped"."id";
