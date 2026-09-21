import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  EffectiveRuntimeSnapshot,
  RunnerCloudSessionWorkerRequest,
  RunnerCloudTurnWorkerRequest,
  RuntimeImOutboxContext,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentInput,
  AgentPromptRequest,
  CreateAgentRuntimeRequest,
  ResumeAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import type { PiRpcClient } from "../providers/pi/rpc-wire.js";
import type { CloudContextTreePreparation } from "../runner/cloud-context-tree.js";
import {
  type CloudTurnPiFactory,
  type CloudTurnPiRuntime,
  cloudTurnPiDocuments,
  renderCloudSystemPrompt,
  runCloudTurnWorker,
} from "../runner/cloud-turn-worker.js";
import { RUNTIME_PROXY_PROVIDER_CA_KEY, RUNTIME_PROXY_PROVIDER_URL_KEY } from "../runtime/runtime-proxy-material.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const MODEL = {
  baseUrl: "https://server.example.com/api/v1/cloud-model",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  model: "deepseek-v4.1-flash-expires-on-0910",
  token: "unit-execution-token-0123456789abcdef",
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((close) => close())));

function turnRequest(executionDir: string, sessionDirectory?: string) {
  const delivery = cloudDeliveryFixture();
  const request: RunnerCloudTurnWorkerRequest = {
    delivery,
    executionDir,
    kind: "turn",
    model: MODEL,
    ...(sessionDirectory ? { piSessionDirectory: sessionDirectory } : {}),
  };
  return request;
}

function sessionRequest(
  executionDir: string,
  overrides: Partial<RunnerCloudSessionWorkerRequest> = {},
): RunnerCloudSessionWorkerRequest {
  const delivery = cloudDeliveryFixture();
  const runtime = delivery.runtime;
  return {
    kind: "session-message",
    executionDir,
    model: MODEL,
    sessionKind: "internal",
    message: {
      type: "session:message:deliver",
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: delivery.sessionId,
      agentId: runtime.agentId,
      placementGeneration: 1,
      content: { kind: "text", text: "Report the integration status." },
      runtime,
    },
    ...overrides,
  };
}

/** Every regular file under a directory tree; used to prove scratch material never persists. */
async function filesUnder(directory: string): Promise<Buffer[]> {
  const files: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(await readFile(path));
  }
  return files;
}

/** Local fixture execution directory: environment.json with the explicit loopback seam. */
async function fixtureExecution(root: string, name: string): Promise<string> {
  const directory = join(root, "mount", name);
  await mkdir(directory, { recursive: true });
  // Public CA material the trusted Runner publishes alongside the manifest.
  await writeFile(join(directory, "ca.pem"), "-----BEGIN CERTIFICATE-----fixture-----END CERTIFICATE-----\n");
  await writeFile(
    join(directory, "environment.json"),
    JSON.stringify({
      executionId: randomUUID(),
      environment: {
        [RUNTIME_PROXY_PROVIDER_URL_KEY]: "http://127.0.0.1:18080",
        [RUNTIME_PROXY_PROVIDER_CA_KEY]: join(directory, "ca.pem"),
      },
    }),
    "utf8",
  );
  return directory;
}

/** One minimal scripted Pi RPC client; reports session state and finishes a stop run. */
class ScriptedPiClient implements PiRpcClient {
  readonly args: readonly string[];
  readonly sessionId: string;
  readonly #listeners = new Set<(message: Readonly<Record<string, unknown>>) => void>();
  #messageCount: number;
  #finalText: string;

  constructor(args: readonly string[], messageCount: number, finalText: string) {
    this.args = args;
    const index = args.indexOf("--session-id");
    this.sessionId = index >= 0 ? (args[index + 1] as string) : "";
    this.#messageCount = messageCount;
    this.#finalText = finalText;
  }

