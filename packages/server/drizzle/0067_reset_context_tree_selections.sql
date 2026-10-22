WITH cleared AS (
  UPDATE "agent_runtime_configs"
  SET "context_trees" = '[]'::jsonb,
      "revision" = nextval('runtime_config_revision_sequence'),
      "updated_at" = now()
  WHERE "context_trees" <> '[]'::jsonb
  RETURNING "agent_id"
)
UPDATE "agents"
SET "revision" = "revision" + 1,
    "updated_at" = now()
WHERE "id" IN (SELECT "agent_id" FROM cleared);
