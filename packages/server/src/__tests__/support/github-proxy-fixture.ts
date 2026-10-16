import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import type { ProviderProxyRequest, ProviderProxyResponse } from "../../runtime-credentials/provider-proxy-adapter.js";
import { GitHubProviderAdapter } from "../../services/github-proxy/github-provider-adapter.js";
import { GitHubHttpTransport } from "../../services/github-proxy/http-transport.js";

export async function bytes(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
export async function* body(value: string | Uint8Array = "") {
  yield Buffer.from(value);
}
export function proxyAuthorization(): RuntimeProxyAuthorization {
  return {
    executionId: randomUUID(),
    sessionId: randomUUID(),
    accountId: randomUUID(),
    agentId: randomUUID(),
    bindingId: randomUUID(),
    provider: "github",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "github:1",
    credentialGeneration: "1",
    cli: { provider: "github", connectionId: "fixture", authority: "user-task" },
    recheck: vi.fn(async () => {}),
    resolveMaterial: async () => {
      throw Error("No material crosses the runtime");
    },
  };
}
export function proxyRequest(
  auth: RuntimeProxyAuthorization,
  overrides: Partial<ProviderProxyRequest> = {},
): ProviderProxyRequest {
  return {
    executionId: auth.executionId,
    sessionId: auth.sessionId,
    bindingId: auth.bindingId,
    provider: "github",
    path: "/user",
    method: "GET",
    headers: { "x-opentag-provider-origin": "api.github.com" },
    body: body(),
    capability: "fixture",
    capabilityTtlSeconds: 60,
    signal: new AbortController().signal,
    ...overrides,
  };
}
export async function githubProxyFixture(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>,
  idleTimeoutMs?: number,
) {
  const requests: { host?: string; path?: string; authorization?: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ host: req.headers.host, path: req.url, authorization: req.headers.authorization });
    void Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const transport = new GitHubHttpTransport({
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
    resolveAddresses: async () => ["140.82.112.3"],
    connect: (url, options, listener) =>
      http.request(
        {
          ...options,
          hostname: "127.0.0.1",
          port,
          path: url.pathname + url.search,
          headers: { ...options.headers, host: url.host },
        },
        listener,
      ),
  });
  let token = "ghu_fixture_owner";
  const management = {
    getExecutionUserCredential: vi.fn(async () => ({
      accessToken: token,
      githubUserId: "owner",
      credentialGeneration: 1n,
      accessExpiresAt: new Date(Date.now() + 60000),
    })),
  };
  const authorization = proxyAuthorization();
  const adapter = new GitHubProviderAdapter({ management, transport });
  const send = (overrides: Partial<ProviderProxyRequest> = {}): Promise<ProviderProxyResponse> =>
    adapter.handle(proxyRequest(authorization, overrides), authorization);
  return {
    server,
    port,
    transport,
    adapter,
    authorization,
    management,
    requests,
    send,
    rotate: (value: string) => {
      token = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
