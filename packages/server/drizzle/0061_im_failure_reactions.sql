CREATE TABLE "im_failure_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"external_message_id" text NOT NULL,
	"credential_generation" bigint NOT NULL,
	"desired" boolean NOT NULL,
	"applied" boolean,
	"revision" bigint DEFAULT 1 NOT NULL,
	"failures" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_id" uuid,
	"claim_expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "im_failure_reactions" ADD CONSTRAINT "im_failure_reactions_binding_id_im_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."im_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "im_failure_reactions_message_unique" ON "im_failure_reactions" USING btree ("binding_id","channel_id","external_message_id");--> statement-breakpoint
CREATE INDEX "im_failure_reactions_due_idx" ON "im_failure_reactions" USING btree ("next_attempt_at");