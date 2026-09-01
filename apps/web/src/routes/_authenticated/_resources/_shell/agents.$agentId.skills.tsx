import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "../../../../features/skills-page.js";

export const Route = createFileRoute("/_authenticated/_resources/_shell/agents/$agentId/skills")({
  component: SkillsPage,
});
