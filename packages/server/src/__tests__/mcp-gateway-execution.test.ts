import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type {
  RuntimeExecutionAuthority,
  RuntimeExecutionRevalidation,
} from "../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import { McpGatewayError, McpGatewayExecutionAuthorizer } from "../runtime-credentials/mcp-gateway-execution.js";
import type { RuntimeScopeResolverPort, RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import type { RuntimeExecutionPurpose } from "../runtime-credentials/types.js";

/**
 * The gateway's security boundary.
 *
 * The bearer proves only which execution is calling; everything that decides *whose* MCP Servers are
 * in reach comes from here. Each case below is a way an execution stops being entitled mid-turn —
 * the Session ends, the connection is replaced, the Agent is suspended, the Cloud credential lapses
 * — and each must stop the very next request, not the next turn.
 */

const ACCOUNT = "00000000-0000-4000-8000-0000000000e1";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const INSTANCE = "00000000-0000-4000-8000-00000000001c";
const CONNECTION = "00000000-0000-4000-8000-0000000000cc";
const SESSION = "00000000-0000-4000-8000-000000000051";

class FakeScopeResolver implements RuntimeScopeResolverPort {
  snapshot: RuntimeScopeSnapshot | undefined = sessionSnapshot();
  violation: ReturnType<RuntimeScopeResolverPort["assertExecutionFence"]> = undefined;

  load(): Promise<RuntimeScopeSnapshot | undefined> {
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

function createHarness(
  options: { granted?: boolean; purpose?: RuntimeExecutionPurpose; computerKind?: "local" | "cloud" } = {},
) {
  const registry = new RuntimeExecutionRegistry();
  const resolver = new FakeScopeResolver();
  const authority = new FakeAuthority();
  const fence: { current: boolean; identity: RuntimeControlIdentity | undefined } = {
    current: true,
    identity: {
      credentialId: "cred-1",
      computerId: COMPUTER,
      installationId: "00000000-0000-4000-8000-00000000001e",
      kind: "cloud",
    },
  };
  const cloud = { active: true };
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
    purpose: options.purpose ?? "execution",
    computerKind: options.computerKind ?? "local",
    providers: new Map(),
    ...((options.granted ?? true) ? { services: [{ service: "mcp" as const, scopes: ["mcp:tools" as const] }] } : {}),
  });
  const authorizer = new McpGatewayExecutionAuthorizer({
    executions: registry,
    scopeResolver: resolver,
    authority,
    connectionFence: {
      isCurrent: () => fence.current,
      currentControlIdentity: () => fence.identity,
    },
    cloudControlActive: async () => cloud.active,
  });
  return { registry, resolver, authority, fence, cloud, record, authorizer };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpGatewayError) return error.code;
    throw error;
  }
  throw new Error("Expected the fence to refuse");
}

describe("the happy path", () => {
  it("authorizes a live execution and yields the identity the gateway acts as", async () => {
    const harness = createHarness();
    const execution = await harness.authorizer.authorize({ executionId: harness.record.executionId });
    // The Account and Agent come from the record, never from the caller.
    expect(execution.accountId).toBe(ACCOUNT);
    expect(execution.agentId).toBe(AGENT);
  });

  it("re-checks on every call rather than trusting the first verdict", async () => {
    const harness = createHarness();
    await harness.authorizer.authorize({ executionId: harness.record.executionId });
    harness.fence.current = false;
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });
});

describe("what the fence refuses", () => {
  it("refuses an execution it does not know", async () => {
    const harness = createHarness();
    expect(await codeOf(harness.authorizer.authorize({ executionId: randomUUID() }))).toBe("execution_unknown");
  });

  it("refuses a closed execution", async () => {
    const harness = createHarness();
    harness.registry.close(harness.record.executionId, "execution_closed");
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_unknown",
    );
  });

  /* A validation run carries read-only identity scope and must never reach a tool. */
  it("refuses a validation-purpose execution", async () => {
    const harness = createHarness({ purpose: "validation" });
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });

  it("refuses an execution that was never granted the MCP service", async () => {
    const harness = createHarness({ granted: false });
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "scope_denied",
    );
  });

  it("refuses once the control connection has been replaced", async () => {
    const harness = createHarness();
    harness.fence.current = false;
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });

  it("refuses when the admission source was released", async () => {
    const harness = createHarness();
    harness.authority.revalidateResult = "invalid";
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });

  it("refuses while the admission source is not ready", async () => {
    const harness = createHarness();
    harness.authority.revalidateResult = "not_ready";
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_unknown",
    );
  });

  it("refuses when the Session snapshot has disappeared", async () => {
    const harness = createHarness();
    harness.resolver.snapshot = undefined;
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_unknown",
    );
  });

  it("honours an already-aborted caller before doing any work", async () => {
    const harness = createHarness();
    const aborted = AbortSignal.abort();
    await expect(
      harness.authorizer.authorize({ executionId: harness.record.executionId, signal: aborted }),
    ).rejects.toThrow();
  });
});

describe("Session fence violations", () => {
  /*
   * The violation vocabulary belongs to the scope resolver; what matters here is that each one maps
   * to a code the route can turn into a status, and that none of them is silently admitted.
   */
  it.each([
    ["session_unknown", "execution_unknown"],
    ["session_ended", "execution_closed"],
    ["session_internal", "execution_closed"],
    ["binding_inactive", "execution_closed"],
    ["installation_inactive", "execution_closed"],
    ["ownership_mismatch", "execution_closed"],
    ["placement_stale", "execution_closed"],
    ["agent_mismatch", "execution_closed"],
    ["agent_inactive", "execution_closed"],
    ["agent_revision_changed", "execution_closed"],
    ["sandbox_mismatch", "execution_closed"],
  ] as const)("maps %s to %s", async (violation, expected) => {
    const harness = createHarness();
    harness.resolver.violation = violation as never;
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(expected);
  });
});

describe("Cloud executions", () => {
  it("authorizes a Cloud execution whose control credential is live", async () => {
    const harness = createHarness({ computerKind: "cloud" });
    await expect(harness.authorizer.authorize({ executionId: harness.record.executionId })).resolves.toMatchObject({
      agentId: AGENT,
    });
  });

  it("refuses a Cloud execution whose control connection was replaced", async () => {
    const harness = createHarness({ computerKind: "cloud" });
    harness.fence.identity = undefined;
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });

  it("refuses a Cloud execution whose identity names another Computer", async () => {
    const harness = createHarness({ computerKind: "cloud" });
    harness.fence.identity = { ...(harness.fence.identity as RuntimeControlIdentity), computerId: randomUUID() };
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });

  it("refuses a Cloud execution whose identity is not a Cloud one", async () => {
    const harness = createHarness({ computerKind: "cloud" });
    harness.fence.identity = { ...(harness.fence.identity as RuntimeControlIdentity), kind: "local" };
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });

  /* Fails closed: an unanswerable liveness check is a refusal, not an assumption. */
  it("refuses a Cloud execution whose control credential is no longer active", async () => {
    const harness = createHarness({ computerKind: "cloud" });
    harness.cloud.active = false;
    expect(await codeOf(harness.authorizer.authorize({ executionId: harness.record.executionId }))).toBe(
      "execution_closed",
    );
  });
});
