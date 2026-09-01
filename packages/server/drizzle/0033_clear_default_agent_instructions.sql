UPDATE "agent_runtime_configs"
SET
  "instructions" = '',
  "revision" = nextval('runtime_config_revision_sequence'),
  "updated_at" = now()
WHERE "instructions" = 'Act as the configured OpenTag Agent and follow the managed workspace instructions.';
