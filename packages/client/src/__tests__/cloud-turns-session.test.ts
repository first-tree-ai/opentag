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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudJournal } from "../runner/cloud-journal.js";
import { CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS, CloudTurnRunner, type CloudTurnScope } from "../runner/cloud-turns.js";
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

/** A real cancelled completion from a nonzero worker exit (the wrapper ended, children may remain). */
function cancelledExec(): ExecResult {
  return {
    code: 1,
    stderr: "",
    stdout: `${JSON.stringify({
      kind: "result",
      completion: { outcome: "cancelled", executionEffects: "may_have_occurred", errorReason: "client_shutdown" },
    })}\n`,
  };
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
      sandbox: {
        exec: () => Promise.reject(new Error("unexpected native seam")),
        openDuplex: () => {
          throw new Error("unexpected native duplex seam");
        },
      },
      scope: () => scope,
      send: (frame) => sent.push(frame),
      serverUrl: "https://server.example.com",
      stateDirectory: join(directory, "private"),
      ...options.runnerOptions,
    });
    return { journal, message, runner, scope, sent, workerInputs };
  }

  it("surfaces an unexpected provider bridge death instead of a claimed Session success", async () => {
    const h = harness({
      runnerOptions: {
        openSessionExecution: async () => ({
          bridgeFailure: () => new Error("provider bridge helper died"),
          close: async () => undefined,
          executionDir: "/run/opentag-execution/turn-session",
        }),
      },
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message, "internal"));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await waitFor(() => settledOf(h.sent).length === 1, "bridge-death settlement");
    // The worker's claimed success over a dead provider transport settles as unknown, never completed.
    expect(settledOf(h.sent)[0]?.outcome).toBe("unknown");
    await h.runner.close();
  });

  it("aborts an active Session worker on bridge failure and settles unknown", async () => {
    const failed = new AbortController();
    let sawAbort = false;
    const h = harness({
      runnerOptions: {
        openSessionExecution: async () => ({
          bridgeFailure: () => (failed.signal.aborted ? new Error("bridge died") : undefined),
          bridgeFailureSignal: failed.signal,
          close: async () => undefined,
          executionDir: "/run/opentag-execution/turn-session",
        }),
      },
      worker: async (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(new Error("worker stopped"));
            },
            { once: true },
          );
          failed.abort();
        }),
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message, "internal"));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await waitFor(() => settledOf(h.sent).length === 1, "bridge-death settlement");
    expect(sawAbort).toBe(true);
    expect(settledOf(h.sent)[0]?.outcome).toBe("unknown");
    await h.runner.close();
  });

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

  it("re-correlates a same-input retry to its new request identity without a second Turn", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    const [first] = sessionReceiptsOf(h.sent);
    if (!first) throw new Error("missing first receipt");
    const retry = { ...h.message, requestId: randomUUID() };

    await h.runner.handleSessionMessageRun(sessionRunFrame(retry));
    const receipts = sessionReceiptsOf(h.sent);
    expect(receipts).toHaveLength(2);
    // The retry's receipt correlates the NEW dispatch attempt; the journaled Turn is unchanged.
    expect(receipts[1]).toMatchObject({
      requestId: retry.requestId,
      messageId: h.message.messageId,
      turnId: first.status === "accepted" ? first.turnId : undefined,
      phase: "received",
    });
    expect(await journal.read(h.message.messageId)).toMatchObject({
      requestId: retry.requestId,
      turnId: first.status === "accepted" ? first.turnId : undefined,
      phase: "received",
    });

    // A verified for the superseded request identity finds no entry and starts nothing.
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(retry.requestId));
    await h.runner.waitForActive();
    expect(h.workerInputs).toHaveLength(1);
    const settled = settledOf(h.sent);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ requestId: retry.requestId, outcome: "completed" });

    // The ack correlates the re-correlated identity and retires the entry exactly once.
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: retry.requestId,
      messageId: h.message.messageId,
      turnId: first.status === "accepted" ? first.turnId : "",
      status: "recorded",
    });
    expect(await journal.read(h.message.messageId)).toBeUndefined();
    await h.runner.close();
  });

  it("supersedes a stale received entry for a retry with changed runtime and executes once", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    const [first] = sessionReceiptsOf(h.sent);
    if (!first || first.status !== "accepted") throw new Error("missing first receipt");
    const changed: SessionMessageDeliveryRequest = {
      ...h.message,
      requestId: randomUUID(),
      runtime: {
        ...h.message.runtime,
        instructions: { ...h.message.runtime.instructions, agent: "Replaced instructions." },
      },
    };

    await h.runner.handleSessionMessageRun(sessionRunFrame(changed));
    const receipts = sessionReceiptsOf(h.sent);
    expect(receipts).toHaveLength(2);
    // The stale entry was retired and the retry journaled as a NEW Turn under the new identity.
    expect(receipts[1]).toMatchObject({ requestId: changed.requestId, phase: "received" });
    if (receipts[1]?.status !== "accepted") throw new Error("missing retry receipt");
    expect(receipts[1].turnId).not.toBe(first.turnId);
    expect(await journal.read(h.message.messageId)).toMatchObject({
      requestId: changed.requestId,
      turnId: receipts[1].turnId,
      phase: "received",
    });

    // A late verified for the retired entry can never start it; only the new attempt executes.
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(changed.requestId));
    await h.runner.waitForActive();
    expect(h.workerInputs).toHaveLength(1);
    expect(settledOf(h.sent)).toHaveLength(1);
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: changed.requestId,
      messageId: h.message.messageId,
      turnId: receipts[1].turnId,
      status: "recorded",
    });
    expect(await journal.read(h.message.messageId)).toBeUndefined();
    await h.runner.close();
  });

  it("refuses a changed-input redispatch while the Turn is started and settles the running Turn", async () => {
    const release = deferred<ExecResult>();
    const h = harness({ worker: () => release.promise });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await waitFor(() => h.workerInputs.length === 1, "worker start");
    const changed: SessionMessageDeliveryRequest = {
      ...h.message,
      requestId: randomUUID(),
      runtime: {
        ...h.message.runtime,
        instructions: { ...h.message.runtime.instructions, agent: "Replaced instructions." },
      },
    };

    await h.runner.handleSessionMessageRun(sessionRunFrame(changed));
    // No second receipt and no second worker: the started Turn owns the message until it settles.
    expect(sessionReceiptsOf(h.sent)).toHaveLength(1);
    expect(h.workerInputs).toHaveLength(1);
    expect(await journal.read(h.message.messageId)).toMatchObject({ phase: "started" });

    release.resolve(completedExec());
    await waitFor(() => settledOf(h.sent).length === 1, "settlement");
    expect(settledOf(h.sent)[0]).toMatchObject({ requestId: h.message.requestId, outcome: "completed" });
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: h.message.requestId,
      messageId: h.message.messageId,
      turnId: settledOf(h.sent)[0]?.turnId ?? "",
      status: "recorded",
    });
    expect(await journal.read(h.message.messageId)).toBeUndefined();
    await h.runner.close();
  });

  it("refuses a Session re-dispatch whose journal key belongs to an IM delivery", async () => {
    const delivery = cloudDeliveryFixture();
    // The journal scope contract needs a non-nullable resource uid.
    const scope = {
      environmentGeneration: 1,
      resourceName: "projects/p/locations/r/instances/ots-s-x-1",
      resourceUid: "uid-1" as string,
      sandboxId: randomUUID(),
      sessionId: delivery.sessionId,
    };
    const h = harness({
      message: sessionMessage({ messageId: delivery.deliveryId, targetSessionId: delivery.sessionId }),
      runnerOptions: { scope: () => scope },
    });
    await journal.recordReceived({
      delivery,
      deliveryId: delivery.deliveryId,
      requestId: delivery.requestId,
      scope,
      turnId: randomUUID(),
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    expect(sessionReceiptsOf(h.sent)).toHaveLength(0);
    expect((await journal.list())[0]?.kind).toBe("delivery");
    await h.runner.close();
  });

  it("refuses a Session re-dispatch that was journaled under another allocation", async () => {
    const h = harness();
    const scope = {
      environmentGeneration: h.scope.environmentGeneration,
      resourceName: h.scope.resourceName,
      resourceUid: h.scope.resourceUid ?? "",
      sandboxId: h.scope.sandboxId,
      sessionId: h.scope.sessionId,
    };
    await journal.recordSessionReceived({
      message: h.message,
      scope: { ...scope, resourceUid: "another-allocation-uid" },
      sessionKind: "internal",
      requestId: h.message.requestId,
      turnId: randomUUID(),
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    expect(sessionReceiptsOf(h.sent)).toHaveLength(0);
    await h.runner.close();
  });

  it("refuses a Session re-dispatch whose input changed under the same attempt identity", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    const changed: SessionMessageDeliveryRequest = {
      ...h.message,
      content: { kind: "text", text: "replaced content" },
    };
    await h.runner.handleSessionMessageRun(sessionRunFrame(changed));
    // Only the original attempt was acknowledged; nothing else was journaled or started.
    expect(sessionReceiptsOf(h.sent)).toHaveLength(1);
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.close();
  });

  it("leaves verified Session work at the received boundary when the queue is full", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ExecResult>();
    const h = harness({
      worker: async () => {
        if (h.workerInputs.length === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return completedExec();
      },
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await firstStarted.promise;
    const queued = Array.from({ length: 64 }, () => sessionMessage({ targetSessionId: h.message.targetSessionId }));
    for (const message of queued) {
      await h.runner.handleSessionMessageRun(sessionRunFrame(message));
      await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(message.requestId));
    }
    const overflow = sessionMessage({ targetSessionId: h.message.targetSessionId });
    await h.runner.handleSessionMessageRun(sessionRunFrame(overflow));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(overflow.requestId));
    expect((await journal.read(overflow.messageId))?.phase).toBe("received");
    releaseFirst.resolve(cancelledExec());
    await h.runner.waitForActive();
    await h.runner.close();
  });

  it("cancels a queued Session message without ever starting a worker", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ExecResult>();
    const h = harness({
      worker: async () => {
        if (h.workerInputs.length === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return completedExec();
      },
    });
    const queued = sessionMessage({ targetSessionId: h.message.targetSessionId });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await firstStarted.promise;
    await h.runner.handleSessionMessageRun(sessionRunFrame(queued));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(queued.requestId));
    h.runner.handleSessionMessageCancel(queued.messageId);
    releaseFirst.resolve(cancelledExec());
    await waitFor(() => settledOf(h.sent).some((frame) => frame.messageId === queued.messageId), "queued cancellation");
    expect(settledOf(h.sent).find((frame) => frame.messageId === queued.messageId)?.outcome).toBe("cancelled");
    expect(h.workerInputs).toHaveLength(1);
    await h.runner.close();
  });

  it("never starts a Session grant minted by a connection that closed while it waited", async () => {
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<ExecResult>();
    const h = harness({
      worker: async () => {
        if (h.workerInputs.length === 1) {
          deliveryStarted.resolve();
          return releaseDelivery.promise;
        }
        throw new Error("the queued Session grant must never reach the worker");
      },
      runnerOptions: {
        openExecution: async () => ({
          close: async () => undefined,
          executionDir: "/run/opentag-execution/turn-im",
        }),
      },
    });
    const delivery = cloudDeliveryFixture({ sessionId: h.message.targetSessionId });
    await h.runner.handleDeliveryRun(deliveryRunFrame(delivery));
    await h.runner.handleVerified(deliveryVerifiedFrame(delivery.requestId));
    await deliveryStarted.promise;
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    // The grant is queued on the current connection generation; that connection now drops.
    h.runner.onChannelClosed();
    releaseDelivery.resolve(completedExec("im"));
    await h.runner.waitForActive();
    // The queued grant from the dead connection must never start; the entry stays received.
    expect(h.workerInputs).toHaveLength(1);
    expect(await journal.read(h.message.messageId)).toMatchObject({ phase: "received" });
    // Fresh verification on the new generation starts it.
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    expect(settledOf(h.sent)).toHaveLength(1);
    await h.runner.close();
  });

  it("ignores a rejected Session receipt once the Turn already started", async () => {
    const started = deferred<void>();
    const release = deferred<ExecResult>();
    const h = harness({
      worker: async () => {
        started.resolve();
        return release.promise;
      },
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await started.promise;
    // A late rejection must never erase real durable started state.
    await h.runner.handleSessionMessageVerified({
      type: "session:message:verified",
      requestId: h.message.requestId,
      status: "rejected",
      code: "conflict",
    });
    expect((await journal.read(h.message.messageId))?.phase).toBe("started");
    release.resolve(completedExec());
    await h.runner.waitForActive();
    await h.runner.close();
  });

  it("retires a rejected Session receipt and answers a settled entry from the journal", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified({
      type: "session:message:verified",
      requestId: h.message.requestId,
      status: "rejected",
      code: "scope_inactive",
    });
    // The never-started entry left the journal; a later run frame journals it fresh.
    expect(await journal.read(h.message.messageId)).toBeUndefined();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    expect(sessionReceiptsOf(h.sent)).toHaveLength(2);
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    const [settled] = settledOf(h.sent);
    if (!settled) throw new Error("missing settlement");
    // A redispatch of completed custody is answered from the immutable settlement.
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    const settledFrames = settledOf(h.sent);
    expect(settledFrames).toHaveLength(2);
    expect(settledFrames[1]?.turnId).toBe(settled.turnId);
    await h.runner.close();
  });

  it("retains a settlement when the Server ack does not match the journaled identity", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    const [settled] = settledOf(h.sent);
    if (!settled) throw new Error("missing settlement");
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: h.message.requestId,
      messageId: randomUUID(),
      status: "recorded",
      turnId: settled.turnId,
    });
    expect(await journal.read(h.message.messageId)).toBeDefined();
    // A settlement for an entry that never reached the reported boundary is a no-op.
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: randomUUID(),
      messageId: h.message.messageId,
      status: "recorded",
      turnId: settled.turnId,
    });
    expect(await journal.read(h.message.messageId)).toBeDefined();
    await h.runner.close();
  });

  it("refuses a Session execution whose persisted runtime deadline already passed", async () => {
    const h = harness({
      runnerOptions: {
        openSessionExecution: async () => {
          throw new Error("the bridge must never open without a live model grant");
        },
      },
      worker: async () => {
        throw new Error("the worker must never run without a live model grant");
      },
    });
    const expired = new Date(Date.now() - 1).toISOString();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(
      sessionVerifiedFrame(h.message.requestId, { ...MODEL_GRANT, expiresAt: expired }),
    );
    await h.runner.waitForActive();
    // The expired grant settles as a not-started failure with zero sandbox work.
    expect(settledOf(h.sent)[0]?.outcome).toBe("failed");
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.close();
  });

  it("fails a Session turn whose worker exits nonzero while claiming completion", async () => {
    const h = harness({
      worker: async () => ({ code: 1, stderr: "", stdout: completedExec("forged").stdout }),
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    // A nonzero exit can never be a completed Turn, even when stdout claims one.
    expect(settledOf(h.sent)[0]?.outcome).toBe("failed");
    await h.runner.close();
  });

  it("settles a Session turn whose worker reports malformed output as unknown", async () => {
    const h = harness({ worker: async () => ({ code: 0, stderr: "", stdout: "not json at all\n" }) });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    expect(settledOf(h.sent)[0]?.outcome).toBe("unknown");
    await h.runner.close();
  });

  it("settles a Session turn cancelled before its started boundary", async () => {
    const h = harness({
      worker: async () => {
        throw new Error("the worker must not run after a pre-start cancellation");
      },
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    h.runner.handleSessionMessageCancel(h.message.messageId);
    await h.runner.waitForActive();
    await waitFor(async () => (await journal.read(h.message.messageId))?.phase === "reported", "cancel settlement");
    expect(settledOf(h.sent)[0]?.outcome).toBe("cancelled");
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.close();
  });

  it("keeps every acquired bridge resource closed and reports a failing close step", async () => {
    const h = harness({
      runnerOptions: {
        openSessionExecution: async () => ({
          close: async () => {
            throw new Error("adapter close failed");
          },
          executionDir: "/run/opentag-execution/turn-session",
        }),
      },
    });
    const failures: unknown[] = [];
    const runner = new CloudTurnRunner({
      credentialChannel: () => {
        throw new Error("unused");
      },
      journal: h.journal,
      onPersistenceError: (error) => failures.push(error),
      openSessionExecution: async () => ({
        close: async () => {
          throw new Error("adapter close failed");
        },
        executionDir: "/run/opentag-execution/turn-session",
      }),
      runWorker: async () => completedExec(),
      sandbox: {
        exec: () => Promise.reject(new Error("unused native seam")),
        openDuplex: () => {
          throw new Error("unused native duplex seam");
        },
      },
      scope: () => h.scope,
      send: () => undefined,
      serverUrl: "https://server.example.com",
      stateDirectory: join(h.journal.directory, "private"),
    });
    await runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await runner.waitForActive();
    // The original close failure is surfaced through the existing failure hook, and the turn
    // still settles honestly.
    expect(failures.map((error) => String(error))).toEqual([expect.stringContaining("adapter close failed")]);
    await runner.close();
  });

  it("announces a queued Session receipt while releasing and settles a started one unknown", async () => {
    const h = harness();
    const scope = {
      environmentGeneration: h.scope.environmentGeneration,
      resourceName: h.scope.resourceName,
      resourceUid: h.scope.resourceUid ?? "",
      sandboxId: h.scope.sandboxId,
      sessionId: h.scope.sessionId,
    };
    const startedMessage = sessionMessage({ targetSessionId: h.message.targetSessionId });
    await journal.recordSessionReceived({
      message: h.message,
      scope,
      sessionKind: "internal",
      requestId: h.message.requestId,
      turnId: randomUUID(),
    });
    const startedEntry = await journal.recordSessionReceived({
      message: startedMessage,
      scope,
      sessionKind: "internal",
      requestId: startedMessage.requestId,
      turnId: randomUUID(),
    });
    await journal.markSessionStarted(startedEntry.messageId, scope);
    h.sent.length = 0;
    const draining = h.runner.drainForRelease(2_000);
    await waitFor(
      () =>
        h.sent.some((frame) => frame.type === "session:message:received" && frame.messageId === h.message.messageId) &&
        h.sent.some(
          (frame) => frame.type === "session:message:settled" && frame.messageId === startedMessage.messageId,
        ),
      "release announcement",
    );
    await waitFor(
      async () => (await journal.read(startedMessage.messageId))?.phase === "reported",
      "unknown release settlement",
    );
    // The queued receipt is re-announced and the started entry is settled unknown while releasing.
    expect(
      h.sent.some((frame) => frame.type === "session:message:received" && frame.messageId === h.message.messageId),
    ).toBe(true);
    const startedSettlement = (await journal.read(startedMessage.messageId)) as { settlement?: { outcome: string } };
    expect(startedSettlement.settlement?.outcome).toBe("unknown");
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: startedMessage.requestId,
      messageId: startedMessage.messageId,
      status: "recorded",
      turnId: startedEntry.turnId,
    });
    await h.runner.close();
    // The queued receipt never produced a settlement and never started a worker.
    expect(await journal.read(h.message.messageId)).toMatchObject({ phase: "received" });
    await draining.catch(() => undefined);
  });

  it("re-announces a durable Session receipt while releasing instead of manufacturing a settlement", async () => {
    const h = harness();
    const scope = {
      environmentGeneration: h.scope.environmentGeneration,
      resourceName: h.scope.resourceName,
      resourceUid: h.scope.resourceUid ?? "",
      sandboxId: h.scope.sandboxId,
      sessionId: h.scope.sessionId,
    };
    await journal.recordSessionReceived({
      message: h.message,
      scope,
      sessionKind: "internal",
      requestId: h.message.requestId,
      turnId: randomUUID(),
    });
    // A `started` entry whose worker is gone settles unknown before the release can finish.
    const startedEntry = await journal.recordSessionReceived({
      message: sessionMessage({ targetSessionId: h.message.targetSessionId }),
      scope,
      sessionKind: "internal",
      requestId: randomUUID(),
      turnId: randomUUID(),
    });
    await journal.markSessionStarted(startedEntry.messageId, scope);
    const draining = h.runner.drainForRelease(2_000);
    await waitFor(async () => (await journal.read(startedEntry.messageId))?.phase === "reported", "release settlement");
    await h.runner.handleSessionMessageSettledAck({
      type: "session:message:settled:ack",
      requestId: startedEntry.requestId,
      messageId: startedEntry.messageId,
      status: "recorded",
      turnId: startedEntry.turnId,
    });
    // The still-received entry keeps the release open until its rejection retires it.
    await draining.catch(() => undefined);
    await h.runner.close();
  });

  it("settles a Session cancel whose entry left the received boundary first", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    const scope = {
      environmentGeneration: h.scope.environmentGeneration,
      resourceName: h.scope.resourceName,
      resourceUid: h.scope.resourceUid ?? "",
      sandboxId: h.scope.sandboxId,
      sessionId: h.scope.sessionId,
    };
    // The entry already started, so a cancel can neither retire nor re-settle it — and a cancel
    // for an id the journal never held is a bounded no-op rather than an error.
    await h.runner.handleSessionMessageCancel(randomUUID());
    await h.runner.handleSessionMessageCancel(h.message.messageId);
    await journal.markSessionStarted(h.message.messageId, scope);
    await h.runner.handleSessionMessageCancel(h.message.messageId);
    expect((await journal.read(h.message.messageId))?.phase).toBe("started");
    expect(settledOf(h.sent)).toHaveLength(0);
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.close();
  });

  it("ignores a Session verification whose entry settled while it waited in the queue", async () => {
    const h = harness();
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    const scope = {
      environmentGeneration: h.scope.environmentGeneration,
      resourceName: h.scope.resourceName,
      resourceUid: h.scope.resourceUid ?? "",
      sandboxId: h.scope.sandboxId,
      sessionId: h.scope.sessionId,
    };
    // The Session turn is already settled when the late verified frame is processed.
    await h.runner.handleSessionMessageVerified({
      type: "session:message:verified",
      requestId: h.message.requestId,
      status: "rejected",
      code: "scope_inactive",
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    expect(settledOf(h.sent)).toHaveLength(1);
    expect(h.workerInputs).toHaveLength(1);
    void scope;
    await h.runner.close();
  });

  it("ignores a Session grant that arrived before its entry was journaled", async () => {
    const h = harness();
    // No entry exists for this request id: the verified frame authorizes nothing.
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(randomUUID()));
    expect(h.workerInputs).toHaveLength(0);
    expect(settledOf(h.sent)).toHaveLength(0);
    await h.runner.close();
  });

  it("drops a queued Session grant denied the model grant while the drain waited", async () => {
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<ExecResult>();
    const gate = deferred<void>();
    const gateEntered = deferred<void>();
    const h = harness({
      worker: async () => {
        if (h.workerInputs.length === 1) {
          deliveryStarted.resolve();
          return releaseDelivery.promise;
        }
        return completedExec("session");
      },
      runnerOptions: {
        openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/turn-im" }),
      },
    });
    const delivery = cloudDeliveryFixture({ sessionId: h.message.targetSessionId });
    const realList = h.journal.list.bind(h.journal);
    let armed = false;
    let consumed = false;
    vi.spyOn(h.journal, "list").mockImplementation(async () => {
      if (armed && !consumed) {
        consumed = true;
        gateEntered.resolve();
        await gate.promise;
      }
      return realList();
    });
    await h.runner.handleDeliveryRun(deliveryRunFrame(delivery));
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleVerified(deliveryVerifiedFrame(delivery.requestId));
    await deliveryStarted.promise;
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    armed = true;
    releaseDelivery.resolve(completedExec("im"));
    await gateEntered.promise;
    // The queue overflow is not the point here: the queued Session grant is denied by a dead
    // generation while the drain is inside its own journal lookup, so it never starts.
    h.runner.onChannelClosed();
    gate.resolve();
    await waitFor(() => h.runner.activeMessageId === undefined, "session drain");
    expect(await journal.read(h.message.messageId)).toMatchObject({ phase: "received" });
    expect(h.workerInputs).toHaveLength(1);
    vi.restoreAllMocks();
    await h.runner.close();
  });

  it("ignores a Session run frame whose target is another Session scope", async () => {
    const h = harness({ runnerOptions: { scope: () => ({ ...h.scope, sessionId: randomUUID() }) } });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    expect(sessionReceiptsOf(h.sent)).toHaveLength(0);
    expect(await journal.list()).toHaveLength(0);
    await h.runner.close();
  });

  it("settles a Session turn cancelled before its worker was ever opened", async () => {
    const opened = deferred<void>();
    const h = harness({
      worker: async () => {
        throw new Error("the worker must not run after a pre-open cancellation");
      },
      runnerOptions: {
        openSessionExecution: async () => {
          opened.resolve();
          return { close: async () => undefined, executionDir: "/run/opentag-execution/turn-session" };
        },
      },
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    // The cancel lands as soon as the credential bridge is open, before the worker document is
    // built: the turn settles as a not-started cancellation with no worker execution.
    await opened.promise;
    h.runner.handleSessionMessageCancel(h.message.messageId);
    await waitFor(
      () => settledOf(h.sent).some((frame) => frame.messageId === h.message.messageId),
      "pre-worker cancellation",
    );
    expect(settledOf(h.sent)[0]?.outcome).toBe("cancelled");
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.close();
  });

  it("marks a Session settlement as failed when its workspace checkpoint throws", async () => {
    const h = harness({
      runnerOptions: {
        checkpoint: async () => {
          throw new Error("session workspace save failed");
        },
        onPersistenceError: () => undefined,
      },
    });
    await h.runner.handleSessionMessageRun(sessionRunFrame(h.message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(h.message.requestId));
    await h.runner.waitForActive();
    // The save failure is recorded honestly as a failed settlement, never as a completion.
    expect(settledOf(h.sent)[0]?.outcome).toBe("failed");
    expect(await journal.read(h.message.messageId)).toMatchObject({
      phase: "reported",
      settlement: { outcome: "failed" },
    });
    await h.runner.close();
  });

  it("anchors the worker timeout and the parent exec backstop to one execution deadline", async () => {
    const budgetMs = 60_000;
    const fixture = cloudDeliveryFixture();
    const message = sessionMessage({
      agentId: fixture.agentId,
      runtime: { ...fixture.runtime, budget: { maxDurationMs: budgetMs } },
    });
    const h = harness({ message });
    const startedAt = Date.now();
    await h.runner.handleSessionMessageRun(sessionRunFrame(message));
    await h.runner.handleSessionMessageVerified(sessionVerifiedFrame(message.requestId));
    await h.runner.waitForActive();
    const finishedAt = Date.now();

    const [workerInput] = h.workerInputs;
    if (!workerInput) throw new Error("expected a worker input");
    const stdin = JSON.parse(workerInput.stdin) as { deadlineAt?: string };
    if (!stdin.deadlineAt) throw new Error("the worker document must carry the execution deadline");
    const deadline = Date.parse(stdin.deadlineAt);
    expect(deadline).toBeGreaterThanOrEqual(startedAt + budgetMs);
    expect(deadline).toBeLessThanOrEqual(finishedAt + budgetMs);
    // The backstop is the shared deadline plus only the bounded reporting grace, so the worker's
    // own turn_timeout always fires first and startup time is never recorded as unknown.
    expect(workerInput.timeoutMs).toBeGreaterThan(budgetMs);
    expect(workerInput.timeoutMs).toBeLessThanOrEqual(budgetMs + CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS);
    await h.runner.close();
  });
});
