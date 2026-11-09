import { randomUUID } from "node:crypto";
import type { SessionReconcileResult } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withAgentSessionStopAuthority,
  withEndedSessionStopAuthority,
} from "../runtime/agent-session-stop-authority.js";
import type { AgentSessionStopDependencies } from "../runtime/agent-session-stopper.js";
import { stopAgentSessions, stopEndedInternalSessions } from "../runtime/agent-session-stopper.js";

import { RuntimeDomainRequestError } from "../runtime/runtime-domain-owner.js";
import { deferred } from "./support/deferred.js";

vi.mock("../runtime/agent-session-stop-authority.js", () => ({
  withAgentSessionStopAuthority: vi.fn(),
  withEndedSessionStopAuthority: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(withAgentSessionStopAuthority).mockImplementation(async (_database, _target, enqueue) =>
    enqueue({} as never),
  );
  vi.mocked(withEndedSessionStopAuthority).mockImplementation(async (_database, _target, enqueue) =>
    enqueue({} as never),
  );
});
describe("stopEndedInternalSessions", () => {
  const target = (computerKind: "local" | "cloud" = "local") => ({
    agentId: randomUUID(),
    computerId: randomUUID(),
    computerKind,
    creatorSessionId: randomUUID(),
    installationId: randomUUID(),
    placementGeneration: 3,
    sessionId: randomUUID(),
  });
  function dependencies(status: SessionReconcileResult["status"] = "stopped") {
    const requestReconcile = vi.fn(async (_computer, _instance, request, _dispatched, admission) => {
      const result = {
        type: "session:reconcile:result",
        requestId: request.requestId,
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        status,
      };
      const admitted = await admission((send: () => void) => {
        send();
        return Promise.resolve(result);
      });
      if (!admitted.admitted) throw new Error("not admitted");
      return admitted.result;
    });
    return {
      currentInstanceId: vi.fn((_computerId: string): string | undefined => "instance"),
      requestReconcile: requestReconcile as never,
      reconcileMock: requestReconcile,
      revokeProof: vi.fn(async (_sessionId: string) => undefined),
      onDiagnostic: vi.fn(),
    };
  }

  it("confirms a Local stop, names the internal kind on the frame, and retires the proof", async () => {
    const stop = target();
    const deps = dependencies();
    await expect(stopEndedInternalSessions({} as never, [stop], deps)).resolves.toEqual(
      new Map([[stop.sessionId, "stopped"]]),
    );
    expect(deps.reconcileMock.mock.calls[0]?.[2]).toMatchObject({
      desired: "stopped",
      sessionKind: "internal",
      creatorSessionId: stop.creatorSessionId,
      sessionId: stop.sessionId,
    });
    expect(deps.revokeProof).toHaveBeenCalledWith(stop.sessionId);
    expect(withEndedSessionStopAuthority).toHaveBeenCalledOnce();
    expect(withAgentSessionStopAuthority).not.toHaveBeenCalled();
  });

  it("keeps the answer when retiring the proof fails", async () => {
    const stop = target();
    const deps = dependencies();
    deps.revokeProof.mockRejectedValue(new Error("write failed"));
    await expect(stopEndedInternalSessions({} as never, [stop], deps)).resolves.toEqual(
      new Map([[stop.sessionId, "stopped"]]),
    );
    expect(deps.onDiagnostic).toHaveBeenCalledWith("SESSION_STOP_PROOF_REVOKE_FAILED");
  });

  it.each([
    ["busy", "not_interrupted"],
    ["rejected", "pending"],
  ] as const)("reports a Client answering %s as %s, keeping the proof", async (status, execution) => {
    const stop = target();
    const deps = dependencies(status);
    await expect(stopEndedInternalSessions({} as never, [stop], deps)).resolves.toEqual(
      new Map([[stop.sessionId, execution]]),
    );
    expect(deps.revokeProof).not.toHaveBeenCalled();
  });

  it("reports an offline Computer or a refused authority as pending", async () => {
    const stop = target();
    const deps = dependencies();
    deps.currentInstanceId.mockReturnValueOnce(undefined);
    await expect(stopEndedInternalSessions({} as never, [stop], deps)).resolves.toEqual(
      new Map([[stop.sessionId, "pending"]]),
    );
    expect(deps.reconcileMock).not.toHaveBeenCalled();
    vi.mocked(withEndedSessionStopAuthority).mockResolvedValueOnce(undefined);
    await expect(stopEndedInternalSessions({} as never, [stop], deps)).resolves.toEqual(
      new Map([[stop.sessionId, "pending"]]),
    );
  });

  it("cancels Cloud Sessions through the Runner owner and never fails", async () => {
    const stop = target("cloud");
    const deps = dependencies();
    const cancelSessionMessages = vi.fn(async () => [{ messageId: randomUUID(), status: "requested" as const }]);
    const cloud = { ...deps, cloudSession: { cancelSessionMessages } as never };
    await expect(stopEndedInternalSessions({} as never, [stop], cloud)).resolves.toEqual(
      new Map([[stop.sessionId, "requested"]]),
    );
    expect(cancelSessionMessages).toHaveBeenCalledWith(stop.sessionId);
    expect(deps.reconcileMock).not.toHaveBeenCalled();
    cancelSessionMessages.mockResolvedValueOnce([{ messageId: randomUUID(), status: "no_connection" as "requested" }]);
    await expect(stopEndedInternalSessions({} as never, [stop], cloud)).resolves.toEqual(
      new Map([[stop.sessionId, "pending"]]),
    );
    cancelSessionMessages.mockRejectedValueOnce(new Error("owner failed"));
    await expect(stopEndedInternalSessions({} as never, [stop], cloud)).resolves.toEqual(
      new Map([[stop.sessionId, "pending"]]),
    );
    expect(deps.onDiagnostic).toHaveBeenCalledWith("CLOUD_SESSION_STOP_FAILED");
    await expect(stopEndedInternalSessions({} as never, [stop], deps)).resolves.toEqual(
      new Map([[stop.sessionId, "pending"]]),
    );
  });
});

describe("stopAgentSessions", () => {
  it("returns before touching the database when no stop targets exist", async () => {
    const database = { transaction: vi.fn() };
    await stopAgentSessions(database as never, [], { currentInstanceId: vi.fn(), requestReconcile: vi.fn() as never });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("skips targets without a current runtime without borrowing SQL", async () => {
    const database = { transaction: vi.fn() };
    const requestReconcile = vi.fn();
    await stopAgentSessions(
      database as never,
      [
        {
          agentId: randomUUID(),
          agentRevision: 2,
          computerId: randomUUID(),
          installationId: randomUUID(),
          sessionId: randomUUID(),
          placementGeneration: 1,
        },
      ],
      { currentInstanceId: () => undefined, requestReconcile },
    );
    expect(database.transaction).not.toHaveBeenCalled();
    expect(requestReconcile).not.toHaveBeenCalled();
  });

  it("dispatches stop requests and fails if a daemon rejects or reports another state", async () => {
    const database = {};
    const targets = [
      {
        agentId: randomUUID(),
        agentRevision: 2,
        computerId: randomUUID(),
        installationId: randomUUID(),
        sessionId: randomUUID(),
        placementGeneration: 2,
      },
      {
        agentId: randomUUID(),
        agentRevision: 2,
        computerId: randomUUID(),
        installationId: randomUUID(),
        sessionId: randomUUID(),
        placementGeneration: 3,
      },
    ];
    const currentInstanceId = vi.fn((computerId: string) =>
      computerId === targets[0]?.computerId ? "instance-1" : undefined,
    );
    const requestReconcile = vi.fn(
      async (_computerId: string, _instanceId: string, _request: unknown, onDispatched?: () => void) => {
        onDispatched?.();
        return {
          type: "session:reconcile:result",
          requestId: randomUUID(),
          sessionId: targets[0]?.sessionId,
          placementGeneration: 2,
          status: "running",
        } as never;
      },
    );
    await expect(
      stopAgentSessions(database as never, targets, { currentInstanceId, requestReconcile: requestReconcile as never }),
    ).rejects.toThrow("Agent runtime stop notification failed");
    expect(requestReconcile).toHaveBeenCalledWith(
      targets[0]?.computerId,
      "instance-1",
      expect.objectContaining({ desired: "stopped", placementGeneration: 2 }),
      undefined,
      expect.any(Function),
      expect.any(AbortSignal),
    );

    const rejecting = vi.fn(
      async (_computerId: string, _instanceId: string, _request: unknown, onDispatched?: () => void) => {
        onDispatched?.();
        throw new Error("daemon unavailable");
      },
    );
    await expect(
      stopAgentSessions(database as never, targets.slice(0, 1), {
        currentInstanceId,
        requestReconcile: rejecting as never,
      }),
    ).rejects.toThrow("Agent runtime stop notification failed");
  });
  it("treats superseded final admission as a skip without fabricating a stopped result", async () => {
    vi.mocked(withAgentSessionStopAuthority).mockResolvedValueOnce(undefined);
    const requestReconcile: AgentSessionStopDependencies["requestReconcile"] = async (
      _computer,
      _instance,
      _request,
      _onDispatched,
      admission,
    ) => {
      if (!admission) throw new Error("Missing admission");
      const result = await admission(() => {
        throw new Error("Must not enqueue");
      });
      if (!result.admitted) throw new Error("Superseded");
      return result.result;
    };
    await expect(
      stopAgentSessions(
        {} as never,
        [
          {
            agentId: randomUUID(),
            agentRevision: 2,
            computerId: randomUUID(),
            installationId: randomUUID(),
            sessionId: randomUUID(),
            placementGeneration: 1,
          },
        ],
        { currentInstanceId: () => "instance", requestReconcile },
      ),
    ).resolves.toBeUndefined();
  });

  it("limits complete stop operations to 16 while sharing one native dispatch budget", async () => {
    const budget = dispatchBudget();
    const release = deferred();
    let active = 0,
      peak = 0;
    const requestReconcile = vi.fn<AgentSessionStopDependencies["requestReconcile"]>(
      async (_computer, _instance, request) => {
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
        return stopped(request);
      },
    );
    const result = stopAgentSessions({} as never, stopTargets(64), {
      currentInstanceId: () => "instance",
      requestReconcile,
    }).then(
      () => undefined,
      (error) => error,
    );
    try {
      await vi.waitFor(() => expect(requestReconcile).toHaveBeenCalledTimes(16));
      expect(active).toBe(16);
      expect(AbortSignal.timeout).toHaveBeenCalledWith(30000);
      release.resolve();
      expect(await result).toBeUndefined();
      expect(requestReconcile).toHaveBeenCalledTimes(64);
      expect(peak).toBe(16);
      expect(active).toBe(0);
      expect(new Set(requestReconcile.mock.calls.map((args) => args[5]))).toEqual(new Set([budget.signal]));
    } finally {
      release.resolve();
      await result;
    }
  });

  it("joins preparation after cutoff without entering a new authority transaction", async () => {
    const budget = dispatchBudget(),
      entered = deferred(),
      release = deferred();
    const send = vi.fn();
    let finished = false;
    const requestReconcile: AgentSessionStopDependencies["requestReconcile"] = async (
      _computer,
      _instance,
      request,
      _sent,
      admission,
    ) => {
      entered.resolve();
      await release.promise;
      if (!admission) throw new Error("Missing admission");
      const admitted = await admission(async () => {
        send();
        return stopped(request);
      });
      if (!admitted.admitted) throw new Error("Not admitted");
      return admitted.result;
    };
    const result = stopAgentSessions({} as never, stopTargets(1), {
      currentInstanceId: () => "instance",
      requestReconcile,
    })
      .then(
        () => undefined,
        (error) => error,
      )
      .finally(() => {
        finished = true;
      });
    try {
      await entered.promise;
      budget.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(withAgentSessionStopAuthority).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await result;
    }
  });

  it("fences enqueue after an already-entered authority wait crosses cutoff", async () => {
    const budget = dispatchBudget(),
      entered = deferred(),
      release = deferred();
    const send = vi.fn();
    vi.mocked(withAgentSessionStopAuthority).mockImplementationOnce(async (_database, _target, enqueue) => {
      entered.resolve();
      await release.promise;
      return enqueue({} as never);
    });
    const requestReconcile: AgentSessionStopDependencies["requestReconcile"] = async (
      _computer,
      _instance,
      request,
      _sent,
      admission,
      signal,
    ) => {
      if (!admission) throw new Error("Missing admission");
      const admitted = await admission(async () => {
        signal?.throwIfAborted();
        send();
        return stopped(request);
      });
      if (!admitted.admitted) throw new Error("Not admitted");
      return admitted.result;
    };
    const result = stopAgentSessions({} as never, stopTargets(1), {
      currentInstanceId: () => "instance",
      requestReconcile,
    }).then(
      () => undefined,
      (error) => error,
    );
    try {
      await entered.promise;
      budget.abort();
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(withAgentSessionStopAuthority).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await result;
    }
  });

  it("keeps a confirmed result after cutoff and waits for its real settlement", async () => {
    const budget = dispatchBudget(),
      entered = deferred(),
      release = deferred();
    let finished = false;
    const requestReconcile: AgentSessionStopDependencies["requestReconcile"] = async (
      _computer,
      _instance,
      request,
    ) => {
      entered.resolve();
      await release.promise;
      return stopped(request);
    };
    const result = stopAgentSessions({} as never, stopTargets(1), {
      currentInstanceId: () => "instance",
      requestReconcile,
    })
      .then(
        () => undefined,
        (error) => error,
      )
      .finally(() => {
        finished = true;
      });
    try {
      await entered.promise;
      budget.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      release.resolve();
      expect(await result).toBeUndefined();
    } finally {
      release.resolve();
      await result;
    }
  });

  it("stops new targets on capacity while the other started requests still settle", async () => {
    const budget = dispatchBudget(),
      release = deferred();
    let called = 0,
      completed = 0,
      finished = false;
    const requestReconcile = vi.fn<AgentSessionStopDependencies["requestReconcile"]>(
      async (_computer, _instance, request) => {
        if (++called === 1) throw new RuntimeDomainRequestError("capacity", "Full");
        await release.promise;
        completed++;
        return stopped(request);
      },
    );
    const result = stopAgentSessions({} as never, stopTargets(64), {
      currentInstanceId: () => "instance",
      requestReconcile,
    })
      .then(
        () => undefined,
        (error) => error,
      )
      .finally(() => {
        finished = true;
      });
    try {
      await vi.waitFor(() => expect(requestReconcile).toHaveBeenCalledTimes(16));
      expect(finished).toBe(false);
      expect(budget.signal.aborted).toBe(false);
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(completed).toBe(15);
      expect(requestReconcile).toHaveBeenCalledTimes(16);
    } finally {
      release.resolve();
      await result;
    }
  });

  it("continues other targets after an individual transport failure", async () => {
    dispatchBudget();
    let called = 0;
    const requestReconcile = vi.fn<AgentSessionStopDependencies["requestReconcile"]>(
      async (_computer, _instance, request) => {
        if (++called === 1) throw new Error("Disconnected");
        return stopped(request);
      },
    );
    await expect(
      stopAgentSessions({} as never, stopTargets(33), { currentInstanceId: () => "instance", requestReconcile }),
    ).rejects.toThrow("Agent runtime stop notification failed");
    expect(requestReconcile).toHaveBeenCalledTimes(33);
  });
});

function dispatchBudget() {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  return controller;
}
function stopTargets(count: number) {
  const agentId = randomUUID(),
    computerId = randomUUID(),
    installationId = randomUUID();
  return Array.from({ length: count }, () => ({
    agentId,
    computerId,
    installationId,
    agentRevision: 2,
    sessionId: randomUUID(),
    placementGeneration: 1,
  }));
}
function stopped(request: Parameters<AgentSessionStopDependencies["requestReconcile"]>[2]): SessionReconcileResult {
  return {
    type: "session:reconcile:result",
    requestId: request.requestId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    status: "stopped",
  };
}
