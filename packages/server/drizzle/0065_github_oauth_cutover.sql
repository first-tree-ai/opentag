ALTER TABLE "github_connections" ALTER COLUMN "app_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_connections" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
UPDATE "github_connections"
SET "status" = 'revoked',
    "authorization_version" = "authorization_version" + 1,
    "recheck_generation" = "recheck_generation" + 1,
    "credential_ciphertext" = NULL, "credential_key_id" = NULL,
    "access_expires_at" = NULL, "refresh_expires_at" = NULL,
    "oauth_state_hash" = NULL, "oauth_context" = NULL,
    "oauth_context_ciphertext" = NULL, "oauth_context_key_id" = NULL,
    "refresh_attempt_id" = NULL, "refresh_claim_until" = NULL, "refresh_status" = 'idle',
    "next_recheck_at" = NULL, "recheck_required" = false,
    "last_error_code" = 'GITHUB_OAUTH_RECONNECT_REQUIRED', "updated_at" = now()
WHERE "app_id" IS NOT NULL AND "oauth_client_id" IS NULL
  AND "status" IN ('pending', 'active', 'reauthorization_required');--> statement-breakpoint
CREATE UNIQUE INDEX "github_connections_oauth_current_unique" ON "github_connections" USING btree ("account_id","github_host") WHERE "github_connections"."oauth_client_id" is not null and "github_connections"."status" in ('pending', 'active', 'reauthorization_required');--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_application_shape" CHECK ((
        "github_connections"."app_id" is not null and "github_connections"."oauth_client_id" is null and "github_connections"."status" in ('revoked', 'superseded')
      ) or (
        "github_connections"."app_id" is null and "github_connections"."oauth_client_id" is not null and
        char_length("github_connections"."oauth_client_id") between 1 and 255 and "github_connections"."oauth_client_id" = btrim("github_connections"."oauth_client_id")
      ));
