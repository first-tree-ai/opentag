import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  RunnerCloudSessionWorkerRequest,
  RunnerCloudTurnWorkerRequest,
  RunnerCloudWorkerRequest,
  RuntimeImOutboxContext,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import type { CloudTurnWorkerRunOptions } from "../runner/cloud-turn-worker.js";
import type { WorkerIo } from "../runner/worker.js";
import { runRunnerWorker } from "../runner/worker.js";
import type { TurnCompletion } from "../runtime/agent-turn-runner.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const MODEL = {
  baseUrl: "https://server.example.test/api/v1/cloud-model",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  model: "fixture-model",
  token: "fixture-execution-token-0123456789abcdef",
  contextWindow: 258_000 as const,
  maxTokens: 8_192,
};

const COMPLETION: TurnCompletion = { executionEffects: "completed", finalText: "done", outcome: "completed" };

function io(payload: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  (stdin as { destroy?: () => void }).destroy = () => undefined;
  queueMicrotask(() => {
    stdin.emit("data", Buffer.from(payload));
    stdin.emit("end");
  });
  const workerIo: WorkerIo = {
    stdin,
    stderr: { write: (chunk) => void stderr.push(chunk) },
    stdout: { write: (chunk: string) => void stdout.push(chunk) },
  };
  return { stdout, stderr, workerIo };
}

function cloudRunner() {
  return vi.fn(async (_request: RunnerCloudWorkerRequest, _options: CloudTurnWorkerRunOptions) => COMPLETION);
}

function sessionRequest(overrides: Partial<RunnerCloudSessionWorkerRequest> = {}): RunnerCloudSessionWorkerRequest {
  const delivery = cloudDeliveryFixture();
  const runtime = delivery.runtime;
  return {
    kind: "session-message",
    executionDir: "/run/opentag-execution/session-1",
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
      content: { kind: "text", text: "Report progress." },
      runtime,
    },
    ...overrides,
  };
}

function turnRequest(): RunnerCloudTurnWorkerRequest {
  return {
    kind: "turn",
    delivery: cloudDeliveryFixture(),
    executionDir: "/run/opentag-execution/turn-1",
    model: MODEL,
  };
}

const OUTBOX: RuntimeImOutboxContext = {
  channelId: "C0EXAMPLE",
  provider: "slack",
  sessionKind: "channel",
};

describe("runRunnerWorker cloud request parsing", () => {
  it("preserves the original preparation failure on stderr and the existing stdout protocol", async () => {
    const output = io(JSON.stringify(turnRequest()));
    const code = await runRunnerWorker(output.workerIo, {
      runCloudTurn: async () => {
        throw Object.assign(new Error("secret payload"), { code: "ENOENT" });
      },
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.stdout.join(""))).toEqual({
      kind: "error",
      code: "worker_failed",
      message: "The in-sandbox Turn worker failed",
    });
    expect(output.stderr.join("")).toContain('"event":"failure"');
    expect(output.stderr.join("")).toContain('"errorCode":"ENOENT"');
    expect(output.stderr.join("")).not.toContain("secret payload");
  });

  it("retains the real incompatible persisted Pi binding error before any Pi process starts", async () => {
    const output = io(JSON.stringify(turnRequest()));
    const code = await runRunnerWorker(output.workerIo, {
      runCloudTurn: async () => {
        const factory = new PiAgentRuntimeFactory({
          createClient: () => {
            throw new Error("Pi must not start");
          },
        });
        await factory.resume({
          binding: { providerId: "pi", schemaVersion: 1, payload: { sessionId: "invalid" } },
          eventSink: () => undefined,
          systemPrompt: "fixture",
          workspace: { cwd: "/workspace" },
          policy: {
            fileSystem: "read-only",
            network: "disabled",
            approvals: "never",
            tools: { mode: "provider-default" },
          },
        });
        throw new Error("invalid binding must reject");
      },
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({ kind: "error", code: "worker_failed" });
    const failure = output.stderr
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("opentag-pi-diagnostic:"))
      .map((line) => JSON.parse(line.slice("opentag-pi-diagnostic:".length)))
      .find((record) => record.event === "failure");
    expect(failure).toMatchObject({
      phase: "worker_preparation",
      error: { name: "AgentRuntimeError", errorCode: "binding_incompatible", messageOrigin: "omitted" },
    });
  });

  it("routes an internal session-message document to the Cloud worker", async () => {
    const runCloudTurn = cloudRunner();
    const output = io(JSON.stringify(sessionRequest()));
    const code = await runRunnerWorker(output.workerIo, { runCloudTurn });
    expect(code).toBe(0);
    expect(runCloudTurn).toHaveBeenCalledTimes(1);
    expect(runCloudTurn.mock.calls[0]?.[0]).toMatchObject({ kind: "session-message", sessionKind: "internal" });
    expect(JSON.parse(output.stdout.join(""))).toEqual({ kind: "result", completion: COMPLETION });
  });

  it("preserves the existing turn document routing", async () => {
    const runCloudTurn = cloudRunner();
    const output = io(JSON.stringify(turnRequest()));
    const code = await runRunnerWorker(output.workerIo, { runCloudTurn });
    expect(code).toBe(0);
    expect(runCloudTurn.mock.calls[0]?.[0]).toMatchObject({ kind: "turn" });
  });

  it("rejects a visible session-message without outbox context before any Pi work", async () => {
    const runCloudTurn = cloudRunner();
    const output = io(JSON.stringify(sessionRequest({ sessionKind: "visible" })));
    const code = await runRunnerWorker(output.workerIo, { runCloudTurn });
    expect(code).toBe(2);
    expect(runCloudTurn).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({ kind: "error", code: "worker_request_invalid" });
  });

  it("rejects an internal session-message that carries outbox context", async () => {
    const runCloudTurn = cloudRunner();
    const output = io(JSON.stringify(sessionRequest({ outboxContext: OUTBOX })));
    const code = await runRunnerWorker(output.workerIo, { runCloudTurn });
    expect(code).toBe(2);
    expect(runCloudTurn).not.toHaveBeenCalled();
  });

  it("rejects a session-message with unknown fields instead of inferring IM input", async () => {
    const runCloudTurn = cloudRunner();
    const output = io(JSON.stringify({ ...sessionRequest(), delivery: cloudDeliveryFixture() }));
    const code = await runRunnerWorker(output.workerIo, { runCloudTurn });
    expect(code).toBe(2);
    expect(runCloudTurn).not.toHaveBeenCalled();
  });

  it("accepts a visible session-message with its real outbox context", async () => {
    const runCloudTurn = cloudRunner();
    const output = io(JSON.stringify(sessionRequest({ outboxContext: OUTBOX, sessionKind: "visible" })));
    const code = await runRunnerWorker(output.workerIo, { runCloudTurn });
    expect(code).toBe(0);
    expect(runCloudTurn.mock.calls[0]?.[0]).toMatchObject({ kind: "session-message", sessionKind: "visible" });
  });
});
