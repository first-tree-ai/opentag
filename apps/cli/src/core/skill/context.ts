import type { OpenTagApi } from "@opentag/client";
import { resolveCommandContext } from "../command/context.js";

export interface SkillApiClient
  extends Pick<
    OpenTagApi,
    | "listSkills"
    | "getSkill"
    | "getSkillMarkdown"
    | "downloadSkillArchive"
    | "uploadSkill"
    | "deleteSkill"
    | "getAgentSkills"
    | "replaceAgentSkills"
    | "listAgents"
  > {}

export interface SkillCommandDependencies {
  accessToken?: string;
  api?: SkillApiClient;
  home?: string;
}

export async function resolveSkillCommandContext(
  options: SkillCommandDependencies,
): Promise<{ accessToken: string; api: SkillApiClient }> {
  if ((options.api && !options.accessToken) || (options.accessToken && !options.api)) {
    throw new Error("Skill command test dependencies must provide both api and accessToken");
  }
  const context = await resolveCommandContext({
    accessToken: options.accessToken,
    api: options.api as OpenTagApi | undefined,
    home: options.home,
    requireAuth: true,
  });
  if (!context.api || !context.accessToken) throw new Error("Command context did not resolve an authenticated API");
  return { api: context.api, accessToken: context.accessToken };
}
