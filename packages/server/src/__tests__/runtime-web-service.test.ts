import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type {
  RuntimeExecutionAuthority,
  RuntimeExecutionRevalidation,
} from "../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import type { RuntimeScopeResolverPort, RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import type { RuntimeExecutionRecord } from "../runtime-credentials/types.js";
import { RuntimeWebError, RuntimeWebExecutionAuthorizer } from "../runtime-credentials/web-execution.js";
import { ConfigRuntimeWebPolicy } from "../runtime-credentials/web-policy.js";
import type { RouterWebClient } from "../runtime-credentials/web-router-client.js";
import { RuntimeWebService } from "../runtime-credentials/web-service.js";

const ACCOUNT = "00000000-0000-4000-8000-0000000000e1";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const INSTANCE = "00000000-0000-4000-8000-00000000001c";
const CONNECTION = "00000000-0000-4000-8000-0000000000cc";
const SESSION = "00000000-0000-4000-8000-000000000051";
const TOOL_CALL = "00000000-0000-4000-8000-00000000007c";

class FakeScopeResolver implements RuntimeScopeResolverPort {
  snapshot: RuntimeScopeSnapshot | undefined = sessionSnapshot();
  violation: ReturnType<RuntimeScopeResolverPort["assertExecutionFence"]> = undefined;
  loads = 0;

  load(): Promise<RuntimeScopeSnapshot | undefined> {
    this.loads += 1;
    return Promise.resolve(this.snapshot);
  }

  assertExecutionFence(): ReturnType<RuntimeScopeResolverPort["assertExecutionFence"]> {
    return this.violation;
  }
}

class FakeAuthority implements RuntimeExecutionAuthority {
  revalidateResult: RuntimeExecutionRevalidation = "valid";
  authorize = vi.fn(async () => ({ status: "authorized" as const }));
  revalidate = vi.fn(async (): Promise<RuntimeExecutionRevalidation> => this.revalidateResult);
}

function sessionSnapshot(): RuntimeScopeSnapshot {
  return {
    sessionId: SESSION,
    sessionKind: "channel",
    sessionEnded: false,
    channelId: "C-channel",
    threadKey: null,
    binding: {
      id: "00000000-0000-4000-8000-0000000000b1",
      agentId: AGENT,
      provider: "feishu",
      status: "active",
      credentialGeneration: 1,
      externalAppId: "app",
      externalTeamId: "team",
      externalTeamBrand: null,
      externalBotId: null,
      slackInstallationId: null,
    },
    slackInstallation: null,
    agent: { id: AGENT, status: "active", revision: 4, computerId: COMPUTER, createdByUserId: ACCOUNT },
    placement: { computerId: COMPUTER, generation: 2 },
    computer: { id: COMPUTER, kind: "local", ownerAccountId: ACCOUNT },
    sandbox: null,
  };
}

interface Harness {
  registry: RuntimeExecutionRegistry;
  resolver: FakeScopeResolver;
  authority: FakeAuthority;
  router: {
    search: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
  };
  policy: ConfigRuntimeWebPolicy;
  service: RuntimeWebService;
  authorizer: RuntimeWebExecutionAuthorizer;
  fence: { current: boolean; identity: RuntimeControlIdentity | undefined };
  cloudActive: boolean;
  record: RuntimeExecutionRecord;
}

