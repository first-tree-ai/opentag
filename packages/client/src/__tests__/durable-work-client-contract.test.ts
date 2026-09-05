import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReconcileRequest, TurnReportRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../runtime/admission-controller.js";
import { MvpTurnReportRecovery } from "../runtime/mvp-turn-report-recovery.js";
import {
  type DurableWorkKind,
  type DurableWorkRecord,
  FileRuntimeDurabilityStore,
  MemoryRuntimeDurabilityStore,
  type RuntimeDurabilityStore,
} from "../runtime/runtime-durability.js";
import type { LocalSessionBinding } from "../runtime/session-binding-store.js";
import { SessionMessageInbox } from "../runtime/session-message-inbox.js";
import { TurnReportOwner, type TurnReportOwnerOptions } from "../runtime/turn-report-owner.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";
import {
  messageFixture,
  ObservedDurabilityStore,
  reportFixture,
  reportReceipt,
} from "./support/durable-work-contract.js";

const cleanups: (() => Promise<void>)[] = [];
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function ownerFixture(
  persistence = new ObservedDurabilityStore(),
  initialState: "registered" | "stopped" = "registered",
  retryPolicy: Partial<Record<"baseDelayMs" | "maxDelayMs" | "maxAgeMs" | "maxAttempts", number>> = {},
) {
  let now = 10_000;
  let state = initialState;
  const listeners = new Set<(nextState: "registered" | "stopped") => void>();
  const send = vi.fn(async (_frame: unknown): Promise<void> => undefined);
  const connection = {
    get state() {
      return state;
    },
    send,
    subscribeState(listener: (nextState: "registered" | "stopped") => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  } satisfies TurnReportOwnerOptions["connection"];
  const owner = new TurnReportOwner({
    connection,
    persistence,
    now: () => ++now,
    retryDelayMs: 20,
    retryPolicy: { baseDelayMs: 100, maxDelayMs: 100, maxAgeMs: 1_000, maxAttempts: 10, ...retryPolicy },
  });
  cleanups.push(async () => {
    owner.stop();
    await owner.settled();
    expect(persistence.rejected).toEqual([]);
  });
  return {
    owner,
    persistence,
    send,
    setState(nextState: "registered" | "stopped") {
      state = nextState;
      for (const listener of listeners) listener(nextState);
    },
  };
}

function submit(owner: TurnReportOwner, report: TurnReportRequest): Promise<void> {
  const pending = owner.submit(report, () => undefined);
  void pending.catch(() => undefined);
  return pending;
}

async function acknowledge(owner: TurnReportOwner, report: TurnReportRequest): Promise<void> {
  await owner.handleResult({
    type: "turn:report:result",
    requestId: report.requestId,
    turnId: report.turnId,
    resultHash: report.resultHash,
    status: "recorded",
  });
}

async function waitForStatus(
  persistence: ObservedDurabilityStore,
  report: TurnReportRequest,
  status: string,
): Promise<void> {
  await vi.waitFor(async () => expect(await persistence.status("turn-report", report.turnId)).toBe(status), {
    interval: 1,
  });
}

/**
 * Match the production FileRuntimeDurabilityStore's FIFO writes while allowing
 * a test to hold one committed write open.
 */
class FifoFileLikeStore implements RuntimeDurabilityStore {
  readonly storage = new MemoryRuntimeDurabilityStore();
  readonly edges: string[] = [];
  gateStatus: DurableWorkRecord["status"] | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #release: (() => void) | undefined;
  readonly gateEntered: Promise<void>;
  #enteredResolve!: () => void;

  constructor() {
    this.gateEntered = new Promise<void>((resolve) => {
      this.#enteredResolve = resolve;
    });
  }

  list<T>(kind: DurableWorkKind): Promise<DurableWorkRecord<T>[]> {
    return this.storage.list<T>(kind);
  }

  write<T>(record: DurableWorkRecord<T>): Promise<void> {
    const run = this.#tail.then(async () => {
      if (record.status === this.gateStatus) {
        this.gateStatus = undefined;
        const gate = new Promise<void>((resolve) => {
          this.#release = resolve;
        });
        this.#enteredResolve();
        await gate;
      }
      const previous = (await this.storage.list(record.kind)).find((item) => item.key === record.key);
      if (previous) this.edges.push(`${previous.status} -> ${record.status}`);
      await this.storage.write(record);
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  release(): void {
    this.#release?.();
  }

  async status(kind: DurableWorkKind, key: string): Promise<DurableWorkRecord["status"] | undefined> {
    return (await this.storage.list(kind)).find((record) => record.key === key)?.status;
  }
}

function manualScheduler() {
  const jobs: (() => void)[] = [];
  return {
    scheduler: {
      schedule(_delay: number, run: () => void) {
        jobs.push(run);
        return { cancel: () => undefined };
      },
    },
    fire() {
      const job = jobs.shift();
      if (!job) throw new Error("no scheduled job");
      job();
    },
    get size() {
      return jobs.length;
    },
  };
}

describe("Real-scheduler Client durable-work contract", () => {
  it("accepts a late acknowledgement while the retained row is still accepted", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write(reportReceipt(report, "accepted"));
    const { owner } = ownerFixture(persistence, "stopped");
    await owner.ready();
    const pending = submit(owner, report);
    await acknowledge(owner, report);
    await pending;
    expect(await persistence.status("turn-report", report.turnId)).toBe("succeeded");
    expect(persistence.edges).toContain("accepted -> succeeded");
  });

  it("settles a failed reopening write and preserves dead-letter bookkeeping", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write(reportReceipt(report, "dead-letter"));
    let failAcceptedWrite = true;
    const persistedWrite = persistence.write.bind(persistence);
    persistence.write = async (record) => {
      if (failAcceptedWrite && record.status === "accepted") {
        failAcceptedWrite = false;
        throw {
          category: "conflict",
          code: "reopen_failed",
          message: "reopening was rejected",
          phase: "persistence",
          requestId: report.requestId,
          retryability: "never",
        };
      }
      await persistedWrite(record);
    };
    const { owner } = ownerFixture(persistence);
    await owner.ready();
    await expect(submit(owner, report)).rejects.toMatchObject({ name: "RuntimeDurabilityFailure" });
    expect(await persistence.status("turn-report", report.turnId)).toBe("dead-letter");
    const stored = await persistence.list("turn-report");
    expect(stored[0]).toMatchObject({ attempts: 1, lastError: { code: "reopen_failed" }, status: "dead-letter" });
    expect(persistence.edges).toContain("dead-letter -> dead-letter");
  });

  it("unwedges MVP replay when reopening persistence fails", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write(reportReceipt(report, "dead-letter"));
    persistence.write = async () => {
      throw new Error("server unavailable");
    };
    const { owner } = ownerFixture(persistence, "registered", { maxAttempts: 1 });
    await owner.ready();
    const { recovery, request, logs } = replayFixture(owner, report);
    const result = await recovery.prepare(request, {
      type: "session:reconcile:result",
      requestId: request.requestId,
      sessionId: report.sessionId,
      placementGeneration: 1,
      status: "recovery_required",
      reason: "unresolved_turn",
      turn: { deliveryId: report.deliveryId, turnId: report.turnId },
    });
    recovery.afterReconciled(request, result);
    await vi.waitFor(
      () => expect(logs.some((entry) => entry.message === "Turn Report replay remains pending")).toBe(true),
      { interval: 1 },
    );
    expect(owner.pendingCount).toBe(0);
    expect(persistence.rejected).toEqual([]);
  });

  it("does not start a live pending whose persisted state is still dead-letter", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write(reportReceipt(report, "dead-letter"));
    persistence.write = async () => {
      throw new Error("server unavailable");
    };
    const { owner, send, setState } = ownerFixture(persistence, "stopped");
    await owner.ready();
    const pending = submit(owner, report);
    await sleep(20);
    setState("registered");
    await sleep(30);
    expect(send).not.toHaveBeenCalled();
    owner.stop();
    await expect(pending).rejects.toThrow("stopped");
  });

  it("consumes rejection for a hydrated pending that has no submitter", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write(reportReceipt(report, "failed"));
    const { owner } = ownerFixture(persistence, "stopped");
    await owner.ready();
    expect(owner.pendingCount).toBe(1);
    owner.stop();
    await owner.settled();
  });

  it("settles a normal acknowledgement after the zero-delay timeout persisted retryable", async () => {
    expect(vi.isFakeTimers()).toBe(false);
    const { owner, send, persistence } = ownerFixture();
    await owner.ready();
    const report = reportFixture();
    const pending = submit(owner, report);

    await waitForStatus(persistence, report, "retryable");
    expect(send).toHaveBeenCalledTimes(1);
    expect(persistence.edges).toContain("running -> retryable");
    await acknowledge(owner, report);
    await pending;
    expect(await persistence.status("turn-report", report.turnId)).toBe("succeeded");
    expect(persistence.edges).toContain("retryable -> succeeded");
    expect(owner.pendingCount).toBe(0);
  });

  it("waits for the full acknowledgement delay on the second send attempt", async () => {
    const { owner, send, persistence } = ownerFixture();
    send.mockRejectedValueOnce(new Error("transport unavailable"));
    await owner.ready();
    const report = reportFixture();
    const pending = submit(owner, report);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { interval: 1 });
    const retryWrites = () => persistence.edges.filter((edge) => edge === "running -> retryable").length;
    expect(retryWrites()).toBe(1);
    await sleep(5);
    expect(retryWrites()).toBe(1);
    await vi.waitFor(() => expect(retryWrites()).toBe(2), { interval: 1 });
    owner.stop();
    await expect(pending).rejects.toThrow("stopped");
  });

  it("passes the real FileRuntimeDurabilityStore path without retrying after confirmation", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-round7-owner-"));
    const persistence = new FileRuntimeDurabilityStore(home);
    const send = vi.fn(async (): Promise<void> => undefined);
    const owner = new TurnReportOwner({
      connection: {
        state: "registered",
        send,
        subscribeState(listener) {
          listener("registered");
          return () => undefined;
        },
      },
      persistence,
      retryDelayMs: 150,
    });
    const report = reportFixture();
    const pending = owner.submit(report, async () => {
      await sleep(10);
    });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { interval: 1 });
      await sleep(30);
      await owner.handleResult({
        type: "turn:report:result",
        requestId: report.requestId,
        turnId: report.turnId,
        resultHash: report.resultHash,
        status: "recorded",
      });
      await pending;
      await sleep(180);
      const stored = (await persistence.list("turn-report")).find((record) => record.key === report.turnId);
      expect(stored).toMatchObject({ status: "succeeded", attempts: 0 });
      expect(stored?.nextAttemptAt).toBeUndefined();
    } finally {
      owner.stop();
      await owner.settled();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps succeeded absorbing when an in-flight send fails after acknowledgement", async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const { owner, send, persistence } = ownerFixture();
    send.mockImplementation(async () => {
      await sendGate;
      throw new Error("late send failure");
    });
    await owner.ready();
    const report = reportFixture();
    const pending = submit(owner, report);
    await waitForStatus(persistence, report, "running");
    await acknowledge(owner, report);
    await pending;
    releaseSend();
    await owner.settled();
    expect(await persistence.status("turn-report", report.turnId)).toBe("succeeded");
    expect(persistence.edges).not.toContain("succeeded -> retryable");
    expect(persistence.edges).not.toContain("succeeded -> dead-letter");
  });

  it("does not overwrite the committed succeeded row when acknowledgement overlaps a retry", async () => {
    const persistence = new FifoFileLikeStore();
    const retry = manualScheduler();
    let now = 10_000;
    const send = vi.fn(async (): Promise<void> => undefined);
    const owner = new TurnReportOwner({
      connection: {
        get state() {
          return "registered" as const;
        },
        send,
        subscribeState(listener) {
          listener("registered");
          return () => undefined;
        },
      },
      persistence,
      now: () => ++now,
      retryDelayMs: 5_000,
      scheduler: retry.scheduler,
      retryPolicy: { baseDelayMs: 100, maxDelayMs: 100, maxAgeMs: 1_000_000, maxAttempts: 10 },
    });
    await owner.ready();

    const report = reportFixture();
    const pending = owner.submit(report, async () => undefined);
    void pending.catch(() => undefined);

    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { interval: 1 });
      await vi.waitFor(async () => expect(await persistence.status("turn-report", report.turnId)).toBe("running"), {
        interval: 1,
      });
      await vi.waitFor(() => expect(retry.size).toBe(1), { interval: 1 });

      // Hold the succeeded commit open so the acknowledgement timer can run in parallel.
      persistence.gateStatus = "succeeded";
      const handled = owner.handleResult({
        type: "turn:report:result",
        requestId: report.requestId,
        turnId: report.turnId,
        resultHash: report.resultHash,
        status: "recorded",
      });
      await persistence.gateEntered;
      retry.fire();

      persistence.release();
      await handled;
      await pending;
      await owner.settled();

      // These assertions inspect writes committed by the durable store, not the owner mirror.
      expect(persistence.edges).not.toContain("succeeded -> retryable");
      expect(await persistence.status("turn-report", report.turnId)).toBe("succeeded");
    } finally {
      persistence.release();
      owner.stop();
      await owner.settled();
    }
  });

  it("retries when the retryable state persist fails transiently", async () => {
    const persistence = new ObservedDurabilityStore();
    let failRetryableWrite = true;
    const persistedWrite = persistence.write.bind(persistence);
    persistence.write = async (record) => {
      if (failRetryableWrite && record.status === "retryable") {
        failRetryableWrite = false;
        throw new Error("temporary persistence outage");
      }
      await persistedWrite(record);
    };
    const { owner, send } = ownerFixture(persistence);
    send.mockRejectedValueOnce(new Error("transport unavailable"));
    await owner.ready();
    const report = reportFixture();
    const pending = submit(owner, report);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { interval: 1 });
    await acknowledge(owner, report);
    await pending;
    expect(await persistence.status("turn-report", report.turnId)).toBe("succeeded");
  });

  it("settles a conflict result when its failed-state persist is rejected", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write(reportReceipt(report, "accepted"));
    const persistedWrite = persistence.write.bind(persistence);
    persistence.write = async (record) => {
      if (record.status === "failed") throw new Error("failed-state persist rejected");
      await persistedWrite(record);
    };
    const { owner } = ownerFixture(persistence, "stopped");
    await owner.ready();
    const pending = submit(owner, report);
    void pending.catch(() => undefined);
    await owner.handleResult({
      type: "turn:report:result",
      requestId: report.requestId,
      turnId: report.turnId,
      status: "conflict",
      resultHash: report.resultHash,
    });
    await expect(pending).rejects.toThrow("failed-state persist rejected");
    expect(owner.pendingCount).toBe(0);
  });

  it("runs the real retry timer through retryable, accepted, and running", async () => {
    const { owner, send, persistence } = ownerFixture();
    send.mockRejectedValueOnce(new Error("transport unavailable"));
    await owner.ready();
    const report = reportFixture();
    const pending = submit(owner, report);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { interval: 1 });
    expect(persistence.edges).toEqual(
      expect.arrayContaining(["running -> retryable", "retryable -> accepted", "accepted -> running"]),
    );
    await acknowledge(owner, report);
    await pending;
    expect(await persistence.status("turn-report", report.turnId)).toBe("succeeded");
  });

  it("hydrates interrupted running work, persists retryable, and sends again", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write(reportReceipt(report, "running"));
    const { owner, send } = ownerFixture(persistence);
    await owner.ready();
    const pending = submit(owner, report);
    await vi.waitFor(() => expect(send).toHaveBeenCalled(), { interval: 1 });
    expect(persistence.edges).toEqual(expect.arrayContaining(["running -> retryable", "retryable -> running"]));
    await acknowledge(owner, report);
    await pending;
  });

  it.each(["conflict", "stale_generation"] as const)(
    "hydrates and explicitly rearms a retained %s report",
    async (code) => {
      const persistence = new ObservedDurabilityStore();
      const report = reportFixture();
      await persistence.storage.write({
        ...reportReceipt(report, "failed"),
        lastError: {
          code,
          category: "conflict",
          phase: "request",
          requestId: report.requestId,
          retryability: "never",
          message: code,
        },
      });
      const { owner, send } = ownerFixture(persistence);
      await owner.ready();
      const pending = submit(owner, report);
      expect(owner.rearmTerminal({ ...report, placementGeneration: 2 })).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(owner.rearmTerminal(report)).toBe(true);
      submit(owner, report);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { interval: 1 });
      expect(persistence.edges).toContain("failed -> running");
      await acknowledge(owner, report);
      await pending;
    },
  );

  it("replays an age-expired Report through MvpTurnReportRecovery and delivers one frame", async () => {
    const persistence = new ObservedDurabilityStore();
    const report = reportFixture();
    await persistence.storage.write({ ...reportReceipt(report, "accepted"), acceptedAt: 1 });
    const { owner, send } = ownerFixture(persistence);
    await owner.ready();
    await waitForStatus(persistence, report, "dead-letter");
    expect(owner.pendingCount).toBe(0);
    expect(owner.rearmTerminal(report)).toBe(false);
    send.mockImplementation(async () => acknowledge(owner, report));

    const { recovery, request, logs, recordResult } = replayFixture(owner, report);
    const result = await recovery.prepare(request, {
      type: "session:reconcile:result",
      requestId: request.requestId,
      sessionId: report.sessionId,
      placementGeneration: 1,
      status: "recovery_required",
      reason: "unresolved_turn",
      turn: { deliveryId: report.deliveryId, turnId: report.turnId },
    });
    expect(result.retainedReports).toHaveLength(1);
    recovery.afterReconciled(request, result);
    await vi.waitFor(() => expect(logs.some((entry) => entry.message === "Turn Report replay completed")).toBe(true), {
      interval: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(report, { priority: "report" });
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(persistence.edges).toEqual(
      expect.arrayContaining([
        "accepted -> dead-letter",
        "dead-letter -> accepted",
        "accepted -> running",
        "running -> succeeded",
      ]),
    );
    expect(await persistence.status("turn-report", report.turnId)).toBe("succeeded");
  });

  it.each(["succeeded", "retry", "failed", "dead-letter"] as const)(
    "runs the Inbox %s path with real timers",
    async (outcome) => {
      const persistence = new ObservedDurabilityStore();
      const request = messageFixture();
      let now = 10_000;
      let attempts = 0;
      const prompt = vi.fn(async () => {
        attempts += 1;
        if (outcome === "failed") throw { message: "blocked", retryability: "never" };
        if (outcome === "dead-letter" || (outcome === "retry" && attempts === 1))
          throw new Error("provider unavailable");
        return { status: "completed", output: [] };
      });
      const inbox = new SessionMessageInbox({
        admission: new AdmissionController(),
        persistence,
        now: () => ++now,
        credentialEnvironment: { cleanup: vi.fn(), prepare: vi.fn() },
        imCredentialGrantVersion: () => 2,
        logger: { warn: vi.fn() },
        retryPolicy: {
          baseDelayMs: 10,
          maxDelayMs: 10,
          maxAgeMs: 1_000,
          maxAttempts: outcome === "dead-letter" ? 1 : 5,
        },
        reconciler: {
          checkSessionMessageDelivery: () => undefined,
          clearActivity: () => true,
          setActivity: () => undefined,
          withAgentLock: async (_agentId, action) => action(),
        },
        runtimeManager: {
          sessionKind: () => "internal",
          ensureRuntime: vi.fn(async () => ({ waitForIdle: vi.fn(), prompt }) as never),
        },
      });
      cleanups.push(async () => {
        inbox.stop();
        await inbox.settled();
        expect(persistence.rejected).toEqual([]);
      });
      await expect(inbox.accept(request)).resolves.toMatchObject({ status: "accepted" });
      const status = outcome === "retry" ? "succeeded" : outcome;
      await vi.waitFor(
        async () =>
          expect(await persistence.status("session-message", `${request.targetSessionId}:${request.messageId}`)).toBe(
            status,
          ),
        { interval: 1 },
      );
      await inbox.settled();
      expect(persistence.edges).toContain("accepted -> running");
      if (outcome === "retry")
        expect(persistence.edges).toEqual(
          expect.arrayContaining(["running -> retryable", "retryable -> accepted", "running -> succeeded"]),
        );
    },
  );
});

