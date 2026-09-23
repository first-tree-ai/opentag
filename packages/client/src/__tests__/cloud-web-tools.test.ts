import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunnerClientFrame,
  RunnerCloudDeliveryRunFrame,
  RunnerCloudDeliveryVerifiedFrame,
  RunnerCloudModelGrant,
  RuntimeCredentialClientFrame,
  RuntimeCredentialServerFrame,
} from "@opentag/shared";
import { RUNTIME_PROVIDER_PROXY_PATH } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudCredentialChannel } from "../runner/cloud-credential-connection.js";
import { CloudJournal } from "../runner/cloud-journal.js";
import { CloudTurnRunner, type CloudTurnScope } from "../runner/cloud-turns.js";
import { NativeSandbox, SANDBOX_NODE, type SpawnProcess } from "../runner/native-sandbox.js";
import type {
  NativeSandboxWebGateway,
  NativeWebExecutionAuthority,
  NativeWebExecutionChannel,
} from "../runner/web-gateway.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

/*
 * The Cloud web wiring end to end at the trusted-parent boundary: the real execution open, the real
 * `runtime:web:gateway` bearer fetch, the real per-execution channel decision, and the real worker
 * stdin document. The Sandbox-facing bridge itself has its own suites; the Server fence and route
 * have theirs. What is proved here is the part in between — that a grant opens exactly one fresh
 * channel per execution, that a withheld grant opens none, and that the bearer never leaves the
 * parent.
 */

const MODEL_GRANT: RunnerCloudModelGrant = {
  baseUrl: "https://server.example.com/api/v1/cloud-model",
  model: "deepseek-v4.1-flash-expires-on-0910",
  token: "unit-execution-token-0123456789abcdef",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  contextWindow: 258_000,
  maxTokens: 8_192,
};

const EXTENSION_PATH = "/opt/opentag/client/dist/pi-extensions/web-tools.mjs";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/** The real Sandbox argv shape, executed by the local Node so the real bridge helper runs. */
function localSandbox(name = "ots-web-cloud"): NativeSandbox {
  const spawnProcess: SpawnProcess = (_command, args) => {
    const separator = args.indexOf("--");
    const [binary, ...rest] = args.slice(separator + 1);
    if (binary !== SANDBOX_NODE) throw new Error(`unexpected sandbox command ${binary ?? "<missing>"}`);
    return spawn(process.execPath, rest, { stdio: "pipe" });
  };
  return new NativeSandbox({ name, workspace: join(tmpdir(), `opentag-web-cloud-ws-${name}`), spawnProcess });
}

/** One live execution's web channel, with the ordering of open/close recorded by the harness. */
interface FakeChannel {
  readonly socketPath: string;
  readonly closed: () => boolean;
  readonly close: () => Promise<void>;
}

function searchResult() {
  return {
    requestId: "router-req-1",
    status: "ok" as const,
    retrievedAt: "2026-09-17T00:00:00.000Z",
    effectiveDepth: "basic" as const,
    results: [],
  };
}

/**
 * The Runner credential tunnel, driven in-process. It answers exactly the frames the relay sends
 * and nothing else, so a frame the production Server would not answer surfaces as a timeout rather
 * than a silent success.
 */
class FakeCredentialChannel implements CloudCredentialChannel {
  readonly requests: RuntimeCredentialClientFrame[] = [];
  grantWeb = true;
  nextExecutionId = randomUUID();
  readonly #credentials = new Set<(frame: RuntimeCredentialServerFrame) => void>();
  readonly #states = new Set<(state: "registered" | "closed") => void>();

