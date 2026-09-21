CREATE TYPE "public"."github_connection_refresh_status" AS ENUM('idle', 'claimed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."github_connection_status" AS ENUM('pending', 'active', 'reauthorization_required', 'revoked', 'superseded');--> statement-breakpoint
CREATE TABLE "github_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"github_host" text NOT NULL,
	"app_id" text NOT NULL,
	"github_user_id" text,
	"github_login" text,
	"status" "github_connection_status" DEFAULT 'pending' NOT NULL,
	"bindings_schema_version" integer DEFAULT 1 NOT NULL,
	"repository_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_ciphertext" text,
	"credential_key_id" text,
	"access_expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"authorization_version" bigint DEFAULT 1 NOT NULL,
	"credential_generation" bigint DEFAULT 0 NOT NULL,
	"refresh_attempt_id" uuid,
	"refresh_claim_until" timestamp with time zone,
	"refresh_status" "github_connection_refresh_status" DEFAULT 'idle' NOT NULL,
	"oauth_state_hash" text,
	"oauth_context_ciphertext" text,
	"oauth_context_key_id" text,
	"oauth_context" jsonb,
	"recheck_generation" bigint DEFAULT 0 NOT NULL,
	"recheck_required" boolean DEFAULT false NOT NULL,
	"next_recheck_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connections_host_nonempty" CHECK (char_length("github_connections"."github_host") between 1 and 255),
	CONSTRAINT "github_connections_app_id_decimal" CHECK ("github_connections"."app_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "github_connections_user_id_decimal" CHECK ("github_connections"."github_user_id" is null or "github_connections"."github_user_id" ~ '^[1-9][0-9]*$'),
	CONSTRAINT "github_connections_login_bounds" CHECK ("github_connections"."github_login" is null or char_length("github_connections"."github_login") between 1 and 100),
	CONSTRAINT "github_connections_identity_pair" CHECK (("github_connections"."github_user_id" is null) = ("github_connections"."github_login" is null)),
	CONSTRAINT "github_connections_credential_pair" CHECK (("github_connections"."credential_ciphertext" is null) = ("github_connections"."credential_key_id" is null)),
	CONSTRAINT "github_connections_oauth_secret_pair" CHECK (("github_connections"."oauth_context_ciphertext" is null) = ("github_connections"."oauth_context_key_id" is null)),
	CONSTRAINT "github_connections_token_expiry_pair" CHECK (("github_connections"."access_expires_at" is null) = ("github_connections"."refresh_expires_at" is null)),
	CONSTRAINT "github_connections_credential_expiry_pair" CHECK (("github_connections"."credential_ciphertext" is null) = ("github_connections"."access_expires_at" is null)),
	CONSTRAINT "github_connections_versions_nonnegative" CHECK ("github_connections"."authorization_version" >= 0 and "github_connections"."credential_generation" >= 0 and "github_connections"."recheck_generation" >= 0),
	CONSTRAINT "github_connections_bindings_schema_version" CHECK ("github_connections"."bindings_schema_version" >= 1),
	CONSTRAINT "github_connections_bindings_array_bounded" CHECK (jsonb_typeof("github_connections"."repository_bindings") = 'array' and pg_column_size("github_connections"."repository_bindings") <= 262144),
	CONSTRAINT "github_connections_oauth_context_object" CHECK ("github_connections"."oauth_context" is null or jsonb_typeof("github_connections"."oauth_context") = 'object'),
	CONSTRAINT "github_connections_refresh_claim_group" CHECK (("github_connections"."refresh_status" = 'claimed') = ("github_connections"."refresh_attempt_id" is not null and "github_connections"."refresh_claim_until" is not null)),
	CONSTRAINT "github_connections_refresh_attempt_pair" CHECK (("github_connections"."refresh_attempt_id" is null) = ("github_connections"."refresh_claim_until" is null)),
	CONSTRAINT "github_connections_refresh_unknown_requires_reauthorization" CHECK ("github_connections"."refresh_status" <> 'unknown' or "github_connections"."status" = 'reauthorization_required'),
	CONSTRAINT "github_connections_oauth_flow_pair" CHECK (("github_connections"."oauth_state_hash" is null) = ("github_connections"."oauth_context" is null)),
	CONSTRAINT "github_connections_oauth_secret_requires_flow" CHECK ("github_connections"."oauth_context_ciphertext" is null or "github_connections"."oauth_state_hash" is not null),
	CONSTRAINT "github_connections_active_shape" CHECK ("github_connections"."status" <> 'active' or (
        "github_connections"."github_user_id" is not null and
        "github_connections"."credential_ciphertext" is not null and
        "github_connections"."next_recheck_at" is not null
      )),
	CONSTRAINT "github_connections_pending_shape" CHECK ("github_connections"."status" <> 'pending' or (
        "github_connections"."github_user_id" is null and
        "github_connections"."credential_ciphertext" is null and
        "github_connections"."next_recheck_at" is null and
        "github_connections"."refresh_status" = 'idle'
      )),
	CONSTRAINT "github_connections_reauthorization_shape" CHECK ("github_connections"."status" <> 'reauthorization_required' or (
        "github_connections"."github_user_id" is not null and
        "github_connections"."credential_ciphertext" is null and
        "github_connections"."next_recheck_at" is null and
        "github_connections"."refresh_status" <> 'claimed'
      )),
	CONSTRAINT "github_connections_terminal_shape" CHECK ("github_connections"."status" not in ('revoked', 'superseded') or (
        "github_connections"."credential_ciphertext" is null and
        "github_connections"."oauth_state_hash" is null and
        "github_connections"."oauth_context_ciphertext" is null and
        "github_connections"."oauth_context" is null and
        "github_connections"."refresh_attempt_id" is null and
        "github_connections"."refresh_claim_until" is null and
        "github_connections"."refresh_status" = 'idle' and
        "github_connections"."next_recheck_at" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_connections_current_unique" ON "github_connections" USING btree ("account_id","github_host","app_id") WHERE "github_connections"."status" in ('pending', 'active', 'reauthorization_required');--> statement-breakpoint
CREATE UNIQUE INDEX "github_connections_oauth_state_unique" ON "github_connections" USING btree ("oauth_state_hash") WHERE "github_connections"."oauth_state_hash" is not null;--> statement-breakpoint
CREATE INDEX "github_connections_recheck_due_idx" ON "github_connections" USING btree ("next_recheck_at") WHERE "github_connections"."status" = 'active';--> statement-breakpoint
CREATE INDEX "github_connections_account_idx" ON "github_connections" USING btree ("account_id");