import type { AgentSkillsResponse, ListSkillsResponse } from "@opentag/shared";
import type { SkillPushResult } from "./mutations.js";
import type { SkillPullResult } from "./queries.js";

const SHORT_DIGEST_LENGTH = 12;

function shortDigest(digest: string): string {
  return digest.slice(0, SHORT_DIGEST_LENGTH);
}

function singleLine(value: string): string {
  return value.replaceAll("\t", " ").replaceAll("\n", " ");
}

export function formatSkillList(response: ListSkillsResponse): string {
  if (response.skills.length === 0) return "No skills in this Account";
  const header = "NAME\tDIGEST\tFILES\tBYTES\tAGENTS\tUPDATED\tDESCRIPTION";
  const rows = response.skills.map((skill) =>
    [
      skill.name,
      shortDigest(skill.digest),
      String(skill.fileCount),
      String(skill.totalBytes),
      String(skill.agentCount),
      skill.updatedAt,
      singleLine(skill.description),
    ].join("\t"),
  );
  return [header, ...rows].join("\n");
}

export function formatSkillPushed(result: SkillPushResult): string {
  const via = result.via === "session" ? "through the current Session" : "to the Account library";
  return `Pushed skill ${result.skill.name} ${via} (digest ${result.skill.digest}, ${result.skill.fileCount} files)`;
}

export function formatSkillPulled(result: SkillPullResult): string {
  return `Pulled skill ${result.skill.name} into ${result.directory} (digest ${result.skill.digest}, ${result.skill.fileCount} files)`;
}

export function formatAgentSkills(response: AgentSkillsResponse): string {
  const names = response.skills.map((skill) => skill.name);
  const assigned = names.length === 0 ? "no skills" : names.join(", ");
  return `Agent ${response.agentId} now has ${assigned} (digest ${response.digest})`;
}
