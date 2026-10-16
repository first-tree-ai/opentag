/** Transport-only rules. GitHub owns repository permissions and API semantics. */
const PRIVATE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "set-cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function githubProxyHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const connection = Object.entries(headers).find(([name]) => name.toLowerCase() === "connection")?.[1];
  const hopHeaders = new Set(
    connection
      ?.toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  );
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      const lower = name.toLowerCase();
      return PRIVATE_HEADERS.has(lower) || hopHeaders.has(lower) || lower.startsWith("x-opentag-")
        ? []
        : [[lower, value]];
    }),
  );
}

/** Closed diagnostics: never serialize an upstream exception, URL, or request options. */
export const GITHUB_PROXY_FAILURE_STATUSES = {
  github_credential_unavailable: 401,
  github_credential_failed: 503,
  github_destination_blocked: 403,
  github_download_target_unsupported: 502,
  github_dns_failed: 502,
  github_tls_failed: 502,
  github_connect_failed: 502,
  github_timeout: 504,
  github_request_body_failed: 502,
  github_response_truncated: 502,
  github_protocol_upgrade_required: 426,
} as const;
export type GitHubProxyFailureCode = keyof typeof GITHUB_PROXY_FAILURE_STATUSES;