  sendFrame(frame: RunnerClientFrame): void {
    if (frame.type !== "credential:frame") return;
    const request = frame.frame;
    this.requests.push(request);
    const response = this.#respond(request);
    if (!response) return;
    queueMicrotask(() => {
      for (const listener of [...this.#credentials]) listener(response);
    });
  }

  onCredentialFrame(listener: (frame: RuntimeCredentialServerFrame) => void): () => void {
    this.#credentials.add(listener);
    return () => this.#credentials.delete(listener);
  }

  onChannelState(listener: (state: "registered" | "closed") => void): () => void {
    this.#states.add(listener);
    return () => this.#states.delete(listener);
  }

  #respond(frame: RuntimeCredentialClientFrame): RuntimeCredentialServerFrame | undefined {
    if (frame.type === "runtime:execution:open") {
      this.nextExecutionId = randomUUID();
      return {
        type: "runtime:execution:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: this.nextExecutionId,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        providers: [],
        ...(this.grantWeb
          ? { services: [{ service: "web" as const, scopes: ["web:search", "web:fetch"] as const }] }
          : {}),
      };
    }
    if (frame.type === "runtime:proxy:ticket") {
      return {
        type: "runtime:proxy:ticket:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: this.nextExecutionId,
        ticket: "t".repeat(43),
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        path: RUNTIME_PROVIDER_PROXY_PATH,
      };
    }
    if (frame.type === "runtime:web:gateway") {
      return {
        type: "runtime:web:gateway:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: this.nextExecutionId,
        token: `otwg_${"w".repeat(43)}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    }
    if (frame.type === "runtime:execution:close") {
      return {
        type: "runtime:execution:closed",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: frame.executionId,
      };
    }
    return undefined;
  }
}

interface Harness {
  readonly runner: CloudTurnRunner;
  readonly channel: FakeCredentialChannel;
  readonly events: string[];
  readonly sent: RunnerClientFrame[];
  readonly workerInputs: string[];
  readonly fetchCalls: Array<{ url: string; authorization: string | undefined; body: string }>;
  readonly openedAuthorities: Array<{ authority: NativeWebExecutionAuthority; channel: FakeChannel }>;
  run(overrides?: { grantWeb?: boolean; delivery?: ReturnType<typeof cloudDeliveryFixture> }): Promise<string>;
}

async function harness(options: { webGatewayOpenError?: Error; missingExtension?: boolean } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-cloud-web-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const journal = await CloudJournal.open(join(directory, "journal"));
  await mkdir(join(directory, "private"), { recursive: true, mode: 0o700 });
  const sessionId = randomUUID();
  const scope: CloudTurnScope = {
    sandboxId: randomUUID(),
    sessionId,
    environmentGeneration: 1,
    resourceName: "projects/p/locations/r/instances/ots-s-x-1",
    resourceUid: "uid-1",
  };
  const channel = new FakeCredentialChannel();
  const events: string[] = [];
  const sent: RunnerClientFrame[] = [];
  const workerInputs: string[] = [];
  const fetchCalls: Array<{ url: string; authorization: string | undefined; body: string }> = [];
  const openedAuthorities: Array<{ authority: NativeWebExecutionAuthority; channel: FakeChannel }> = [];
  let socketCounter = 0;
  const webGateway = {
    openExecution: async (input: { authority: NativeWebExecutionAuthority }) => {
      if (options.webGatewayOpenError) throw options.webGatewayOpenError;
      const socketPath = `/tmp/opentag-web-${++socketCounter}.sock`;
      let closed = false;
      const fake: FakeChannel = {
        socketPath,
        closed: () => closed,
        close: async () => {
          if (closed) return;
          closed = true;
          events.push(`close:${socketPath}`);
        },
      };
      events.push(`open:${socketPath}`);
      openedAuthorities.push({ authority: input.authority, channel: fake });
      return fake as unknown as NativeWebExecutionChannel;
    },
  } as unknown as NativeSandboxWebGateway;
  const runner = new CloudTurnRunner({
    credentialChannel: () => channel,
    fetchImpl: async (url, init) => {
      fetchCalls.push({
        url: String(url),
        authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify(searchResult()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    journal,
    relayOptions: {
      dataConnectionFactory: async () => ({
        closed: false,
        close: async () => undefined,
        openStream: async () => ({}) as never,
        settled: async () => new Promise<void>(() => undefined),
      }),
    },
    runWorker: async (input) => {
      workerInputs.push(input.stdin);
      return {
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { outcome: "completed", executionEffects: "completed", finalText: "done" },
        })}\n`,
      };
    },
    sandbox: localSandbox(),
    scope: () => scope,
    send: (frame) => sent.push(frame),
    serverUrl: "https://server.example.com",
    stateDirectory: join(directory, "private"),
    ...(options.missingExtension ? {} : { webExtensionPath: EXTENSION_PATH }),
    webGateway,
  });
  cleanup.push(() => runner.close());
  const run = async (
    overrides: { grantWeb?: boolean; delivery?: ReturnType<typeof cloudDeliveryFixture> } = {},
  ): Promise<string> => {
    channel.grantWeb = overrides.grantWeb ?? true;
    const delivery = overrides.delivery ?? cloudDeliveryFixture({ sessionId });
    const runFrame: RunnerCloudDeliveryRunFrame = {
      type: "delivery:run",
      requestId: delivery.requestId,
      delivery,
    };
    const verified: RunnerCloudDeliveryVerifiedFrame = {
      type: "delivery:verified",
      requestId: delivery.requestId,
      status: "verified",
      model: MODEL_GRANT,
    };
    await runner.handleDeliveryRun(runFrame);
    await runner.handleVerified(verified);
    await runner.waitForActive();
    return delivery.deliveryId;
  };
  return { runner, channel, events, sent, workerInputs, fetchCalls, openedAuthorities, run };
}

