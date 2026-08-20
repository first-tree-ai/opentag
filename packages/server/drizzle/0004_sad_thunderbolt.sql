CREATE SEQUENCE "public"."runtime_config_revision_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9007199254740991 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "agent_runtime_configs" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT nextval('runtime_config_revision_sequence') NOT NULL,
	"model" text,
	"reasoning_effort" text,
	"instructions" text NOT NULL,
	"allowed_tools" text[] NOT NULL,
	"max_duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runtime_configs_revision_safe_positive" CHECK ("agent_runtime_configs"."revision" > 0 and "agent_runtime_configs"."revision" <= 9007199254740991),
	CONSTRAINT "agent_runtime_configs_max_duration_valid" CHECK ("agent_runtime_configs"."max_duration_ms" is null or ("agent_runtime_configs"."max_duration_ms" > 0 and "agent_runtime_configs"."max_duration_ms" <= 86400000))
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_configs" ADD CONSTRAINT "agent_runtime_configs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "agent_runtime_configs" (
	"agent_id",
	"model",
	"reasoning_effort",
	"instructions",
	"allowed_tools",
	"max_duration_ms",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	NULL,
	NULL,
	'Act as the configured OpenTag Agent and follow the managed workspace instructions.',
	ARRAY['opentag_message_react', 'opentag_message_reply', 'opentag_message_send']::text[],
	NULL,
	"created_at",
	"updated_at"
FROM "agents";
