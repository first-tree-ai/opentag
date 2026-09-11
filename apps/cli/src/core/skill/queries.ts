import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { extractSkillArchive, sha256Hex } from "@opentag/client";
import { type ListSkillsResponse, type SkillDetail, SkillNameSchema, type SkillSummary } from "@opentag/shared";
import { CommandError } from "../command/policy.js";
import { resolveSkillCommandContext, type SkillCommandDependencies } from "./context.js";

export type SkillListOptions = SkillCommandDependencies;

/** List every skill in the Account, following the Server's cursor so the output is complete. */
export async function runSkillList(options: SkillListOptions = {}): Promise<ListSkillsResponse> {
  const { api, accessToken } = await resolveSkillCommandContext(options);
  const skills: SkillSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listSkills(accessToken, cursor ? { cursor } : {});
    skills.push(...page.skills);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { skills, nextCursor: null };
}

export async function runSkillShow(name: string, options: SkillCommandDependencies = {}): Promise<string> {
  const skillName = parseSkillName(name);
  const { api, accessToken } = await resolveSkillCommandContext(options);
  return api.getSkillMarkdown(accessToken, skillName);
}

export interface SkillPullOptions extends SkillCommandDependencies {
  /** Parent directory that receives `<name>/`; defaults to the current working directory. */
  out?: string;
}

export interface SkillPullResult {
  skill: SkillDetail;
  directory: string;
}

/** Download a skill archive, verify it against the Server's manifest, and unpack it to `<out>/<name>`. */
export async function runSkillPull(name: string, options: SkillPullOptions = {}): Promise<SkillPullResult> {
  const skillName = parseSkillName(name);
  const parent = resolve(options.out ?? process.cwd());
  const directory = resolve(parent, skillName);
  await assertAbsentOrEmpty(directory);
  const { api, accessToken } = await resolveSkillCommandContext(options);
  const skill = await api.getSkill(accessToken, skillName);
  const download = await api.downloadSkillArchive(accessToken, skillName);
  if (download.status !== 200) {
    throw new CommandError(
      { code: "SKILL_ARCHIVE_UNAVAILABLE", category: "unavailable", retryability: "backoff", phase: "request" },
      "The server did not return the skill archive",
    );
  }
  if (download.bytes.length !== skill.archiveBytes || sha256Hex(download.bytes) !== skill.archiveSha256) {
    throw new CommandError(
      { code: "SKILL_ARCHIVE_CHECKSUM_MISMATCH", category: "internal", retryability: "immediate", phase: "request" },
      "The downloaded skill archive does not match its advertised checksum",
    );
  }
  await mkdir(parent, { recursive: true });
  const temporary = resolve(parent, `.opentag-skill-${skillName}-${randomUUID()}`);
  try {
    await extractSkillArchive(download.bytes, {
      manifest: skill.manifest,
      digest: skill.digest,
      destination: temporary,
      root: parent,
    });
    await rm(directory, { recursive: true, force: true });
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { skill, directory };
}

export function parseSkillName(name: string): string {
  const parsed = SkillNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new CommandError(
      { code: "VALIDATION_ERROR", category: "validation", retryability: "never", phase: "validation" },
      "Skill names must match ^[a-z0-9][a-z0-9-]{0,63}$",
    );
  }
  return parsed.data;
}

async function assertAbsentOrEmpty(directory: string): Promise<void> {
  try {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink() || (await readdir(directory)).length > 0) {
      throw new CommandError(
        { code: "SKILL_TARGET_EXISTS", category: "validation", retryability: "never", phase: "validation" },
        `${directory} already exists; pass --out <dir> to unpack somewhere else`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
