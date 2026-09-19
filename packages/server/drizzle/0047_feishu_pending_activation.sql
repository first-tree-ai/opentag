ALTER TYPE "public"."feishu_setup_state" ADD VALUE 'pending_activation';--> statement-breakpoint
ALTER TABLE "im_bindings" DROP CONSTRAINT "im_bindings_setup_owner_shape";--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_setup_owner_shape" CHECK ((("im_bindings"."setup_state"::text is distinct from 'pending_activation') and (
          ("im_bindings"."setup_owner_instance_id" is null and "im_bindings"."setup_owner_heartbeat_at" is null and
            "im_bindings"."encrypted_setup_context" is null and "im_bindings"."setup_expires_at" is null)
          or ("im_bindings"."setup_attempt_id" is not null and "im_bindings"."setup_intent" is not null and
            "im_bindings"."setup_state" is not null and "im_bindings"."setup_owner_instance_id" is not null and
            "im_bindings"."setup_owner_heartbeat_at" is not null and "im_bindings"."encrypted_setup_context" is not null and
            "im_bindings"."setup_expires_at" is not null)))
        or ("im_bindings"."provider" = 'feishu' and "im_bindings"."status" <> 'disabled' and
          "im_bindings"."setup_state"::text = 'pending_activation' and "im_bindings"."setup_attempt_id" is not null and
          "im_bindings"."setup_intent" is not null and "im_bindings"."setup_owner_instance_id" is null and
          "im_bindings"."setup_owner_heartbeat_at" is null and "im_bindings"."encrypted_setup_context" is not null and
          "im_bindings"."setup_expires_at" is not null));