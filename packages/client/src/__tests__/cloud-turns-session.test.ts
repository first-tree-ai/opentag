import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunnerClientFrame,
  RunnerCloudDeliveryRunFrame,
  RunnerCloudDeliveryVerifiedFrame,
  RunnerCloudModelGrant,
  RunnerCloudSessionMessageRunFrame,
  RunnerCloudSessionMessageSettledAckFrame,
  RunnerCloudSessionMessageVerifiedFrame,
  RuntimeImOutboxContext,
  SessionCliProofGrant,
  SessionMessageDeliveryRequest,
} from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudJournal } from "../runner/cloud-journal.js";
import { CloudTurnRunner, type CloudTurnScope } from "../runner/cloud-turns.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const MODEL_GRANT: RunnerCloudModelGrant = {
  baseUrl: "https://server.example.com/api/v1/cloud-model",
  model: "deepseek-v4.1-flash-expires-on-0910",
  token: "unit-execution-token-0123456789abcdef",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

const PROOF: SessionCliProofGrant = { proofId: randomUUID(), token: "p".repeat(40) };

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function completedExec(text = "done"): ExecResult {
  return {
    code: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      kind: "result",
      completion: { outcome: "completed", executionEffects: "completed", finalText: text },
    })}\n`,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function sessionMessage(overrides: Partial<SessionMessageDeliveryRequest> = {}): SessionMessageDeliveryRequest {
  const runtime = cloudDeliveryFixture().runtime;
  const messageId = overrides.messageId ?? randomUUID();
  return {
    type: "session:message:deliver",
    requestId: messageId,
    messageId,
    sourceSessionId: randomUUID(),
    targetSessionId: randomUUID(),
    agentId: runtime.agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "child task" },
    runtime,
    ...overrides,
  };
}

function sessionRunFrame(
  message: SessionMessageDeliveryRequest,
  sessionKind: "internal" | "visible" = "internal",
  outboxContext?: RuntimeImOutboxContext,
): RunnerCloudSessionMessageRunFrame {
  return {
    type: "session:message:run",
    requestId: message.requestId,
    message,
    sessionKind,
    ...(outboxContext ? { outboxContext } : {}),
  };
}

function sessionVerifiedFrame(requestId: string, model: RunnerCloudModelGrant | undefined = MODEL_GRANT) {
  return {
    type: "session:message:verified",
    requestId,
    status: "verified",
    ...(model ? { model } : {}),
  } satisfies RunnerCloudSessionMessageVerifiedFrame;
}

function deliveryRunFrame(delivery: ReturnType<typeof cloudDeliveryFixture>): RunnerCloudDeliveryRunFrame {
  return { type: "delivery:run", requestId: delivery.requestId, delivery };
}

function deliveryVerifiedFrame(requestId: string): RunnerCloudDeliveryVerifiedFrame {
  return { type: "delivery:verified", requestId, status: "verified", model: MODEL_GRANT };
}

function settledOf(sent: RunnerClientFrame[]) {
  return sent.filter((frame) => frame.type === "session:message:settled") as Extract<
    RunnerClientFrame,
    { type: "session:message:settled" }
  >[];
}

function sessionReceiptsOf(sent: RunnerClientFrame[]) {
  return sent.filter((frame) => frame.type === "session:message:received") as Extract<
    RunnerClientFrame,
    { type: "session:message:received" }
  >[];
}

describe("CloudTurnRunner Session collaboration", () => {
  let directory: string;
  let journal: CloudJournal;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cloud-turns-session-"));
    journal = await CloudJournal.open(join(directory, "journal"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function harness(
    options: {
      message?: SessionMessageDeliveryRequest;
      sessionKind?: "internal" | "visible";
      outboxContext?: RuntimeImOutboxContext;
      proof?: SessionCliProofGrant;
      worker?: (input: { stdin: string; timeoutMs: number }, signal: AbortSignal) => Promise<ExecResult>;
      runnerOptions?: Partial<ConstructorParameters<typeof CloudTurnRunner>[0]>;
    } = {},
  ) {
    const message = options.message ?? sessionMessage();
    const scope: CloudTurnScope = {
      sandboxId: randomUUID(),
      sessionId: message.targetSessionId,
      environmentGeneration: 1,
      resourceName: "projects/p/locations/r/instances/ots-s-x-1",
      resourceUid: "uid-1",
    };
    const sent: RunnerClientFrame[] = [];
    const workerInputs: { stdin: string; timeoutMs: number }[] = [];
    const runner = new CloudTurnRunner({
      credentialChannel: () => {
        throw new Error("unexpected credential tunnel");
      },
      journal,
      openSessionExecution: async () => ({
        close: async () => undefined,
        executionDir: "/run/opentag-execution/turn-session",
        ...(options.proof ? { sessionCliProof: options.proof } : {}),
      }),
      runWorker: (input, signal) => {
        workerInputs.push(input);
        return options.worker?.(input, signal) ?? Promise.resolve(completedExec());
      },
      sandbox: { exec: () => Promise.reject(new Error("unexpected native seam")) },
      scope: () => scope,
      send: (frame) => sent.push(frame),
      serverUrl: "https://server.example.com",
      stateDirectory: join(directory, "private"),
      ...options.runnerOptions,
    });
    return { message, runner, scope, sent, workerInputs };
  }

  it("journals, executes, and settles a Session message, forwarding the open proof via stdin", async () => {
    const h = harness({ proof: PROOF });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message, "internal"));
    expect(sessionReceiptsOf(h.sent)).toEqual([
      {
        type: "session:message:received",
        requestId: h.message.requestId,
        messageId: h.message.messageId,
        turnId: expect.any(String),
        status: "accepted",
        phase: "received",
      },
    ]);
    const received = await journal.read(h.message.messageId);
    if (received?.kind !== "session-message") throw new Error("expected a Session journal entry");

    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    expect(settledOf(h.sent)).toHaveLength(1);
    expect(settledOf(h.sent)[0]).toMatchObject({
      messageId: h.message.messageId,
      outcome: "completed",
      turnId: received.turnId,
    });
    expect(h.workerInputs).toHaveLength(1);
    const [workerInput] = h.workerInputs;
    if (!workerInput) throw new Error("expected a worker input");
    const stdin = JSON.parse(workerInput.stdin) as {
      kind: string;
      sessionKind: string;
      sessionCollaboration?: { proof: SessionCliProofGrant; serverUrl: string };
      outboxContext?: unknown;
    };
    expect(stdin).toMatchObject({
      kind: "session-message",
      sessionKind: "internal",
      sessionCollaboration: { proof: PROOF, serverUrl: "https://server.example.com" },
    });
    expect(stdin.outboxContext).toBeUndefined();

    // The immutable settlement replays until the exact ack retires it.
    h.sent.length = 0;
    await h.runner.reconcile();
    expect(settledOf(h.sent)).toHaveLength(1);
    expect(await journal.read(h.message.messageId)).toBeDefined();
    const ack: RunnerCloudSessionMessageSettledAckFrame = {
      type: "session:message:settled:ack",
      requestId: h.message.requestId,
      messageId: h.message.messageId,
      turnId: received.turnId,
      status: "recorded",
    };
    await h.runner.handleSessionMessageSettledAck(ack);
    expect(await journal.read(h.message.messageId)).toBeUndefined();
    await h.runner.close();
  });

  it("carries the real visible outbox context and omits collaboration material without a proof", async () => {
    const outboxContext: RuntimeImOutboxContext = {
      provider: "slack",
      sessionKind: "channel",
      channelId: "C123",
    };
    const h = harness({ sessionKind: "visible", outboxContext });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message, "visible", outboxContext));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    const [workerInput] = h.workerInputs;
    if (!workerInput) throw new Error("expected a worker input");
    const stdin = JSON.parse(workerInput.stdin) as {
      sessionKind: string;
      outboxContext?: RuntimeImOutboxContext;
      sessionCollaboration?: unknown;
    };
    expect(stdin.sessionKind).toBe("visible");
    expect(stdin.outboxContext).toEqual(outboxContext);
    expect(stdin.sessionCollaboration).toBeUndefined();
    expect(settledOf(h.sent)[0]?.outcome).toBe("completed");
    await h.runner.close();
  });

  it("shares the single FIFO slot with IM deliveries and preserves dispatch order", async () => {
    const sessionId = randomUUID();
    const delivery = cloudDeliveryFixture({ sessionId });
    const message = sessionMessage({ targetSessionId: sessionId });
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ExecResult>();
    const kinds: string[] = [];
    const h = harness({
      message,
      worker: async (input) => {
        kinds.push((JSON.parse(input.stdin) as { kind: string }).kind);
        if (kinds.length === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return completedExec("second");
      },
      runnerOptions: {
        openExecution: async () => ({
          close: async () => undefined,
          executionDir: "/run/opentag-execution/turn-im",
        }),
      },
    });
    await h.runner.handleDeliveryRun(deliveryRunFrame(delivery));
    await h.runner.handleVerified(deliveryVerifiedFrame(delivery.requestId));
    await firstStarted.promise;
    await h.runner.handleSessionMessageRun(sessionRunFrame(message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(message.requestId));
    // The Session message is verified but must wait behind the active IM Turn.
    expect(kinds).toEqual(["turn"]);
    expect(h.runner.activeMessageId).toBeUndefined();
    releaseFirst.resolve(completedExec("first"));
    await waitFor(() => settledOf(h.sent).length === 1, "Session settlement after the IM Turn");
    expect(kinds).toEqual(["turn", "session-message"]);
    expect(h.sent.some((frame) => frame.type === "delivery:report" && frame.report.outcome === "completed")).toBe(true);
    await h.runner.close();
  });

  it("never re-executes a started Session message after restart and replays unknown until acked", async () => {
    const message = sessionMessage();
    const h = harness({ message });
    const journalScope = {
      environmentGeneration: h.scope.environmentGeneration,
      resourceName: h.scope.resourceName,
      resourceUid: h.scope.resourceUid ?? "",
      sandboxId: h.scope.sandboxId,
      sessionId: h.scope.sessionId,
    };
    const received = await journal.recordSessionReceived({
      message,
      sessionKind: "internal",
      scope: journalScope,
      requestId: message.requestId,
      turnId: "turn-restart",
    });
    await journal.markSessionStarted(received.messageId, journalScope);

    await h.runner.reconcile();
    expect(h.workerInputs).toHaveLength(0);
    expect(settledOf(h.sent)).toEqual([
      {
        type: "session:message:settled",
        requestId: message.requestId,
        messageId: message.messageId,
        turnId: "turn-restart",
        outcome: "unknown",
      },
    ]);
    const reported = await journal.read(message.messageId);
    expect(reported).toMatchObject({ phase: "reported", settlement: { outcome: "unknown" } });
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: message.requestId,
      messageId: message.messageId,
      turnId: "turn-restart",
      status: "already_recorded",
    });
    expect(await journal.read(message.messageId)).toBeUndefined();
    await h.runner.close();
  });

  it("settles a cancelled Session message before it starts and never runs the worker", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    h.runner.handleSessionMessageCancel(h.message.messageId);
    await waitFor(() => settledOf(h.sent).length === 1, "cancelled settlement");
    expect(settledOf(h.sent)[0]).toMatchObject({ messageId: h.message.messageId, outcome: "cancelled" });
    expect(h.workerInputs).toHaveLength(0);
    expect(await journal.read(h.message.messageId)).toMatchObject({
      phase: "reported",
      settlement: { outcome: "cancelled" },
    });
    await h.runner.close();
  });

  it("honours an explicit execution close over settlement replay while the Turn is still saving", async () => {
    const saved = deferred<void>();
    const saving = deferred<void>();
    const h = harness({
      runnerOptions: {
        checkpoint: async () => {
          saving.resolve();
          await saved.promise;
        },
      },
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await saving.promise;
    // The checkpoint holds the slot: no settlement exists yet and no replay may invent one.
    await h.runner.reconcile();
    expect(settledOf(h.sent)).toHaveLength(0);
    expect(await journal.read(h.message.messageId)).toMatchObject({ phase: "started" });
    saved.resolve();
    await h.runner.waitForActive();
    expect(settledOf(h.sent)).toHaveLength(1);
    expect(settledOf(h.sent)[0]?.outcome).toBe("completed");
    await h.runner.close();
  });

  it("records an unknown settlement when the worker reports unknown effects", async () => {
    const h = harness({
      worker: async () => ({
        code: 1,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { outcome: "unknown", executionEffects: "may_have_occurred", errorReason: "turn_state_unknown" },
        })}\n`,
      }),
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    expect(settledOf(h.sent)[0]?.outcome).toBe("unknown");
    expect(await journal.read(h.message.messageId)).toMatchObject({
      phase: "reported",
      settlement: { outcome: "unknown" },
    });
    await h.runner.close();
  });
});
