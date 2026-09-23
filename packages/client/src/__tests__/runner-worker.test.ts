import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  RunnerCloudSessionWorkerRequest,
  RunnerCloudTurnWorkerRequest,
  RunnerCloudWorkerRequest,
  RuntimeImOutboxContext,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
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
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  (stdin as { destroy?: () => void }).destroy = () => undefined;
  queueMicrotask(() => {
    stdin.emit("data", Buffer.from(payload));
    stdin.emit("end");
  });
  const workerIo: WorkerIo = {
    stdin,
    stderr: { write: () => undefined },
    stdout: { write: (chunk: string) => void stdout.push(chunk) },
  };
  return { stdout, workerIo };
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
