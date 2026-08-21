import { AGENT_RUNTIME_PROVIDERS, type AgentRuntimeProvider } from "@opentag/shared";

export interface ServerAgentRuntimeProviderPolicy {
  readonly execution: {
    readonly approvalPolicy: "never";
    readonly networkAccess: boolean;
  };
}

const SERVER_AGENT_RUNTIME_PROVIDER_POLICIES = {
  codex: { execution: { approvalPolicy: "never", networkAccess: true } },
  "claude-code": { execution: { approvalPolicy: "never", networkAccess: true } },
} as const satisfies Partial<Record<AgentRuntimeProvider, ServerAgentRuntimeProviderPolicy>>;

export type ServerAdmittedAgentRuntimeProvider = keyof typeof SERVER_AGENT_RUNTIME_PROVIDER_POLICIES;

export const SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS = AGENT_RUNTIME_PROVIDERS.filter(
  (provider): provider is ServerAdmittedAgentRuntimeProvider => provider in SERVER_AGENT_RUNTIME_PROVIDER_POLICIES,
);

export function isServerAdmittedAgentRuntimeProvider(value: string): value is ServerAdmittedAgentRuntimeProvider {
  return SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS.some((provider) => provider === value);
}

export function serverAgentRuntimeProviderPolicy(
  provider: ServerAdmittedAgentRuntimeProvider,
): ServerAgentRuntimeProviderPolicy {
  return SERVER_AGENT_RUNTIME_PROVIDER_POLICIES[provider];
}
