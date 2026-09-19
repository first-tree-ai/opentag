import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  extractSkillArchive,
  isSkillMaterializationTarget,
  markSkillDirectoryManaged,
  OpenTagApiError,
  packSkillDirectory,
  SkillArchiveError,
  verifySkillBundle,
} from "@opentag/client";
import { type ListAgentSkillsResponse, SKILL_ERROR_CODES, type Skill } from "@opentag/shared";
import { CommandError } from "../command/policy.js";
import { resolveSkillCommandContext, type SkillAuthority } from "./context.js";
import type { SkillCommandDependencies } from "./shared.js";

/**
 * The Skill operations the CLI performs.
 *
 * `push` packs the local directory client-side so the user sees manifest and limit errors before a
 * byte is uploaded, and adopts the directory as platform-managed when it is the Skill's own
 * materialization target. `pull` refuses a non-empty destination rather than overwriting an
 * Agent's authored work.
 */

function conflictError(name: string, cause: { requestId?: string }): CommandError {
  return new CommandError(
    {
      code: SKILL_ERROR_CODES.NAME_CONFLICT,
      category: "conflict",
      retryability: "never",
      phase: "request",
      ...(cause.requestId ? { requestId: cause.requestId } : {}),
    },
    `A Skill named "${name}" already exists; pass --replace to replace it`,
    { cause },
  );
}

/**
 * A name conflict is reported by the server as `SKILL_NAME_CONFLICT`; the shared error envelope
 * admits that code, so the CLI can act on it directly.
 */
function isUploadConflict(error: unknown): error is OpenTagApiError {
  return error instanceof OpenTagApiError && error.code === SKILL_ERROR_CODES.NAME_CONFLICT;
}

async function resolveSkill(nameOrId: string, authority: SkillAuthority): Promise<Skill> {
  const listing: ListAgentSkillsResponse =
    authority.mode === "account"
      ? await authority.api.listAgentSkills(authority.accessToken, authority.agentId)
      : await authority.api.listRuntimeSkills(authority.proof);
  const match = listing.skills.find((skill) => skill.name === nameOrId || skill.id === nameOrId);
  if (!match) throw new Error(`No Skill named or identified by "${nameOrId}"`);
  return match;
}

export interface SkillPushOptions {
  agentId?: string;
  replace?: boolean;
}

export interface SkillPushResult {
  readonly skill: Skill;
  readonly adopted: boolean;
  /** Present exactly when `adopted` is false, so the CLI can always explain the outcome. */
  readonly adoptionReason?: string;
}

/**
 * Adopt the uploaded directory as platform-managed, and say whether it happened.
 *
 * Adoption is Agent-only: a human pushing from their own checkout must never have a marker written
 * into their repository. Inside a Session the workspace is derived from the directory's own path
 * shape, so `cd`-ing into the skill directory does not change the outcome. A Skill the server
 * reports as disabled is not adopted, because the next sync would remove the authored directory.
 */
async function adoptPushedDirectory(
  directory: string,
  name: string,
  authority: SkillAuthority,
  uploaded: Skill,
): Promise<{ adopted: boolean; adoptionReason?: string }> {
  if (authority.mode !== "agent") {
    return { adopted: false, adoptionReason: "adoption applies only inside an Agent Session" };
  }
  if (!isSkillMaterializationTarget(directory, name)) {
    return { adopted: false, adoptionReason: "the directory is not a Skill materialization target" };
  }
  if (uploaded.enabled === false) {
    return { adopted: false, adoptionReason: "the Skill is disabled on the platform; the next sync would remove it" };
  }
  await markSkillDirectoryManaged(resolve(directory), {
    skillId: uploaded.id,
    archiveSha256: uploaded.archiveSha256,
  });
  return { adopted: true };
}

export async function runSkillPush(
  directory: string,
  options: SkillPushOptions,
  dependencies: SkillCommandDependencies = {},
): Promise<SkillPushResult> {
  const packed = await packSkillDirectory(directory);
  const authority = await resolveSkillCommandContext("push", { ...dependencies, agentId: options.agentId });
  const input = {
    archive: packed.archive,
    sha256: packed.sha256,
    format: "tar.gz" as const,
    ...(options.replace === true ? { replace: true } : {}),
  };
  let uploaded: Skill;
  try {
    uploaded =
      authority.mode === "account"
        ? await authority.api.uploadAgentSkill(authority.accessToken, authority.agentId, input)
        : await authority.api.pushRuntimeSkill(authority.proof, input);
  } catch (error) {
    if (isUploadConflict(error)) throw conflictError(packed.name, error);
    throw error;
  }
  const adoption = await adoptPushedDirectory(directory, packed.name, authority, uploaded);
  return { skill: uploaded, ...adoption };
}

