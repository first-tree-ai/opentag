CREATE TABLE "session_cli_proofs" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"proof_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"workspace_computer_id" uuid NOT NULL,
	"placement_generation" bigint NOT NULL,
	"connection_instance_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_cli_proofs_proof_id_unique" UNIQUE("proof_id"),
	CONSTRAINT "session_cli_proofs_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "session_cli_proofs_token_hash_shape" CHECK ("session_cli_proofs"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_cli_proofs_generation_positive" CHECK ("session_cli_proofs"."placement_generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "session_descendants" (
	"ancestor_session_id" uuid NOT NULL,
	"descendant_session_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"last_message_created_at" timestamp with time zone NOT NULL,
	"last_message_id" uuid NOT NULL,
	"last_delivery_outcome" text NOT NULL,
	"task_preview" text NOT NULL,
	CONSTRAINT "session_descendants_ancestor_session_id_descendant_session_id_pk" PRIMARY KEY("ancestor_session_id","descendant_session_id"),
	CONSTRAINT "session_descendants_depth_positive" CHECK ("session_descendants"."depth" >= 1),
	CONSTRAINT "session_descendants_outcome_valid" CHECK ("session_descendants"."last_delivery_outcome" in ('accepted', 'unreachable', 'unknown', 'rejected')),
	CONSTRAINT "session_descendants_preview_bounds" CHECK (char_length("session_descendants"."task_preview") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "session_cli_proofs" ADD CONSTRAINT "session_cli_proofs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_cli_proofs" ADD CONSTRAINT "session_cli_proofs_workspace_computer_id_workspace_computers_id_fk" FOREIGN KEY ("workspace_computer_id") REFERENCES "public"."workspace_computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_descendants" ADD CONSTRAINT "session_descendants_ancestor_session_id_sessions_id_fk" FOREIGN KEY ("ancestor_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_descendants" ADD CONSTRAINT "session_descendants_descendant_session_id_sessions_id_fk" FOREIGN KEY ("descendant_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
WITH RECURSIVE descendants AS (
	SELECT created_by_session_id AS ancestor_session_id, id AS descendant_session_id, 1 AS depth
	FROM sessions
	WHERE kind = 'internal' AND created_by_session_id IS NOT NULL
	UNION ALL
	SELECT parent.created_by_session_id, descendants.descendant_session_id, descendants.depth + 1
	FROM descendants
	INNER JOIN sessions parent ON parent.id = descendants.ancestor_session_id
	WHERE parent.created_by_session_id IS NOT NULL
)
INSERT INTO session_descendants (
	ancestor_session_id,
	descendant_session_id,
	depth,
	last_message_created_at,
	last_message_id,
	last_delivery_outcome,
	task_preview
)
SELECT
	descendants.ancestor_session_id,
	descendants.descendant_session_id,
	descendants.depth,
	COALESCE(latest.created_at, child.created_at),
	COALESCE(latest.id, child.id),
	COALESCE(latest.last_outcome::text, 'unknown'),
	COALESCE(NULLIF(left(initial.content, 256), ''), '[existing internal Session]')
FROM descendants
INNER JOIN sessions child ON child.id = descendants.descendant_session_id
LEFT JOIN LATERAL (
	SELECT id, created_at, last_outcome
	FROM session_messages
	WHERE source_session_id = descendants.descendant_session_id
		OR target_session_id = descendants.descendant_session_id
	ORDER BY created_at DESC, id DESC
	LIMIT 1
) latest ON true
LEFT JOIN LATERAL (
	SELECT content
	FROM session_messages
	WHERE source_session_id = child.created_by_session_id
		AND target_session_id = descendants.descendant_session_id
	ORDER BY created_at ASC, id ASC
	LIMIT 1
) initial ON true;--> statement-breakpoint
CREATE INDEX "session_descendants_ancestor_activity_idx" ON "session_descendants" USING btree ("ancestor_session_id","last_message_created_at","last_message_id","descendant_session_id");--> statement-breakpoint
CREATE INDEX "session_descendants_ancestor_depth_activity_idx" ON "session_descendants" USING btree ("ancestor_session_id","depth","last_message_created_at","last_message_id","descendant_session_id");--> statement-breakpoint
CREATE INDEX "session_descendants_descendant_ancestor_idx" ON "session_descendants" USING btree ("descendant_session_id","ancestor_session_id");--> statement-breakpoint
CREATE INDEX "session_descendants_last_message_idx" ON "session_descendants" USING btree ("last_message_id");--> statement-breakpoint
CREATE INDEX "sessions_creator_created_idx" ON "sessions" USING btree ("created_by_session_id","created_at","id");
