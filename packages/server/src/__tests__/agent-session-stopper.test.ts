import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withAgentSessionStopAuthority } from "../runtime/agent-session-stop-authority.js";
import type { AgentSessionStopDependencies } from "../runtime/agent-session-stopper.js";
import { assertAgentSessionsStopped, stopAgentSessions } from "../runtime/agent-session-stopper.js";

vi.mock("../runtime/agent-session-stop-authority.js", () => ({ withAgentSessionStopAuthority: vi.fn() }));
beforeEach(() => {
  vi.mocked(withAgentSessionStopAuthority).mockImplementation(async (_database, _target, enqueue) =>
    enqueue({} as never),
  );
});
describe("stopAgentSessions", () => {
  it("accepts only explicit stopped reconciliation results", () => {
    expect(() =>
      assertAgentSessionsStopped([
        {
          status: "fulfilled",
          value: {
            type: "session:reconcile:result",
            requestId: "request-1",
            sessionId: "session-1",
            placementGeneration: 1,
            status: "stopped",
          },
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertAgentSessionsStopped([
        {
          status: "fulfilled",
          value: {
            type: "session:reconcile:result",
            requestId: "request-2",
            sessionId: "session-1",
            placementGeneration: 1,
            status: "rejected",
            reason: "runtime unavailable",
          },
        },
      ]),
    ).toThrow("Agent runtime stop notification failed");
    expect(() => assertAgentSessionsStopped([{ status: "rejected", reason: new Error("connection closed") }])).toThrow(
      "Agent runtime stop notification failed",
    );
  });

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
});
