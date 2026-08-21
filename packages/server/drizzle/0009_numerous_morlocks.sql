DROP TABLE "im_outbound_requests" CASCADE;--> statement-breakpoint
ALTER TABLE "im_messages" ADD COLUMN "provider_context" jsonb;--> statement-breakpoint
UPDATE "im_messages"
SET "provider_context" = jsonb_build_object('provider', "im_bindings"."provider")
FROM "im_bindings"
WHERE "im_messages"."im_binding_id" = "im_bindings"."id";--> statement-breakpoint
ALTER TABLE "im_messages" ALTER COLUMN "provider_context" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_configs" DROP COLUMN "allowed_tools";--> statement-breakpoint
UPDATE "im_bindings"
SET "status" = 'reauthorization_required',
    "last_error_code" = 'SLACK_BOT_ID_REAUTH_REQUIRED',
    "updated_at" = now()
WHERE "provider" = 'slack' AND "status" = 'active';--> statement-breakpoint
DROP TYPE "public"."im_outbound_operation";--> statement-breakpoint
DROP TYPE "public"."im_outbound_state";