  async request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (command.type === "get_state") {
      return {
        messageCount: this.#messageCount,
        model: { id: "fixture-model", provider: "fixture" },
        sessionFile: `/tmp/fixture-sessions/${this.sessionId}.jsonl`,
        sessionId: this.sessionId,
      };
    }
    if (command.type === "prompt") {
      const assistant = {
        content: [{ text: this.#finalText, type: "text" }],
        role: "assistant",
        stopReason: "stop",
        usage: { cacheRead: 1, cacheWrite: 1, input: 2, output: 3 },
      };
      for (const message of [
        { type: "agent_start" },
        { type: "turn_start" },
        { message: { content: "hello", role: "user" }, type: "message_start" },
        { message: { content: "hello", role: "user" }, type: "message_end" },
        { message: { ...assistant, content: [] }, type: "message_start" },
        { assistantMessageEvent: { type: "start" }, type: "message_update" },
        { assistantMessageEvent: { contentIndex: 0, type: "text_start" }, type: "message_update" },
        {
          assistantMessageEvent: { contentIndex: 0, delta: this.#finalText, type: "text_delta" },
          type: "message_update",
        },
        {
          assistantMessageEvent: { content: this.#finalText, contentIndex: 0, type: "text_end" },
          type: "message_update",
        },
        { assistantMessageEvent: { reason: "stop", type: "done" }, type: "message_update" },
        { message: assistant, type: "message_end" },
        { message: assistant, toolResults: [], type: "turn_end" },
        { messages: [assistant], type: "agent_end", willRetry: false },
        { type: "agent_settled" },
      ]) {
        for (const listener of this.#listeners) listener(message);
      }
      this.#messageCount = Math.max(this.#messageCount, 2);
      return undefined;
    }
    if (command.type === "abort") {
      for (const listener of this.#listeners) listener({ type: "agent_settled" });
      return undefined;
    }
    throw new Error(`unexpected Pi command ${String(command.type)}`);
  }

  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
  }
}

describe("cloud-turn-worker", () => {
  it("renders the model grant as a disposable OpenAI-compatible provider document set", () => {
    const documents = cloudTurnPiDocuments(turnRequest("/run/opentag-execution/turn-1"));
    const auth = JSON.parse(documents.authJson) as Record<string, { type: string; key: string }>;
    expect(Object.keys(auth)).toEqual(["opentag"]);
    expect(auth.opentag?.type).toBe("api_key");
    const models = JSON.parse(documents.modelsJson) as {
      providers: Record<string, { api: string; baseUrl: string; models: { id: string }[] }>;
    };
    expect(Object.keys(models.providers)).toEqual(["opentag"]);
    expect(models.providers.opentag?.api).toBe("openai-completions");
    expect(models.providers.opentag?.baseUrl).toBe("https://server.example.com/api/v1/cloud-model");
    expect(models.providers.opentag?.models[0]?.id).toBe("deepseek-v4.1-flash-expires-on-0910");
    const settings = JSON.parse(documents.settingsJson) as { defaultProvider: string; defaultModel: string };
    expect(settings.defaultProvider).toBe("opentag");
    expect(settings.defaultModel).toBe("opentag/deepseek-v4.1-flash-expires-on-0910");
  });

  it("renders Cloud-true system instructions without Local Agent Home or Context Tree claims", () => {
    const prompt = renderCloudSystemPrompt(cloudDeliveryFixture().runtime);
    expect(prompt).toContain("Platform.");
    expect(prompt).toContain("Agent.");
    expect(prompt).toContain("Session-scoped Cloud Sandbox");
    expect(prompt).toContain("256 MiB");
    expect(prompt).toContain("50,000 entries");
    expect(prompt).toContain("128 MiB");
    expect(prompt).toContain("Hard links, sockets, FIFOs");
    expect(prompt).not.toContain("Agent Home");
    expect(prompt).not.toContain("Context Tree");
    expect(prompt).not.toContain("shared across this Agent's Sessions");
  });

  it("renders the current Context Tree truthfully with the Agent slug and exact path", () => {
    const snapshot = cloudDeliveryFixture().runtime;
    const ready = renderCloudSystemPrompt(
      { ...snapshot, instructions: { ...snapshot.instructions, platform: "OpenTag Agent slug: tree-agent" } },
      { contextTree: { status: "ready", treePath: "/ws/tree", branch: "master", sha: "a".repeat(40) } },
    );
    expect(ready).toContain("Context Tree: /ws/tree");
    expect(ready).toContain("tree-agent");
    expect(ready).toContain("members/tree-agent/");
    expect(ready).toContain("branch master, commit aaaaaaaaaaaa");

    const dirty = renderCloudSystemPrompt(snapshot, {
      contextTree: { status: "stale", treePath: "/ws/tree", reason: "DIRTY_TREE" },
    });
    expect(dirty).toContain("Context Tree: /ws/tree");
    expect(dirty).toContain("unpublished changes");
    expect(dirty).toContain("do not reset or discard");

    const stale = renderCloudSystemPrompt(snapshot, {
      contextTree: { status: "stale", treePath: "/ws/tree", reason: "TIMEOUT" },
    });
    expect(stale).toContain("may be outdated");
    expect(stale).toContain("TIMEOUT");

    const unconfigured = renderCloudSystemPrompt(snapshot, { contextTree: { status: "unconfigured" } });
    expect(unconfigured).toContain("disabled for this Agent");

    const denied = renderCloudSystemPrompt(snapshot, {
      contextTree: { status: "unavailable", reason: "GITHUB_PERMISSION" },
    });
    expect(denied).toContain("Context Tree unavailable (GITHUB_PERMISSION)");
    expect(denied).toContain("does not grant this Session the selected repository");
  });

  it("renders one Cloud tree section and shared guidance for multiple aliases", () => {
    const prompt = renderCloudSystemPrompt(cloudDeliveryFixture().runtime, {
      contextTree: {
        status: "configured",
        connections: [
          {
            alias: "team",
            repository: "acme/team",
            status: "ready",
            treePath: "/trees/team",
            branch: "main",
            sha: "a".repeat(40),
          },
          { alias: "product", repository: "acme/product", status: "ready", treePath: "/trees/product" },
          { alias: "stale", repository: "acme/stale", status: "stale", treePath: "/trees/stale", reason: "DIRTY_TREE" },
          { alias: "denied", repository: "acme/denied", status: "unavailable", reason: "GITHUB_PERMISSION" },
          { alias: "timeout", repository: "acme/timeout", status: "unavailable", reason: "TIMEOUT" },
        ],
      },
    });
    expect(prompt.match(/^## Context Trees$/gm)).toHaveLength(1);
    expect(prompt).not.toMatch(/^## Context Tree$/m);
    expect(prompt).toContain("Alias team — acme/team");
    expect(prompt).toContain("Context Tree: /trees/product");
    expect(prompt).toContain("branch main, commit aaaaaaaaaaaa");
    expect(prompt).toContain("Context Tree: /trees/stale");
    expect(prompt).toContain("do not reset or discard");
    expect(prompt).toContain("GITHUB_PERMISSION");
    expect(prompt.match(/Use the context-tree-read and context-tree-write skills/g)).toHaveLength(1);
    expect(prompt.match(/Do not write to another Agent's member directory/g)).toHaveLength(1);
    expect(prompt.match(/Continue the task without those trees/g)).toHaveLength(1);
  });

  it("resumes the SAME Pi binding/history across two Turns of one allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-continuity-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const continuity = join(root, "continuity");
    const sessionDirectory = join(continuity, "sessions");
    const created: string[] = [];
    const resumed: { sessionDirectory: string; sessionId: string }[] = [];
    const captured: { args: string[]; environment: Record<string, string>; sessionDirectory: string }[] = [];
    let turn = 0;
    const createPiFactory = (input: {
      environment: Record<string, string>;
      pids: Set<number>;
      sessionDirectory: string;
    }): CloudTurnPiFactory => {
      const index = turn;
      turn += 1;
      const factory = new PiAgentRuntimeFactory({
        createClient: (_cwd, args) => {
          captured.push({
            args: [...args],
            environment: input.environment,
            sessionDirectory: input.sessionDirectory,
          });
          return new ScriptedPiClient(args, index === 0 ? 0 : 2, index === 0 ? "first-answer" : "history-2");
        },
        createSessionId: () => "11111111-2222-4333-8444-555555555555",
        process: { command: "pi", sessionDirectory: input.sessionDirectory },
      });
      return {
        create: (request) => {
          created.push("create");
          return factory.create(request) as Promise<CloudTurnPiRuntime>;
        },
        resume: (request) => {
          created.push("resume");
          resumed.push({
            sessionDirectory: input.sessionDirectory,
            sessionId: (request.binding.payload as { sessionId: string }).sessionId,
          });
          return factory.resume(request) as Promise<CloudTurnPiRuntime>;
        },
      };
    };

    const first = await runCloudTurnWorker(turnRequest(await fixtureExecution(root, "turn-1"), continuity), {
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    });
    expect(first.outcome).toBe("completed");
    expect(first.finalText).toBe("first-answer");
    // The first Turn materializes the binding so the next Turn can resume it.
    const persistedBinding = JSON.parse(await readFile(join(continuity, "pi-binding.json"), "utf8")) as {
      payload: { sessionId: string };
    };
    const second = await runCloudTurnWorker(turnRequest(await fixtureExecution(root, "turn-2"), continuity), {
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    });
    expect(second.outcome).toBe("completed");
    expect(second.finalText).toBe("history-2");
    expect(created).toEqual(["create", "resume"]);
    expect(resumed[0]?.sessionId).toBe(persistedBinding.payload.sessionId);
    expect(resumed[0]?.sessionDirectory).toBe(sessionDirectory);
    // Both Turns used the same Pi session directory, and the parent never leaks its own HOME or
    // any bootstrap/IM/GitHub credential into the worker environment.
    expect(captured.map((entry) => entry.sessionDirectory)).toEqual([sessionDirectory, sessionDirectory]);
    expect(captured[1]?.args.join(" ")).toContain(`--session-id ${persistedBinding.payload.sessionId}`);
    for (const entry of captured) {
      expect(entry.environment.HOME).not.toBe(process.env.HOME);
      expect(entry.environment.OPENTAG_RUNNER_BOOTSTRAP_TOKEN).toBeUndefined();
      expect(entry.environment.GITHUB_TOKEN).toBeUndefined();
      expect(entry.environment.GH_TOKEN).toBeUndefined();
      expect(entry.environment.SLACK_BOT_TOKEN).toBeUndefined();
      expect(entry.environment.LARKSUITE_CLI_APP_SECRET).toBeUndefined();
      // The published manifest loopback seam is applied, not the parent's ambient proxy. The
      // standard routing variables stay out of the Agent runtime environment entirely.
      expect(entry.environment[RUNTIME_PROXY_PROVIDER_URL_KEY]).toBe("http://127.0.0.1:18080");
      expect(entry.environment.HTTPS_PROXY).toBeUndefined();
      expect(entry.environment.https_proxy).toBeUndefined();
      expect(entry.environment.SSL_CERT_FILE).toBeUndefined();
      expect(entry.environment.GIT_SSL_CAINFO).toBeUndefined();
    }
  });

  it("fails closed on an incomplete or missing native proxy socket mount before Pi starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-sockets-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    let factoryBuilt = false;
    const factory = (): CloudTurnPiFactory => {
      factoryBuilt = true;
      throw new Error("the Pi factory must not be built without a verified proxy mount");
    };
    // A single REAL Unix socket: one half of the native mount is missing.
    const server: Server = createServer();
    server.listen(join(executionDir, "connect.sock"));
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await expect(
      runCloudTurnWorker(turnRequest(executionDir), {
        createPiFactory: factory,
        executionMount: join(root, "mount"),
        workspace: join(root, "workspace"),
      }),
    ).rejects.toThrow(/incomplete/);
    // No sockets at all: the exact production manifest shape must still reject without the seam.
    await rm(join(executionDir, "connect.sock"), { force: true });
    await expect(
      runCloudTurnWorker(turnRequest(executionDir), {
        createPiFactory: factory,
        executionMount: join(root, "mount"),
        workspace: join(root, "workspace"),
      }),
    ).rejects.toThrow(/sockets are missing/);
    expect(factoryBuilt).toBe(false);
  });

  it("uses the loopback manifest only through the explicit local test seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-seam-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const createPiFactory = (): CloudTurnPiFactory => ({
      create: async () =>
        ({
          close: async () => undefined,
          prompt: async () => ({ output: [{ text: "seam", type: "text" }], status: "completed" }),
        }) as unknown as CloudTurnPiRuntime,
      resume: async () => {
        throw new Error("unexpected resume");
      },
    });
    const completion = await runCloudTurnWorker(turnRequest(executionDir), {
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    });
    expect(completion.outcome).toBe("completed");
    // Even with the seam enabled, a manifest that names another endpoint is rejected.
    await writeFile(
      join(executionDir, "environment.json"),
      JSON.stringify({
        environment: {
          [RUNTIME_PROXY_PROVIDER_URL_KEY]: "http://127.0.0.1:9999",
          [RUNTIME_PROXY_PROVIDER_CA_KEY]: join(executionDir, "ca.pem"),
        },
        executionId: "fixture",
      }),
      "utf8",
    );
    await expect(
      runCloudTurnWorker(turnRequest(executionDir), {
        createPiFactory,
        executionMount: join(root, "mount"),
        localProxyLoopbackSeam: true,
        workspace: join(root, "workspace"),
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("bridges the loopback endpoints to real mounted Unix sockets", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-bridge-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const upstream = createServer((socket) => socket.pipe(socket));
    upstream.listen(join(executionDir, "connect.sock"));
    await new Promise<void>((resolve) => upstream.once("listening", resolve));
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const slack = createServer((socket) => socket.pipe(socket));
    slack.listen(join(executionDir, "slack.sock"));
    await new Promise<void>((resolve) => slack.once("listening", resolve));
    cleanup.push(() => new Promise<void>((resolve) => slack.close(() => resolve())));

    const forwarded: string[] = [];
    const createPiFactory = (): CloudTurnPiFactory => ({
      create: async () => {
        forwarded.push(
          await new Promise<string>((resolve, reject) => {
            const socket = new Socket();
            socket.once("error", reject);
            socket.connect(18_080, "127.0.0.1", () => socket.write("ping"));
            socket.once("data", (chunk: Buffer) => {
              socket.destroy();
              resolve(chunk.toString("utf8"));
            });
          }),
        );
        return {
          close: async () => undefined,
          prompt: async () => ({ output: [{ text: "bridged", type: "text" }], status: "completed" }),
        } as unknown as CloudTurnPiRuntime;
      },
      resume: async () => {
        throw new Error("unexpected resume");
      },
    });
    const completion = await runCloudTurnWorker(turnRequest(executionDir), {
      continuityDirectory: join(root, "continuity"),
      createPiFactory,
      executionMount: join(root, "mount"),
      workspace: join(root, "workspace"),
    });
    expect(forwarded).toEqual(["ping"]);
    expect(completion.outcome).toBe("completed");
  });

  it("publishes the per-turn provider environment file and keeps reply instructions intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-reply-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const continuity = join(root, "continuity");
    const observed: {
      environmentFile?: string;
      fileContent?: string;
      fileMode?: number;
      inputText?: string;
    } = {};
    const createPiFactory = (input: { environment: Record<string, string> }): CloudTurnPiFactory => {
      observed.environmentFile = input.environment.OPENTAG_PROVIDER_ENV_FILE;
      return {
        create: async () =>
          ({
            close: async () => undefined,
            prompt: async (request: AgentPromptRequest) => {
              observed.inputText = request.input.items.map((item) => item.text).join("\n");
              if (observed.environmentFile) {
                observed.fileContent = await readFile(observed.environmentFile, "utf8");
                observed.fileMode = (await stat(observed.environmentFile)).mode & 0o777;
              }
              return { output: [{ text: "reply-path", type: "text" }], status: "completed" };
            },
          }) as unknown as CloudTurnPiRuntime,
        resume: async () => {
          throw new Error("unexpected resume");
        },
      };
    };
    const completion = await runCloudTurnWorker(turnRequest(executionDir, continuity), {
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    });
    expect(completion.outcome).toBe("completed");
    // The managed outbox instructions from buildAgentInput are preserved in the Cloud prompt.
    expect(observed.inputText).toContain('<opentag-im-context source="managed">');
    expect(observed.inputText).toContain("$OPENTAG_PROVIDER_ENV_FILE");
    expect(observed.inputText).toContain("lark-cli");
    // The instruction target exists for the Turn, is private, and carries the published proxy env.
    expect(observed.environmentFile).toBeDefined();
    expect(observed.fileMode).toBe(0o600);
    expect(observed.fileContent).toContain("export HTTPS_PROXY='http://127.0.0.1:18080'");
    // The sourced provider shell trusts the Sandbox-owned CA copy, never the root-owned mount.
    const sandboxCa = join(dirname(observed.environmentFile as string), "home", ".opentag", "ca.pem");
    expect(observed.fileContent).toContain(`export SSL_CERT_FILE='${sandboxCa}'`);
    expect(observed.fileContent).not.toContain(`export SSL_CERT_FILE='${join(executionDir, "ca.pem")}'`);
    expect(observed.fileContent).not.toContain("MASTER");
    // The per-turn secret file is scratch-only: never part of the persistent Pi continuity dir.
    expect(observed.environmentFile?.startsWith(continuity)).toBe(false);
    await expect(stat(observed.environmentFile as string)).rejects.toThrow();
  });

  it("never starts Pi when the execution deadline fires during Context Tree preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-prep-deadline-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const request = turnRequest(executionDir);
    request.delivery = cloudDeliveryFixture({ deadlineAt: new Date(Date.now() + 30).toISOString() });
    let factoryBuilt = false;
    const completion = await runCloudTurnWorker(request, {
      createPiFactory: () => {
        factoryBuilt = true;
        throw new Error("Pi must not start after the execution deadline");
      },
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      prepareContextTree: async (input): Promise<CloudContextTreePreparation> => {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: { status: "unavailable", reason: "TIMEOUT" } };
      },
      workspace: join(root, "workspace"),
    });
    expect(completion.outcome).toBe("failed");
    expect(completion.errorReason).toBe("turn_timeout");
    expect(factoryBuilt).toBe(false);
  });

  it("never starts Pi when the caller stops during Context Tree preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-prep-stop-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const running = runCloudTurnWorker(turnRequest(executionDir), {
      createPiFactory: () => {
        throw new Error("Pi must not start after the caller stopped");
      },
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      prepareContextTree: async (input): Promise<CloudContextTreePreparation> => {
        markStarted();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: { status: "unavailable", reason: "TIMEOUT" } };
      },
      signal: controller.signal,
      workspace: join(root, "workspace"),
    });
    await started;
    controller.abort();
    const completion = await running;
    expect(completion.outcome).toBe("cancelled");
    expect(completion.errorReason).toBe("client_shutdown");
  });

  it("continues the base task with a truthful status when only the preparation budget expires", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-prep-budget-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const prompts: string[] = [];
    const createPiFactory = (): CloudTurnPiFactory => ({
      create: async (request) => {
        prompts.push(request.systemPrompt ?? "");
        return {
          close: async () => undefined,
          prompt: async () => ({ output: [{ text: "continued", type: "text" }], status: "completed" }),
        } as unknown as CloudTurnPiRuntime;
      },
      resume: async () => {
        throw new Error("unexpected resume");
      },
    });
    const completion = await runCloudTurnWorker(turnRequest(executionDir), {
      contextTreePreparationBudgetMs: 20,
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      prepareContextTree: async (input): Promise<CloudContextTreePreparation> => {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: { status: "unavailable", reason: "TIMEOUT" } };
      },
      workspace: join(root, "workspace"),
    });
    expect(completion.outcome).toBe("completed");
    // The task ran; the prompt tells the Agent the truth about optional memory.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Context Tree unavailable (TIMEOUT)");
  });

