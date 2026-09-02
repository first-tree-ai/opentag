ALTER TABLE "agents" DROP CONSTRAINT "agents_creation_intent_pair";--> statement-breakpoint
DROP INDEX "agents_creation_intent_unique";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "creation_intent_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "creation_intent_fingerprint";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "setup_completed_at";