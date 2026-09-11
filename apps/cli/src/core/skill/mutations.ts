import { lstat, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { inspectSkillArchive, type OpenTagApi, packSkillDirectory, SkillArchiveError } from "@opentag/client";
import {
  AgentSkillAssignmentRequestSchema,
  type AgentSkillsResponse,
  SKILL_ARCHIVE_MAX_BYTES,
  type SkillDetail,
} from "@opentag/shared";
import { CommandError } from "../command/policy.js";
import { resolveSessionCommandContext } from "../session/index.js";
import { resolveSkillCommandContext, type SkillCommandDependencies } from "./context.js";
import { parseSkillName } from "./queries.js";

const SESSION_ID_ENVIRONMENT_VARIABLE = "OPENTAG_SESSION_ID";

export interface SkillPushOptions extends SkillCommandDependencies {
  /** Replace an existing skill with the same name instead of failing with a conflict. */
  replace?: boolean;
  /** The Session to publish through when running inside an Agent Session. */
  session?: string;
  environment?: NodeJS.ProcessEnv;
  /** Test seam for the Session upload path. */
  sessionApi?: Pick<OpenTagApi, "uploadSessionSkill">;
  sessionProof?: string;
}

export interface SkillPushResult {
  skill: SkillDetail;
  source: "directory" | "archive";
  via: "account" | "session";
}

function validationError(code: string, message: string): CommandError {
  return new CommandError({ code, category: "validation", retryability: "never", phase: "validation" }, message);
}

async function readSkillSource(source: string): Promise<{ bytes: Uint8Array; kind: SkillPushResult["source"] }> {
  const status = await lstat(source);
  try {
    if (status.isDirectory()) return { bytes: (await packSkillDirectory(source)).bytes, kind: "directory" };
    if (!status.isFile())
      throw validationError("SKILL_SOURCE_INVALID", `${source} is neither a directory nor a zip file`);
    if (status.size > SKILL_ARCHIVE_MAX_BYTES) {
      throw validationError(
        "SKILL_ARCHIVE_TOO_LARGE",
        `Skill archives must be at most ${SKILL_ARCHIVE_MAX_BYTES} bytes`,
      );
    }
    const bytes = new Uint8Array(await readFile(source));
    inspectSkillArchive(bytes);
    return { bytes, kind: "archive" };
  } catch (error) {
    if (error instanceof SkillArchiveError)
      throw validationError(`SKILL_ARCHIVE_${error.rejection.toUpperCase().replaceAll("-", "_")}`, error.message);
    throw error;
  }
}

/**
 * Publish a skill directory or zip. Inside an Agent Session the upload goes through the Session proof
 * and is assigned to the Session's Agent; elsewhere it uses the Account login.
 */
export async function runSkillPush(source: string, options: SkillPushOptions = {}): Promise<SkillPushResult> {
  const environment = options.environment ?? process.env;
  const { bytes, kind } = await readSkillSource(source);
  const upload = { onConflict: options.replace ? ("replace" as const) : ("fail" as const) };
  if (environment.OPENTAG_SESSION_PROOF_FILE) {
    const sessionId = options.session ?? environment[SESSION_ID_ENVIRONMENT_VARIABLE];
    if (!sessionId) {
      throw validationError(
        "SKILL_SESSION_REQUIRED",
        "Inside an Agent Session pass --session <session-id> (the Current Session named in your instructions)",
      );
    }
    const session =
      options.sessionApi && options.sessionProof
        ? { api: options.sessionApi, proof: options.sessionProof }
        : await resolveSessionCommandContext(environment);
    const skill = await session.api.uploadSessionSkill(session.proof, sessionId, bytes, upload);
    return { skill, source: kind, via: "session" };
  }
  const { api, accessToken } = await resolveSkillCommandContext(options);
  const skill = await api.uploadSkill(accessToken, bytes, upload);
  return { skill, source: kind, via: "account" };
}

export interface SkillDeleteOptions extends SkillCommandDependencies {
  yes?: boolean;
  /** Test seam for the interactive confirmation. */
  confirm?: (question: string) => Promise<boolean>;
}

async function confirmInteractively(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw validationError("SKILL_DELETE_UNCONFIRMED", "Refusing to delete without --yes when stdin is not interactive");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(question);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function runSkillDelete(name: string, options: SkillDeleteOptions = {}): Promise<string> {
  const skillName = parseSkillName(name);
  if (!options.yes) {
    const confirmed = await (options.confirm ?? confirmInteractively)(`Delete skill ${skillName}? [y/N] `);
    if (!confirmed) {
      throw new CommandError(
        { code: "SKILL_DELETE_CANCELLED", category: "cancelled", retryability: "never", phase: "request" },
        `Deletion of skill ${skillName} was cancelled`,
      );
    }
  }
  const { api, accessToken } = await resolveSkillCommandContext(options);
  await api.deleteSkill(accessToken, skillName);
  return `Deleted skill ${skillName}`;
}

export interface SkillAssignOptions extends SkillCommandDependencies {
  set: readonly string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Replace an Agent's skill set. The Agent may be named by id or by its slug. */
export async function runSkillAssign(agent: string, options: SkillAssignOptions): Promise<AgentSkillsResponse> {
  const input = AgentSkillAssignmentRequestSchema.parse({ skillNames: [...options.set] });
  const { api, accessToken } = await resolveSkillCommandContext(options);
  let agentId = agent;
  if (!UUID_PATTERN.test(agent)) {
    const agents = await api.listAgents(accessToken);
    const match = agents.agents.find((candidate) => candidate.name === agent);
    if (!match) throw validationError("AGENT_NOT_FOUND", `No Agent is named "${agent}"`);
    agentId = match.id;
  }
  return api.replaceAgentSkills(accessToken, agentId, input);
}