  it("kills real Pi child processes when the Turn is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-cancel-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    let markPromptStarted: () => void = () => undefined;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    let markChildExited: () => void = () => undefined;
    const childExited = new Promise<void>((resolve) => {
      markChildExited = resolve;
    });
    const createPiFactory = (input: {
      environment: Record<string, string>;
      pids: Set<number>;
      sessionDirectory: string;
    }): CloudTurnPiFactory => ({
      create: async () => {
        const spawnedChild = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
          stdio: "ignore",
        });
        child = spawnedChild;
        if (typeof spawnedChild.pid === "number") input.pids.add(spawnedChild.pid);
        spawnedChild.once("exit", () => markChildExited());
        return {
          close: async () => {
            await childExited;
          },
          prompt: async (request: { signal?: AbortSignal }) => {
            markPromptStarted();
            await new Promise<void>((resolve) => {
              if (request.signal?.aborted) resolve();
              else request.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("turn cancelled");
          },
        } as unknown as CloudTurnPiRuntime;
      },
      resume: async () => {
        throw new Error("unexpected resume");
      },
    });

    const running = runCloudTurnWorker(turnRequest(executionDir), {
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      signal: controller.signal,
      workspace: join(root, "workspace"),
    });
    await promptStarted;
    expect(child?.exitCode).toBeNull();
    controller.abort();
    const completion = await running;
    await childExited;
    // The real owned child process is gone, terminated by the worker's tracked-process kill.
    expect(child?.signalCode ?? (child?.exitCode === null ? null : "exited")).toBe("SIGTERM");
    expect(completion.outcome).toBe("cancelled");
    expect(completion.errorReason).toBe("client_shutdown");
  });
});

