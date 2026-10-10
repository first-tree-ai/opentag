import type { InstallSkillPresetResponse, ListSkillPresetsResponse } from "@opentag/shared";
import { resolveSkillCommandContext } from "./context.js";
import type { SkillCommandDependencies } from "./shared.js";

/**
 * The preset Skill operations: browse the platform catalog and install or update one entry.
 *
 * Both use the same authority rules as the rest of `skill`: outside a managed Session an operator
 * names the Agent with `--agent`, and inside one the Session proof supplies it and `--agent` is
 * refused. The Server computes each preset's state for that Agent, so the CLI never joins the
 * catalog against a Skills listing itself.
 */

export interface SkillPresetOptions {
  agentId?: string;
}

export async function runSkillPresetList(
  options: SkillPresetOptions,
  dependencies: SkillCommandDependencies = {},
): Promise<ListSkillPresetsResponse> {
  const authority = await resolveSkillCommandContext("list", { ...dependencies, agentId: options.agentId });
  return authority.mode === "account"
    ? authority.api.listSkillPresets(authority.accessToken, authority.agentId)
    : authority.api.listRuntimeSkillPresets(authority.proof);
}

export async function runSkillPresetInstall(
  name: string,
  options: SkillPresetOptions,
  dependencies: SkillCommandDependencies = {},
): Promise<InstallSkillPresetResponse> {
  const authority = await resolveSkillCommandContext("install", { ...dependencies, agentId: options.agentId });
  return authority.mode === "account"
    ? authority.api.installSkillPreset(authority.accessToken, authority.agentId, name)
    : authority.api.installRuntimeSkillPreset(authority.proof, name);
}
