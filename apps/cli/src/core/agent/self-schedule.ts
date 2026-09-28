import { readFile } from "node:fs/promises";
import type { OpenTagApi } from "@opentag/client";
import {
  type AgentSchedule,
  type AgentScheduleInput,
  type AgentScheduleListResponse,
  type AgentSchedulePreview,
  CreateAgentScheduleRequestSchema,
  PreviewAgentScheduleRequestSchema,
  UpdateAgentScheduleRequestSchema,
} from "@opentag/shared";
import { CommandError } from "../command/policy.js";
import { resolveSessionProofContext } from "../session/index.js";

export interface ScheduleSelfApiClient
  extends Pick<
    OpenTagApi,
    | "createRuntimeAgentSchedule"
    | "listRuntimeAgentSchedules"
    | "getRuntimeAgentSchedule"
    | "updateRuntimeAgentSchedule"
    | "pauseRuntimeAgentSchedule"
    | "resumeRuntimeAgentSchedule"
    | "deleteRuntimeAgentSchedule"
    | "previewRuntimeAgentSchedule"
  > {}

export interface ScheduleSelfDependencies {
  api?: ScheduleSelfApiClient;
  proof?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ScheduleRuleOptions {
  at?: string;
  every?: string;
  cron?: string;
}

export interface SchedulePromptOptions {
  prompt?: string;
  promptFile?: string;
}

export interface CreateScheduleOptions extends ScheduleSelfDependencies, ScheduleRuleOptions, SchedulePromptOptions {
  name: string;
  timezone: string;
}

export interface UpdateScheduleOptions extends ScheduleSelfDependencies, ScheduleRuleOptions, SchedulePromptOptions {
  name?: string;
  timezone?: string;
}

async function context(dependencies: ScheduleSelfDependencies): Promise<{ api: ScheduleSelfApiClient; proof: string }> {
  if ((dependencies.api && !dependencies.proof) || (dependencies.proof && !dependencies.api)) {
    throw new Error("Schedule command test dependencies must provide both api and proof");
  }
  if (dependencies.api && dependencies.proof) return { api: dependencies.api, proof: dependencies.proof };
  const environment = dependencies.environment ?? process.env;
  if (!environment.OPENTAG_SESSION_PROOF_FILE) {
    throw new CommandError(
      { code: "AGENT_SELF_SESSION_REQUIRED", category: "validation", retryability: "never", phase: "validation" },
      "agent self schedule commands run only inside an OpenTag-managed Agent Session",
    );
  }
  return resolveSessionProofContext(environment);
}

/** CLI accepts one explicit rule; interpretation of natural language belongs to the Agent. */
function ruleFromOptions(options: ScheduleRuleOptions, required: true): AgentScheduleInput;
function ruleFromOptions(options: ScheduleRuleOptions, required: false): AgentScheduleInput | undefined;
function ruleFromOptions(options: ScheduleRuleOptions, required: boolean): AgentScheduleInput | undefined {
  const count =
    Number(options.at !== undefined) + Number(options.every !== undefined) + Number(options.cron !== undefined);
  if (count > 1 || (required && count !== 1)) {
    throw new Error("Specify exactly one of --at, --every, or --cron");
  }
  if (options.at !== undefined) return { kind: "at", at: options.at };
  if (options.every !== undefined) {
    if (!/^[1-9][0-9]*$/.test(options.every)) throw new Error("--every must be an integer number of seconds");
    return { kind: "every", intervalSeconds: Number(options.every) };
  }
  if (options.cron !== undefined) return { kind: "cron", expression: options.cron };
  return undefined;
}

async function promptFromOptions(options: SchedulePromptOptions, required: true): Promise<string>;
async function promptFromOptions(options: SchedulePromptOptions, required: false): Promise<string | undefined>;
async function promptFromOptions(options: SchedulePromptOptions, required: boolean): Promise<string | undefined> {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new Error("--prompt and --prompt-file cannot be used together");
  }
  if (required && options.prompt === undefined && options.promptFile === undefined) {
    throw new Error("Specify --prompt or --prompt-file");
  }
  // Preserve the file's exact UTF-8 text. The schema checks the byte budget without truncation.
  return options.promptFile === undefined ? options.prompt : readFile(options.promptFile, "utf8");
}

export async function runAgentSelfScheduleCreate(options: CreateScheduleOptions): Promise<AgentSchedule> {
  const prompt = await promptFromOptions(options, true);
  const input = CreateAgentScheduleRequestSchema.parse({
    name: options.name,
    prompt,
    schedule: ruleFromOptions(options, true),
    timezone: options.timezone,
  });
  const { api, proof } = await context(options);
  // A transport timeout is indeterminate. The caller sees it and can list/show; there is no
  // automatic POST retry that could create a second schedule.
  return api.createRuntimeAgentSchedule(proof, input);
}

