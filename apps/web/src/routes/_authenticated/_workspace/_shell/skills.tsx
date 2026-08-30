import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "../../../../features/skills-page.js";

export const Route = createFileRoute("/_authenticated/_workspace/_shell/skills")({
  component: SkillsPage,
});
