UPDATE "im_bindings"
SET
  "status" = 'disabled',
  "encrypted_credential" = NULL,
  "setup_attempt_id" = NULL,
  "setup_intent" = NULL,
  "setup_state" = NULL,
  "setup_owner_instance_id" = NULL,
  "setup_owner_heartbeat_at" = NULL,
  "encrypted_setup_context" = NULL,
  "setup_expires_at" = NULL,
  "connection_owner_instance_id" = NULL,
  "connection_lease_expires_at" = NULL,
  "disabled_at" = COALESCE("disabled_at", NOW()),
  "last_error_code" = 'SLACK_CONFIGURATION_REQUIRED',
  "updated_at" = NOW()
WHERE
  "provider" = 'slack'
  AND "status" <> 'disabled'
  AND ("credential_generation" < 1 OR "encrypted_credential" IS NULL);
--> statement-breakpoint
UPDATE "im_bindings"
SET
  "setup_attempt_id" = NULL,
  "setup_intent" = NULL,
  "setup_state" = NULL,
  "setup_owner_instance_id" = NULL,
  "setup_owner_heartbeat_at" = NULL,
  "encrypted_setup_context" = NULL,
  "setup_expires_at" = NULL,
  "observed_connected_at" = NULL,
  "updated_at" = NOW()
WHERE "provider" = 'slack';
--> statement-breakpoint
UPDATE "im_bindings"
SET
  "status" = 'active',
  "last_error_code" = NULL,
  "updated_at" = NOW()
WHERE
  "provider" = 'slack'
  AND "status" = 'reauthorization_required'
  AND "last_error_code" = 'IM_BINDING_SCOPE_REAUTH_REQUIRED'
  AND "granted_capabilities" @> ARRAY[
    'app_mentions:read',
    'channels:history',
    'chat:write',
    'files:read',
    'groups:history',
    'im:history',
    'mpim:history'
  ]::text[];
--> statement-breakpoint
UPDATE "im_bindings"
SET
  "status" = 'reauthorization_required',
  "last_error_code" = CASE
    WHEN "last_error_code" IS NULL OR "last_error_code" = 'IM_BINDING_SCOPE_REAUTH_REQUIRED'
      THEN 'SLACK_SCOPE_REAUTH_REQUIRED'
    ELSE "last_error_code"
  END,
  "updated_at" = NOW()
WHERE
  "provider" = 'slack'
  AND "status" IN ('active', 'reauthorization_required')
  AND "credential_generation" >= 1
  AND "encrypted_credential" IS NOT NULL
  AND NOT (
    "granted_capabilities" @> ARRAY[
      'app_mentions:read',
      'channels:history',
      'chat:write',
      'files:read',
      'groups:history',
      'im:history',
      'mpim:history'
    ]::text[]
  );
--> statement-breakpoint
ALTER TABLE "im_bindings" DROP COLUMN "pending_receive_mode";--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_slack_setup_fields_null" CHECK ("im_bindings"."provider" <> 'slack' or (
        "im_bindings"."setup_attempt_id" is null and "im_bindings"."setup_intent" is null and
        "im_bindings"."setup_state" is null and "im_bindings"."setup_owner_instance_id" is null and
        "im_bindings"."setup_owner_heartbeat_at" is null and "im_bindings"."encrypted_setup_context" is null and
        "im_bindings"."setup_expires_at" is null
      ));
