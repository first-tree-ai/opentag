import { randomUUID } from "node:crypto";
import type { DirectImMessageDeliveryRequest, EffectiveRuntimeSnapshot, RuntimeUsage } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenTagRuntimeContext,
  CODEX_V0_APP_SERVER_ARGS,
  CodexAdapter,
  CodexLocalPolicy,
  type CodexTraceItemType,
  type CodexTraceSink,
  type CodexTurnError,
  type CodexTurnOutcome,
  codexProviderEnvironment,
} from "../providers/codex/adapter.js";
import type { CodexAppServerClient, CodexAppServerMessage } from "../providers/codex/app-server-wire.js";

describe("CodexAdapter", () => {
  it("D-01/D-02/D-03/D-05/D-07 maps a first Turn and replays early notifications after durable IDs", async () => {
    const journal: string[] = [];
    const client = new ScriptedClient({ journal });
    const trace = new TraceJournal(journal);
    const adapter = new CodexAdapter({ clientVersion: "0.0.1", createClient: () => client });
    const request = delivery();

    const result = await adapter.runTurn({
      request,
      cwd: "/runtime/agent/files",
      agentsFile: "/runtime/agent/AGENTS.md",
      trace,
      onThreadReady: (threadId) => {
        journal.push(`persist-thread:${threadId}`);
      },
      onTurnStarted: (turnId) => {
        journal.push(`persist-turn:${turnId}`);
      },
    });

    expect(result).toEqual({
      outcome: "completed",
      finalText: "final answer",
      providerThreadId: "thread-1",
      providerTurnId: "provider-turn-1",
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
    });
    expect(client.calls.map((call) => call.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(client.calls[2]?.params).toMatchObject({
      cwd: "/runtime/agent",
      ephemeral: false,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const turn = client.calls[3]?.params as { input: Array<{ type: string; text: string }>; sandboxPolicy: unknown };
    expect(turn.input).toHaveLength(2);
    expect(turn.input[0]).toEqual({ type: "text", text: buildOpenTagRuntimeContext(request) });
    expect(turn.input[1]).toEqual({ type: "text", text: request.content.text });
    expect(turn.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/runtime/agent/files"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    expect(journal.indexOf("persist-turn:provider-turn-1")).toBeLessThan(journal.indexOf("trace:turn_started"));
    expect(trace.events).not.toContain("commentary should not be exported");
    expect(client.closed).toBe(true);
  });

  it("D-22 resumes the exact persisted Thread in a fresh App Server process", async () => {
    const client = new ScriptedClient();
    const adapter = new CodexAdapter({ clientVersion: "0.0.1", createClient: () => client });
    await adapter.runTurn({
      request: delivery(),
      cwd: "/runtime/agent/files",
      agentsFile: "/runtime/agent/AGENTS.md",
      providerThreadId: "thread-1",
      onThreadReady: () => undefined,
      onTurnStarted: () => undefined,
    });
    expect(client.calls.map((call) => call.method)).toContain("thread/resume");
    expect(client.calls.map((call) => call.method)).not.toContain("thread/start");
    expect(client.calls.find((call) => call.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread-1",
    });
  });

  it("D-25 fails a rejected Resume without falling back to thread/start", async () => {
    const client = new ScriptedClient({ resumeFailure: true });
    const adapter = new CodexAdapter({ clientVersion: "0.0.1", createClient: () => client });
    await expect(
      adapter.runTurn({
        request: delivery(),
        cwd: "/runtime/agent/files",
        agentsFile: "/runtime/agent/AGENTS.md",
        providerThreadId: "thread-missing",
        onThreadReady: () => undefined,
        onTurnStarted: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "session_resume_failed", executionEffects: "not_started" });
    expect(client.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(client.calls.some((call) => call.method === "thread/start")).toBe(false);
  });

  it("D-06/D-12 fails a conflicting early Turn ID as unknown and never retries turn/start", async () => {
    const client = new ScriptedClient({ terminalTurnId: "wrong-turn" });
    const adapter = new CodexAdapter({ clientVersion: "0.0.1", createClient: () => client });
    await expect(
      adapter.runTurn({
        request: delivery(),
        cwd: "/runtime/agent/files",
        agentsFile: "/runtime/agent/AGENTS.md",
        onThreadReady: () => undefined,
        onTurnStarted: () => undefined,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CodexTurnError>>({
        reason: "turn_state_unknown",
        executionEffects: "may_have_occurred",
      }),
    );
    expect(client.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });

  it("D-10/D-11 interrupts and closes an accepted Turn when its total signal aborts", async () => {
    const client = new ScriptedClient({ noTerminal: true });
    const adapter = new CodexAdapter({ clientVersion: "0.0.1", createClient: () => client });
    const abort = new AbortController();
    const turn = adapter.runTurn({
      request: delivery(),
      cwd: "/runtime/agent/files",
      agentsFile: "/runtime/agent/AGENTS.md",
      signal: abort.signal,
      onThreadReady: () => undefined,
      onTurnStarted: () => undefined,
    });
    await vi.waitFor(() => expect(client.calls.some((call) => call.method === "turn/start")).toBe(true));
    abort.abort("turn_timeout");
    await expect(turn).rejects.toMatchObject({ reason: "turn_timeout", executionEffects: "may_have_occurred" });
    expect(client.interrupts).toBe(1);
    expect(client.closed).toBe(true);
  });

  it("D-04 applies a fail-closed local Tool, Network and Reasoning policy", () => {
    const policy = new CodexLocalPolicy();
    const runtime = snapshot();
    expect(policy.validate(runtime)).toBeUndefined();
    expect(policy.validate({ ...runtime, allowedTools: ["browser"] })).toBe("configuration_unsupported");
    expect(policy.validate({ ...runtime, execution: { approvalPolicy: "never", networkAccess: true } })).toBe(
      "configuration_unsupported",
    );
    expect(policy.validate({ ...runtime, reasoningEffort: "unbounded" })).toBe("configuration_unsupported");
  });

  it("D-14 passes only an explicit provider environment allowlist", () => {
    expect(
      codexProviderEnvironment({
        HOME: "/home/provider",
        PATH: "/bin",
        CODEX_HOME: "/home/provider/.codex",
        OPENAI_API_KEY: "canary-api-key",
        OPENTAG_ACCESS_TOKEN: "canary-opentag-token",
        RANDOM_SECRET: "canary-secret",
      }),
    ).toEqual({ HOME: "/home/provider", PATH: "/bin", CODEX_HOME: "/home/provider/.codex" });
  });

  it("D-04/D-14 disables non-V0 tools, memory, web search, login shells, and secret-bearing command env", () => {
    const args = CODEX_V0_APP_SERVER_ARGS.join("\n");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("memories.use_memories=false");
    expect(args).toContain("memories.generate_memories=false");
    expect(args).toContain("allow_login_shell=false");
    expect(args).toContain(
      'shell_environment_policy.filters={ PATH = "include", LANG = "include", LC_ALL = "include" }',
    );
    expect(args).toContain("goals");
  });
});

interface ScriptedClientOptions {
  journal?: string[];
  noTerminal?: boolean;
  resumeFailure?: boolean;
  terminalTurnId?: string;
}

class ScriptedClient implements CodexAppServerClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly #journal: string[];
  readonly #options: ScriptedClientOptions;
  #listener?: (message: CodexAppServerMessage) => void;
  closed = false;
  interrupts = 0;

  constructor(options: ScriptedClientOptions = {}) {
    this.#options = options;
    this.#journal = options.journal ?? [];
  }

  async initialize(clientVersion: string): Promise<void> {
    this.calls.push({ method: "initialize", params: { clientVersion } });
    this.calls.push({ method: "initialized", params: {} });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/resume" && this.#options.resumeFailure) throw new Error("rollout missing");
    if (method === "thread/start" || method === "thread/resume") {
      const record = params as { cwd: string; model?: string; threadId?: string };
      return {
        thread: { id: record.threadId ?? "thread-1", ephemeral: false },
        cwd: record.cwd,
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", networkAccess: false },
        instructionSources: ["/runtime/agent/AGENTS.md"],
        model: record.model ?? "default-model",
      };
    }
    if (method === "turn/start") {
      this.#journal.push("provider:turn-start");
      const turnId = "provider-turn-1";
      if (this.#options.noTerminal) return { turn: { id: turnId, status: "inProgress", items: [] } };
      this.#emit({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: turnId, status: "inProgress", items: [] } },
      });
      this.#emit({
        method: "item/completed",
        params: {
          completedAtMs: 1,
          threadId: "thread-1",
          turnId,
          item: {
            id: "commentary-1",
            type: "agentMessage",
            phase: "commentary",
            text: "commentary should not be exported",
          },
        },
      });
      this.#emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "stale-provider-turn",
          tokenUsage: {
            last: { inputTokens: 999, cachedInputTokens: 999, outputTokens: 999 },
          },
        },
      });
      this.#emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId,
          tokenUsage: {
            last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
          },
        },
      });
      this.#emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: this.#options.terminalTurnId ?? turnId,
            status: "completed",
            items: [
              { id: "legacy-1", type: "agentMessage", phase: null, text: "legacy answer" },
              { id: "final-1", type: "agentMessage", phase: "final_answer", text: "final answer" },
            ],
          },
        },
      });
      return { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    throw new Error(`Unexpected method: ${method}`);
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.calls.push({ method, params });
  }

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  #emit(message: CodexAppServerMessage): void {
    this.#listener?.(message);
  }
}

class TraceJournal implements CodexTraceSink {
  readonly events: string[] = [];
  readonly #journal: string[];

  constructor(journal: string[]) {
    this.#journal = journal;
  }

  turnStarted(): void {
    this.#journal.push("trace:turn_started");
    this.events.push("turn_started");
  }

  itemCompleted(itemType: CodexTraceItemType, status: "completed" | "failed"): void {
    this.events.push(`item:${itemType}:${status}`);
  }

  usageUpdated(usage: RuntimeUsage): void {
    this.events.push(`usage:${usage.outputTokens}`);
  }

  warning(code: string, message: string): void {
    this.events.push(`warning:${code}:${message}`);
  }

  turnCompleted(outcome: CodexTurnOutcome): void {
    this.events.push(`completed:${outcome}`);
  }
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    model: "gpt-5.6-codex",
    reasoningEffort: "high",
    instructions: { platform: "platform", agent: "agent", session: "session-only" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function delivery(): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: "delivery-1",
    imMessageId: "message-1",
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text: "raw direct text" },
    runtime: snapshot(),
  };
}