export async function runSkillList(
  options: { agentId?: string },
  dependencies: SkillCommandDependencies = {},
): Promise<ListAgentSkillsResponse> {
  const authority = await resolveSkillCommandContext("list", { ...dependencies, agentId: options.agentId });
  return authority.mode === "account"
    ? await authority.api.listAgentSkills(authority.accessToken, authority.agentId)
    : await authority.api.listRuntimeSkills(authority.proof);
}

export interface SkillPullOptions {
  agentId?: string;
  outDir?: string;
}

async function assertEmptyDestination(directory: string): Promise<void> {
  let present: boolean;
  try {
    present = (await stat(directory)).isDirectory();
  } catch {
    return;
  }
  if (!present) {
    throw new CommandError(
      { code: "SKILL_PULL_DESTINATION_INVALID", category: "validation", retryability: "never", phase: "validation" },
      `Pull destination is not a directory: ${directory}`,
    );
  }
  if ((await readdir(directory)).length > 0) {
    throw new CommandError(
      { code: "SKILL_PULL_DESTINATION_NOT_EMPTY", category: "validation", retryability: "never", phase: "validation" },
      `Pull destination is not empty: ${directory}`,
    );
  }
}

export async function runSkillPull(
  nameOrId: string,
  options: SkillPullOptions,
  dependencies: SkillCommandDependencies = {},
): Promise<{ skill: Skill; directory: string }> {
  const authority = await resolveSkillCommandContext("pull", { ...dependencies, agentId: options.agentId });
  const skill = await resolveSkill(nameOrId, authority);
  const directory = resolve(options.outDir ?? join(dependencies.cwd ?? process.cwd(), skill.name));
  await assertEmptyDestination(directory);
  const response =
    authority.mode === "account"
      ? await authority.api.openAgentSkillBundle(authority.accessToken, authority.agentId, skill.id)
      : await authority.api.openRuntimeSkillBundle(authority.proof, skill.name);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifySkillBundle(new Uint8Array(bytes), {
    archiveBytes: skill.archiveBytes,
    archiveSha256: skill.archiveSha256,
    name: skill.name,
  });
  await mkdir(resolve(directory, ".."), { recursive: true, mode: 0o700 });
  try {
    await extractSkillArchive(Readable.from(bytes), directory);
  } catch (error) {
    if (error instanceof SkillArchiveError && error.code === "destination_not_empty") {
      throw new CommandError(
        {
          code: "SKILL_PULL_DESTINATION_NOT_EMPTY",
          category: "validation",
          retryability: "never",
          phase: "validation",
        },
        `Pull destination is not empty: ${directory}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { skill, directory };
}

export async function runSkillRemove(
  nameOrId: string,
  options: { agentId?: string },
  dependencies: SkillCommandDependencies = {},
): Promise<Skill> {
  const authority = await resolveSkillCommandContext("remove", { ...dependencies, agentId: options.agentId });
  const skill = await resolveSkill(nameOrId, authority);
  /* The Session-proof path is rejected in `resolveSkillCommandContext`, so only an operator reaches here. */
  if (authority.mode !== "account") throw new Error("Removing a Skill requires an Account operator");
  await authority.api.removeAgentSkill(authority.accessToken, authority.agentId, skill.id);
  return skill;
}

export async function runSkillSetEnabled(
  nameOrId: string,
  enabled: boolean,
  options: { agentId?: string },
  dependencies: SkillCommandDependencies = {},
): Promise<Skill> {
  const authority = await resolveSkillCommandContext(enabled ? "enable" : "disable", {
    ...dependencies,
    agentId: options.agentId,
  });
  const skill = await resolveSkill(nameOrId, authority);
  if (authority.mode !== "account") throw new Error("Changing a Skill's state requires an Account operator");
  return await authority.api.updateAgentSkill(authority.accessToken, authority.agentId, skill.id, { enabled });
}