function createHarness(
  options: { services?: ("web:search" | "web:fetch")[]; computerKind?: "local" | "cloud" } = {},
): Harness {
  const registry = new RuntimeExecutionRegistry();
  const resolver = new FakeScopeResolver();
  const authority = new FakeAuthority();
  const fence = {
    current: true,
    identity: {
      credentialId: "cred-1",
      computerId: COMPUTER,
      installationId: "00000000-0000-4000-8000-00000000001e",
      kind: "cloud" as const,
    },
  };
  const harness: Harness = {} as Harness;
  const cloudState = { active: true };
  const record = registry.open({
    runId: randomUUID(),
    accountId: ACCOUNT,
    agentId: AGENT,
    agentRevision: 4,
    sessionId: SESSION,
    computerId: COMPUTER,
    instanceId: INSTANCE,
    connectionId: CONNECTION,
    placementGeneration: 2,
    source: { kind: "delivery", deliveryId: "delivery-1", turnId: randomUUID() },
    purpose: "execution",
    computerKind: options.computerKind ?? "local",
    providers: new Map(),
    ...(options.services ? { services: [{ service: "web" as const, scopes: options.services }] } : {}),
  });
  const router = {
    search: vi.fn(async () => ({
      requestId: "router-req-1",
      status: "ok" as const,
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "basic" as const,
      results: [],
    })),
    fetch: vi.fn(async () => ({
      requestId: "router-req-2",
      status: "ok" as const,
      retrievedAt: "2026-09-17T00:00:00Z",
      effectiveDepth: "basic" as const,
      results: [],
    })),
  };
  const policy = new ConfigRuntimeWebPolicy({
    tenants: new Map([[ACCOUNT, { tenantId: "internal-test", routerKey: "tvly-test-key" }]]),
  });
  const authorizer = new RuntimeWebExecutionAuthorizer({
    executions: registry,
    scopeResolver: resolver,
    authority,
    connectionFence: {
      isCurrent: () => fence.current,
      currentControlIdentity: () => fence.identity,
    },
    cloudControlActive: async () => cloudState.active,
  });
  const service = new RuntimeWebService({
    authorizer,
    policy,
    router: router as unknown as RouterWebClient,
    executions: registry,
  });
  Object.assign(harness, {
    registry,
    resolver,
    authority,
    router,
    policy,
    service,
    authorizer,
    fence,
    record,
  });
  Object.defineProperty(harness, "cloudActive", {
    get: () => cloudState.active,
    set: (value: boolean) => {
      cloudState.active = value;
    },
  });
  return harness;
}

function searchRequest() {
  return {
    protocolVersion: 1 as const,
    executionId: "",
    toolCallId: TOOL_CALL,
    query: "opentag router",
    limit: 5,
    depth: "basic" as const,
  };
}

