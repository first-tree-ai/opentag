/** Local proxy mode is explicit; an invalid value never silently falls back to raw credential grants. */
export function resolveRuntimeCredentialMode(environment: NodeJS.ProcessEnv): "legacy" | "proxy" {
  const mode = environment.OPENTAG_RUNTIME_CREDENTIAL_MODE;
  if (mode === undefined || mode === "legacy") return "legacy";
  if (mode === "proxy") return "proxy";
  throw new Error("OPENTAG_RUNTIME_CREDENTIAL_MODE must be legacy or proxy");
}

/**
 * Legacy mode delivers bound MCP Servers through an MCP-only execution by default.
 * `OPENTAG_LEGACY_MCP_GATEWAY=off` restores the execution-free legacy path.
 */
export function resolveLegacyMcpGateway(environment: NodeJS.ProcessEnv): boolean {
  const value = environment.OPENTAG_LEGACY_MCP_GATEWAY;
  if (value === undefined || value === "on") return true;
  if (value === "off") return false;
  throw new Error("OPENTAG_LEGACY_MCP_GATEWAY must be on or off");
}
