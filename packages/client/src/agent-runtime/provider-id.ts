const AGENT_RUNTIME_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isAgentRuntimeProviderId(value: unknown): value is string {
  return typeof value === "string" && AGENT_RUNTIME_PROVIDER_ID_PATTERN.test(value);
}
