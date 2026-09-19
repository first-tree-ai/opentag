import type { OpenTagApi } from "@opentag/client";
import type { ListAgentSkillsResponse, Skill } from "@opentag/shared";
import type { SkillPushResult } from "./operations.js";

/**
 * Shared plumbing for the `skill` commands.
 *
 * A Skill is owned by exactly one Agent, so every command either names its Agent (an Account
 * operator) or is scoped by the Session proof (the Agent itself). `context.ts` decides which, and
 * these helpers only format what the operations return.
 */

export interface SkillApiClient
  extends Pick<
    OpenTagApi,
    | "listAgentSkills"
    | "uploadAgentSkill"
    | "updateAgentSkill"
    | "removeAgentSkill"
    | "openAgentSkillBundle"
    | "listRuntimeSkills"
    | "pushRuntimeSkill"
    | "openRuntimeSkillBundle"
  > {}

export interface SkillCommandDependencies {
  accessToken?: string;
  api?: SkillApiClient;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  proof?: string;
  cwd?: string;
}

export function formatSkill(skill: Skill): string {
  return [
    `id\t${skill.id}`,
    `name\t${skill.name}`,
    `description\t${skill.description}`,
    `enabled\t${skill.enabled}`,
    `source\t${skill.source}`,
    `revision\t${skill.revision}`,
    `bytes\t${skill.archiveBytes}`,
    `files\t${skill.fileCount}`,
    `sha256\t${skill.archiveSha256}`,
    `updatedAt\t${skill.updatedAt}`,
  ].join("\n");
}

export function formatSkillPush(result: SkillPushResult): string {
  return [
    formatSkill(result.skill),
    `adopted\t${result.adopted}`,
    ...(result.adoptionReason === undefined ? [] : [`adoptionReason\t${result.adoptionReason}`]),
  ].join("\n");
}

export function formatSkillList(result: ListAgentSkillsResponse): string {
  if (result.skills.length === 0) return `No Skills configured (storage: ${result.storage})`;
  return [
    ["NAME", "ENABLED", "SOURCE", "FILES", "REVISION", "UPDATED"].join("\t"),
    ...result.skills.map((skill) =>
      [
        skill.name,
        skill.enabled ? "enabled" : "disabled",
        skill.source,
        String(skill.fileCount),
        String(skill.revision),
        skill.updatedAt,
      ].join("\t"),
    ),
    `storage\t${result.storage}`,
  ].join("\n");
}

export function formatSkillPull(result: { skill: Skill; directory: string }): string {
  return [`name\t${result.skill.name}`, `directory\t${result.directory}`].join("\n");
}

export function formatSkillRemoval(skill: Skill): string {
  return `Removed Skill ${skill.name}`;
}

export function formatSkillEnabled(skill: Skill): string {
  return `${skill.enabled ? "Enabled" : "Disabled"} Skill ${skill.name}`;
}
