import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RuntimeCapabilityStore } from "../runtime-credentials/capability-store.js";
import { RuntimeCredentialBroker } from "../runtime-credentials/credential-broker.js";
import { RuntimeProviderProxyTransport } from "../runtime-credentials/data-transport.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import { RuntimeScopeResolver, type RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import { RuntimeProxyTicketStore } from "../runtime-credentials/ticket-store.js";

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
}

function fixture() {
  const executions = new RuntimeExecutionRegistry();
  const target = { kind: "git", repository: "acme/docs", path: ".", ref: "main" } as const;
  const parent = executions.open({
    accountId: randomUUID(),
    agentId: randomUUID(),
    agentRevision: 1,
    sessionId: randomUUID(),
    computerId: randomUUID(),
    computerKind: "local",
    instanceId: "instance",
    connectionId: "connection",
    placementGeneration: 1,
    source: { kind: "delivery", deliveryId: "delivery", turnId: "turn" },
    purpose: "execution",
    providers: new Map(),
    runId: randomUUID(),
    services: [{ service: "context-tree", scopes: ["context-tree:local"] }],
  });
  const child = executions.open({
    ...parent,
    purpose: "context-tree",
    contextTree: { ...target, parentExecutionId: parent.executionId, mode: "local" },
  });
  const snapshot: RuntimeScopeSnapshot = {
    sessionId: parent.sessionId,
    sessionKind: "thread",
    sessionEnded: false,
    channelId: "channel",
    threadKey: null,
    slackInstallation: null,
    sandbox: null,
    contextTrees: [target],
    agent: {
      id: parent.agentId,
      status: "active",
      revision: 1,
      computerId: parent.computerId,
      createdByUserId: parent.accountId,
    },
    computer: { id: parent.computerId, kind: "local", ownerAccountId: parent.accountId },
    placement: { computerId: parent.computerId, generation: 1 },
    binding: {
      id: randomUUID(),
      agentId: parent.agentId,
      provider: "slack",
      status: "active",
      credentialGeneration: 1,
      externalAppId: null,
      externalTeamId: null,
      externalTeamBrand: null,
      externalBotId: null,
      slackInstallationId: null,
    },
  };
  const state = { sourceValid: true, snapshot };
  const load = vi.fn(async () => state.snapshot);
  const resolver = new RuntimeScopeResolver({} as never);
  const admit = vi.fn(async () => undefined);
  const broker = new RuntimeCredentialBroker({
    executions,
    capabilities: new RuntimeCapabilityStore(),
    materialResolvers: {},
    scopeResolver: {
      load,
      assertExecutionFence: (record, observed) => resolver.assertExecutionFence(record, observed),
    },
    gitHubAdmission: { admit },
    policy: { authorize: () => "deny" },
    authority: {
      authorize: async () => ({ status: "authorized" }),
      revalidate: async () => (state.sourceValid ? "valid" : "invalid"),
    },
  });
  const tickets = new RuntimeProxyTicketStore();
  const { ticket } = tickets.issue(child);
  const socket = new Socket();
  const transport = new RuntimeProviderProxyTransport({
    executions,
    tickets,
    broker,
    adapters: new Map(),
    revalidateIntervalMs: 10,
  });
  const channel = transport.attach(socket as unknown as WebSocket);
  socket.emit("message", Buffer.from(JSON.stringify({ type: "auth", ticket })), false);
  expect(channel.snapshot().active).toBe(0);
  expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"ready"'));
  return { executions, parent, child, socket, state, admit, load };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("credential-free Context channel", () => {
  it.each(["agent", "revision", "selection", "task"])(
    "cancels an idle channel when %s authority changes",
    async (reason) => {
      const f = fixture();
      await vi.advanceTimersByTimeAsync(10);
      expect(f.socket.close).not.toHaveBeenCalled();
      if (reason === "agent") f.state.snapshot.agent.status = "suspended";
      if (reason === "revision") f.state.snapshot.agent.revision++;
      if (reason === "selection") f.state.snapshot.contextTrees = [];
      if (reason === "task") f.state.sourceValid = false;
      await vi.advanceTimersByTimeAsync(10);
      expect(f.executions.get(f.child.executionId)).toBeUndefined();
      expect(f.socket.close).toHaveBeenCalledOnce();
      expect(f.admit).not.toHaveBeenCalled();
    },
  );

  it("never overlaps checks or revives a child after a slow query crosses parent closure", async () => {
    const f = fixture();
    let release!: (snapshot: RuntimeScopeSnapshot) => void;
    f.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(f.load).toHaveBeenCalledOnce();
    f.executions.close(f.parent.executionId, "execution_closed");
    release(f.state.snapshot);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.executions.get(f.child.executionId)).toBeUndefined();
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.load).toHaveBeenCalledOnce();
  });

  it("keeps valid local work alive without any GitHub admission", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.load).toHaveBeenCalledTimes(10);
    expect(f.socket.close).not.toHaveBeenCalled();
    expect(f.executions.get(f.child.executionId)).toBeDefined();
    expect(f.admit).not.toHaveBeenCalled();
    f.socket.emit("close");
  });
});