export async function runAgentSelfScheduleList(
  options: ScheduleSelfDependencies & { limit?: string; cursor?: string } = {},
): Promise<AgentScheduleListResponse> {
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  const { api, proof } = await context(options);
  return api.listRuntimeAgentSchedules(proof, {
    ...(limit ? { limit } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
}

export async function runAgentSelfScheduleShow(
  scheduleId: string,
  dependencies: ScheduleSelfDependencies = {},
): Promise<AgentSchedule> {
  const { api, proof } = await context(dependencies);
  return api.getRuntimeAgentSchedule(proof, scheduleId);
}

export async function runAgentSelfScheduleUpdate(
  scheduleId: string,
  options: UpdateScheduleOptions,
): Promise<AgentSchedule> {
  const prompt = await promptFromOptions(options, false);
  const rule = ruleFromOptions(options, false);
  const mutation = {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(rule !== undefined ? { schedule: rule } : {}),
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
  };
  const preflight = UpdateAgentScheduleRequestSchema.parse({ expectedRevision: 1, ...mutation });
  const { api, proof } = await context(options);
  const current = await api.getRuntimeAgentSchedule(proof, scheduleId);
  return api.updateRuntimeAgentSchedule(proof, scheduleId, { ...preflight, expectedRevision: current.revision });
}

export async function runAgentSelfSchedulePause(
  scheduleId: string,
  dependencies: ScheduleSelfDependencies = {},
): Promise<AgentSchedule> {
  const { api, proof } = await context(dependencies);
  const current = await api.getRuntimeAgentSchedule(proof, scheduleId);
  return api.pauseRuntimeAgentSchedule(proof, scheduleId, current.revision);
}

export async function runAgentSelfScheduleResume(
  scheduleId: string,
  dependencies: ScheduleSelfDependencies = {},
): Promise<AgentSchedule> {
  const { api, proof } = await context(dependencies);
  const current = await api.getRuntimeAgentSchedule(proof, scheduleId);
  return api.resumeRuntimeAgentSchedule(proof, scheduleId, current.revision);
}

export async function runAgentSelfScheduleDelete(
  scheduleId: string,
  dependencies: ScheduleSelfDependencies = {},
): Promise<{ scheduleId: string; deleted: true }> {
  const { api, proof } = await context(dependencies);
  const current = await api.getRuntimeAgentSchedule(proof, scheduleId);
  await api.deleteRuntimeAgentSchedule(proof, scheduleId, current.revision);
  return { scheduleId, deleted: true };
}

export async function runAgentSelfSchedulePreview(
  options: ScheduleSelfDependencies & ScheduleRuleOptions & { scheduleId?: string; timezone?: string },
): Promise<AgentSchedulePreview> {
  const rule = ruleFromOptions(options, false);
  const input =
    options.scheduleId !== undefined
      ? PreviewAgentScheduleRequestSchema.parse({
          scheduleId: options.scheduleId,
          ...(rule ? { schedule: rule } : {}),
          ...(options.timezone ? { timezone: options.timezone } : {}),
        })
      : PreviewAgentScheduleRequestSchema.parse({ schedule: rule, timezone: options.timezone });
  const { api, proof } = await context(options);
  return api.previewRuntimeAgentSchedule(proof, input);
}

export function formatAgentSchedule(schedule: AgentSchedule): string {
  return [
    `Name: ${schedule.name}`,
    `ID: ${schedule.id}`,
    `Target Session: ${schedule.target.sessionId}`,
    `Target: ${schedule.target.provider} ${schedule.target.channelId}${schedule.target.threadKey ? ` / ${schedule.target.threadKey}` : ""}`,
    `Rule: ${JSON.stringify(schedule.schedule)}`,
    `Timezone: ${schedule.timezone}`,
    `Enabled: ${schedule.enabled}`,
    `Next: ${schedule.nextTriggerAt ?? "—"}`,
    `Revision: ${schedule.revision}`,
    `Latest handoff: ${schedule.lastDispatch ? JSON.stringify(schedule.lastDispatch) : "—"}`,
    `Detail: ${schedule.detailUrl}`,
    `Prompt:\n${schedule.prompt}`,
  ].join("\n");
}

export function formatAgentScheduleList(result: AgentScheduleListResponse): string {
  const rows = ["ID\tNAME\tENABLED\tNEXT\tLAST HANDOFF"];
  for (const item of result.items) {
    rows.push(
      [item.id, item.name, String(item.enabled), item.nextTriggerAt ?? "—", item.lastDispatch?.outcome ?? "—"].join(
        "\t",
      ),
    );
  }
  if (result.nextCursor) rows.push(`Next cursor: ${result.nextCursor}`);
  return rows.join("\n");
}

export function formatAgentSchedulePreview(preview: AgentSchedulePreview): string {
  return [
    `Calculated at: ${preview.calculatedAt}`,
    `Rule: ${JSON.stringify(preview.schedule)}`,
    `Timezone: ${preview.timezone}`,
    ...preview.items.map((item) => `${item.local} (${item.timezone})\t${item.at}`),
  ].join("\n");
}
