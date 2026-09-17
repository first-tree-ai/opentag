import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunnerClientFrame,
  RunnerCloudDeliveryRunFrame,
  RunnerCloudDeliveryVerifiedFrame,
  RunnerCloudModelGrant,
} from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudJournal, CloudJournalError, type CloudJournalScope } from "../runner/cloud-journal.js";
import { CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS, CloudTurnRunner, type CloudTurnScope } from "../runner/cloud-turns.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const MODEL_GRANT: RunnerCloudModelGrant = {
  baseUrl: "https://server.example.com/api/v1/cloud-model",
  model: "deepseek-v4.1-flash-expires-on-0910",
  token: "unit-execution-token-0123456789abcdef",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

/** The same grant shape with a chosen token, for connection-generation regressions. */
function grantWith(token: string): RunnerCloudModelGrant {
  return { ...MODEL_GRANT, token };
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

function runFrame(delivery: ReturnType<typeof cloudDeliveryFixture>): RunnerCloudDeliveryRunFrame {
  return { type: "delivery:run", requestId: delivery.requestId, delivery };
}

function verifiedFrame(
  requestId: string,
  model: RunnerCloudModelGrant | undefined = MODEL_GRANT,
): RunnerCloudDeliveryVerifiedFrame {
  return { type: "delivery:verified", requestId, status: "verified", ...(model ? { model } : {}) };
}

function rejectionFrame(requestId: string, code = "conflict"): RunnerCloudDeliveryVerifiedFrame {
  return { type: "delivery:verified", requestId, status: "rejected", code };
}

function reportsOf(sent: RunnerClientFrame[]) {
  return sent.filter((frame) => frame.type === "delivery:report") as Extract<
    RunnerClientFrame,
    { type: "delivery:report" }
  >[];
}

/**
 * Gate the real journal's list() so a drain can be held inside actual filesystem I/O; consumers
 * still read the real journal once the gate opens. One-shot so later lookups pass through.
 */
function gateJournalList(journal: CloudJournal, gate: Promise<void>, onGated: () => void) {
  const realList = journal.list.bind(journal);
  let armed = false;
  let consumed = false;
  // Real journal snapshot taken when the gate is armed: non-gated lookups resolve from the same
  // durable state without adding filesystem-latency nondeterminism to the race under test.
  let snapshot: Promise<Awaited<ReturnType<CloudJournal["list"]>>> | undefined;
  const spy = vi.spyOn(journal, "list").mockImplementation(async () => {
    if (armed && !consumed) {
      consumed = true;
      onGated();
      await gate;
      // The gated delivery's journal read stays slow past the gate, so a racer is never hidden
      // by filesystem timing: any overtake happens while this read is still pending.
      await new Promise((resolve) => setImmediate(resolve));
      return realList();
    }
    if (!snapshot) return realList();
    return snapshot;
  });
  return {
    arm: () => {
      armed = true;
      snapshot ??= realList();
    },
    restore: () => spy.mockRestore(),
  };
}

/**
 * Gate the real journal's read() one-shot so a start can be held at the boundary under test;
 * subsequent reads go to the real journal.
 */
function gateJournalRead(journal: CloudJournal, gate: Promise<void>, onGated: () => void) {
  const realRead = journal.read.bind(journal);
  let armed = false;
  let consumed = false;
  const spy = vi.spyOn(journal, "read").mockImplementation(async (deliveryId: string) => {
    if (armed && !consumed) {
      consumed = true;
      onGated();
      await gate;
    }
    return realRead(deliveryId);
  });
  return {
    arm: () => {
      armed = true;
    },
    restore: () => spy.mockRestore(),
  };
}

/** Gate the real journal's markStarted one-shot to exercise the started-boundary window. */
function gateJournalMarkStarted(journal: CloudJournal, gate: Promise<void>, onGated: () => void) {
  const realMarkStarted = journal.markStarted.bind(journal);
  let armed = false;
  let consumed = false;
  const spy = vi
    .spyOn(journal, "markStarted")
    .mockImplementation(async (deliveryId: string, scope: CloudJournalScope) => {
      if (armed && !consumed) {
        consumed = true;
        onGated();
        await gate;
      }
      return realMarkStarted(deliveryId, scope);
    });
  return {
    arm: () => {
      armed = true;
    },
    restore: () => spy.mockRestore(),
  };
}

/** Bounded explicit completion waiter; never an unbounded loop, and it fails with a real signal. */
async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("CloudTurnRunner", () => {
  let directory: string;
  let journal: CloudJournal;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cloud-turns-test-"));
    journal = await CloudJournal.open(join(directory, "journal"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  interface Harness {
    readonly delivery: ReturnType<typeof cloudDeliveryFixture>;
    readonly journal: CloudJournal;
    readonly runner: CloudTurnRunner;
    readonly scope: CloudTurnScope;
    readonly sent: RunnerClientFrame[];
    readonly workerInputs: { stdin: string; timeoutMs: number }[];
    readonly journalDirectory: string;
    opened: number;
  }

  function harness(
    options: {
      delivery?: ReturnType<typeof cloudDeliveryFixture>;
      scope?: Partial<CloudTurnScope>;
      worker?: (input: { stdin: string; timeoutMs: number }, signal: AbortSignal) => Promise<ExecResult>;
      canStart?: () => boolean;
      journal?: CloudJournal;
      runnerOptions?: Partial<ConstructorParameters<typeof CloudTurnRunner>[0]>;
    } = {},
  ): Harness {
    const delivery = options.delivery ?? cloudDeliveryFixture();
    const scope: CloudTurnScope = {
      sandboxId: randomUUID(),
      sessionId: delivery.sessionId,
      environmentGeneration: 1,
      resourceName: "projects/p/locations/r/instances/ots-s-x-1",
      resourceUid: "uid-1",
      ...options.scope,
    };
    const sent: RunnerClientFrame[] = [];
    const workerInputs: { stdin: string; timeoutMs: number }[] = [];
    const state = { opened: 0 };
    const activeJournal = options.journal ?? journal;
    const runner = new CloudTurnRunner({
      ...(options.canStart ? { canStart: options.canStart } : {}),
      credentialChannel: () => {
        throw new Error("unexpected credential tunnel");
      },
      journal: activeJournal,
      openExecution: async () => {
        state.opened += 1;
        return { close: async () => undefined, executionDir: "/run/opentag-execution/turn-x" };
      },
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
    return {
      delivery,
      get opened() {
        return state.opened;
      },
      journal: activeJournal,
      journalDirectory: activeJournal.directory,
      runner,
      scope,
      sent,
      workerInputs,
    };
  }

  it("journals the receipt before acknowledging and never executes without the verified boundary", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleDeliveryRun(runFrame(h.delivery)); // duplicate dispatch
    const receipts = h.sent.filter((frame) => frame.type === "delivery:received") as { turnId: string }[];
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((frame) => frame.turnId)).size).toBe(1);
    expect(h.workerInputs).toHaveLength(0);
    const [entry] = await h.journal.list();
    expect(entry?.phase).toBe("received");
    // A verified frame for an unknown request can never authorize execution.
    await h.runner.handleVerified(verifiedFrame("unknown-request"));
    expect(h.workerInputs).toHaveLength(0);
    await h.runner.close();
  });

  it("runs exactly one worker and one report for concurrent duplicate verified frames", async () => {
    const workerStarted = deferred<void>();
    const release = deferred<ExecResult>();
    const h = harness({
      worker: async () => {
        workerStarted.resolve();
        return release.promise;
      },
    });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await Promise.all([
      h.runner.handleVerified(verifiedFrame(h.delivery.requestId)),
      h.runner.handleVerified(verifiedFrame(h.delivery.requestId)),
      h.runner.handleVerified(verifiedFrame(h.delivery.requestId)),
    ]);
    await workerStarted.promise;
    expect(h.workerInputs).toHaveLength(1);
    release.resolve(completedExec());
    await waitFor(() => h.runner.activeDeliveryId === undefined, "single turn to settle");
    const reports = reportsOf(h.sent);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.report.outcome).toBe("completed");
    await h.runner.close();
  });

  it("settles a missing or expired model grant as a durable not_started failure with zero sandbox work", async () => {
    const frames: RunnerCloudDeliveryVerifiedFrame[] = [
      { type: "delivery:verified", requestId: "missing", status: "verified" },
      verifiedFrame("expired", { ...MODEL_GRANT, expiresAt: new Date(Date.now() - 1).toISOString() }),
    ];
    for (const frame of frames) {
      const h = harness();
      frame.requestId = h.delivery.requestId;
      await h.runner.handleDeliveryRun(runFrame(h.delivery));
      await h.runner.handleVerified(frame);
      const [report] = reportsOf(h.sent);
      expect(report?.report.executionEffects).toBe("not_started");
      expect(report?.report.outcome).toBe("failed");
      expect(report?.report.errorReason).toBe("credential_unavailable");
      expect(h.workerInputs).toHaveLength(0);
      const [entry] = await h.journal.list();
      expect(entry?.phase).toBe("reported");
      await h.runner.close();
    }
  });

  it("refuses a verified turn whose persisted runtime deadline already passed and never extends the budget", async () => {
    const expired = cloudDeliveryFixture({ deadlineAt: new Date(Date.now() - 1_000).toISOString() });
    const refused = harness({ delivery: expired });
    await refused.runner.handleDeliveryRun(runFrame(expired));
    await refused.runner.handleVerified(verifiedFrame(expired.requestId));
    expect(refused.workerInputs).toHaveLength(0);
    const [refusedReport] = reportsOf(refused.sent);
    expect(refusedReport?.report.executionEffects).toBe("not_started");
    expect(refusedReport?.report.errorReason).toBe("turn_timeout");
    await refused.runner.close();
    // A live deadline stays the worker's own budget, and the parent exec backstop adds only the
    // bounded reporting grace so the worker can publish `turn_timeout` first.
    const before = Date.now();
    const nearly = cloudDeliveryFixture({ deadlineAt: new Date(before + 1_500).toISOString() });
    const h = harness({ delivery: nearly });
    await h.runner.handleDeliveryRun(runFrame(nearly));
    await h.runner.handleVerified(verifiedFrame(nearly.requestId));
    await waitFor(() => h.workerInputs.length === 1, "bounded worker start");
    const capturedAfter = Date.now();
    const timeoutMs = h.workerInputs[0]?.timeoutMs ?? 0;
    expect(timeoutMs).toBeLessThanOrEqual(before + 1_500 - before + CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS);
    expect(timeoutMs).toBeGreaterThanOrEqual(before + 1_500 - capturedAfter + CLOUD_TURN_EXEC_TIMEOUT_GRACE_MS);
    expect(timeoutMs).toBeGreaterThan(1_500 - (capturedAfter - before));
    await h.runner.close();
  });

  it("reports the worker's own turn_timeout instead of the parent exec backstop", async () => {
    const h = harness({
      worker: async () => ({
        code: 1,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { errorReason: "turn_timeout", executionEffects: "may_have_occurred", outcome: "failed" },
        })}\n`,
      }),
    });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await waitFor(() => reportsOf(h.sent).length === 1, "timeout report");
    const report = reportsOf(h.sent)[0]?.report;
    expect(report?.outcome).toBe("failed");
    expect(report?.errorReason).toBe("turn_timeout");
    await h.runner.close();
  });

  it("retires a rejected receipt without executing but never erases a started record", async () => {
    const workerStarted = deferred<void>();
    const release = deferred<ExecResult>();
    const h = harness({
      worker: async () => {
        workerStarted.resolve();
        return release.promise;
      },
    });
    // Rejected before start: retire, never execute.
    const first = harness();
    await first.runner.handleDeliveryRun(runFrame(first.delivery));
    await first.runner.handleVerified(rejectionFrame(first.delivery.requestId));
    expect(first.workerInputs).toHaveLength(0);
    expect(await first.journal.list()).toHaveLength(0);
    await first.runner.close();
    // Started then a late rejection: the durable started turn survives and still completes.
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await workerStarted.promise;
    await h.runner.handleVerified(rejectionFrame(h.delivery.requestId));
    const [entry] = await h.journal.list();
    expect(entry?.phase).toBe("started");
    release.resolve(completedExec());
    await waitFor(() => h.runner.activeDeliveryId === undefined, "started turn to finish");
    expect(reportsOf(h.sent)[0]?.report.outcome).toBe("completed");
    await h.runner.close();
  });

  it("rejects same-request/different-input re-dispatch without a second receipt or turn", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleDeliveryRun({
      ...runFrame(h.delivery),
      delivery: { ...h.delivery, content: { ...h.delivery.content, text: "changed input" } },
    });
    const receipts = h.sent.filter((frame) => frame.type === "delivery:received");
    expect(receipts).toHaveLength(1);
    const [entry] = await h.journal.list();
    expect(entry?.delivery.content).toEqual(h.delivery.content);
    await h.runner.close();
  });

  it("reports unknown exactly once from a reopened started journal and never re-executes", async () => {
    const delivery = cloudDeliveryFixture();
    const scope: CloudTurnScope = {
      sandboxId: randomUUID(),
      sessionId: delivery.sessionId,
      environmentGeneration: 1,
      resourceName: "projects/p/locations/r/instances/ots-s-x-1",
      resourceUid: "uid-1",
    };
    // First "process": receive, verify, start — then crash mid-worker (the promise never settles).
    const crashed = new CloudTurnRunner({
      credentialChannel: () => {
        throw new Error("unused");
      },
      journal,
      openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/turn-x" }),
      runWorker: () => new Promise<ExecResult>(() => undefined),
      sandbox: { exec: () => Promise.reject(new Error("unused native seam")) },
      scope: () => scope,
      send: () => undefined,
      serverUrl: "https://server.example.com",
      stateDirectory: directory,
    });
    await crashed.handleDeliveryRun(runFrame(delivery));
    await crashed.handleVerified(verifiedFrame(delivery.requestId));
    await waitFor(async () => (await journal.list()).some((entry) => entry.phase === "started"), "started boundary");
    // Second "process" over the same real directory: unknown, never a replay.
    const reopenedJournal = await CloudJournal.open(join(directory, "journal"));
    const sent: RunnerClientFrame[] = [];
    let workerCalls = 0;
    const recovered = new CloudTurnRunner({
      credentialChannel: () => {
        throw new Error("unused");
      },
      journal: reopenedJournal,
      openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/turn-x" }),
      runWorker: async () => {
        workerCalls += 1;
        return completedExec();
      },
      sandbox: { exec: () => Promise.reject(new Error("unused native seam")) },
      scope: () => scope,
      send: (frame) => sent.push(frame),
      serverUrl: "https://server.example.com",
      stateDirectory: directory,
    });
    await recovered.reconcile();
    expect(workerCalls).toBe(0);
    const [report] = reportsOf(sent);
    expect(report?.report.outcome).toBe("unknown");
    expect(report?.report.errorReason).toBe("turn_state_unknown");
    // The reported boundary is durable: a second reconcile re-sends the same result hash only.
    await recovered.reconcile();
    const reports = reportsOf(sent);
    expect(reports).toHaveLength(2);
    expect(reports[1]?.report.resultHash).toBe(reports[0]?.report.resultHash);
    await recovered.close();
  });

  it("reconstructs a reopened received journal and starts only after fresh verification", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    const [journaled] = await h.journal.list();
    await h.runner.close();
    const reopened = await CloudJournal.open(h.journalDirectory);
    const sent: RunnerClientFrame[] = [];
    let workerCalls = 0;
    const recovered = new CloudTurnRunner({
      credentialChannel: () => {
        throw new Error("unused");
      },
      journal: reopened,
      openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/turn-x" }),
      runWorker: async () => {
        workerCalls += 1;
        return completedExec("recovered");
      },
      sandbox: { exec: () => Promise.reject(new Error("unused native seam")) },
      scope: () => h.scope,
      send: (frame) => sent.push(frame),
      serverUrl: "https://server.example.com",
      stateDirectory: directory,
    });
    await recovered.reconcile();
    const receipts = sent.filter((frame) => frame.type === "delivery:received") as { turnId: string }[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.turnId).toBe(journaled?.turnId);
    // No Server verification after the restart: still zero executions.
    expect(workerCalls).toBe(0);
    await recovered.handleVerified(verifiedFrame(h.delivery.requestId));
    await waitFor(() => reportsOf(sent).length === 1, "reconstructed turn report");
    expect(workerCalls).toBe(1);
    expect(reportsOf(sent)[0]?.report.finalText).toBe("recovered");
    await recovered.close();
  });

  it("fails closed when a reopened journal belongs to another allocation", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.close();
    const reopened = await CloudJournal.open(h.journalDirectory);
    const sent: RunnerClientFrame[] = [];
    const next = new CloudTurnRunner({
      credentialChannel: () => {
        throw new Error("unused");
      },
      journal: reopened,
      openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/turn-x" }),
      runWorker: async () => completedExec(),
      sandbox: { exec: () => Promise.reject(new Error("unused native seam")) },
      scope: () => ({ ...h.scope, environmentGeneration: 2, resourceUid: "new-uid" }),
      send: (frame) => sent.push(frame),
      serverUrl: "https://server.example.com",
      stateDirectory: directory,
    });
    await expect(next.reconcile()).rejects.toBeInstanceOf(CloudJournalError);
    expect(sent).toHaveLength(0);
    await next.close();
  });

  it("reconciles around a live execution without manufacturing unknown or starting twice", async () => {
    const workerStarted = deferred<void>();
    const release = deferred<ExecResult>();
    const h = harness({
      worker: async () => {
        workerStarted.resolve();
        return release.promise;
      },
    });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await workerStarted.promise;
    await h.runner.reconcile();
    expect(reportsOf(h.sent)).toHaveLength(0);
    release.resolve(completedExec("after-reconcile"));
    await waitFor(() => h.runner.activeDeliveryId === undefined, "turn to complete");
    const reports = reportsOf(h.sent);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.report.outcome).toBe("completed");
    expect(reports[0]?.report.finalText).toBe("after-reconcile");
    await h.runner.close();
  });

  it("does not abort a live execution on a channel drop and reports its real outcome (queued grants are dropped)", async () => {
    const workerStarted = deferred<void>();
    const release = deferred<ExecResult>();
    let aborted = false;
    const h = harness({
      worker: async (_input, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        workerStarted.resolve();
        return release.promise;
      },
    });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await workerStarted.promise;
    h.runner.onChannelClosed();
    expect(aborted).toBe(false);
    expect(h.workerInputs).toHaveLength(1);
    release.resolve(completedExec("survived-reconnect"));
    await waitFor(() => h.runner.activeDeliveryId === undefined, "turn to complete");
    expect(reportsOf(h.sent)[0]?.report.finalText).toBe("survived-reconnect");
    await h.runner.close();
  });

  it("serializes two queued inputs for the same Session in arrival order", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ExecResult>();
    const startedDeliveries: string[] = [];
    const h = harness({
      worker: async (input) => {
        const parsed = JSON.parse(input.stdin) as { delivery: { deliveryId: string } };
        startedDeliveries.push(parsed.delivery.deliveryId);
        if (startedDeliveries.length === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return completedExec("second");
      },
    });
    const second = cloudDeliveryFixture({ sessionId: h.delivery.sessionId });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleDeliveryRun(runFrame(second));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await h.runner.handleVerified(verifiedFrame(second.requestId));
    await firstStarted.promise;
    expect(startedDeliveries).toEqual([h.delivery.deliveryId]);
    releaseFirst.resolve(completedExec("first"));
    await waitFor(() => startedDeliveries.length === 2, "second queued turn to start");
    expect(startedDeliveries).toEqual([h.delivery.deliveryId, second.deliveryId]);
    await waitFor(() => reportsOf(h.sent).length === 2, "both turns to report");
    await h.runner.close();
  });

  it("waits for the shared native occupation boundary instead of racing acceptance cleanup", async () => {
    let canStart = false;
    const h = harness({ canStart: () => canStart });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    expect(h.workerInputs).toHaveLength(0);
    expect(h.runner.hasPendingWork).toBe(true);
    canStart = true;
    h.runner.notifyAvailable();
    await waitFor(() => h.workerInputs.length === 1, "queued turn to start");
    await h.runner.close();
  });

  it("retires only the exact acknowledged report and retains conflicting or stale acks", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await waitFor(() => reportsOf(h.sent).length === 1, "report");
    const report = reportsOf(h.sent)[0]?.report as { turnId: string; resultHash: string };
    await h.runner.handleReportAck({
      type: "delivery:report:ack",
      requestId: "ack-1",
      status: "conflict",
      turnId: report.turnId,
      resultHash: report.resultHash,
    });
    await h.runner.handleReportAck({
      type: "delivery:report:ack",
      requestId: "ack-2",
      status: "stale_generation",
      turnId: report.turnId,
      resultHash: report.resultHash,
    });
    await h.runner.handleReportAck({
      type: "delivery:report:ack",
      requestId: "ack-3",
      status: "recorded",
      turnId: report.turnId,
      resultHash: "0".repeat(64),
    });
    expect(await h.journal.list()).toHaveLength(1);
    await h.runner.handleReportAck({
      type: "delivery:report:ack",
      requestId: "ack-4",
      status: "recorded",
      turnId: report.turnId,
      resultHash: report.resultHash,
    });
    expect(await h.journal.list()).toHaveLength(0);
    // A replayed ack after retirement is a no-op, never an error or another clear.
    await h.runner.handleReportAck({
      type: "delivery:report:ack",
      requestId: "ack-5",
      status: "already_recorded",
      turnId: report.turnId,
      resultHash: report.resultHash,
    });
    await h.runner.close();
  });

  it("never reports a nonzero worker exit as completed and honors a genuine failure", async () => {
    const forged = harness({ worker: async () => ({ code: 1, stderr: "", stdout: completedExec("forged").stdout }) });
    await forged.runner.handleDeliveryRun(runFrame(forged.delivery));
    await forged.runner.handleVerified(verifiedFrame(forged.delivery.requestId));
    await waitFor(() => reportsOf(forged.sent).length === 1, "forged completion report");
    const forgedReport = reportsOf(forged.sent)[0]?.report;
    expect(forgedReport?.outcome).toBe("failed");
    expect(forgedReport?.errorReason).toBe("provider_failed");
    await forged.runner.close();
    // A nonzero exit with a real non-completed completion is preserved as that failure.
    const honest = harness({
      worker: async () => ({
        code: 1,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { outcome: "failed", executionEffects: "may_have_occurred", errorReason: "provider_failed" },
        })}\n`,
      }),
    });
    await honest.runner.handleDeliveryRun(runFrame(honest.delivery));
    await honest.runner.handleVerified(verifiedFrame(honest.delivery.requestId));
    await waitFor(() => reportsOf(honest.sent).length === 1, "honest failure report");
    expect(reportsOf(honest.sent)[0]?.report.outcome).toBe("failed");
    await honest.runner.close();
  });

  it("cleans up the native namespace immediately after an interrupted turn before publishing the report", async () => {
    const resetStarted = deferred<void>();
    const resetGate = deferred<void>();
    let resetCalls = 0;
    const h = harness({
      runnerOptions: {
        sandboxReset: async () => {
          resetCalls += 1;
          resetStarted.resolve();
          await resetGate.promise;
        },
      },
      worker: async () => (h.workerInputs.length === 1 ? cancelledExec() : completedExec("second")),
    });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    // Cleanup starts immediately; no next delivery is needed to trigger it.
    await resetStarted.promise;
    expect(resetCalls).toBe(1);
    expect(reportsOf(h.sent)).toHaveLength(0);
    expect(h.runner.activeDeliveryId).toBe(h.delivery.deliveryId);
    expect(h.runner.needsSandboxReset).toBe(true);
    expect(h.runner.hasPendingWork).toBe(true);
    resetGate.resolve();
    await waitFor(() => reportsOf(h.sent).length === 1, "report after verified cleanup");
    const report = reportsOf(h.sent)[0]?.report;
    expect(report?.outcome).toBe("cancelled");
    expect(report?.errorReason).toBe("client_shutdown");
    await waitFor(() => h.runner.activeDeliveryId === undefined, "interrupted turn to settle");
    expect(h.runner.needsSandboxReset).toBe(false);
    // A later successful turn must not reset the namespace again.
    const second = cloudDeliveryFixture({ sessionId: h.delivery.sessionId });
    await h.runner.handleDeliveryRun(runFrame(second));
    await h.runner.handleVerified(verifiedFrame(second.requestId));
    await waitFor(() => reportsOf(h.sent).length === 2, "second turn report");
    expect(resetCalls).toBe(1);
    await h.runner.close();
  });

  it("publishes an honest unknown and disables the runner when cleanup cannot be verified", async () => {
    const h = harness({
      runnerOptions: {
        sandboxReset: async () => {
          throw new Error("delete --force failed");
        },
      },
      worker: async () => cancelledExec(),
    });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await waitFor(() => reportsOf(h.sent).length === 1, "cleanup-failure report");
    const report = reportsOf(h.sent)[0]?.report;
    // The failed reset must never be published as a safe cancellation.
    expect(report?.outcome).toBe("unknown");
    expect(report?.errorReason).toBe("sandbox_unavailable");
    expect(report?.executionEffects).toBe("may_have_occurred");
    await waitFor(() => h.runner.activeDeliveryId === undefined, "failed turn to settle");
    expect(h.runner.hasPendingWork).toBe(true);
    // Every later attempt is refused instead of silently reusing the unverified namespace.
    const second = cloudDeliveryFixture({ sessionId: h.delivery.sessionId });
    await h.runner.handleDeliveryRun(runFrame(second));
    await expect(h.runner.handleVerified(verifiedFrame(second.requestId))).rejects.toBeInstanceOf(CloudJournalError);
    expect(h.workerInputs).toHaveLength(1);
    await expect(h.runner.handleVerified(verifiedFrame(second.requestId))).rejects.toBeInstanceOf(CloudJournalError);
    expect(h.workerInputs).toHaveLength(1);
    await h.runner.close();
  });

  it("settles an explicit pre-start cancel durably without any sandbox work", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    h.runner.handleCancel(h.delivery.deliveryId);
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    expect(h.workerInputs).toHaveLength(0);
    const [report] = reportsOf(h.sent);
    expect(report?.report.executionEffects).toBe("not_started");
    expect(report?.report.outcome).toBe("cancelled");
    expect(report?.report.errorReason).toBe("client_shutdown");
    const [entry] = await h.journal.list();
    expect(entry?.phase).toBe("reported");
    await h.runner.close();
  });

  it("cancels a queued verified delivery without ever starting a worker", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<ExecResult>();
    const startedDeliveries: string[] = [];
    const h = harness({
      worker: async (input) => {
        const parsed = JSON.parse(input.stdin) as { delivery: { deliveryId: string } };
        startedDeliveries.push(parsed.delivery.deliveryId);
        if (startedDeliveries.length === 1) {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return completedExec("second");
      },
    });
    const queued = cloudDeliveryFixture({ sessionId: h.delivery.sessionId });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleDeliveryRun(runFrame(queued));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await firstStarted.promise;
    await h.runner.handleVerified(verifiedFrame(queued.requestId));
    h.runner.handleCancel(queued.deliveryId);
    releaseFirst.resolve(completedExec("first"));
    await waitFor(() => h.runner.activeDeliveryId === undefined, "first turn to settle");
    await waitFor(() => reportsOf(h.sent).length === 2, "both turns to settle");
    expect(startedDeliveries).toEqual([h.delivery.deliveryId]);
    const cancelled = reportsOf(h.sent).find((frame) => frame.report.deliveryId === queued.deliveryId);
    expect(cancelled?.report.executionEffects).toBe("not_started");
    expect(cancelled?.report.outcome).toBe("cancelled");
    await h.runner.close();
  });

  it("cancels a live worker and persists the cancellation result", async () => {
    const workerStarted = deferred<void>();
    let aborted = false;
    const h = harness({
      worker: async (_input, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        workerStarted.resolve();
        return new Promise<ExecResult>((resolve) => {
          signal.addEventListener("abort", () => resolve({ code: 143, stderr: "", stdout: "" }));
        });
      },
    });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await workerStarted.promise;
    h.runner.handleCancel(h.delivery.deliveryId);
    await waitFor(() => h.runner.activeDeliveryId === undefined, "cancelled turn to settle");
    expect(aborted).toBe(true);
    const [report] = reportsOf(h.sent);
    expect(report?.report.outcome).toBe("cancelled");
    expect(report?.report.errorReason).toBe("client_shutdown");
    const [entry] = await h.journal.list();
    expect(entry?.phase).toBe("reported");
    await h.runner.close();
  });

  it("answers a Server recovery query from the journal, not from memory", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    const receipt = h.sent.find((frame) => frame.type === "delivery:received") as { turnId: string };
    await h.runner.handleQuery({
      type: "delivery:query",
      requestId: "q1",
      deliveryId: h.delivery.deliveryId,
      turnId: receipt.turnId,
    });
    await h.runner.handleQuery({
      type: "delivery:query",
      requestId: "q2",
      deliveryId: h.delivery.deliveryId,
      turnId: "somebody-elses-turn",
    });
    const answers = h.sent.filter((frame) => frame.type === "delivery:query:result") as { phase: string }[];
    expect(answers.map((answer) => answer.phase)).toEqual(["received", "none"]);
    await h.runner.close();
  });

  it("never runs a malformed or oversized worker completion as a successful report", async () => {
    for (const stdout of [
      "not json at all\n",
      '{"kind":"result","completion":null}\n',
      `${JSON.stringify({
        kind: "result",
        completion: { outcome: "completed", executionEffects: "completed", finalText: "x".repeat(60 * 1024) },
      })}\n`,
    ]) {
      const h = harness({ worker: async () => ({ code: 0, stderr: "", stdout }) });
      await h.runner.handleDeliveryRun(runFrame(h.delivery));
      await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
      await waitFor(() => reportsOf(h.sent).length === 1, "malformed completion report");
      const [report] = reportsOf(h.sent);
      expect(report?.report.outcome).toBe("unknown");
      expect(report?.report.executionEffects).toBe("may_have_occurred");
      await h.runner.close();
    }
  });

  it("cannot authorize or acknowledge another allocation's journal entries", async () => {
    const h = harness();
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    await h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await waitFor(() => reportsOf(h.sent).length === 1, "report before stale access");
    const report = reportsOf(h.sent)[0]?.report as { turnId: string; resultHash: string };
    // A replacement allocation over the same directory can neither start nor clear the old entry.
    const stale = harness({
      journal: await CloudJournal.open(h.journalDirectory),
      scope: { environmentGeneration: 2, resourceUid: "replacement-uid" },
    });
    await expect(stale.runner.handleVerified(verifiedFrame(h.delivery.requestId))).rejects.toBeInstanceOf(
      CloudJournalError,
    );
    await expect(
      stale.runner.handleReportAck({
        type: "delivery:report:ack",
        requestId: "stale-ack",
        status: "recorded",
        turnId: report.turnId,
        resultHash: report.resultHash,
      }),
    ).rejects.toBeInstanceOf(CloudJournalError);
    expect(stale.workerInputs).toHaveLength(0);
    expect(await stale.journal.list()).toHaveLength(1);
    await stale.runner.close();
    await h.runner.close();
  });

  it("starts queued verified work in FIFO order when a drain is gated on journal I/O", async () => {
    const started: string[] = [];
    const releaseA = deferred<ExecResult>();
    const aStarted = deferred<void>();
    const bStarted = deferred<void>();
    const dStarted = deferred<void>();
    const releaseD = deferred<ExecResult>();
    const gate = deferred<void>();
    const gateEntered = deferred<void>();
    const h = harness({
      worker: async (input) => {
        const deliveryId = (JSON.parse(input.stdin) as { delivery: { deliveryId: string } }).delivery.deliveryId;
        started.push(deliveryId);
        return dStartedFor(deliveryId);
      },
    });
    function dStartedFor(deliveryId: string): Promise<ExecResult> {
      if (deliveryId === h.delivery.deliveryId) {
        aStarted.resolve();
        return releaseA.promise;
      }
      if (deliveryId === b.deliveryId) {
        bStarted.resolve();
        return Promise.resolve(completedExec("b"));
      }
      if (deliveryId === d.deliveryId) {
        dStarted.resolve();
        return releaseD.promise;
      }
      return Promise.resolve(completedExec("c"));
    }
    const a = h.delivery;
    const b = cloudDeliveryFixture({ sessionId: a.sessionId });
    const c = cloudDeliveryFixture({ sessionId: a.sessionId });
    const d = cloudDeliveryFixture({ sessionId: a.sessionId });
    const gated = gateJournalList(h.journal, gate.promise, () => gateEntered.resolve());
    await h.runner.handleDeliveryRun(runFrame(a));
    await h.runner.handleDeliveryRun(runFrame(b));
    await h.runner.handleDeliveryRun(runFrame(c));
    await h.runner.handleDeliveryRun(runFrame(d));
    await h.runner.handleVerified(verifiedFrame(a.requestId));
    await aStarted.promise;
    // B and C are already queued behind the live A when the drain starts.
    await h.runner.handleVerified(verifiedFrame(b.requestId));
    await h.runner.handleVerified(verifiedFrame(c.requestId));
    gated.arm();
    releaseA.resolve(completedExec("a")); // A settles; the drain for B starts and blocks in list()
    await gateEntered.promise;
    // A concurrent verification and an extra availability signal must not overtake B or C.
    const verifyingD = h.runner.handleVerified(verifiedFrame(d.requestId));
    h.runner.notifyAvailable();
    // Give the pre-fix scheduler's fs-backed direct-start path a bounded chance to overtake the
    // gated FIFO head. On the fixed scheduler D cannot progress while B's drain holds the head.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const firstStarted = Promise.race([bStarted.promise.then(() => "b"), dStarted.promise.then(() => "d")]);
    gate.resolve();
    // D starting before B is exactly the pre-fix overtake this regression pins down.
    expect(await firstStarted).toBe("b");
    releaseD.resolve(completedExec("d"));
    await verifyingD;
    await waitFor(() => reportsOf(h.sent).length === 4, "all four reports");
    expect(started).toEqual([a.deliveryId, b.deliveryId, c.deliveryId, d.deliveryId]);
    expect(new Set(started).size).toBe(4);
    gated.restore();
    await h.runner.close();
  });

  it("never starts work cancelled while its drain is waiting on journal I/O", async () => {
    const started: string[] = [];
    const releaseA = deferred<ExecResult>();
    const aStarted = deferred<void>();
    const gate = deferred<void>();
    const gateEntered = deferred<void>();
    const h = harness({
      worker: async (input) => {
        const deliveryId = (JSON.parse(input.stdin) as { delivery: { deliveryId: string } }).delivery.deliveryId;
        started.push(deliveryId);
        if (started.length === 1) {
          aStarted.resolve();
          return releaseA.promise;
        }
        return completedExec(`done-${deliveryId}`);
      },
    });
    const a = h.delivery;
    const b = cloudDeliveryFixture({ sessionId: a.sessionId });
    const c = cloudDeliveryFixture({ sessionId: a.sessionId });
    const gated = gateJournalList(h.journal, gate.promise, () => gateEntered.resolve());
    await h.runner.handleDeliveryRun(runFrame(a));
    await h.runner.handleDeliveryRun(runFrame(b));
    await h.runner.handleDeliveryRun(runFrame(c));
    await h.runner.handleVerified(verifiedFrame(a.requestId));
    await aStarted.promise;
    await h.runner.handleVerified(verifiedFrame(b.requestId)); // B queued behind the live A
    gated.arm();
    releaseA.resolve(completedExec("a"));
    await gateEntered.promise;
    // Cancellation arrives while B's drain is blocked in journal I/O.
    h.runner.handleCancel(b.deliveryId);
    const verifyingC = h.runner.handleVerified(verifiedFrame(c.requestId));
    gate.resolve();
    await verifyingC;
    await waitFor(() => reportsOf(h.sent).length === 3, "cancelled and remaining reports");
    // B must never start; the later C still runs after the cancellation settles.
    expect(started).toEqual([a.deliveryId, c.deliveryId]);
    const cancelled = reportsOf(h.sent).find((frame) => frame.report.deliveryId === b.deliveryId)?.report;
    expect(cancelled?.outcome).toBe("cancelled");
    expect(cancelled?.executionEffects).toBe("not_started");
    gated.restore();
    await h.runner.close();
  });

  it("drops queued grants from a closed channel generation and re-verifies with a fresh grant", async () => {
    const aStarted = deferred<void>();
    const releaseA = deferred<ExecResult>();
    const tokens: string[] = [];
    const h = harness({
      worker: async (input) => {
        const parsed = JSON.parse(input.stdin) as { model: { token: string } };
        tokens.push(parsed.model.token);
        if (tokens.length === 1) {
          aStarted.resolve();
          return releaseA.promise;
        }
        return completedExec("second");
      },
    });
    const a = h.delivery;
    const b = cloudDeliveryFixture({ sessionId: a.sessionId });
    await h.runner.handleDeliveryRun(runFrame(a));
    await h.runner.handleDeliveryRun(runFrame(b));
    await h.runner.handleVerified(verifiedFrame(a.requestId, grantWith("dead-channel-grant-token-a-0123456789")));
    await aStarted.promise;
    await h.runner.handleVerified(verifiedFrame(b.requestId, grantWith("dead-channel-grant-token-b-0123456789")));
    // B is queued on the current connection generation; that connection now drops.
    h.runner.onChannelClosed();
    releaseA.resolve(completedExec("a"));
    await waitFor(() => h.runner.activeDeliveryId === undefined, "first turn to settle");
    // The queued grant from the dead connection must never start.
    expect(tokens).toEqual(["dead-channel-grant-token-a-0123456789"]);
    const entryB = (await h.journal.list()).find((entry) => entry.deliveryId === b.deliveryId);
    expect(entryB?.phase).toBe("received");
    // Fresh verification on the new generation starts B with the new grant.
    await h.runner.handleVerified(verifiedFrame(b.requestId, grantWith("fresh-channel-token-b-0123456789")));
    await waitFor(() => reportsOf(h.sent).length === 2, "fresh-grant report");
    expect(tokens).toEqual(["dead-channel-grant-token-a-0123456789", "fresh-channel-token-b-0123456789"]);
    await h.runner.close();
  });

  it("never starts a delivery whose channel generation closed while its start read was pending", async () => {
    const aStarted = deferred<void>();
    const releaseA = deferred<ExecResult>();
    const gate = deferred<void>();
    const gateEntered = deferred<void>();
    const tokens: string[] = [];
    const h = harness({
      worker: async (input) => {
        tokens.push((JSON.parse(input.stdin) as { model: { token: string } }).model.token);
        if (tokens.length === 1) {
          aStarted.resolve();
          return releaseA.promise;
        }
        return completedExec("second");
      },
    });
    const a = h.delivery;
    const b = cloudDeliveryFixture({ sessionId: a.sessionId });
    const gated = gateJournalRead(h.journal, gate.promise, () => gateEntered.resolve());
    await h.runner.handleDeliveryRun(runFrame(a));
    await h.runner.handleDeliveryRun(runFrame(b));
    await h.runner.handleVerified(verifiedFrame(a.requestId, grantWith("start-read-token-a-0123456789ab")));
    await aStarted.promise;
    await h.runner.handleVerified(verifiedFrame(b.requestId, grantWith("start-read-token-b-0123456789ab")));
    gated.arm();
    // A settles; the drain starts B and blocks in the real journal read for B.
    releaseA.resolve(completedExec("a"));
    await gateEntered.promise;
    h.runner.onChannelClosed();
    gate.resolve();
    await waitFor(() => h.runner.activeDeliveryId === undefined, "runner to settle");
    expect(tokens).toEqual(["start-read-token-a-0123456789ab"]);
    const entryB = (await h.journal.list()).find((entry) => entry.deliveryId === b.deliveryId);
    expect(entryB?.phase).toBe("received");
    gated.restore();
    await h.runner.close();
  });

  it("never starts a verified frame captured before a close while it waited in the serial queue", async () => {
    const gate = deferred<void>();
    const gateEntered = deferred<void>();
    const tokens: string[] = [];
    const h = harness({
      worker: async (input) => {
        tokens.push((JSON.parse(input.stdin) as { model: { token: string } }).model.token);
        return completedExec("b");
      },
    });
    const a = h.delivery;
    const b = cloudDeliveryFixture({ sessionId: a.sessionId });
    await h.runner.handleDeliveryRun(runFrame(a));
    await h.runner.handleDeliveryRun(runFrame(b));
    const gated = gateJournalList(h.journal, gate.promise, () => gateEntered.resolve());
    gated.arm();
    // A slow reconcile holds the serial queue while the verified frame is enqueued behind it.
    const reconciling = h.runner.reconcile();
    await gateEntered.promise;
    const verifying = h.runner.handleVerified(
      verifiedFrame(b.requestId, grantWith("queued-old-token-0123456789abcdef")),
    );
    h.runner.onChannelClosed();
    gate.resolve();
    await reconciling;
    await verifying;
    // The old grant must not start: no worker, and the durable entry stays received.
    expect(tokens).toEqual([]);
    const entryB = (await h.journal.list()).find((entry) => entry.deliveryId === b.deliveryId);
    expect(entryB?.phase).toBe("received");
    // Fresh verification on the new generation starts it with the new grant.
    await h.runner.handleVerified(verifiedFrame(b.requestId, grantWith("fresh-token-0123456789abcdefgh")));
    await waitFor(() => reportsOf(h.sent).length === 1, "fresh report");
    expect(tokens).toEqual(["fresh-token-0123456789abcdefgh"]);
    gated.restore();
    await h.runner.close();
  });

  it("settles not_started when cancelled while markStarted is pending and never opens the bridge", async () => {
    const gate = deferred<void>();
    const gateEntered = deferred<void>();
    let opened = 0;
    const h = harness({
      runnerOptions: {
        openExecution: async () => {
          opened += 1;
          return { close: async () => undefined, executionDir: "/run/opentag-execution/unit" };
        },
      },
      worker: async () => {
        throw new Error("the worker must not run after a cancellation during markStarted");
      },
    });
    const gated = gateJournalMarkStarted(h.journal, gate.promise, () => gateEntered.resolve());
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    gated.arm();
    const verifying = h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await gateEntered.promise;
    h.runner.handleCancel(h.delivery.deliveryId);
    gate.resolve();
    await verifying;
    await waitFor(() => reportsOf(h.sent).length === 1, "not-started report");
    const report = reportsOf(h.sent)[0]?.report;
    expect(report?.outcome).toBe("cancelled");
    expect(report?.executionEffects).toBe("not_started");
    expect(report?.errorReason).toBe("client_shutdown");
    expect(h.workerInputs).toHaveLength(0);
    expect(opened).toBe(0);
    const [entry] = await h.journal.list();
    expect(entry?.phase).toBe("reported");
    gated.restore();
    await h.runner.close();
  });

  it.each(["cancel", "channel_close"] as const)(
    "closes an opened credential execution without invoking the worker after %s during the open",
    async (event) => {
      const gate = deferred<void>();
      const gateEntered = deferred<void>();
      let closed = 0;
      const h = harness({
        runnerOptions: {
          openExecution: async () => {
            gateEntered.resolve();
            await gate.promise;
            return {
              close: async () => {
                closed += 1;
              },
              executionDir: "/run/opentag-execution/unit",
            };
          },
        },
        worker: async () => {
          throw new Error("the worker must not run after a cancellation during the credential open");
        },
      });
      await h.runner.handleDeliveryRun(runFrame(h.delivery));
      const verifying = h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
      await gateEntered.promise;
      if (event === "cancel") h.runner.handleCancel(h.delivery.deliveryId);
      else h.runner.onChannelClosed();
      gate.resolve();
      await verifying;
      await waitFor(() => reportsOf(h.sent).length === 1, "not-started report");
      const report = reportsOf(h.sent)[0]?.report;
      expect(report?.outcome).toBe("cancelled");
      expect(report?.executionEffects).toBe("not_started");
      expect(report?.errorReason).toBe("client_shutdown");
      expect(h.workerInputs).toHaveLength(0);
      expect(closed).toBe(1);
      const [entry] = await h.journal.list();
      expect(entry?.phase).toBe("reported");
      await h.runner.close();
    },
  );

  it("settles not_started when cancelled before the started boundary and never runs the worker", async () => {
    const gate = deferred<void>();
    const gateEntered = deferred<void>();
    const h = harness({
      worker: async () => {
        throw new Error("the worker must not run after a pre-start cancellation");
      },
    });
    const gated = gateJournalRead(h.journal, gate.promise, () => gateEntered.resolve());
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    gated.arm();
    const verifying = h.runner.handleVerified(verifiedFrame(h.delivery.requestId));
    await gateEntered.promise;
    h.runner.handleCancel(h.delivery.deliveryId);
    gate.resolve();
    await verifying;
    await waitFor(() => reportsOf(h.sent).length === 1, "not-started report");
    const report = reportsOf(h.sent)[0]?.report;
    expect(report?.outcome).toBe("cancelled");
    expect(report?.executionEffects).toBe("not_started");
    expect(report?.errorReason).toBe("client_shutdown");
    expect(h.workerInputs).toHaveLength(0);
    const [entry] = await h.journal.list();
    expect(entry?.phase).toBe("reported");
    gated.restore();
    await h.runner.close();
  });

  it("refuses a delivery outside the current Session scope", async () => {
    const h = harness({ scope: { sessionId: randomUUID() } });
    await h.runner.handleDeliveryRun(runFrame(h.delivery));
    expect(h.sent).toHaveLength(0);
    expect(await h.journal.list()).toHaveLength(0);
    await h.runner.close();
  });
});
