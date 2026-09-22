ALTER TABLE "agent_runtime_configs" ADD COLUMN "context_trees" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_configs" DROP COLUMN "context_tree_repository";