-- 0058_agent_permissions changed the effective runtime snapshot of existing Agents (local
-- approval policy, network access, and allowCommands) without advancing their revision.
-- Runtimes holding a binding at the old sequence reject the new snapshot as a same-revision
-- conflict, so their Sessions never become ready. Advance every revision so the new snapshot
-- is delivered as a newer revision.
UPDATE "agent_runtime_configs"
SET "revision" = nextval('runtime_config_revision_sequence');
