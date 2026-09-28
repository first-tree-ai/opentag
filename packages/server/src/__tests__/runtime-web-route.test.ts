import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { RUNTIME_WEB_FETCH_PATH, RUNTIME_WEB_SEARCH_PATH } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { RuntimeWebError } from "../runtime-credentials/web-execution.js";
import { RuntimeWebGatewayTokenStore } from "../runtime-credentials/web-gateway-token-store.js";
import type { RuntimeWebService } from "../runtime-credentials/web-service.js";
import type { ComputerAuthContext } from "../services/computers/index.js";

const COMPUTER = randomUUID();
const CLOUD_COMPUTER = randomUUID();
const EXECUTION = randomUUID();
const TOOL_CALL = randomUUID();

const searchResult = {
  requestId: "r-1",
  status: "ok" as const,
  retrievedAt: "2026-09-17T00:00:00Z",
  effectiveDepth: "basic" as const,
  results: [],
};

function createTestApp(
  overrides: {
    verify?: (token: string) => Promise<ComputerAuthContext>;
    search?: (input: Record<string, unknown>) => Promise<unknown>;
    fetch?: (input: Record<string, unknown>) => Promise<unknown>;
    /** Live execution → Computer map for the bearer path; absent means no bearer is accepted. */
    executions?: Map<string, string>;
  } = {},
) {
  const search = vi.fn(overrides.search ?? (async () => searchResult));
  const fetch = vi.fn(
    overrides.fetch ??
      (async () => ({
        ...searchResult,
        requestId: "r-2",
      })),
  );
  const verifyMachineToken = vi.fn(
    overrides.verify ?? (async () => ({ credentialId: "cred", computerId: COMPUTER, installationId: randomUUID() })),
  );
  const tokens = new RuntimeWebGatewayTokenStore();
  const app = createApp({
    runtimeWeb: {
      machineAuth: { verifyMachineToken },
      service: {
        search,
        fetch,
        executionComputerId: (executionId: string) => overrides.executions?.get(executionId),
      } as unknown as RuntimeWebService,
      tokens,
    },
  });
  return { app, search, fetch, tokens, verifyMachineToken };
}

/** Issue one execution bearer through the real store, as the credential tunnel would. */
function issueBearer(tokens: RuntimeWebGatewayTokenStore, executionId: string): string {
  return tokens.issue({ executionId, expiresAt: Date.now() + 60_000 }).token;
}

