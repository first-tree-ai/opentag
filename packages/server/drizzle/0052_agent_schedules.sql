CREATE TABLE "agent_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"target_session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_trigger_at" timestamp with time zone,
	"revision" bigint DEFAULT 1 NOT NULL,
	"last_dispatch" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_schedules_name_bounds" CHECK (char_length("agent_schedules"."name") between 1 and 120),
	CONSTRAINT "agent_schedules_prompt_bounds" CHECK (octet_length("agent_schedules"."prompt") between 1 and 16384),
	CONSTRAINT "agent_schedules_revision_positive" CHECK ("agent_schedules"."revision" >= 1),
	CONSTRAINT "agent_schedules_disabled_next_null" CHECK ("agent_schedules"."enabled" or "agent_schedules"."next_trigger_at" is null),
	CONSTRAINT "agent_schedules_timezone_shape" CHECK ("agent_schedules"."timezone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'),
	CONSTRAINT "agent_schedules_schedule_shape" CHECK (jsonb_typeof("agent_schedules"."schedule") = 'object'
        and jsonb_typeof("agent_schedules"."schedule"->'kind') = 'string' and (
        (
          "agent_schedules"."schedule"->>'kind' = 'at'
          and "agent_schedules"."schedule" ?& array['kind', 'at']
          and ("agent_schedules"."schedule" - 'kind' - 'at') = '{}'::jsonb
          and jsonb_typeof("agent_schedules"."schedule"->'at') = 'string'
          and length("agent_schedules"."schedule"->>'at') > 0
        ) or (
          "agent_schedules"."schedule"->>'kind' = 'every'
          and "agent_schedules"."schedule" ?& array['kind', 'intervalSeconds', 'anchorAt']
          and ("agent_schedules"."schedule" - 'kind' - 'intervalSeconds' - 'anchorAt') = '{}'::jsonb
          and case when jsonb_typeof("agent_schedules"."schedule"->'intervalSeconds') = 'number'
            then (("agent_schedules"."schedule"->>'intervalSeconds')::numeric >= 60
              and ("agent_schedules"."schedule"->>'intervalSeconds')::numeric <= 9007199254740991
              and ("agent_schedules"."schedule"->>'intervalSeconds')::numeric = floor(("agent_schedules"."schedule"->>'intervalSeconds')::numeric))
            else false end
          and jsonb_typeof("agent_schedules"."schedule"->'anchorAt') = 'string'
          and length("agent_schedules"."schedule"->>'anchorAt') > 0
        ) or (
          "agent_schedules"."schedule"->>'kind' = 'cron'
          and "agent_schedules"."schedule" ?& array['kind', 'expression']
          and ("agent_schedules"."schedule" - 'kind' - 'expression') = '{}'::jsonb
          and jsonb_typeof("agent_schedules"."schedule"->'expression') = 'string'
          and length("agent_schedules"."schedule"->>'expression') > 0
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "session_messages" ALTER COLUMN "source_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_messages" ADD COLUMN "scheduled_origin" jsonb;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_schedules" ADD CONSTRAINT "agent_schedules_target_session_id_sessions_id_fk" FOREIGN KEY ("target_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_schedules_due_idx" ON "agent_schedules" USING btree ("next_trigger_at","id") WHERE "agent_schedules"."enabled" and "agent_schedules"."next_trigger_at" is not null;--> statement-breakpoint
CREATE INDEX "agent_schedules_agent_created_idx" ON "agent_schedules" USING btree ("agent_id","created_at","id");--> statement-breakpoint
CREATE INDEX "agent_schedules_target_session_idx" ON "agent_schedules" USING btree ("target_session_id");--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_source_shape" CHECK (("session_messages"."source_session_id" is not null and "session_messages"."scheduled_origin" is null)
        or ("session_messages"."source_session_id" is null
          and "session_messages"."scheduled_origin" is not null
          and jsonb_typeof("session_messages"."scheduled_origin") = 'object'
          and "session_messages"."scheduled_origin" ?& array['scheduleId', 'scheduledFor', 'timezone', 'name']
          and ("session_messages"."scheduled_origin" - 'scheduleId' - 'scheduledFor' - 'timezone' - 'name') = '{}'::jsonb
          and jsonb_typeof("session_messages"."scheduled_origin"->'scheduleId') = 'string'
          and "session_messages"."scheduled_origin"->>'scheduleId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and jsonb_typeof("session_messages"."scheduled_origin"->'scheduledFor') = 'string'
          and length("session_messages"."scheduled_origin"->>'scheduledFor') > 0
          and jsonb_typeof("session_messages"."scheduled_origin"->'timezone') = 'string'
          and length("session_messages"."scheduled_origin"->>'timezone') > 0
          and jsonb_typeof("session_messages"."scheduled_origin"->'name') = 'string'
          and char_length("session_messages"."scheduled_origin"->>'name') between 1 and 120));
