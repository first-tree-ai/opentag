ALTER TABLE "agents" ALTER COLUMN "workspace_computer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "computer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_computer_pair" CHECK (("agents"."computer_id" is null) = ("agents"."workspace_computer_id" is null));