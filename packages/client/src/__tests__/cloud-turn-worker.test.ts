import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCloudTurnWorkerRequest } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPromptRequest } from "../agent-runtime/types.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import type { PiRpcClient } from "../providers/pi/rpc-wire.js";
import {
  type CloudTurnPiFactory,
  type CloudTurnPiRuntime,
  cloudTurnPiDocuments,
  renderCloudSystemPrompt,
  runCloudTurnWorker,
} from "../runner/cloud-turn-worker.js";
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
      environment: { HTTPS_PROXY: "http://127.0.0.1:18080", https_proxy: "http://127.0.0.1:18080" },
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
    expect(prompt).not.toContain("Agent Home");
    expect(prompt).not.toContain("Context Tree");
    expect(prompt).not.toContain("shared across this Agent's Sessions");
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
      // The published manifest loopback seam is applied, not the parent's ambient proxy.
      expect(entry.environment.HTTPS_PROXY).toBe("http://127.0.0.1:18080");
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
      JSON.stringify({ environment: { HTTPS_PROXY: "http://127.0.0.1:9999" }, executionId: "fixture" }),
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
    expect(observed.fileContent).not.toContain("MASTER");
    // The per-turn secret file is scratch-only: never part of the persistent Pi continuity dir.
    expect(observed.environmentFile?.startsWith(continuity)).toBe(false);
    await expect(stat(observed.environmentFile as string)).rejects.toThrow();
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