function replayFixture(owner: TurnReportOwner, report: TurnReportRequest) {
  const logs: RecordedLog[] = [];
  const binding: LocalSessionBinding = {
    schemaVersion: 3,
    agentId: report.agentId,
    sessionId: report.sessionId,
    placementGeneration: 1,
    workspaceId: "workspace",
    provider: "codex",
    providerHomeIdentity: "a".repeat(64),
    appliedSessionRevisionSequence: 1,
    appliedSessionRevisionId: "revision",
    sessionConfigHash: "a".repeat(64),
    lastEffectiveSnapshotHash: "a".repeat(64),
    recentRecordedInputs: [],
    unresolvedTurn: {
      requestId: report.requestId,
      deliveryId: report.deliveryId,
      turnId: report.turnId,
      inputHash: "a".repeat(64),
      phase: "reporting",
      report,
      resultHash: report.resultHash,
    },
  };
  const recordResult = vi.fn(async () => binding);
  const recovery = new MvpTurnReportRecovery({
    reportOwner: owner,
    logger: recordingLogger(logs),
    bindingStore: { read: async () => binding, recordResult, updateUnresolved: vi.fn() },
    reconciler: {
      claimRecovery: () => true,
      clearRecovery: vi.fn(),
      withAgentLock: async (_agentId, action) => action(),
    },
  });
  const request: SessionReconcileRequest = {
    type: "session:reconcile",
    requestId: randomUUID(),
    installationId: "computer",
    agentId: report.agentId,
    sessionId: report.sessionId,
    placementGeneration: 1,
    desired: "ready",
    runtime: messageFixture().runtime,
  };
  return { recovery, request, logs, recordResult };
}
