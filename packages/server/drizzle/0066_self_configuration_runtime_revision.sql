-- Owner opt-in changes previously altered Agent snapshots without advancing their runtime
-- sequence. Advance existing configurations once so offline Sessions can apply that state.
UPDATE "agent_runtime_configs"
SET "revision" = nextval('runtime_config_revision_sequence');