describe("cloud-turn-worker sandbox path and manifest guards", () => {
  it("refuses an execution directory outside the execution mount before any Pi work", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-outside-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    await expect(
      runCloudTurnWorker(turnRequest(executionDir), {
        createPiFactory: () => {
          throw new Error("Pi factory must not be constructed");
        },
        executionMount: join(root, "other-mount"),
        localProxyLoopbackSeam: true,
        workspace: join(root, "workspace"),
      }),
    ).rejects.toThrow(/outside the Sandbox mount/);
  });

  it("refuses an unsafe execution directory, continuity directory, and workspace path", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-unsafe-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const options = {
      createPiFactory: () => {
        throw new Error("Pi factory must not be constructed");
      },
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    };
    // A relative, oversized, traversal, or control-character path is refused everywhere.
    for (const bad of ["relative/path", `/${"x".repeat(600)}`, "/run/../etc", "/run/opentag\n"]) {
      await expect(runCloudTurnWorker(turnRequest(bad), options)).rejects.toThrow(/Unsafe/);
      await expect(
        runCloudTurnWorker({ ...turnRequest(executionDir), piSessionDirectory: bad }, options),
      ).rejects.toThrow(/Unsafe/);
    }
    await expect(
      runCloudTurnWorker(turnRequest(executionDir), { ...options, workspace: "relative-workspace" }),
    ).rejects.toThrow(/Unsafe/);
  });

  it("rejects a proxy manifest and a persisted binding that are structurally invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-manifest-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const createPiFactory = (): CloudTurnPiFactory => ({
      create: async () =>
        ({
          close: async () => undefined,
          prompt: async () => ({ output: [{ text: "ok", type: "text" }], status: "completed" }),
        }) as unknown as CloudTurnPiRuntime,
      resume: async () => {
        throw new Error("unexpected resume");
      },
    });
    const options = {
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    };
    // A manifest that is not an object at all fails closed before Pi starts.
    await writeFile(join(executionDir, "environment.json"), "null", "utf8");
    await expect(runCloudTurnWorker(turnRequest(executionDir), options)).rejects.toThrow(
      /proxy environment manifest is invalid/,
    );
    // A manifest whose executionId/environment are the wrong shape fails closed as well.
    await writeFile(join(executionDir, "environment.json"), JSON.stringify({ environment: 1 }), "utf8");
    await expect(runCloudTurnWorker(turnRequest(executionDir), options)).rejects.toThrow(
      /proxy environment manifest is invalid/,
    );
  });

  it("fails closed on a persisted Pi binding that is structurally invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-binding-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const workspace = join(root, "workspace");
    const continuity = join(workspace, ".opentag", "pi-session");
    await mkdir(continuity, { recursive: true });
    // A corrupt persisted binding must never be silently ignored: the continuity guarantee would
    // be lost, so the worker fails instead of starting a fresh conversation.
    for (const contents of ["null", JSON.stringify({ providerId: "pi" }), JSON.stringify([1, 2])]) {
      await writeFile(join(continuity, "pi-binding.json"), contents, "utf8");
      await expect(
        runCloudTurnWorker(turnRequest(executionDir), {
          createPiFactory: (): CloudTurnPiFactory => ({
            create: async () =>
              ({
                close: async () => undefined,
                prompt: async () => ({ output: [{ text: "ok", type: "text" }], status: "completed" }),
              }) as unknown as CloudTurnPiRuntime,
            resume: async () => {
              throw new Error("unexpected resume");
            },
          }),
          executionMount: join(root, "mount"),
          localProxyLoopbackSeam: true,
          workspace,
        }),
      ).rejects.toThrow(/persisted Pi binding is invalid/);
    }
  });

  it("still returns the real completion when closing the runtime throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-close-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const completion = await runCloudTurnWorker(turnRequest(executionDir), {
      createPiFactory: (): CloudTurnPiFactory => ({
        create: async () =>
          ({
            close: async () => {
              // A close failure is a cleanup detail: it must never mask the honest result.
              throw new Error("runtime close failed");
            },
            prompt: async () => ({ output: [{ text: "closed", type: "text" }], status: "completed" }),
          }) as unknown as CloudTurnPiRuntime,
        resume: async () => {
          throw new Error("unexpected resume");
        },
      }),
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    });
    expect(completion).toMatchObject({ finalText: "closed", outcome: "completed" });
  });

  it("reports a non-missing persisted binding read failure instead of starting fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-binding-read-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const workspace = join(root, "workspace");
    const continuity = join(workspace, ".opentag", "pi-session");
    // A DIRECTORY where the binding file must be is a real EISDIR: the worker must surface it
    // rather than silently starting a fresh conversation.
    await mkdir(join(continuity, "pi-binding.json"), { recursive: true });
    await expect(
      runCloudTurnWorker(turnRequest(executionDir), {
        createPiFactory: (): CloudTurnPiFactory => ({
          create: async () =>
            ({
              close: async () => undefined,
              prompt: async () => ({ output: [{ text: "ok", type: "text" }], status: "completed" }),
            }) as unknown as CloudTurnPiRuntime,
          resume: async () => {
            throw new Error("unexpected resume");
          },
        }),
        executionMount: join(root, "mount"),
        localProxyLoopbackSeam: true,
        workspace,
      }),
    ).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("keeps the real completion even when the runtime close is slow", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-slow-close-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "turn-1");
    const completion = await runCloudTurnWorker(turnRequest(executionDir), {
      createPiFactory: (): CloudTurnPiFactory => ({
        create: async () =>
          ({
            close: async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
            },
            prompt: async () => ({ output: [{ text: "slow-close", type: "text" }], status: "completed" }),
          }) as unknown as CloudTurnPiRuntime,
        resume: async () => {
          throw new Error("unexpected resume");
        },
      }),
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    });
    expect(completion).toMatchObject({ finalText: "slow-close", outcome: "completed" });
  });
});

