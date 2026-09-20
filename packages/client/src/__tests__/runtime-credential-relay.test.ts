import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeBusinessFrame, RuntimeConnectionState } from "../runtime/runtime-connection.js";
import { RuntimeCredentialEnvironmentManager } from "../runtime/runtime-credential-environment-manager.js";
import { runtimeProxyErrorReason } from "../runtime/runtime-credential-frames.js";
import {
  RuntimeCredentialRelay,
  RuntimeCredentialRelayError,
  type RuntimeProxyDataConnectInput,
  type RuntimeProxyDataConnectionLike,
  type RuntimeRelayScheduleHandle,
  type RuntimeRelayScheduler,
} from "../runtime/runtime-credential-relay.js";
import type { RuntimeProxyStreamResponse } from "../runtime/runtime-proxy-data-client.js";
import {
  buildRuntimeProxyEnvironment,
  providerRoutingEnvironment,
  RUNTIME_PROXY_PROVIDER_CA_KEY,
  RUNTIME_PROXY_PROVIDER_URL_KEY,
  RuntimeProxyMaterialStore,
  renderRuntimeProxyGitCredentialHelper,
  renderRuntimeProxyShim,
} from "../runtime/runtime-proxy-material.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const CAPABILITY_1 = "c".repeat(43);
const CAPABILITY_2 = "d".repeat(43);
const TICKET = "t".repeat(43);
const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_IDS: Record<"github" | "slack" | "feishu", string> = {
  github: "22222222-2222-4222-8222-222222222222",
  slack: "33333333-3333-4333-8333-333333333333",
  feishu: "44444444-4444-4444-8444-444444444444",
};

/** Virtual clock + scheduler so renewal/retry windows are deterministic. */
class ManualScheduler implements RuntimeRelayScheduler {
  #now = 1_700_000_000_000;
  #tasks: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];

  get now(): number {
    return this.#now;
  }

  schedule(delayMs: number, callback: () => void): RuntimeRelayScheduleHandle {
    const task = { at: this.#now + Math.max(0, delayMs), callback, cancelled: false };
    this.#tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  }

  /** Run every task due within `milliseconds`, in time order. */
  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      const due = this.#tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.#now = due.at;
      this.#tasks = this.#tasks.filter((task) => task !== due);
      due.callback();
    }
    this.#now = target;
  }
}

class FakeControlConnection {
  readonly requests: Array<Record<string, unknown>> = [];
  #business = new Set<(frame: RuntimeBusinessFrame) => void>();
  #states = new Set<(state: RuntimeConnectionState) => void>();
  #respond: (frame: RuntimeBusinessFrame) => unknown | undefined;
  readonly #capabilities: Record<string, number>;

  constructor(options: {
    capabilities?: Record<string, number>;
    respond: (frame: RuntimeBusinessFrame) => unknown | undefined;
  }) {
    this.#respond = options.respond;
    this.#capabilities = options.capabilities ?? { "runtime.runtimeCredential": 1, "runtime.providerProxy": 1 };
  }

  setResponder(responder: (frame: RuntimeBusinessFrame) => unknown | undefined): void {
    this.#respond = responder;
  }

  capabilityVersion(capability: string): number | undefined {
    return this.#capabilities[capability];
  }

  async send(frame: RuntimeBusinessFrame): Promise<void> {
    this.requests.push({ ...frame });
    const response = this.#respond(frame);
    if (response === undefined) return;
    const frames = Array.isArray(response) ? response : [response];
    queueMicrotask(() => {
      for (const next of frames) this.emit(next as RuntimeBusinessFrame);
    });
  }

  subscribeBusinessFrames(listener: (frame: RuntimeBusinessFrame) => void): () => void {
    this.#business.add(listener);
    return () => this.#business.delete(listener);
  }

  subscribeState(listener: (state: RuntimeConnectionState) => void): () => void {
    this.#states.add(listener);
    return () => this.#states.delete(listener);
  }

