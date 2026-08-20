import type { AgentRuntimeProvider } from "@opentag/shared";

export const SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS = ["codex"] as const satisfies readonly AgentRuntimeProvider[];

export type ServerAdmittedAgentRuntimeProvider = (typeof SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS)[number];

export function isServerAdmittedAgentRuntimeProvider(value: string): value is ServerAdmittedAgentRuntimeProvider {
  return SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS.some((provider) => provider === value);
}
