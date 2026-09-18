import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { RUNTIME_WEB_FETCH_PATH, RUNTIME_WEB_SEARCH_PATH } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { RuntimeWebError } from "../runtime-credentials/web-execution.js";
import type { RuntimeWebService } from "../runtime-credentials/web-service.js";
import type { ComputerAuthContext } from "../services/computers/index.js";

const COMPUTER = randomUUID();
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
  const machineAuth = {
    verifyMachineToken:
      overrides.verify ?? (async () => ({ credentialId: "cred", computerId: COMPUTER, installationId: randomUUID() })),
  };
  const app = createApp({
    runtimeWeb: {
      machineAuth,
      service: { search, fetch } as unknown as RuntimeWebService,
    },
  });
  return { app, search, fetch };
}

function searchBody(): string {
  return JSON.stringify({ protocolVersion: 1, executionId: EXECUTION, toolCallId: TOOL_CALL, query: "q" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runtime web routes", () => {
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
