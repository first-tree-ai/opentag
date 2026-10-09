import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAgentRuntimeFactory } from "../providers/claude-code/agent-runtime.js";
import type { ClaudeCodeProcessClient } from "../providers/claude-code/process-wire.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import type { InteractiveCodexAppServerClient } from "../providers/codex/app-server-wire.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";

function codexClient(request: InteractiveCodexAppServerClient["request"]): InteractiveCodexAppServerClient {
  return {
    request,
    close: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(),
    notify: vi.fn(),
    rejectServerRequest: vi.fn(),
    respondServerRequest: vi.fn(),
    subscribe: vi.fn(),
    subscribeServerRequests: vi.fn(),
  };
}

describe("native runtime options without model turns", () => {
  it("reads all Codex pages and the effective configured model rather than the directory default", async () => {
    const calls = vi.fn(async (method, params) => {
      if (method === "config/read") return { config: { model: "luna" } };
      expect(method).toBe("model/list");
      return params.cursor
        ? { data: [{ model: "luna", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null }
        : {
            data: [
              {
                model: "sol",
                isDefault: true,
                defaultReasoningEffort: "ultra",
                supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
              },
            ],
            nextCursor: "next",
          };
    });
    const client = codexClient(calls);
    const factory = new CodexAgentRuntimeFactory({ clientVersion: "test", createClient: () => client });
    expect(await factory.getConfigurationOptions({ cwd: "/workspace" })).toEqual({
      modelSuggestions: ["sol", "luna"],
      reasoningEffortAllowedValues: ["high"],
    });
    expect(calls).toHaveBeenCalledTimes(3);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("keeps unknown Codex models usable and closes malformed or cancelled queries", async () => {
    const client = codexClient(vi.fn().mockResolvedValue({ data: [{ model: "sol", supportedReasoningEfforts: [] }] }));
    const factory = new CodexAgentRuntimeFactory({ clientVersion: "test", createClient: () => client });
    expect(
      (await factory.getConfigurationOptions({ cwd: "/workspace", model: "private" })).reasoningEffortAllowedValues,
    ).toBeNull();
    vi.mocked(client.request).mockResolvedValue({ data: "bad" });
    await expect(factory.getConfigurationOptions({ cwd: "/workspace", model: "sol" })).rejects.toThrow();
    expect(client.close).toHaveBeenCalledTimes(2);
    const signal = AbortSignal.abort();
    await expect(factory.getConfigurationOptions({ cwd: "/workspace", signal })).rejects.toThrow();
  });

  it("rejects looping Codex pagination and returns unknown when effective config cannot be read", async () => {
    const client = codexClient(vi.fn().mockResolvedValue({ data: [], nextCursor: "loop" }));
    const factory = new CodexAgentRuntimeFactory({ clientVersion: "test", createClient: () => client });
    await expect(factory.getConfigurationOptions({ cwd: "/workspace" })).rejects.toThrow("repeated a cursor");
    vi.mocked(client.request).mockImplementation(async (method) => {
      if (method === "config/read") throw new Error("Older server");
      return { data: [{ model: "plain", supportedReasoningEfforts: [] }] };
    });
    expect((await factory.getConfigurationOptions({ cwd: "/workspace" })).reasoningEffortAllowedValues).toBeNull();
    expect(
      (await factory.getConfigurationOptions({ cwd: "/workspace", model: "plain" })).reasoningEffortAllowedValues,
    ).toEqual([]);
  });

  it("cancels hanging Claude initialization and closes its process", async () => {
    let finish: (() => void) | undefined;
    const process: ClaudeCodeProcessClient = {
      execute: vi.fn(
        () =>
          new Promise<{ stderr: string }>((resolve) => {
            finish = () => resolve({ stderr: "" });
          }),
      ),
      interrupt: vi.fn(),
      close: vi.fn(async () => {
        finish?.();
      }),
    };
    const controller = new AbortController();
    const query = new ClaudeCodeAgentRuntimeFactory({ createProcess: () => process }).getConfigurationOptions({
      cwd: "/workspace",
      signal: controller.signal,
    });
    controller.abort();
    await expect(query).rejects.toThrow();
    expect(process.close).toHaveBeenCalledOnce();
  });

  it("keeps Pi model options when older RPC cannot report thinking levels", async () => {
    const client = {
      request: vi.fn(async (command) => {
        if (command.type === "get_available_models") return { models: [{ provider: "a", id: "plain" }] };
        if (command.type === "get_state") return { model: { provider: "a", id: "plain" } };
        throw new Error("Unknown command");
      }),
      subscribe: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const factory = new PiAgentRuntimeFactory({ createClient: () => client });
    expect(await factory.getConfigurationOptions({ cwd: "/workspace" })).toEqual({
      modelSuggestions: ["a/plain"],
      reasoningEffortAllowedValues: null,
    });
  });

  it("rejects oversized Codex lists and treats an unset effective model as unknown", async () => {
    const client = codexClient(
      vi.fn().mockResolvedValue({ data: Array.from({ length: 4097 }, () => ({ model: "m" })) }),
    );
    const factory = new CodexAgentRuntimeFactory({ clientVersion: "test", createClient: () => client });
    await expect(factory.getConfigurationOptions({ cwd: "/workspace" })).rejects.toThrow("model limit");
    vi.mocked(client.request).mockImplementation(async (method) =>
      method === "config/read" ? { config: {} } : { data: [] },
    );
    expect((await factory.getConfigurationOptions({ cwd: "/workspace" })).reasoningEffortAllowedValues).toBeNull();
  });

  it.each(["rejected", "exited"])("cleans up a %s Claude metadata request", async (mode) => {
    const process: ClaudeCodeProcessClient = {
      execute: vi.fn(async (input, receive) => {
        if (mode === "rejected") {
          receive({ type: "system" });
          receive({ type: "control_response" });
          receive({ type: "control_response", response: { request_id: "other" } });
          receive({ type: "control_response", response: { request_id: input.request_id, subtype: "error" } });
        }
        return { stderr: "" };
      }),
      interrupt: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const factory = new ClaudeCodeAgentRuntimeFactory({
      createProcess: () => process,
      probeRunner: async () => ({ credential: true, streamJson: true, version: "test" }),
    });
    await expect(factory.getConfigurationOptions({ cwd: "/workspace" })).rejects.toThrow();
    expect(process.close).toHaveBeenCalledOnce();
    expect(await factory.probe({ configuration: { reasoningEffort: " " } })).toMatchObject({
      ready: false,
      issues: [{ code: "configuration_invalid" }],
    });
  });

  it("reports unknown Pi efforts without a selected model and handles a caller signal", async () => {
    const client = {
      request: vi.fn(async (command) => (command.type === "get_available_models" ? { models: [] } : { model: null })),
      subscribe: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    expect(
      await new PiAgentRuntimeFactory({ createClient: () => client }).getConfigurationOptions({
        cwd: "/workspace",
        signal: new AbortController().signal,
      }),
    ).toEqual({ modelSuggestions: [], reasoningEffortAllowedValues: null });
  });

  it("keeps executable wrapper arguments but excludes explicitly loaded Pi resources from metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-options-wrapper-"));
    const script = join(root, "rpc.mjs");
    const log = join(root, "args.json");
    try {
      await writeFile(
        script,
        `import { writeFileSync } from "node:fs"; import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
createInterface({ input: process.stdin }).on("line", line => { const c = JSON.parse(line); const data = c.type === "get_available_models" ? { models: [{ provider: "a", id: "plain" }] } : c.type === "get_state" ? { model: { provider: "a", id: "plain" } } : { levels: ["off"] }; process.stdout.write(JSON.stringify({ type: "response", command: c.type, id: c.id, success: true, data }) + "\\n"); });
`,
      );
      const factory = new PiAgentRuntimeFactory({
        process: {
          command: process.execPath,
          args: [script, "--skill", "/excluded", "-e", "/excluded", "--theme=/excluded"],
          env: { HOME: root, PATH: process.env.PATH },
        },
      });
      expect(await factory.getConfigurationOptions({ cwd: root })).toEqual({
        modelSuggestions: ["a/plain"],
        reasoningEffortAllowedValues: ["off"],
      });
      const args = JSON.parse(await readFile(log, "utf8"));
      expect(args).toContain("--no-session");
      expect(args).not.toContain("--skill");
      expect(args).not.toContain("-e");
      expect(args).not.toContain("--theme=/excluded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["opus[1m]", ["high", "max"]],
    ["haiku", null],
    ["plain", []],
    [undefined, null],
    ["private", null],
  ])("reads Claude initialization capabilities for %s", async (model, levels) => {
    let finish: (() => void) | undefined;
    const process: ClaudeCodeProcessClient = {
      execute: vi.fn((input, receive) => {
        receive({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: input.request_id,
            response: {
              models: [
                { value: "default", supportedEffortLevels: ["high"] },
                { value: "opus[1m]", supportsEffort: true, supportedEffortLevels: ["high", "max"] },
                { value: "haiku" },
                { value: "plain", supportsEffort: false },
              ],
            },
          },
        });
        return new Promise<{ stderr: string }>((_resolve, reject) => {
          finish = () => reject(new Error("metadata process closed"));
        });
      }),
      interrupt: vi.fn(),
      close: vi.fn(async () => {
        finish?.();
      }),
    };
    const createProcess = vi.fn(() => process);
    const factory = new ClaudeCodeAgentRuntimeFactory({ createProcess });
    expect(await factory.getConfigurationOptions({ cwd: "/workspace", model })).toEqual({
      modelSuggestions: ["opus[1m]", "haiku", "plain"],
      reasoningEffortAllowedValues: levels,
    });
    expect(createProcess.mock.calls[0]?.length).toBeGreaterThan(0);
    expect(process.execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "control_request", request: { subtype: "initialize", hooks: {} } }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(process.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, "a/same", "same", "private"])(
    "uses Pi startup model selection without persistent RPC setters (%s)",
    async (model) => {
      const request = vi.fn(async (command) => {
        if (command.type === "get_available_models")
          return {
            models: [
              { provider: "a", id: "same" },
              { provider: "b", id: "same" },
            ],
          };
        if (command.type === "get_state") return { model: { provider: "a", id: "same" } };
        if (command.type === "get_available_thinking_levels") return { levels: ["off", "max"] };
        throw new Error("Metadata query must not send mutating commands");
      });
      const client = { request, subscribe: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      const createClient = vi.fn((_cwd: string, _args: readonly string[]) => client);
      const factory = new PiAgentRuntimeFactory({ createClient });
      expect(await factory.getConfigurationOptions({ cwd: "/workspace", model })).toEqual({
        modelSuggestions: ["a/same", "b/same"],
        reasoningEffortAllowedValues: model === "private" ? null : ["off", "max"],
      });
      const args = createClient.mock.calls[0]?.[1];
      expect(args).toEqual(expect.arrayContaining(["--no-session", "--no-extensions", "--offline"]));
      expect(args).not.toContain("--session-id");
      if (model) expect(args).toEqual(expect.arrayContaining(["--model", model]));
      else expect(args).not.toContain("--model");
      expect(client.close).toHaveBeenCalledOnce();
    },
  );
});
