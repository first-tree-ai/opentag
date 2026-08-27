CREATE TABLE "slack_oauth_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"expected_binding_id" uuid,
	"expected_credential_generation" bigint,
	"session_binding_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_oauth_nonces_nonce_hash_unique" UNIQUE("nonce_hash"),
	CONSTRAINT "slack_oauth_nonces_intent" CHECK ("slack_oauth_nonces"."intent" in ('create', 'reauthorize', 'replace')),
	CONSTRAINT "slack_oauth_nonces_expiry" CHECK ("slack_oauth_nonces"."expires_at" > "slack_oauth_nonces"."created_at"),
	CONSTRAINT "slack_oauth_nonces_expected_binding_pair" CHECK (("slack_oauth_nonces"."expected_binding_id" is null) = ("slack_oauth_nonces"."expected_credential_generation" is null)),
	CONSTRAINT "slack_oauth_nonces_generation_positive" CHECK ("slack_oauth_nonces"."expected_credential_generation" is null or "slack_oauth_nonces"."expected_credential_generation" >= 1)
);
--> statement-breakpoint
ALTER TABLE "slack_oauth_nonces" ADD CONSTRAINT "slack_oauth_nonces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_oauth_nonces" ADD CONSTRAINT "slack_oauth_nonces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_oauth_nonces_user_agent_idx" ON "slack_oauth_nonces" USING btree ("user_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "slack_oauth_nonces_expires_idx" ON "slack_oauth_nonces" USING btree ("expires_at");