ALTER TABLE "mcp_server_authorizations" DROP CONSTRAINT "mcp_server_authorizations_oauth_shape";--> statement-breakpoint
ALTER TABLE "mcp_server_authorizations" ADD COLUMN "credential_source_id" uuid;--> statement-breakpoint
CREATE INDEX "mcp_server_authorizations_credential_source_idx" ON "mcp_server_authorizations" USING btree ("credential_source_id") WHERE "mcp_server_authorizations"."credential_source_id" is not null;--> statement-breakpoint
ALTER TABLE "mcp_server_authorizations" ADD CONSTRAINT "mcp_server_authorizations_source_shape" CHECK ("mcp_server_authorizations"."credential_source_id" is null or (
        "mcp_server_authorizations"."credential_source_id" <> "mcp_server_authorizations"."id"
        and "mcp_server_authorizations"."kind" = 'oauth' and "mcp_server_authorizations"."status" = 'active'
        and "mcp_server_authorizations"."ciphertext" is null and "mcp_server_authorizations"."key_id" is null
        and "mcp_server_authorizations"."access_token_expires_at" is null
        and "mcp_server_authorizations"."refresh_claim_id" is null and "mcp_server_authorizations"."refresh_claimed_at" is null
        and "mcp_server_authorizations"."state" is null and "mcp_server_authorizations"."state_expires_at" is null
        and "mcp_server_authorizations"."pkce_ciphertext" is null and "mcp_server_authorizations"."login_session_hash" is null
        and "mcp_server_authorizations"."flow_authorization_server" is null and "mcp_server_authorizations"."flow_oauth_resource" is null
      ));--> statement-breakpoint
ALTER TABLE "mcp_server_authorizations" ADD CONSTRAINT "mcp_server_authorizations_oauth_shape" CHECK ("mcp_server_authorizations"."kind" <> 'oauth' or (
        "mcp_server_authorizations"."status" not in ('active', 'expired') or "mcp_server_authorizations"."ciphertext" is not null or "mcp_server_authorizations"."credential_source_id" is not null
      ));