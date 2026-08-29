ALTER TABLE "agents" ALTER COLUMN "computer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ALTER COLUMN "issued_by_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ALTER COLUMN "mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "session_cli_proofs" ALTER COLUMN "computer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "session_placements" ALTER COLUMN "computer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_agent_id_id_unique" UNIQUE("agent_id","id");--> statement-breakpoint
ALTER TABLE "im_bindings" ADD CONSTRAINT "im_bindings_slack_installation_owner_fk" FOREIGN KEY ("agent_id","slack_installation_id") REFERENCES "public"."slack_installations"("agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_computer_matches_enrollment" CHECK ("agents"."computer_id" = "agents"."workspace_computer_id");--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_issued_by_account_pair" CHECK ("computer_connect_codes"."issued_by_account_id" = "computer_connect_codes"."issued_by_user_id");--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_consumed_computer_identity" CHECK ("computer_connect_codes"."consumed_computer_id" is not distinct from "computer_connect_codes"."consumed_workspace_computer_id");--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_consumed_computer_pair" CHECK (("computer_connect_codes"."consumed_computer_id" is null) = ("computer_connect_codes"."consumed_at" is null));--> statement-breakpoint
ALTER TABLE "computer_connect_codes" ADD CONSTRAINT "computer_connect_codes_repair_target_pair" CHECK (("computer_connect_codes"."mode" = 'create') = ("computer_connect_codes"."target_computer_id" is null));--> statement-breakpoint
ALTER TABLE "session_cli_proofs" ADD CONSTRAINT "session_cli_proofs_computer_matches_enrollment" CHECK ("session_cli_proofs"."computer_id" = "session_cli_proofs"."workspace_computer_id");--> statement-breakpoint
ALTER TABLE "session_placements" ADD CONSTRAINT "session_placements_computer_matches_enrollment" CHECK ("session_placements"."computer_id" = "session_placements"."workspace_computer_id");