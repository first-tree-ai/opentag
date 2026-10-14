import { readFile } from "node:fs/promises";
import { Agent, request } from "node:https";
import { getCACertificates } from "node:tls";
import type { AgentRuntimeProbeIssue } from "../../agent-runtime/types.js";

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";

/** Verify explicit first-party credentials without a model request or touching native login storage. */
export async function probeClaudeEnvironmentCredential(
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  readStatus = requestCredentialStatus,
): Promise<AgentRuntimeProbeIssue | undefined> {
  const credential = environment.ANTHROPIC_AUTH_TOKEN
    ? { token: environment.ANTHROPIC_AUTH_TOKEN, header: "Authorization", oauth: false }
    : environment.ANTHROPIC_API_KEY
      ? { token: environment.ANTHROPIC_API_KEY, header: "x-api-key", oauth: false }
      : environment.CLAUDE_CODE_OAUTH_TOKEN
        ? { token: environment.CLAUDE_CODE_OAUTH_TOKEN, header: "Authorization", oauth: true }
        : undefined;
  if (
    !credential ||
    ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
      (key) => environment[key] === "1",
    ) ||
    (environment.ANTHROPIC_BASE_URL &&
      environment.ANTHROPIC_BASE_URL.replace(/\/+$/u, "") !== "https://api.anthropic.com")
  )
    return undefined;
  const rejected = {
    code: "credential_missing" as const,
    message:
      "Claude Code credentials were rejected; renew the selected API credential or run claude setup-token for OAuth",
  };
  if (credential.token.trim() !== credential.token || /[\r\n]/u.test(credential.token)) return rejected;
  try {
    const status = await readStatus(environment, credential, signal);
    if (status === 200) return undefined;
    if (status === 401) return rejected;
  } catch {
    signal?.throwIfAborted();
  }
  return {
    code: "temporarily_unavailable",
    message: "Claude Code authentication could not be verified; check connectivity and try again",
  };
}

async function requestCredentialStatus(
  environment: NodeJS.ProcessEnv,
  credential: { token: string; header: string; oauth: boolean },
  signal?: AbortSignal,
): Promise<number> {
  const certificatePaths = [
    ...new Set(
      [environment.SSL_CERT_FILE, environment.NODE_EXTRA_CA_CERTS].filter((path): path is string => Boolean(path)),
    ),
  ];
  const ca = certificatePaths.length
    ? [...getCACertificates("default"), ...(await Promise.all(certificatePaths.map((path) => readFile(path, "utf8"))))]
    : undefined;
  const agent = new Agent({ proxyEnv: environment, ...(ca ? { ca } : {}) });
  const timeout = AbortSignal.timeout(5_000);
  try {
    return await new Promise<number>((resolve, reject) => {
      const check = request(
        MODELS_URL,
        {
          agent,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            [credential.header]:
              credential.header === "Authorization" ? `Bearer ${credential.token}` : credential.token,
            "anthropic-version": "2023-06-01",
            ...(credential.oauth ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
            Accept: "application/json",
          },
        },
        (response) => {
          // Never follow redirects or retain/log the response body or credential-bearing request.
          response.destroy();
          resolve(response.statusCode ?? 0);
        },
      );
      check.on("error", reject);
      check.end();
    });
  } finally {
    agent.destroy();
  }
}