describe("session-message worker integration", () => {
  it("runs an internal Session child with its own instructions and no IM outbox material", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-session-internal-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "session-1");
    let environment: Record<string, string> = {};
    let systemPrompt = "";
    let input: AgentInput | undefined;
    const createPiFactory = (factoryInput: { environment: Record<string, string> }): CloudTurnPiFactory => {
      environment = factoryInput.environment;
      return {
        create: async (request) => {
          systemPrompt = request.systemPrompt ?? "";
          return {
            close: async () => undefined,
            prompt: async (prompt: AgentPromptRequest) => {
              input = prompt.input;
              return { output: [{ text: "internal-done", type: "text" }], status: "completed" };
            },
          } as unknown as CloudTurnPiRuntime;
        },
        resume: async () => {
          throw new Error("unexpected resume");
        },
      };
    };

    const completion = await runCloudTurnWorker(sessionRequest(executionDir), {
      createPiFactory,
      executionMount: join(root, "mount"),
      localProxyLoopbackSeam: true,
      workspace: join(root, "workspace"),
    });
    expect(completion.outcome).toBe("completed");
    // Internal children have no IM outbox and no provider env file to pretend otherwise.
    expect(environment.OPENTAG_PROVIDER_ENV_FILE).toBeUndefined();
    expect(systemPrompt).not.toContain("## Session collaboration");
    const text = input?.items.map((item) => item.text).join("\n") ?? "";
    expect(text).toContain('<opentag-session-message-context source="managed">');
    expect(text).toContain("Your final text is not returned automatically");
    expect(text).toContain("opentag session send");
    // No fake IM input: neither IM managed context nor a fabricated provider reference.
    expect(text).not.toContain("<opentag-im-context");
    expect(text).not.toContain("Default provider outbox context");
    expect(input?.items.at(-1)).toEqual({ type: "text", text: "Report the integration status." });
  });

  it("keeps the visible callback's exact channel/thread outbox and provider environment file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-session-visible-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const executionDir = await fixtureExecution(root, "session-1");
    const outbox: RuntimeImOutboxContext = {
      channelId: "C0EXAMPLE",
      provider: "slack",
      sessionKind: "thread",
      threadTs: "1700000000.1234",
    };
    const observed: { inputText?: string; providerFile?: string; fileContent?: string; fileMode?: number } = {};
    const createPiFactory = (factoryInput: { environment: Record<string, string> }): CloudTurnPiFactory => {
      observed.providerFile = factoryInput.environment.OPENTAG_PROVIDER_ENV_FILE;
      return {
        create: async () =>
          ({
            close: async () => undefined,
            prompt: async (prompt: AgentPromptRequest) => {
              observed.inputText = prompt.input.items.map((item) => item.text).join("\n");
              if (observed.providerFile) {
                observed.fileContent = await readFile(observed.providerFile, "utf8");
                observed.fileMode = (await stat(observed.providerFile)).mode & 0o777;
              }
              return { output: [{ text: "visible-done", type: "text" }], status: "completed" };
            },
          }) as unknown as CloudTurnPiRuntime,
        resume: async () => {
          throw new Error("unexpected resume");
        },
      };
    };

    const completion = await runCloudTurnWorker(
      sessionRequest(executionDir, { outboxContext: outbox, sessionKind: "visible" }),
      {
        createPiFactory,
        executionMount: join(root, "mount"),
        localProxyLoopbackSeam: true,
        workspace: join(root, "workspace"),
      },
    );
    expect(completion.outcome).toBe("completed");
    // The visible continuation keeps its real provider scope and the outbox instruction path.
    expect(observed.inputText).toContain('Default provider outbox context: {"channelId":"C0EXAMPLE"');
    expect(observed.inputText).toContain("1700000000.1234");
    expect(observed.inputText).toContain("deliver it through the provider CLI");
    expect(observed.inputText).not.toContain("Your final text is not returned automatically");
    expect(observed.providerFile).toBeDefined();
    expect(observed.fileMode).toBe(0o600);
    expect(observed.fileContent).toContain("export HTTPS_PROXY='http://127.0.0.1:18080'");
    await expect(stat(observed.providerFile as string)).rejects.toThrow();
  });

  it("exposes the exact proof during the run only and replaces it on the next message", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-session-proof-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const proofA = { proofId: randomUUID(), token: "proof-token-a-0123456789abcdef" };
    const proofB = { proofId: randomUUID(), token: "proof-token-b-0123456789abcdef" };
    const observed: { paths: string[]; contents: unknown[]; modes: number[] } = { paths: [], contents: [], modes: [] };
    const capture = async (environment: Record<string, string>) => {
      const proofPath = environment.OPENTAG_SESSION_PROOF_FILE;
      if (!proofPath) throw new Error("missing proof path");
      observed.paths.push(proofPath);
      observed.contents.push(JSON.parse(await readFile(proofPath, "utf8")));
      observed.modes.push((await stat(proofPath)).mode & 0o777);
      return { output: [{ text: "proof-done", type: "text" }], status: "completed" as const };
    };
    const createPiFactory = (factoryInput: { environment: Record<string, string> }): CloudTurnPiFactory => ({
      create: async (request) => {
        expect(request.systemPrompt).toContain("## Session collaboration");
        return {
          close: async () => undefined,
          prompt: async () => capture(factoryInput.environment),
        } as unknown as CloudTurnPiRuntime;
      },
      resume: async (request) => {
        expect(request.systemPrompt).toContain("## Session collaboration");
        return {
          close: async () => undefined,
          prompt: async () => capture(factoryInput.environment),
        } as unknown as CloudTurnPiRuntime;
      },
    });
    const run = async (executionDir: string, proof: typeof proofA) => {
      const request = sessionRequest(executionDir, {
        sessionCollaboration: { proof, serverUrl: "https://server.example.test" },
      });
      const completion = await runCloudTurnWorker(request, {
        createPiFactory,
        executionMount: join(root, "mount"),
        localProxyLoopbackSeam: true,
        workspace,
      });
      expect(completion.outcome).toBe("completed");
    };

    await run(await fixtureExecution(root, "session-1"), proofA);
    expect(observed.contents[0]).toEqual(proofA);
    expect(observed.modes[0]).toBe(0o600);
    // The proof file belongs to per-message scratch, never the Session workspace.
    expect(observed.paths[0]?.startsWith(`${workspace}/`)).toBe(false);
    await expect(stat(observed.paths[0] as string)).rejects.toMatchObject({ code: "ENOENT" });

    await run(await fixtureExecution(root, "session-2"), proofB);
    expect(observed.contents[1]).toEqual(proofB);
    // Each message gets a fresh proof file; the previous one is gone and never archived.
    expect(observed.paths[1]).not.toBe(observed.paths[0]);
    await expect(stat(observed.paths[0] as string)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(observed.paths[1] as string)).rejects.toMatchObject({ code: "ENOENT" });
    for (const bytes of await filesUnder(workspace)) {
      expect(bytes.includes(Buffer.from(proofA.token))).toBe(false);
      expect(bytes.includes(Buffer.from(proofB.token))).toBe(false);
    }
  });

  it("continues the same Pi binding and history while applying the current Session snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-worker-session-continuity-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const continuity = join(root, "continuity");
    const delivery = cloudDeliveryFixture();
    const base: EffectiveRuntimeSnapshot = {
      ...delivery.runtime,
      instructions: { agent: "Base agent instruction.", platform: "Base platform." },
    };
    const opened: {
      kind: "create" | "resume";
      sessionDirectory: string;
      sessionId?: string;
      systemPrompt?: string;
      inputText?: string;
      runId?: string;
    }[] = [];
    const createPiFactory = (factoryInput: {
      environment: Record<string, string>;
      sessionDirectory: string;
    }): CloudTurnPiFactory => {
      const open = async (
        request: CreateAgentRuntimeRequest | ResumeAgentRuntimeRequest,
        kind: "create" | "resume",
      ) => {
        const binding =
          "binding" in request
            ? request.binding
            : { payload: { sessionId: randomUUID() }, providerId: "pi", schemaVersion: 1 };
        const entry = {
          kind,
          sessionDirectory: factoryInput.sessionDirectory,
          sessionId: (binding.payload as { sessionId?: string }).sessionId,
          systemPrompt: request.systemPrompt,
        } as (typeof opened)[number];
        opened.push(entry);
        await request.eventSink({ binding, type: "binding_changed" });
        return {
          close: async () => undefined,
          prompt: async (prompt: AgentPromptRequest) => {
            entry.inputText = prompt.input.items.map((item) => item.text).join("\n");
            entry.runId = prompt.runId;
            return { output: [{ text: `${kind}-done`, type: "text" }], status: "completed" };
          },
        } as unknown as CloudTurnPiRuntime;
      };
      return {
        create: (request) => open(request, "create"),
        resume: (request) => open(request, "resume"),
      };
    };

    await runCloudTurnWorker(
      {
        kind: "turn",
        delivery: cloudDeliveryFixture({ agentId: base.agentId, runtime: base, sessionId: delivery.sessionId }),
        executionDir: await fixtureExecution(root, "turn-1"),
        model: MODEL,
        piSessionDirectory: continuity,
      },
      {
        createPiFactory,
        executionMount: join(root, "mount"),
        localProxyLoopbackSeam: true,
        workspace: join(root, "workspace"),
      },
    );

    const updated: EffectiveRuntimeSnapshot = {
      ...base,
      instructions: { agent: "Session child instruction.", platform: "Session platform." },
      revision: {
        agent: { id: randomUUID(), sequence: 2 },
        session: { id: randomUUID(), sequence: 2 },
      },
    };
    const message = {
      type: "session:message:deliver" as const,
      requestId: randomUUID(),
      messageId: randomUUID(),
      sourceSessionId: randomUUID(),
      targetSessionId: delivery.sessionId,
      agentId: updated.agentId,
      placementGeneration: 2,
      content: { kind: "text" as const, text: "Continue the visible work." },
      runtime: updated,
    };
    await runCloudTurnWorker(
      sessionRequest(await fixtureExecution(root, "session-2"), { message, piSessionDirectory: continuity }),
      {
        createPiFactory,
        executionMount: join(root, "mount"),
        localProxyLoopbackSeam: true,
        workspace: join(root, "workspace"),
      },
    );

    expect(opened.map((entry) => entry.kind)).toEqual(["create", "resume"]);
    // The continuation resumes the exact binding and history from the Turn that created it.
    expect(opened[0]?.sessionId).toBeDefined();
    expect(opened[1]?.sessionId).toBe(opened[0]?.sessionId);
    expect(opened[0]?.sessionDirectory).toBe(opened[1]?.sessionDirectory);
    // The Session message runs on the current snapshot, not the snapshot that created the binding.
    expect(opened[0]?.systemPrompt).toContain("Base agent instruction.");
    expect(opened[1]?.systemPrompt).toContain("Session child instruction.");
    expect(opened[1]?.systemPrompt).toContain("Session platform.");
    expect(opened[1]?.systemPrompt).not.toContain("Base agent instruction.");
    expect(opened[1]?.inputText).toContain('<opentag-session-message-context source="managed">');
    expect(opened[1]?.inputText).toContain("Continue the visible work.");
    expect(opened[1]?.runId).toBe(`cloud-session-${message.messageId}`);
    // The continuation binding persists under the Session continuity directory, not scratch.
    await expect(readFile(join(continuity, "pi-binding.json"), "utf8")).resolves.toContain("pi");
  });
});
