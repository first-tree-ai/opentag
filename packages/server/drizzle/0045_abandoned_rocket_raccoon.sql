CREATE TYPE "public"."mcp_auth_kind" AS ENUM('none', 'bearer', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."mcp_authorization_status" AS ENUM('pending', 'active', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."mcp_client_registration_source" AS ENUM('preregistered', 'cimd', 'dcr');--> statement-breakpoint
CREATE TYPE "public"."mcp_probe_state" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mcp_protocol_era" AS ENUM('modern', 'legacy');--> statement-breakpoint
CREATE TABLE "agent_mcp_servers" (
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"url_override" text,
	"auth_header_override" text,
	"auth_scheme_override" text,
	"extra_headers_override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mcp_servers_agent_id_mcp_server_id_pk" PRIMARY KEY("agent_id","mcp_server_id"),
	CONSTRAINT "agent_mcp_servers_auth_header_override_token" CHECK ("agent_mcp_servers"."auth_header_override" is null or (
        "agent_mcp_servers"."auth_header_override" <> '' and "agent_mcp_servers"."auth_header_override" ~ '^[[:alnum:]!#$%&*+.^_`|~-]+$'
        and auth_header_override = lower(auth_header_override)
      )),
	CONSTRAINT "agent_mcp_servers_auth_scheme_override_no_control" CHECK ("agent_mcp_servers"."auth_scheme_override" is null or "agent_mcp_servers"."auth_scheme_override" !~ '[[:cntrl:]]'),
	CONSTRAINT "agent_mcp_servers_extra_headers_override_object" CHECK ("agent_mcp_servers"."extra_headers_override" is null or (
        jsonb_typeof("agent_mcp_servers"."extra_headers_override") = 'object'
        and pg_column_size("agent_mcp_servers"."extra_headers_override") <= 8192
      )),
	CONSTRAINT "agent_mcp_servers_url_override_bounds" CHECK ("agent_mcp_servers"."url_override" is null or char_length("agent_mcp_servers"."url_override") between 1 and 2048)
);
--> statement-breakpoint
CREATE TABLE "mcp_client_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"authorization_server" text NOT NULL,
	"source" "mcp_client_registration_source" NOT NULL,
	"client_id" text NOT NULL,
	"ciphertext" text,
	"key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_client_registrations_credential_pair" CHECK (("mcp_client_registrations"."ciphertext" is null) = ("mcp_client_registrations"."key_id" is null)),
	CONSTRAINT "mcp_client_registrations_client_id_bounds" CHECK (char_length("mcp_client_registrations"."client_id") between 1 and 512),
	CONSTRAINT "mcp_client_registrations_authorization_server_bounds" CHECK (char_length("mcp_client_registrations"."authorization_server") between 1 and 2048)
);
--> statement-breakpoint
CREATE TABLE "mcp_server_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "mcp_auth_kind" NOT NULL,
	"status" "mcp_authorization_status" DEFAULT 'pending' NOT NULL,
	"ciphertext" text,
	"key_id" text,
	"scopes" text[],
	"access_token_expires_at" timestamp with time zone,
	"authorization_server" text,
	"client_registration_id" uuid,
	"state" text,
	"state_expires_at" timestamp with time zone,
	"pkce_ciphertext" text,
	"probe_state" "mcp_probe_state" DEFAULT 'pending' NOT NULL,
	"probed_at" timestamp with time zone,
	"probe_error" text,
	"protocol_era" "mcp_protocol_era",
	"protocol_version" text,
	"server_info" jsonb,
	"capabilities" jsonb,
	"instructions" text,
	"tools" jsonb,
	"tools_count" integer,
	"tools_truncated" boolean DEFAULT false NOT NULL,
	"refresh_generation" integer DEFAULT 0 NOT NULL,
	"refresh_claim_id" uuid,
	"refresh_claimed_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"failure_code" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_authorizations_revision_positive" CHECK ("mcp_server_authorizations"."revision" >= 1),
	CONSTRAINT "mcp_server_authorizations_refresh_generation_nonnegative" CHECK ("mcp_server_authorizations"."refresh_generation" >= 0),
	CONSTRAINT "mcp_server_authorizations_tools_count_nonnegative" CHECK ("mcp_server_authorizations"."tools_count" is null or "mcp_server_authorizations"."tools_count" >= 0),
	CONSTRAINT "mcp_server_authorizations_instructions_bounds" CHECK ("mcp_server_authorizations"."instructions" is null or octet_length("mcp_server_authorizations"."instructions") <= 4096),
	CONSTRAINT "mcp_server_authorizations_probe_error_bounds" CHECK ("mcp_server_authorizations"."probe_error" is null or char_length("mcp_server_authorizations"."probe_error") <= 400),
	CONSTRAINT "mcp_server_authorizations_credential_pair" CHECK (("mcp_server_authorizations"."ciphertext" is null) = ("mcp_server_authorizations"."key_id" is null)),
	CONSTRAINT "mcp_server_authorizations_none_has_no_credential" CHECK ("mcp_server_authorizations"."kind" <> 'none' or ("mcp_server_authorizations"."ciphertext" is null and "mcp_server_authorizations"."key_id" is null)),
	CONSTRAINT "mcp_server_authorizations_bearer_has_credential" CHECK ("mcp_server_authorizations"."kind" <> 'bearer' or (
        "mcp_server_authorizations"."status" not in ('pending', 'active') or "mcp_server_authorizations"."ciphertext" is not null
      )),
	CONSTRAINT "mcp_server_authorizations_oauth_shape" CHECK ("mcp_server_authorizations"."kind" <> 'oauth' or (
        "mcp_server_authorizations"."status" not in ('active', 'expired') or "mcp_server_authorizations"."ciphertext" is not null
      )),
	CONSTRAINT "mcp_server_authorizations_flow_shape" CHECK (("mcp_server_authorizations"."state" is null) = ("mcp_server_authorizations"."state_expires_at" is null)),
	CONSTRAINT "mcp_server_authorizations_flow_requires_pkce" CHECK ("mcp_server_authorizations"."state" is null or ("mcp_server_authorizations"."kind" = 'oauth' and "mcp_server_authorizations"."pkce_ciphertext" is not null)),
	CONSTRAINT "mcp_server_authorizations_flow_is_pending" CHECK ("mcp_server_authorizations"."state" is null or "mcp_server_authorizations"."status" = 'pending'),
	CONSTRAINT "mcp_server_authorizations_refresh_claim_pair" CHECK (("mcp_server_authorizations"."refresh_claim_id" is null) = ("mcp_server_authorizations"."refresh_claimed_at" is null)),
	CONSTRAINT "mcp_server_authorizations_refresh_claim_requires_oauth" CHECK ("mcp_server_authorizations"."refresh_claim_id" is null or "mcp_server_authorizations"."kind" = 'oauth'),
	CONSTRAINT "mcp_server_authorizations_tools_object" CHECK ("mcp_server_authorizations"."tools" is null or (jsonb_typeof("mcp_server_authorizations"."tools") = 'array' and pg_column_size("mcp_server_authorizations"."tools") <= 262144))
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"default_auth_kind" "mcp_auth_kind" DEFAULT 'oauth' NOT NULL,
	"auth_header" text DEFAULT 'authorization' NOT NULL,
	"auth_scheme" text DEFAULT 'Bearer' NOT NULL,
	"extra_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_revision_positive" CHECK ("mcp_servers"."revision" >= 1),
	CONSTRAINT "mcp_servers_name_bounds" CHECK (char_length("mcp_servers"."name") between 1 and 64),
	CONSTRAINT "mcp_servers_display_name_bounds" CHECK (char_length("mcp_servers"."display_name") between 1 and 120),
	CONSTRAINT "mcp_servers_description_bounds" CHECK ("mcp_servers"."description" is null or octet_length("mcp_servers"."description") <= 1024),
	CONSTRAINT "mcp_servers_auth_header_token" CHECK ("mcp_servers"."auth_header" <> '' and "mcp_servers"."auth_header" ~ '^[[:alnum:]!#$%&*+.^_`|~-]+$' and auth_header = lower(auth_header)),
	CONSTRAINT "mcp_servers_auth_scheme_no_control" CHECK ("mcp_servers"."auth_scheme" !~ '[[:cntrl:]]'),
	CONSTRAINT "mcp_servers_extra_headers_object" CHECK (jsonb_typeof("mcp_servers"."extra_headers") = 'object' and pg_column_size("mcp_servers"."extra_headers") <= 8192)
);
--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_client_registrations" ADD CONSTRAINT "mcp_client_registrations_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_authorizations" ADD CONSTRAINT "mcp_server_authorizations_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_authorizations" ADD CONSTRAINT "mcp_server_authorizations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_authorizations" ADD CONSTRAINT "mcp_server_authorizations_client_registration_id_mcp_client_registrations_id_fk" FOREIGN KEY ("client_registration_id") REFERENCES "public"."mcp_client_registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_mcp_server_id_idx" ON "agent_mcp_servers" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_client_registrations_account_server_unique" ON "mcp_client_registrations" USING btree ("account_id","authorization_server");--> statement-breakpoint
CREATE INDEX "mcp_client_registrations_account_idx" ON "mcp_client_registrations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_authorizations_server_agent_unique" ON "mcp_server_authorizations" USING btree ("mcp_server_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_authorizations_state_unique" ON "mcp_server_authorizations" USING btree ("state") WHERE "mcp_server_authorizations"."state" is not null;--> statement-breakpoint
CREATE INDEX "mcp_server_authorizations_agent_idx" ON "mcp_server_authorizations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mcp_server_authorizations_refresh_due_idx" ON "mcp_server_authorizations" USING btree ("access_token_expires_at") WHERE "mcp_server_authorizations"."kind" = 'oauth' and "mcp_server_authorizations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_account_name_unique" ON "mcp_servers" USING btree ("account_id",lower("name"));--> statement-breakpoint
CREATE INDEX "mcp_servers_account_idx" ON "mcp_servers" USING btree ("account_id");