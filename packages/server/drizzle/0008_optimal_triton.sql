ALTER TABLE "agents" ADD COLUMN "creation_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "creation_intent_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_creation_intent_unique" ON "agents" USING btree ("team_id","manager_user_id","creation_intent_id") WHERE "agents"."creation_intent_id" is not null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_creation_intent_pair" CHECK (("agents"."creation_intent_id" is null) = ("agents"."creation_intent_fingerprint" is null));