  emit(frame: RuntimeBusinessFrame): void {
    for (const listener of [...this.#business]) listener(frame);
  }

  setState(state: RuntimeConnectionState): void {
    for (const listener of [...this.#states]) listener(state);
  }
}

class FakeDataConnection implements RuntimeProxyDataConnectionLike {
  closed = false;
  closeCalls = 0;
  readonly openRequests: Array<Record<string, unknown>> = [];
  response: RuntimeProxyStreamResponse = {
    status: 200,
    headers: { "content-type": "text/plain" },
    body: (async function* () {
      yield new TextEncoder().encode("ok");
    })(),
  };
  #settle!: () => void;
  readonly #settled = new Promise<void>((resolve) => {
    this.#settle = resolve;
  });

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls += 1;
    this.#settle();
  }

  settled(): Promise<void> {
    return this.#settled;
  }

  async openStream(request: Record<string, unknown>): Promise<RuntimeProxyStreamResponse> {
    this.openRequests.push(request);
    return this.response;
  }
}

function succeededGrant(
  requestId: string,
  provider: "github" | "slack" | "feishu",
  bindingId: string,
  options: { now: number; refreshAfterMs?: number; expiresInMs?: number; token?: string },
): Record<string, unknown> {
  return {
    type: "runtime:credential:result",
    requestId,
    status: "succeeded",
    executionId: EXECUTION_ID,
    grantId: GRANT_IDS[provider],
    provider,
    bindingId,
    opaqueToken: options.token ?? CAPABILITY_1,
    expiresAt: new Date(options.now + (options.expiresInMs ?? 60_000)).toISOString(),
    refreshAfter: new Date(options.now + (options.refreshAfterMs ?? 30_000)).toISOString(),
    scopeHash: "a".repeat(64),
    authorizationRevision: "rev-1",
    credentialGeneration: "gen-1",
    cli:
      provider === "feishu"
        ? { provider: "feishu", appId: "cli-app", teamBrand: "feishu" }
        : provider === "slack"
          ? { provider: "slack", teamId: "T1", botUserId: "U1" }
          : { provider: "github", connectionId: "connection-1", repositories: [] },
  };
}

function cliMetadata(provider: "github" | "slack" | "feishu"): Record<string, unknown> {
  if (provider === "feishu") {
    return {
      provider: "feishu",
      appId: "cli-app",
      teamBrand: "feishu",
      outboxContext: { provider: "feishu", sessionKind: "channel", chatId: "oc_chat_1" },
    };
  }
  if (provider === "slack") return { provider: "slack", teamId: "T1", botUserId: "U1" };
  return { provider: "github", connectionId: "connection-1", repositories: [] };
}

function openResultFrame(
  requestId: unknown,
  providers: Array<"github" | "slack" | "feishu">,
  now: number,
): Record<string, unknown> {
  return {
    type: "runtime:execution:result",
    requestId,
    status: "succeeded",
    executionId: EXECUTION_ID,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    providers: providers.map((provider) => ({
      provider,
      bindingId: `binding-${provider}`,
      cli: cliMetadata(provider),
    })),
  };
}

function sequencedOpenResult(requestId: unknown, now: number, executionIds: string[]): Record<string, unknown> {
  const executionId = executionIds.length === 0 ? EXECUTION_ID : "99999999-9999-4999-8999-999999999999";
  executionIds.push(executionId);
  return {
    type: "runtime:execution:result",
    requestId,
    status: "succeeded",
    executionId,
    expiresAt: new Date(now + 3_600_000).toISOString(),
    providers: [{ provider: "github", bindingId: "binding-github", cli: cliMetadata("github") }],
  };
}

function acquireResultFrame(
  frame: RuntimeBusinessFrame,
  grants: Record<string, Record<string, unknown>> | undefined,
  now: number,
): Record<string, unknown> {
  const provider = frame.provider as "github" | "slack" | "feishu";
  const grant =
    grants?.[provider] ?? succeededGrant(frame.requestId as string, provider, frame.bindingId as string, { now });
  return { ...grant, requestId: frame.requestId };
}

function renewResultFrame(frame: RuntimeBusinessFrame, now: number): Record<string, unknown> {
  const provider = frame.grantId === GRANT_IDS.github ? "github" : "feishu";
  return succeededGrant(frame.requestId as string, provider, `binding-${provider}`, {
    now,
    token: CAPABILITY_2,
  });
}

function ticketResultFrame(requestId: unknown, now: number): Record<string, unknown> {
  return {
    type: "runtime:proxy:ticket:result",
    requestId,
    status: "succeeded",
    executionId: EXECUTION_ID,
    ticket: TICKET,
    expiresAt: new Date(now + 15_000).toISOString(),
    path: "/api/v1/runtime/provider-proxy",
  };
}

function closeResultFrame(requestId: unknown): Record<string, unknown> {
  return { type: "runtime:execution:closed", requestId, executionId: EXECUTION_ID, status: "succeeded" };
}

function relayHarness(options: {
  providers?: Array<"github" | "slack" | "feishu">;
  scheduler?: ManualScheduler;
  grants?: Record<string, Record<string, unknown>>;
  dataConnection?: FakeDataConnection;
  openResults?: Array<Record<string, unknown>>;
  openBudgetMs?: number;
}) {
  const scheduler = options.scheduler ?? new ManualScheduler();
  const providers = options.providers ?? ["feishu", "github"];
  const dataConnection = options.dataConnection ?? new FakeDataConnection();
  const dataInputs: RuntimeProxyDataConnectInput[] = [];
  const queuedOpenResults = options.openResults ? [...options.openResults] : undefined;
  const connection = new FakeControlConnection({
    respond(frame) {
      if (frame.type === "runtime:execution:open") {
        const queued = queuedOpenResults?.shift();
        if (queued) return { ...queued, requestId: frame.requestId };
        return openResultFrame(frame.requestId, providers, scheduler.now);
      }
      if (frame.type === "runtime:credential:acquire") {
        return acquireResultFrame(frame, options.grants, scheduler.now);
      }
      if (frame.type === "runtime:credential:renew") return renewResultFrame(frame, scheduler.now);
      if (frame.type === "runtime:proxy:ticket") return ticketResultFrame(frame.requestId, scheduler.now);
      if (frame.type === "runtime:execution:close") return closeResultFrame(frame.requestId);
      return undefined;
    },
  });
  return {
    connection,
    dataConnection,
    dataInputs,
    scheduler,
    relayOptions: {
      connection,
      dataConnectionFactory: async (input: RuntimeProxyDataConnectInput) => {
        dataInputs.push(input);
        return dataConnection;
      },
      jitter: () => 0,
      now: () => scheduler.now,
      openBudgetMs: options.openBudgetMs ?? 5_000,
      serverUrl: "https://runtime.example",
      scheduler,
    },
    subject: {
      agentId: "agent-1",
      placementGeneration: 1,
      runId: randomUUID(),
      sessionId: "session-1",
      source: { kind: "delivery" as const, deliveryId: "delivery-1", turnId: randomUUID() },
    },
  };
}

const tick = async (times = 3): Promise<void> => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

describe("RuntimeCredentialRelay", () => {
  it("opens an execution, acquires providers, and masks capabilities behind stable local handles", async () => {
    const harness = relayHarness({});
    const relay = await RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    try {
      expect(relay.executionId).toBe(EXECUTION_ID);
      expect(relay.providers.map((provider) => provider.provider)).toEqual(["feishu", "github"]);
      expect(harness.dataInputs).toEqual([
        expect.objectContaining({ executionId: EXECUTION_ID, ticket: TICKET, path: "/api/v1/runtime/provider-proxy" }),
      ]);

      const feishuHandle = relay.localHandleFor("feishu");
      const githubHandle = relay.localHandleFor("github");
      expect(feishuHandle).toMatch(/^otrh_[A-Za-z0-9_-]{22,}$/);
      expect(feishuHandle).not.toContain(CAPABILITY_1);
      expect(githubHandle).not.toBe(feishuHandle);
      expect(relay.verifyLocalHandle("feishu", feishuHandle)).toBe(true);
      expect(relay.verifyLocalHandle("feishu", `${feishuHandle}x`)).toBe(false);
      expect(relay.verifyLocalHandle("github", feishuHandle)).toBe(false);

      await relay.openProviderStream({ provider: "github", method: "GET", path: "/user", headers: {} });
      expect(harness.dataConnection.openRequests[0]).toMatchObject({
        capability: CAPABILITY_1,
        provider: "github",
        bindingId: "binding-github",
      });
      expect(harness.dataConnection.openRequests[0]).not.toHaveProperty("localHandle");
    } finally {
      await relay.close("test");
    }
  });

  it("renews at refreshAfter with a constant local handle while new streams use the newest capability", async () => {
    const harness = relayHarness({ providers: ["github"] });
    const relay = await RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    try {
      const handle = relay.localHandleFor("github");
      harness.scheduler.advance(30_000);
      await tick();
      expect(relay.localHandleFor("github")).toBe(handle);
      await relay.openProviderStream({ provider: "github", method: "GET", path: "/user", headers: {} });
      expect(harness.dataConnection.openRequests.at(-1)).toMatchObject({ capability: CAPABILITY_2 });
      const renewRequests = harness.connection.requests.filter((frame) => frame.type === "runtime:credential:renew");
      expect(renewRequests).toHaveLength(1);
      expect(renewRequests[0]).toMatchObject({ executionId: EXECUTION_ID, grantId: GRANT_IDS.github });
    } finally {
      await relay.close("test");
    }
  });

  it("retains the Session CLI proof from the open result only until the execution closes", async () => {
    const proof = { proofId: randomUUID(), token: "p".repeat(40) };
    const harness = relayHarness({
      providers: ["github"],
      openResults: [{ ...openResultFrame("placeholder", ["github"], Date.now()), sessionCliProof: proof }],
    });
    const relay = await RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    try {
      expect(relay.sessionCliProof).toEqual(proof);
    } finally {
      await relay.close("test");
    }
    expect(relay.sessionCliProof).toBeUndefined();
  });

  it("retries execution_not_ready until custody is accepted", async () => {
    const harness = relayHarness({
      providers: ["github"],
      openResults: [
        { type: "runtime:execution:result", status: "rejected", code: "execution_not_ready" },
        { type: "runtime:execution:result", status: "rejected", code: "execution_not_ready" },
      ],
    });
    const openPromise = RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    await tick();
    expect(harness.connection.requests.filter((frame) => frame.type === "runtime:execution:open")).toHaveLength(1);
    harness.scheduler.advance(250);
    await tick();
    harness.scheduler.advance(250);
    const relay = await openPromise;
    try {
      expect(harness.connection.requests.filter((frame) => frame.type === "runtime:execution:open")).toHaveLength(3);
      expect(relay.executionId).toBe(EXECUTION_ID);
    } finally {
      await relay.close("test");
    }
  });

  it("gives up after the bounded execution_not_ready budget", async () => {
    const harness = relayHarness({
      providers: ["github"],
      openBudgetMs: 1_000,
      openResults: [],
    });
    harness.connection.setResponder((frame) => {
      if (frame.type === "runtime:execution:open") {
        return {
          type: "runtime:execution:result",
          requestId: frame.requestId,
          status: "rejected",
          code: "execution_not_ready",
        };
      }
      return undefined;
    });
    const openPromise = RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    const rejection = expect(openPromise).rejects.toMatchObject({ code: "execution_not_ready" });
    await tick();
    harness.scheduler.advance(5_000);
    await rejection;
  });

  it("rejects a non-retryable open rejection immediately", async () => {
    const harness = relayHarness({
      openResults: [{ type: "runtime:execution:result", status: "rejected", code: "placement_stale" }],
    });
    await expect(RuntimeCredentialRelay.open(harness.relayOptions, harness.subject)).rejects.toMatchObject({
      name: "RuntimeCredentialRelayError",
      code: "execution_rejected",
      serverCode: "placement_stale",
    });
  });

  it("sends runtime:execution:close when released before reports", async () => {
    const harness = relayHarness({ providers: ["github"] });
    const relay = await RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    await relay.close("turn_finished");
    const closeRequests = harness.connection.requests.filter((frame) => frame.type === "runtime:execution:close");
    expect(closeRequests).toHaveLength(1);
    expect(closeRequests[0]).toMatchObject({ executionId: EXECUTION_ID });
    expect(harness.dataConnection.closeCalls).toBe(1);
    expect(relay.closed).toBe(true);
  });

  it("closes the execution on revocation and on control connection replacement", async () => {
    const harness = relayHarness({ providers: ["feishu"] });
    const relay = await RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    harness.connection.emit({ type: "runtime:credential:revoked", executionId: EXECUTION_ID, code: "owner_lost" });
    await tick();
    expect(relay.closed).toBe(true);
    expect(relay.signal.aborted).toBe(true);
    expect(harness.dataConnection.closeCalls).toBe(1);
    const revokedCloseRequests = harness.connection.requests.filter(
      (frame) => frame.type === "runtime:execution:close",
    );
    expect(revokedCloseRequests).toHaveLength(0);

    const second = relayHarness({ providers: ["feishu"] });
    const relayTwo = await RuntimeCredentialRelay.open(second.relayOptions, second.subject);
    second.connection.setState("stopped");
    await tick();
    expect(relayTwo.closed).toBe(true);
    expect(second.dataConnection.closeCalls).toBe(1);
  });

  it("fails streams when the grant expired without renewal instead of replaying", async () => {
    const harness = relayHarness({
      providers: ["github"],
      grants: {
        github: succeededGrant("placeholder", "github", "binding-github", {
          now: 1_700_000_000_000,
          expiresInMs: 10_000,
          refreshAfterMs: 60_000,
        }),
      },
    });
    const relay = await RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    try {
      harness.scheduler.advance(10_000);
      await expect(
        relay.openProviderStream({ provider: "github", method: "GET", path: "/user", headers: {} }),
      ).rejects.toMatchObject({ code: "capability_expired" });
    } finally {
      await relay.close("test");
    }
  });

  it("treats a non-retryable renewal rejection as a dead grant", async () => {
    const harness = relayHarness({ providers: ["github"] });
    const relay = await RuntimeCredentialRelay.open(harness.relayOptions, harness.subject);
    try {
      harness.connection.setResponder((frame) => {
        if (frame.type === "runtime:credential:renew") {
          return {
            type: "runtime:credential:result",
            requestId: frame.requestId,
            status: "rejected",
            code: "execution_closed",
          };
        }
        if (frame.type === "runtime:execution:close") {
          return {
            type: "runtime:execution:closed",
            requestId: frame.requestId,
            executionId: frame.executionId,
            status: "succeeded",
          };
        }
        return undefined;
      });
      harness.scheduler.advance(30_000);
      await tick();
      await expect(
        relay.openProviderStream({ provider: "github", method: "GET", path: "/user", headers: {} }),
      ).rejects.toBeInstanceOf(RuntimeCredentialRelayError);
    } finally {
      await relay.close("test");
    }
  });

  it("logs renewal failures without capability or ticket material", async () => {
    const entries: RecordedLog[] = [];
    const harness = relayHarness({
      providers: ["github"],
      grants: {
        github: succeededGrant("placeholder", "github", "binding-github", {
          now: 1_700_000_000_000,
          expiresInMs: 5_000,
          refreshAfterMs: 1_000,
        }),
      },
    });
    const relay = await RuntimeCredentialRelay.open(
      { ...harness.relayOptions, logger: recordingLogger(entries) },
      harness.subject,
    );
    try {
      harness.connection.setResponder((frame) => {
        if (frame.type === "runtime:credential:renew") {
          throw new Error(`renew failed with ${CAPABILITY_1} and ${TICKET}`);
        }
        if (frame.type === "runtime:execution:close") return closeResultFrame(frame.requestId);
        return undefined;
      });
      harness.scheduler.advance(1_000);
      await tick();
      const serialized = JSON.stringify(entries);
      expect(serialized).toContain("credential_renew_expired");
      expect(serialized).not.toContain(CAPABILITY_1);
      expect(serialized).not.toContain(TICKET);
    } finally {
      await relay.close("test");
    }
  });
});

describe("runtime proxy error reasons", () => {
  it("never renders exception messages, capabilities, tickets, or handles", () => {
    const secret = "otrh_capability_or_ticket_secret";
    expect(runtimeProxyErrorReason(new Error(`request failed with ${secret}`))).toBe("Error");
    expect(runtimeProxyErrorReason(Object.assign(new Error(secret), { code: "ECONNRESET" }))).toBe("Error:ECONNRESET");
    expect(runtimeProxyErrorReason(secret)).toBe("UnknownError");
    expect(runtimeProxyErrorReason({ code: secret })).toBe("Error");
    expect(runtimeProxyErrorReason(Object.assign(new Error(secret), { code: secret }))).toBe("Error");
    expect(runtimeProxyErrorReason(null)).toBe("UnknownError");
  });
});

describe("RuntimeCredentialEnvironmentManager", () => {
  it("delegates unchanged to the legacy environment manager in legacy mode", async () => {
    const preparedLegacy = { path: "/tmp/legacy.sh", provider: "slack" as const, slackConfigDir: "/tmp/cfg" };
    const calls: string[] = [];
    const legacy = {
      prepare: async () => {
        calls.push("prepare");
        return preparedLegacy;
      },
      cleanup: async () => {
        calls.push("cleanup");
      },
      close: async () => {
        calls.push("close");
      },
      pathForSession: () => "/tmp/legacy.sh",
      activeSlackConfigDirForSession: () => "/tmp/cfg",
    };
    const manager = new RuntimeCredentialEnvironmentManager({
      connection: relayHarness({}).connection,
      home: "/tmp/opentag-legacy-home",
      legacy: () => legacy as never,
      mode: "legacy",
    });
    const prepared = await manager.prepare({ sessionId: "s", agentId: "a", placementGeneration: 1 });
    expect(prepared.path).toBe("/tmp/legacy.sh");
    expect(prepared.providers).toEqual(["slack"]);
    await manager.cleanup("s");
    await manager.close();
    expect(calls).toEqual(["prepare", "cleanup", "close"]);
  });

  it("never falls back to raw materials when proxy negotiation is unavailable", async () => {
    const home = await temporaryHome();
    const noCapabilities = new FakeControlConnection({
      capabilities: { "runtime.runtimeCredential": 1 },
      respond: () => undefined,
    });
    const strict = new RuntimeCredentialEnvironmentManager({
      connection: noCapabilities,
      home,
      mode: "proxy",
      serverUrl: "https://runtime.example",
    });
    await expect(
      strict.prepare({
        sessionId: "session-1",
        agentId: "agent-1",
        placementGeneration: 1,
        run: { runId: randomUUID(), source: { kind: "session-message", messageId: randomUUID() } },
      }),
    ).rejects.toMatchObject({ name: "ImCredentialEnvironmentError", code: "proxy_negotiation_unavailable" });
    await strict.close();
  });

  it("materializes handles and loopback settings without capabilities, then cleans up exactly", async () => {
    const home = await temporaryHome();
    const harness = relayHarness({ providers: ["feishu", "github"] });
    const manager = new RuntimeCredentialEnvironmentManager({
      connection: harness.connection,
      dataConnectionFactory: harness.relayOptions.dataConnectionFactory,
      home,
      logger: { debug() {}, warn() {} },
      mode: "proxy",
      now: harness.relayOptions.now,
      platform: "linux",
      serverUrl: "https://runtime.example",
    });
    const prepared = await manager.prepare({
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      run: {
        runId: randomUUID(),
        source: { kind: "delivery", deliveryId: "delivery-1", turnId: randomUUID() },
      },
    });
    try {
      expect(prepared.executionId).toBe(EXECUTION_ID);
      expect(prepared.providers).toEqual(["feishu", "github"]);
      expect(prepared.provider).toBe("feishu");
      const environment = manager.environmentForSession("session-1") ?? {};
      const envFile = await readFile(prepared.path, "utf8");
      expect(environment.GH_TOKEN).toMatch(/^otrh_/);
      expect(envFile).toContain(environment.GH_TOKEN as string);
      expect(envFile).toContain("# opentag-execution: ");
      expect(envFile).not.toContain(CAPABILITY_1);
      expect(envFile).not.toContain("export GITHUB_TOKEN=");
      expect(environment).not.toHaveProperty("GH_REPO");
      // The Agent runtime env stays scoped: only the standard provider CLI variables may turn
      // these routing inputs into a proxy/CA, and the sourced env file does exactly that.
      expect(environment[RUNTIME_PROXY_PROVIDER_URL_KEY]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(environment[RUNTIME_PROXY_PROVIDER_CA_KEY]).toContain("loopback-ca.pem");
      for (const key of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE"]) {
        expect(environment).not.toHaveProperty(key);
      }
      expect(envFile).toContain(`export HTTPS_PROXY='${environment[RUNTIME_PROXY_PROVIDER_URL_KEY]}'`);
      expect(envFile).toContain(`export SSL_CERT_FILE='${environment[RUNTIME_PROXY_PROVIDER_CA_KEY]}'`);
      expect(environment.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toMatch(/^otrh_/);
      expect(manager.shimDirForSession("session-1")).toContain("bin");
      expect(manager.executionIdForSession("session-1")).toBe(EXECUTION_ID);
    } finally {
      await manager.cleanup("session-1", prepared.executionId);
    }
    await expect(stat(prepared.path)).rejects.toMatchObject({ code: "ENOENT" });
    await manager.close();
  });

  it("opens a validation-scoped execution with the Server-issued validationRunId and releases it", async () => {
    const home = await temporaryHome();
    const harness = relayHarness({ providers: ["slack"] });
    const manager = new RuntimeCredentialEnvironmentManager({
      connection: harness.connection,
      dataConnectionFactory: harness.relayOptions.dataConnectionFactory,
      home,
      logger: { debug() {}, warn() {} },
      mode: "proxy",
      now: harness.relayOptions.now,
      platform: "linux",
      serverUrl: "https://runtime.example",
    });
    const validationRunId = "77777777-7777-4777-8777-777777777777";
    const session = await manager.prepareValidationSession({
      agentId: "agent-1",
      placementGeneration: 1,
      validationRunId,
    });
    try {
      const openRequest = harness.connection.requests.find((frame) => frame.type === "runtime:execution:open");
      expect(openRequest).toMatchObject({
        runId: validationRunId,
        source: { kind: "validation", validationRunId },
        sessionId: `validation:${validationRunId}`,
      });
      expect(session.environment.SLACK_BOT_TOKEN).toMatch(/^otrh_/);
      expect(session.arguments).toEqual(["--apihost", expect.stringMatching(/^https:\/\/127\.0\.0\.1:\d+$/)]);
      expect(JSON.stringify(session.environment)).not.toContain(CAPABILITY_1);
    } finally {
      await session.cleanup();
    }
    // Released before the caller reports, and the validation material is gone.
    const closeRequests = harness.connection.requests.filter((frame) => frame.type === "runtime:execution:close");
    expect(closeRequests).toHaveLength(1);
    await manager.close();
  });

  it("scopes cleanup to the exact execution so a stale cleanup cannot delete successor material", async () => {
    const home = await temporaryHome();
    const scheduler = new ManualScheduler();
    const first = relayHarness({ providers: ["github"], scheduler });
    const executionIds: string[] = [];
    first.connection.setResponder((frame) => {
      if (frame.type === "runtime:execution:open")
        return sequencedOpenResult(frame.requestId, scheduler.now, executionIds);
      if (frame.type === "runtime:credential:acquire") {
        return {
          ...succeededGrant(frame.requestId as string, "github", "binding-github", { now: scheduler.now }),
          executionId: executionIds.at(-1),
        };
      }
      if (frame.type === "runtime:proxy:ticket") {
        return {
          type: "runtime:proxy:ticket:result",
          requestId: frame.requestId,
          status: "succeeded",
          executionId: executionIds.at(-1),
          ticket: TICKET,
          expiresAt: new Date(scheduler.now + 15_000).toISOString(),
          path: "/api/v1/runtime/provider-proxy",
        };
      }
      if (frame.type === "runtime:execution:close") {
        return {
          type: "runtime:execution:closed",
          requestId: frame.requestId,
          executionId: frame.executionId,
          status: "succeeded",
        };
      }
      return undefined;
    });
    const manager = new RuntimeCredentialEnvironmentManager({
      connection: first.connection,
      dataConnectionFactory: first.relayOptions.dataConnectionFactory,
      home,
      logger: { debug() {}, warn() {} },
      mode: "proxy",
      now: first.relayOptions.now,
      platform: "linux",
      serverUrl: "https://runtime.example",
    });
    const subject = {
      sessionId: "session-1",
      agentId: "agent-1",
      placementGeneration: 1,
      run: { runId: randomUUID(), source: { kind: "delivery" as const, deliveryId: "d", turnId: randomUUID() } },
    };
    const firstPrepared = await manager.prepare(subject);
    expect(firstPrepared.executionId).toBe(EXECUTION_ID);
    const secondPrepared = await manager.prepare(subject);
    expect(secondPrepared.executionId).toBe("99999999-9999-4999-8999-999999999999");

    // A stale cleanup for the replaced execution must leave the successor material alone.
    await manager.cleanup("session-1", EXECUTION_ID);
    const successorEnv = await readFile(secondPrepared.path, "utf8");
    expect(successorEnv).toContain("otrh_");
    expect(manager.executionIdForSession("session-1")).toBe(secondPrepared.executionId);

    await manager.cleanup("session-1", secondPrepared.executionId);
    await expect(stat(secondPrepared.path)).rejects.toMatchObject({ code: "ENOENT" });
    await manager.close();
  });
});

describe("runtime proxy material", () => {
  it("builds an execution environment with handles and CA only", () => {
    const environment = buildRuntimeProxyEnvironment({
      adapterCaCertPath: "/exec/loopback-ca.pem",
      cliMetadata: (provider) => {
        if (provider === "feishu") return { provider: "feishu", appId: "cli-app", teamBrand: "feishu" };
        return {
          provider: "github",
          connectionId: "connection",
          repositories: [
            {
              repositoryId: "1",
              fullName: "owner/repository",
              role: "context_tree",
              access: "write",
              publish: "pull_request",
              branch: "refs/heads/master",
              workBranchPrefix: "refs/heads/opentag/11111111-1111-4111-8111-111111111111/context_tree/",
            },
          ],
        };
      },
      connectProxyUrl: "http://127.0.0.1:1234",
      handles: new Map([
        ["github", "otrh_github"],
        ["feishu", "otrh_feishu"],
        ["slack", "otrh_slack"],
      ]),
      layout: {
        adapterCaCertPath: "/exec/loopback-ca.pem",
        executionDir: "/exec",
        gitConfigPath: "/exec/gitconfig",
        gitCredentialHelperPath: "/exec/git-credential-helper.sh",
        larkConfigDir: "/exec/lark-config",
        slackConfigDir: "/exec/slack-config",
      },
      slackApiHost: "https://127.0.0.1:5678",
    });
    expect(environment.GH_TOKEN).toBe("otrh_github");
    expect(JSON.parse(environment.OPENTAG_GITHUB_REPOSITORIES ?? "[]")).toEqual([
      expect.objectContaining({
        fullName: "owner/repository",
        branch: "refs/heads/master",
        publish: "pull_request",
        workBranchPrefix: expect.stringContaining("/context_tree/"),
      }),
    ]);
    expect(environment.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("otrh_feishu");
    expect(environment.SLACK_BOT_TOKEN).toBe("otrh_slack");
    expect(environment[RUNTIME_PROXY_PROVIDER_URL_KEY]).toBe("http://127.0.0.1:1234");
    expect(environment[RUNTIME_PROXY_PROVIDER_CA_KEY]).toBe("/exec/loopback-ca.pem");
    // Ordinary Agent subprocesses must not inherit a global proxy or the execution CA.
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("NO_PROXY");
    expect(environment).not.toHaveProperty("SSL_CERT_FILE");
    expect(environment).not.toHaveProperty("GIT_SSL_CAINFO");
    expect(providerRoutingEnvironment(environment)).toEqual({
      CURL_CA_BUNDLE: "/exec/loopback-ca.pem",
      HTTPS_PROXY: "http://127.0.0.1:1234",
      NO_PROXY: "127.0.0.1,localhost",
      SSL_CERT_FILE: "/exec/loopback-ca.pem",
      https_proxy: "http://127.0.0.1:1234",
      no_proxy: "127.0.0.1,localhost",
    });
    expect(providerRoutingEnvironment({ GH_TOKEN: "otrh_only" })).toEqual({});
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.LARKSUITE_CLI_APP_SECRET).toBeUndefined();
    expect(environment.SSH_AUTH_SOCK).toBeUndefined();
    expect(JSON.stringify(environment)).not.toMatch(/GH_REPO|x-access-token|capability|Bearer /);
  });

  it("renders a git credential helper that answers only github.com with the handle", async () => {
    const home = await temporaryHome();
    const helperPath = join(home, "helper.sh");
    await writeFile(helperPath, renderRuntimeProxyGitCredentialHelper("otrh_handle"), "utf8");
    await chmod(helperPath, 0o700);
    const github = await runWithInput("sh", [helperPath, "get"], "protocol=https\nhost=github.com\n\n");
    expect(github.stdout).toBe("username=x-access-token\npassword=otrh_handle\n");
    const other = await runWithInput("sh", [helperPath, "get"], "protocol=https\nhost=example.com\n\n");
    expect(other.stdout).toBe("");
  });

  it("renders a PATH shim that preserves argv, cwd, stdin, and exit status", async () => {
    const home = await temporaryHome();
    const binDir = join(home, "real-bin");
    const shimDir = join(home, "shims");
    await mkdir(binDir, { recursive: true });
    await mkdir(shimDir, { recursive: true });
    await chmod(binDir, 0o700);
    await writeFile(
      join(binDir, "git"),
      '#!/bin/sh\nprintf "cwd=%s args=%s stdin=%s\\n" "$PWD" "$*" "$(cat)"\nexit 7\n',
      "utf8",
    );
    await chmod(join(binDir, "git"), 0o700);
    const envFile = join(home, "current.sh");
    await writeFile(envFile, "export OPENTAG_TEST_VALUE=loaded\n", "utf8");
    await writeFile(join(shimDir, "git"), renderRuntimeProxyShim("git", envFile), "utf8");
    await chmod(join(shimDir, "git"), 0o700);
    const result = await runWithInput(join(shimDir, "git"), ["status", "--short"], "payload", {
      cwd: binDir,
      env: { ...process.env, PATH: `${shimDir}:${binDir}:/usr/bin:/bin` },
    });
    expect(result.code).toBe(7);
    expect(result.stdout).toContain(`cwd=${await realpath(binDir)}`);
    expect(result.stdout).toContain("args=status --short");
    expect(result.stdout).toContain("stdin=payload");
  });

  it("cleans stale managed Session directories without touching foreign entries", async () => {
    const home = await temporaryHome();
    const store = new RuntimeProxyMaterialStore({ home });
    const sessionId = "55555555-5555-4555-8555-555555555555";
    await store.publish({
      adapterCaCertPath: join(home, "ca.pem"),
      environment: { GH_TOKEN: "otrh_x" },
      executionId: EXECUTION_ID,
      handles: new Map(),
      platform: "linux",
      sessionId,
    });
    await writeFile(join(store.root, "foreign.txt"), "keep", "utf8");
    await store.cleanupStale();
    await expect(stat(store.sessionDir(sessionId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(store.root, "foreign.txt"), "utf8")).toBe("keep");
  });
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-credentials-"));
  homes.push(home);
  return home;
}

interface RunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** Spawn helper with stdin support (execFile has no `input` option). */
function runWithInput(
  file: string,
  args: readonly string[],
  input: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