function searchBody(): string {
  return JSON.stringify({ protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runtime web routes", () => {
  it("serves a Cloud execution bearer, deriving the Computer from the live execution", async () => {
    const executions = new Map([[EXECUTION, CLOUD_COMPUTER]]);
    const { app, search, tokens, verifyMachineToken } = createTestApp({ executions });
    const bearer = issueBearer(tokens, EXECUTION);
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: `Bearer ${bearer}`, "x-web-timeout-ms": "9000" },
      payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
    });
    expect(response.statusCode).toBe(200);
    // The bearer never falls back to machine auth, and the Computer is the execution's own.
    expect(vi.mocked(verifyMachineToken)).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ computerId: CLOUD_COMPUTER }));
  });

  it("refuses a bearer presented for an execution the body does not name", async () => {
    const executions = new Map([[EXECUTION, CLOUD_COMPUTER]]);
    const { app, search, tokens } = createTestApp({ executions });
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: `Bearer ${issueBearer(tokens, EXECUTION)}` },
      payload: { protocolVersion: 1, executionId: randomUUID(), toolCallId: TOOL_CALL, query: "q" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("execution_unknown");
    expect(search).not.toHaveBeenCalled();
  });

  it("refuses an unknown, expired, or revoked bearer instead of treating it as machine auth", async () => {
    const executions = new Map([[EXECUTION, CLOUD_COMPUTER]]);
    const { app, search, tokens } = createTestApp({ executions });
    const revoked = issueBearer(tokens, EXECUTION);
    tokens.revokeExecution(EXECUTION);
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: `Bearer ${revoked}` },
      payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
    });
    expect(response.statusCode).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it("refuses every bearer when the deployment wired no web token store", async () => {
    // The fail-closed deployment: the route exists (a Local machine token still works) but no
    // execution bearer can ever be issued or accepted.
    const search = vi.fn(async () => searchResult);
    const app = createApp({
      runtimeWeb: {
        machineAuth: {
          verifyMachineToken: async () => ({
            credentialId: "cred",
            computerId: COMPUTER,
            installationId: randomUUID(),
          }),
        },
        service: { search, fetch: vi.fn() } as unknown as RuntimeWebService,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: `Bearer otwg_${"w".repeat(43)}` },
      payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
    });
    expect(response.statusCode).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it("never accepts a Cloud Computer credential through the machine-auth branch", async () => {
    // The kind-aware verifier accepts Cloud control credentials in a deployment that injected a
    // Cloud verifier; this route must still refuse them, because a control credential is not an
    // execution-scoped web authorization.
    const { app, search } = createTestApp({
      verify: async () => ({
        credentialId: "cloud-cred",
        computerId: CLOUD_COMPUTER,
        installationId: randomUUID(),
        kind: "cloud",
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: "Bearer otcc_cloud_control" },
      payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
    });
    expect(response.statusCode).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it("serves a fenced search over machine auth with a no-store bounded response", async () => {
    const { app, search } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: "Bearer otmc_test", "x-web-timeout-ms": "9000" },
      payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().requestId).toBe("r-1");
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ computerId: COMPUTER, remainingMs: 9000, deadlineAt: expect.any(Number) }),
    );
    const dispatch = search.mock.calls[0]?.[0] as { deadlineAt: number; signal: AbortSignal };
    const remainingBudget = dispatch.deadlineAt - Date.now();
    expect(remainingBudget).toBeGreaterThan(0);
    expect(remainingBudget).toBeLessThanOrEqual(9000);
    expect(dispatch.signal).toBeInstanceOf(AbortSignal);
  });

  it("requires machine authentication", async () => {
    const { app, search } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
    });
    expect(response.statusCode).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, spoofed identity fields, and bad URLs with 400", async () => {
    const { app, search, fetch } = createTestApp();
    const spoofed = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: "Bearer otmc_test" },
      payload: {
        protocolVersion: 1,
        executionId: EXECUTION,
        toolCallId: TOOL_CALL,
        query: "q",
        accountId: randomUUID(),
      },
    });
    expect(spoofed.statusCode).toBe(400);
    const badUrl = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_FETCH_PATH,
      headers: { authorization: "Bearer otmc_test" },
      payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, urls: ["http://127.0.0.1/"] },
    });
    expect(badUrl.statusCode).toBe(400);
    expect(search).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed or zero remaining-budget header", async () => {
    const { app } = createTestApp();
    for (const value of ["abc", "0", "1.5", "1".repeat(8)]) {
      const response = await app.inject({
        method: "POST",
        url: RUNTIME_WEB_SEARCH_PATH,
        headers: { authorization: "Bearer otmc_test", "x-web-timeout-ms": value },
        payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
      });
      expect(response.statusCode, value).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
    }
  });

  it("maps bounded service errors to statuses and envelopes", async () => {
    const failures: Array<[RuntimeWebError, number, string]> = [
      [new RuntimeWebError("credential_scope_denied", "denied"), 403, "credential_scope_denied"],
      [new RuntimeWebError("execution_unknown", "unknown"), 404, "execution_unknown"],
      [new RuntimeWebError("execution_closed", "closed"), 409, "execution_closed"],
      [new RuntimeWebError("rate_limited", "limited", { retryable: true }), 429, "rate_limited"],
      [new RuntimeWebError("timeout", "slow", { retryable: true }), 504, "timeout"],
      [new RuntimeWebError("upstream_unavailable", "down", { retryable: true }), 503, "upstream_unavailable"],
    ];
    for (const [error, status, code] of failures) {
      const failing = {
        search: vi.fn(async () => {
          throw error;
        }),
        fetch: vi.fn(),
      };
      const failingApp = createApp({
        runtimeWeb: {
          machineAuth: {
            verifyMachineToken: async () => ({ credentialId: "c", computerId: COMPUTER, installationId: randomUUID() }),
          },
          service: failing as unknown as RuntimeWebService,
        },
      });
      const response = await failingApp.inject({
        method: "POST",
        url: RUNTIME_WEB_SEARCH_PATH,
        headers: { authorization: "Bearer otmc_test" },
        payload: { protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
    }
  });

  it("bounds the request body at 16 KiB", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: RUNTIME_WEB_SEARCH_PATH,
      headers: { authorization: "Bearer otmc_test", "content-type": "application/json" },
      payload: `{"protocolVersion":1,"executionId":"${EXECUTION}","toolCallId":"${TOOL_CALL}","query":"${"x".repeat(16 * 1024)}"}`,
    });
    expect([400, 413]).toContain(response.statusCode);
  });
});

/**
 * Real TCP acceptance for the ingress budget. `inject()` cannot prove response-side disconnect
 * observation or that a blocked auth/body phase is actually aborted by the deadline.
 */
describe("runtime web routes over real TCP", () => {
  it("cancels an in-flight web call when the caller disconnects", async () => {
    let entered: () => void = () => undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    let finished = false;
    const { app } = createTestApp({
      search: async (input) => {
        const signal = input.signal as AbortSignal;
        entered();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        if (!signal.aborted) finished = true;
        return searchResult;
      },
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const body = searchBody();
      const request = httpRequest(`${origin}${RUNTIME_WEB_SEARCH_PATH}`, {
        method: "POST",
        headers: {
          authorization: "Bearer otmc_test",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      });
      request.on("error", () => undefined);
      request.end(body);
      await enteredPromise;
      request.destroy();
      await sleep(200);
      expect(aborted).toBe(true);
      expect(finished).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("does not restart the budget after a blocked authentication wait", async () => {
    const { app, search } = createTestApp({
      verify: async () => {
        await sleep(400);
        return { credentialId: "cred", computerId: COMPUTER, installationId: randomUUID() };
      },
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const startedAt = Date.now();
      const response = await fetch(`${origin}${RUNTIME_WEB_SEARCH_PATH}`, {
        method: "POST",
        headers: {
          authorization: "Bearer otmc_test",
          "content-type": "application/json",
          "x-web-timeout-ms": "100",
        },
        body: searchBody(),
      });
      expect(response.status).toBe(504);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("timeout");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(search).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("times out an unfinished request body without waiting for the rest", async () => {
    const { app, search } = createTestApp();
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const seen = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(`${origin}${RUNTIME_WEB_SEARCH_PATH}`, {
          method: "POST",
          headers: {
            authorization: "Bearer otmc_test",
            "content-type": "application/json",
            "content-length": 10_000,
            "x-web-timeout-ms": "100",
          },
        });
        request.on("response", (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        });
        request.on("error", reject);
        // Send only a prefix of the declared body and never finish it.
        request.write("{");
      });
      expect(seen.status).toBe(504);
      expect((JSON.parse(seen.body) as { error: { code: string } }).error.code).toBe("timeout");
      expect(search).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
