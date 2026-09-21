/** Local proxy mode is explicit; an invalid value never silently falls back to raw credential grants. */
export function resolveRuntimeCredentialMode(environment: NodeJS.ProcessEnv): "legacy" | "proxy" {
  const mode = environment.OPENTAG_RUNTIME_CREDENTIAL_MODE;
  if (mode === undefined || mode === "legacy") return "legacy";
  if (mode === "proxy") return "proxy";
  throw new Error("OPENTAG_RUNTIME_CREDENTIAL_MODE must be legacy or proxy");
}