describe("RuntimeWebService", () => {
  it("dispatches a fenced search with stable derived idempotency and business-only params", async () => {
    const harness = createHarness({ services: ["web:search", "web:fetch"] });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    const result = await harness.service.search({ computerId: COMPUTER, request });
    expect(result.status).toBe("ok");
    const dispatch = harness.router.search.mock.calls[0]?.[0];
    expect(dispatch.idempotencyKey).toBe(`opentag.web.v1:${harness.record.executionId}:${TOOL_CALL}`);
    expect(dispatch.routerKey).toBe("tvly-test-key");
    expect(dispatch.remainingMs).toBeGreaterThan(0);
    expect(dispatch.remainingMs).toBeLessThanOrEqual(15_000);
    // The Router body carries business parameters only: no identity, tenant, or key material.
    expect(dispatch.params).toEqual({ query: "opentag router", limit: 5, depth: "basic" });
    // Fence ran before dispatch and again before delivery.
    expect(harness.resolver.loads).toBe(2);
  });

  it("reuses the same idempotency key across retransmits of one tool call", async () => {
    const harness = createHarness({ services: ["web:search"] });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    await harness.service.search({ computerId: COMPUTER, request });
    await harness.service.search({ computerId: COMPUTER, request });
    const keys = harness.router.search.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("refuses when the Account has no tenant mapping (no shared default tenant)", async () => {
    const harness = createHarness({ services: ["web:search"] });
    harness.policy = new ConfigRuntimeWebPolicy({ tenants: new Map() });
    harness.service = new RuntimeWebService({
      authorizer: harness.authorizer,
      policy: harness.policy,
      router: harness.router as unknown as RouterWebClient,
      executions: harness.registry,
    });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "web_disabled",
    });
    expect(harness.router.search).not.toHaveBeenCalled();
  });

  it("refuses a missing or narrower service scope", async () => {
    const harness = createHarness({ services: ["web:fetch"] });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "credential_scope_denied",
    });
    const noServices = createHarness();
    await expect(
      noServices.service.search({
        computerId: COMPUTER,
        request: { ...searchRequest(), executionId: noServices.record.executionId },
      }),
    ).rejects.toMatchObject({ code: "credential_scope_denied" });
  });

  it("refuses foreign computers, closed executions, and stale generations", async () => {
    const harness = createHarness({ services: ["web:search"] });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    await expect(harness.service.search({ computerId: randomUUID(), request })).rejects.toMatchObject({
      code: "execution_unknown",
    });
    harness.registry.close(harness.record.executionId, "execution_closed");
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "execution_unknown",
    });

    const stale = createHarness({ services: ["web:search"] });
    stale.resolver.violation = "placement_stale";
    await expect(
      stale.service.search({
        computerId: COMPUTER,
        request: { ...searchRequest(), executionId: stale.record.executionId },
      }),
    ).rejects.toMatchObject({ code: "execution_closed" });

    const ownerChanged = createHarness({ services: ["web:search"] });
    ownerChanged.resolver.violation = "ownership_mismatch";
    await expect(
      ownerChanged.service.search({
        computerId: COMPUTER,
        request: { ...searchRequest(), executionId: ownerChanged.record.executionId },
      }),
    ).rejects.toMatchObject({ code: "credential_scope_denied" });
  });

  it("refuses when the control connection was replaced or the admission source released", async () => {
    const harness = createHarness({ services: ["web:search"] });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    harness.fence.current = false;
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "execution_closed",
    });
    harness.fence.current = true;
    harness.authority.revalidateResult = "invalid";
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "execution_closed",
    });
    harness.authority.revalidateResult = "not_ready";
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "execution_unknown",
    });
  });

  it("requires a live Cloud control credential for Cloud executions", async () => {
    const harness = createHarness({ services: ["web:search"], computerKind: "cloud" });
    harness.resolver.snapshot = {
      ...sessionSnapshot(),
      computer: { id: COMPUTER, kind: "cloud", ownerAccountId: ACCOUNT },
      sandbox: { id: randomUUID(), resourceUid: "res-1", environmentGeneration: 3, lifecycle: "ready" },
    };
    harness.resolver.violation = undefined;
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    harness.cloudActive = false;
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "execution_closed",
    });
    harness.cloudActive = true;
    await harness.service.search({ computerId: COMPUTER, request });
    expect(harness.router.search).toHaveBeenCalledTimes(1);
  });

  it("does not deliver the result when the execution was revoked in flight", async () => {
    const harness = createHarness({ services: ["web:search"] });
    let calls = 0;
    harness.authorizer = new RuntimeWebExecutionAuthorizer({
      executions: harness.registry,
      scopeResolver: harness.resolver,
      authority: harness.authority,
      connectionFence: {
        isCurrent: () => {
          calls += 1;
          return calls === 1;
        },
        currentControlIdentity: () => undefined,
      },
    });
    harness.service = new RuntimeWebService({
      authorizer: harness.authorizer,
      policy: harness.policy,
      router: harness.router as unknown as RouterWebClient,
      executions: harness.registry,
    });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    await expect(harness.service.search({ computerId: COMPUTER, request })).rejects.toMatchObject({
      code: "execution_closed",
    });
    // Dispatch happened (outcome uncertainty is the Router's reconciliation domain), but the
    // result was never delivered past the second fence.
    expect(harness.router.search).toHaveBeenCalledTimes(1);
  });

  it("caps the remaining budget per operation and fails closed below the dispatch floor", async () => {
    const harness = createHarness({ services: ["web:search", "web:fetch"] });
    await harness.service.fetch({
      computerId: COMPUTER,
      request: {
        protocolVersion: 1,
        executionId: harness.record.executionId,
        toolCallId: TOOL_CALL,
        urls: ["https://example.com"],
        depth: "basic",
      },
      remainingMs: 999_999,
    });
    expect(harness.router.fetch.mock.calls[0]?.[0].remainingMs).toBeLessThanOrEqual(45_000);
    await expect(
      harness.service.search({
        computerId: COMPUTER,
        request: { ...searchRequest(), executionId: harness.record.executionId },
        remainingMs: 100,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("fails closed for every explicitly invalid budget instead of restarting a cap", async () => {
    const harness = createHarness({ services: ["web:search"] });
    const request = { ...searchRequest(), executionId: harness.record.executionId };
    for (const remainingMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(harness.service.search({ computerId: COMPUTER, request, remainingMs })).rejects.toMatchObject({
        code: "timeout",
      });
    }
    await expect(
      harness.service.search({ computerId: COMPUTER, request, deadlineAt: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(harness.router.search).not.toHaveBeenCalled();
  });

  it("aborts a blocked admission wait at the absolute deadline", async () => {
    const harness = createHarness({ services: ["web:search"] });
    harness.authority.revalidate.mockImplementation(() => new Promise<never>(() => undefined));
    const startedAt = Date.now();
    await expect(
      harness.service.search({
        computerId: COMPUTER,
        request: { ...searchRequest(), executionId: harness.record.executionId },
        deadlineAt: startedAt + 50,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(harness.router.search).not.toHaveBeenCalled();
  });

  it("cancels an in-flight dispatch when the execution is revoked", async () => {
    const harness = createHarness({ services: ["web:search"] });
    let entered: () => void = () => undefined;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    harness.router.search.mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          entered();
          input.signal?.addEventListener("abort", () => reject(new Error("dispatch aborted")), { once: true });
        }),
    );
    const pending = harness.service.search({
      computerId: COMPUTER,
      request: { ...searchRequest(), executionId: harness.record.executionId },
    });
    await dispatched;
    harness.registry.close(harness.record.executionId, "execution_closed");
    await expect(pending).rejects.toMatchObject({ code: "execution_closed" });
    // The dispatch started before the revocation but its result was never delivered.
    expect(harness.router.search).toHaveBeenCalledTimes(1);
    expect(harness.resolver.loads).toBe(1);
  });

  it("does not abort a successor dispatch when a stale execution closes", async () => {
    const harness = createHarness({ services: ["web:search"] });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.router.search.mockImplementation(async (input: { signal?: AbortSignal }) => {
      await blocked;
      if (input.signal?.aborted) throw new Error("unexpected abort");
      return {
        requestId: "router-req-1",
        status: "ok" as const,
        retrievedAt: "2026-09-17T00:00:00Z",
        effectiveDepth: "basic" as const,
        results: [],
      };
    });
    const pending = harness.service.search({
      computerId: COMPUTER,
      request: { ...searchRequest(), executionId: harness.record.executionId },
    });
    // A close for a different execution never cancels this dispatch.
    harness.registry.close("00000000-0000-4000-8000-0000000000ff", "execution_closed");
    release();
    await expect(pending).resolves.toMatchObject({ status: "ok" });
  });

  it("propagates aborts without dispatching", async () => {
    const harness = createHarness({ services: ["web:search"] });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      harness.service.search({
        computerId: COMPUTER,
        request: { ...searchRequest(), executionId: harness.record.executionId },
        signal: abort.signal,
      }),
    ).rejects.toBeTruthy();
    expect(harness.router.search).not.toHaveBeenCalled();
  });
});

describe("ConfigRuntimeWebPolicy", () => {
  it("grants scopes only for mapped Accounts", () => {
    const policy = new ConfigRuntimeWebPolicy({
      tenants: new Map([[ACCOUNT, { tenantId: "t", routerKey: "k" }]]),
    });
    expect(policy.authorizeWeb({ accountId: ACCOUNT })).toEqual(["web:search", "web:fetch"]);
    expect(policy.authorizeWeb({ accountId: randomUUID() })).toBeUndefined();
    expect(policy.resolveTenant({ accountId: ACCOUNT })).toEqual({ tenantId: "t", routerKey: "k" });
    expect(policy.resolveTenant({ accountId: randomUUID() })).toBeUndefined();
  });
});

describe("RuntimeWebError", () => {
  it("keeps bounded code and message", () => {
    const error = new RuntimeWebError("timeout", "timed out", { retryable: true });
    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });
});
