import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderError, AgentRuntimeError } from "../agent-runtime/errors.js";
import type {
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeEventSink,
  AgentRuntimeFactory,
  CreateAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";
import {
  AgentRuntimeAvailabilityTester,
  agentRuntimeAvailabilityPolicy,
} from "../runtime/agent-runtime-availability-tester.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AgentRuntimeAvailabilityTester", () => {
  it("fails closed before creating a runtime when cancelled or when the provider is unknown", async () => {
    const factories = new Map<string, AgentRuntimeFactory>();
    const tester = new AgentRuntimeAvailabilityTester({ factories });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(tester.run(testRequest("codex"), cancelled.signal)).resolves.toMatchObject({
      status: "failed",
      code: "cancelled",
    });
    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toMatchObject({
      status: "failed",
      code: "provider_start_failed",
    });
  });

  it("handles a signal that becomes aborted between the initial check and the race", async () => {
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads > 1;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const factory = scriptedFactory({ prompt: () => new Promise(() => undefined) });
    const tester = new AgentRuntimeAvailabilityTester({ factories: new Map([["codex", factory]]), timeoutMs: 5_000 });
    await expect(tester.run(testRequest("codex"), signal)).resolves.toMatchObject({
      status: "failed",
      code: "cancelled",
    });
  });

  it("uses a Codex policy the real factory accepts and rejects read-only plus network", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "opentag-runtime-test-policy-"));
    directories.push(cwd);
    let validated = false;
    const factory = new CodexAgentRuntimeFactory({
      clientVersion: "0.0.1-test",
      createClient: () => {
        validated = true;
        throw new Error("stop-after-validate");
      },
    });
    const request = {
      eventSink: () => undefined,
      systemPrompt: "You are running a bounded OpenTag availability test. Reply with only the requested token.",
      workspace: { cwd },
      policy: agentRuntimeAvailabilityPolicy("codex"),
    };
    await expect(factory.create(request)).rejects.toThrow("stop-after-validate");
    expect(validated).toBe(true);
    await expect(
      factory.create({
        ...request,
        policy: {
          fileSystem: "read-only",
          network: "enabled",
          approvals: "never",
          tools: { mode: "provider-default" },
        },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
  });

  it("passes only when the local sentinel matches and keeps model text off the result", async () => {
    const sentinelHolder = { value: "" };
    const factory = scriptedFactory({
      prompt: async (request) => {
        sentinelHolder.value = String(request.input.items[0]?.text ?? "").match(/exactly ([a-f0-9]{32})/)?.[1] ?? "";
        return completed(sentinelHolder.value);
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["codex", factory]]),
    });
    const result = await tester.run(testRequest("codex"), new AbortController().signal);
    expect(result).toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "passed",
    });
    expect(JSON.stringify(result)).not.toContain(sentinelHolder.value);
    expect(factory.closed).toBe(true);
    expect(factory.policy).toEqual(agentRuntimeAvailabilityPolicy("codex"));
  });

  it("fails tool activity immediately even when prompt ignores AbortSignal", async () => {
    const factory = scriptedFactory({
      prompt: async (_request, sink) => {
        await sink({
          type: "interaction_requested",
          runId: "run-1",
          request: { requestId: "interaction-1", kind: "approval", title: "Approve" },
        });
        return new Promise(() => undefined);
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["codex", factory]]),
      timeoutMs: 5_000,
      cleanupMs: 20,
    });
    const startedAt = Date.now();
    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      code: "interaction_or_tool",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("returns timeout when prompt ignores AbortSignal", async () => {
    const factory = scriptedFactory({
      prompt: () => new Promise(() => undefined),
    });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["codex", factory]]),
      timeoutMs: 30,
      cleanupMs: 20,
    });
    const startedAt = Date.now();
    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      code: "timeout",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("closes a runtime that finishes creating after the hard timeout", async () => {
    let resolveCreate!: (runtime: AgentRuntime) => void;
    const delayedCreate = new Promise<AgentRuntime>((resolve) => {
      resolveCreate = resolve;
    });
    const factory = scriptedFactory({ create: () => delayedCreate });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["codex", factory]]),
      timeoutMs: 30,
      cleanupMs: 20,
    });

    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      code: "timeout",
    });
    expect(factory.closed).toBe(false);

    resolveCreate(factory.runtime);
    await vi.waitFor(() => expect(factory.closed).toBe(true));
  });

  it("rejects non-positive timeout and cleanup budgets", () => {
    const factories = new Map();
    expect(() => new AgentRuntimeAvailabilityTester({ factories, timeoutMs: 0 })).toThrow(
      "Agent Runtime availability test timeout must be a positive safe integer",
    );
    expect(() => new AgentRuntimeAvailabilityTester({ factories, cleanupMs: 0 })).toThrow(
      "Agent Runtime availability test cleanup budget must be a positive safe integer",
    );
  });

  it("maps prompt throw after tool activity to interaction_or_tool", async () => {
    const factory = scriptedFactory({
      prompt: async (_request, sink) => {
        await sink({
          type: "tool_started",
          runId: "run-1",
          toolCallId: "tool-1",
          name: "shell",
        });
        throw new Error("provider crashed after tool");
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["codex", factory]]),
      timeoutMs: 5_000,
      cleanupMs: 20,
    });
    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      code: "interaction_or_tool",
    });
  });

  it("maps a post-start prompt throw without tools to provider_failed", async () => {
    const factory = scriptedFactory({
      prompt: async () => {
        throw new Error("model transport failed");
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["codex", factory]]),
      timeoutMs: 5_000,
      cleanupMs: 20,
    });
    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      code: "provider_failed",
    });
  });

  it("maps an AbortError and every terminal run shape without leaking provider output", async () => {
    const abortFactory = scriptedFactory({
      prompt: async () => {
        const error = new Error("transport aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({ factories: new Map([["codex", abortFactory]]) });
    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toMatchObject({
      status: "failed",
      code: "timeout",
    });

    for (const [run, expectedCode] of [
      [
        { runId: "run-1", status: "completed", error: { code: "provider_start_failed" }, output: [] },
        "provider_start_failed",
      ],
      [{ runId: "run-1", status: "failed", output: [] }, "provider_failed"],
      [{ runId: "run-1", status: "completed", output: [{ type: "text", text: "wrong sentinel" }] }, "provider_failed"],
    ] as const) {
      const factory = scriptedFactory({ prompt: async () => run as AgentRunResult });
      const current = new AgentRuntimeAvailabilityTester({ factories: new Map([["codex", factory]]) });
      await expect(current.run(testRequest("codex"), new AbortController().signal)).resolves.toMatchObject({
        status: "failed",
        code: expectedCode,
      });
    }
  });

  it("passes model and reasoning options through the request and handles interaction events", async () => {
    const factory = scriptedFactory({
      createRequest: (request) => {
        expect(request.configuration).toEqual({ model: "test-model", reasoningEffort: "low" });
      },
      prompt: async (_request, sink) => {
        await sink({
          type: "tool_started",
          runId: "run-1",
          toolCallId: "tool-1",
          name: "shell",
        });
        return completed("ignored");
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({ factories: new Map([["codex", factory]]) });
    await expect(
      tester.run(
        { ...testRequest("codex"), model: "test-model", reasoningEffort: "low" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "failed", code: "interaction_or_tool" });
  });

  it("maps AgentRuntimeError create failures to provider_start_failed", async () => {
    for (const code of ["create_failed", "configuration_invalid"] as const) {
      const factory = scriptedFactory({
        create: async () => {
          throw new AgentRuntimeError(code, `${code} from factory`);
        },
      });
      const tester = new AgentRuntimeAvailabilityTester({
        factories: new Map([["codex", factory]]),
      });
      await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toEqual({
        type: "agent-runtime:test:result",
        requestId: "11111111-1111-4111-8111-111111111111",
        status: "failed",
        code: "provider_start_failed",
      });
    }
  });

  it("classifies an untyped create failure as a provider start failure", async () => {
    const factory = scriptedFactory({
      create: async () => {
        throw new Error("spawn failed");
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({ factories: new Map([["codex", factory]]) });
    await expect(tester.run(testRequest("codex"), new AbortController().signal)).resolves.toMatchObject({
      status: "failed",
      code: "provider_start_failed",
    });
  });

  it("fails start failures without leaking diagnostics and does not resume a Session binding", async () => {
    const startFactory = scriptedFactory({
      create: async () => {
        throw new AgentProviderError("provider_start_failed", "spawn failed: ENOENT /secret/path");
      },
    });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["claude-code", startFactory]]),
    });
    const startFailure = await tester.run(testRequest("claude-code"), new AbortController().signal);
    expect(startFailure).toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      code: "provider_start_failed",
    });
    expect(JSON.stringify(startFailure)).not.toContain("/secret/path");
    expect(startFactory.resume).not.toHaveBeenCalled();
    expect(startFactory.policy).toEqual(agentRuntimeAvailabilityPolicy("claude-code"));
  });

  it("maps abort to cancelled even when prompt ignores AbortSignal", async () => {
    const factory = scriptedFactory({
      prompt: () => new Promise(() => undefined),
    });
    const tester = new AgentRuntimeAvailabilityTester({
      factories: new Map([["codex", factory]]),
      timeoutMs: 5_000,
      cleanupMs: 20,
    });
    const controller = new AbortController();
    const pending = tester.run(testRequest("codex"), controller.signal);
    await vi.waitFor(() => expect(factory.created).toBe(true));
    controller.abort();
    await expect(pending).resolves.toEqual({
      type: "agent-runtime:test:result",
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      code: "cancelled",
    });
  });
});

function testRequest(provider: "codex" | "claude-code") {
  return {
    type: "agent-runtime:test" as const,
    requestId: "11111111-1111-4111-8111-111111111111",
    computerId: "22222222-2222-4222-8222-222222222222",
    provider,
  };
}

function completed(text: string): AgentRunResult {
  return {
    runId: "run-1",
    status: "completed",
    output: [{ type: "text", text }],
  };
}

function scriptedFactory(options: {
  create?: (request: CreateAgentRuntimeRequest) => Promise<AgentRuntime>;
  createRequest?: (request: CreateAgentRuntimeRequest) => void;
  prompt?: (request: Parameters<AgentRuntime["prompt"]>[0], sink: AgentRuntimeEventSink) => Promise<AgentRunResult>;
}) {
  const closed = { current: false };
  const created = { current: false };
  const policy = { current: undefined as CreateAgentRuntimeRequest["policy"] | undefined };
  const resume = vi.fn(async () => {
    throw new Error("availability tester must not resume a Session binding");
  });
  let sink: AgentRuntimeEventSink = () => undefined;
  const runtime: AgentRuntime = {
    manifest: {
      providerId: "codex",
      displayName: "Codex",
      contractVersion: 2,
      bindingSchemaVersion: 1,
    },
    capabilities: { steer: "unsupported", interactions: "unsupported" },
    state: { phase: "idle", queuedRunCount: 0 },
    binding: undefined,
    prompt: (request) => options.prompt?.(request, sink) ?? Promise.resolve(completed("nope")),
    steer: async () => undefined,
    followUp: async () => completed("nope"),
    respond: async () => undefined,
    abort: async () => undefined,
    waitForIdle: async () => undefined,
    close: async () => {
      closed.current = true;
    },
  };
  const factory = {
    manifest: runtime.manifest,
    probe: async () => ({ ready: true, issues: [] }),
    create: async (request: CreateAgentRuntimeRequest) => {
      created.current = true;
      policy.current = request.policy;
      sink = request.eventSink;
      options.createRequest?.(request);
      if (options.create) return options.create(request);
      return runtime;
    },
    resume,
    get closed() {
      return closed.current;
    },
    get created() {
      return created.current;
    },
    get policy() {
      return policy.current;
    },
    get runtime() {
      return runtime;
    },
  } satisfies AgentRuntimeFactory & {
    closed: boolean;
    created: boolean;
    policy: CreateAgentRuntimeRequest["policy"] | undefined;
    resume: typeof resume;
    runtime: AgentRuntime;
  };
  return factory;
}
