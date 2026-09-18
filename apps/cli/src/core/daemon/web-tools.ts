/**
 * Web tools daemon opt-in. Off by default; effective only together with
 * OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy, a negotiated webTools capability, and a Server-granted
 * web execution scope — the flag alone never enables anything.
 */
export function resolveWebToolsOptIn(environment: NodeJS.ProcessEnv): { enabled: boolean } {
  const value = environment.OPENTAG_WEB_TOOLS_ENABLED;
  if (value === undefined || value === "false") return { enabled: false };
  if (value === "true") return { enabled: true };
  throw new Error("OPENTAG_WEB_TOOLS_ENABLED must be true or false");
}