describe("Cloud execution web tools", () => {
  it("opens one channel per granted execution and passes only nonsecret facts to the worker", async () => {
    const h = await harness();
    await h.run();
    // The open frame asks for both platform services; the Server decides each one.
    expect(h.channel.requests[0]).toMatchObject({ type: "runtime:execution:open", services: ["mcp", "web"] });
    expect(h.events).toEqual(["open:/tmp/opentag-web-1.sock", "close:/tmp/opentag-web-1.sock"]);
    expect(h.channel.requests.some((frame) => frame.type === "runtime:web:gateway")).toBe(true);
    const stdin = JSON.parse(h.workerInputs[0] ?? "{}") as {
      webTools?: { extensionPath: string; socketPath: string };
    };
    expect(stdin.webTools).toEqual({
      extensionPath: EXTENSION_PATH,
      socketPath: "/tmp/opentag-web-1.sock",
    });
    // The bearer is not in the worker document, and neither is the deployment Router key or any
    // Tavily material: the Sandbox receives two paths and nothing else.
    expect(h.workerInputs[0]).not.toContain("otwg_");
    expect(h.workerInputs[0]).not.toMatch(/tavily|OPENTAG_WEB_ROUTER_KEY/i);
    // The authority binds the exact execution the Server opened.
    expect(h.openedAuthorities[0]?.authority.executionIdentity).toBe(h.channel.nextExecutionId);
  });

  it("dispatches through the execution bearer, not through a Sandbox-visible credential", async () => {
    const h = await harness();
    await h.run();
    const authority = h.openedAuthorities[0]?.authority;
    if (!authority) throw new Error("expected an opened web authority");
    const result = await authority.dispatch(
      {
        operation: "search",
        toolCallId: "tool-call-1",
        remainingMs: 9_000,
        params: { query: "opentag", limit: 5, depth: "basic" },
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("ok");
    // One fixed route, one execution bearer, one execution id — and the query appears only in the
    // trusted parent's Server call, never in the worker document above.
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0]?.url).toBe("https://server.example.com/api/v1/runtime/web/search");
    expect(h.fetchCalls[0]?.authorization).toBe(`Bearer otwg_${"w".repeat(43)}`);
    expect(JSON.parse(h.fetchCalls[0]?.body ?? "{}")).toMatchObject({
      protocolVersion: 1,
      executionId: authority.executionIdentity,
      toolCallId: "tool-call-1",
      query: "opentag",
    });
  });

  it("opens no channel at all when the Server withholds the web grant", async () => {
    const h = await harness();
    await h.run({ grantWeb: false });
    expect(h.events).toEqual([]);
    expect(h.channel.requests.some((frame) => frame.type === "runtime:web:gateway")).toBe(false);
    const stdin = JSON.parse(h.workerInputs[0] ?? "{}") as { webTools?: unknown };
    expect(stdin.webTools).toBeUndefined();
  });

  it.each([
    { name: "the packaged extension is missing", options: { missingExtension: true } },
    { name: "the native channel cannot open", options: { webGatewayOpenError: new Error("gateway unavailable") } },
  ])("fails the turn when web was granted but $name", async ({ options }) => {
    const h = await harness(options);
    await h.run();
    expect(h.channel.requests.some((frame) => frame.type === "runtime:web:gateway")).toBe(true);
    expect(h.channel.requests.some((frame) => frame.type === "runtime:execution:close")).toBe(true);
    expect(h.workerInputs).toHaveLength(0);
    const report = h.sent.find((frame) => frame.type === "delivery:report");
    expect(report?.report.outcome).toBe("unknown");
  });

  it("gives a successor execution a fresh channel and never reuses the closed socket", async () => {
    const h = await harness();
    await h.run();
    await h.run();
    expect(h.events).toEqual([
      "open:/tmp/opentag-web-1.sock",
      "close:/tmp/opentag-web-1.sock",
      "open:/tmp/opentag-web-2.sock",
      "close:/tmp/opentag-web-2.sock",
    ]);
    const identities = h.openedAuthorities.map((entry) => entry.authority.executionIdentity);
    expect(new Set(identities).size).toBe(2);
    expect(h.workerInputs).toHaveLength(2);
  });
});
