import { readFile } from "node:fs/promises";
import type { OpenTagApi } from "@opentag/client";
import { ProvisionSlackAgentRequestSchema, type ProvisionSlackAgentResponse } from "@opentag/shared";
import { resolveSessionProofContext } from "../session/index.js";

export interface SlackAgentProvisionOptions {
  requestFile: string;
  credentialsFile: string;
  codeFile?: string;
  environment?: NodeJS.ProcessEnv;
  runtime?: { api: Pick<OpenTagApi, "provisionSlackAgent">; proof: string; serverUrl: string };
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The provisioning input file is not valid JSON");
  }
}

export async function runSlackAgentProvision(
  options: SlackAgentProvisionOptions,
): Promise<
  ProvisionSlackAgentResponse | { confirmationUrl: string; agentName: string; appId: string; teamId: string }
> {
  const prepared = ProvisionSlackAgentRequestSchema.omit({ code: true }).parse({
    agent: await readJson(options.requestFile),
    slack: await readJson(options.credentialsFile),
  });
  const runtime = options.runtime ?? (await resolveSessionProofContext(options.environment));
  if (!options.codeFile) {
    const url = new URL("/account", runtime.serverUrl);
    url.searchParams.set("slackProvision", "true");
    return {
      confirmationUrl: url.toString(),
      agentName: prepared.agent.displayName,
      appId: prepared.slack.appId,
      teamId: prepared.slack.teamId,
    };
  }
  const input = ProvisionSlackAgentRequestSchema.parse({
    ...prepared,
    code: (await readFile(options.codeFile, "utf8")).trim(),
  });
  return runtime.api.provisionSlackAgent(runtime.proof, input);
}
