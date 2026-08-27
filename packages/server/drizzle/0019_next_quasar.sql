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
ALTER TABLE "session_cli_proofs" ADD CONSTRAINT "session_cli_proofs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_cli_proofs" ADD CONSTRAINT "session_cli_proofs_workspace_computer_id_workspace_computers_id_fk" FOREIGN KEY ("workspace_computer_id") REFERENCES "public"."workspace_computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_creator_created_idx" ON "sessions" USING btree ("created_by_session_id","created_at","id");