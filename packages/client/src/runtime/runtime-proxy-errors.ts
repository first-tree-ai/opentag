import { RuntimeProxyDataError } from "./runtime-proxy-data-client.js";

const HTTP_ERRORS: Readonly<Record<string, number>> = {
  scope_denied: 403,
  credential_scope_denied: 403,
  invalid_request: 400,
  resource_limit: 429,
  remote_conflict: 409,
  unavailable: 503,
  GITHUB_CREDENTIAL_INVALID: 401,
  GITHUB_RATE_LIMITED: 429,
  GITHUB_UPSTREAM_UNAVAILABLE: 503,
  GITHUB_UPSTREAM_ERROR: 502,
  GITHUB_API_RESPONSE_INVALID: 502,
  GITHUB_TOKEN_LIFETIME_UNSUPPORTED: 503,
};

/** Only closed, nonsecret reason codes cross the local HTTP boundary. Never expose raw errors. */
export function githubProxyFailure(error: unknown): { status: number; code: string } {
  const code = error instanceof RuntimeProxyDataError ? error.upstreamCode : undefined;
  if (code && Object.hasOwn(HTTP_ERRORS, code)) return { status: HTTP_ERRORS[code] as number, code };
  return { status: 503, code: "upstream_unavailable" };
}
