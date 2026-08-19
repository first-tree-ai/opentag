import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshot,
  SessionReconcileRequest,
  TurnReportRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../providers/codex/adapter.js";
import type { CodexAppServerClient, CodexAppServerMessage } from "../providers/codex/app-server-wire.js";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { CodexTurnRunner } from "../runtime/codex-turn-runner.js";
import type { RuntimeConnectionState } from "../runtime/runtime-connection.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import { TurnCustodyOwner } from "../runtime/turn-custody-owner.js";
import { TurnReportOwner } from "../runtime/turn-report-owner.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex Client Turn vertical", () => {
  it("E-01/E-02 completes a first Turn, records it, then resumes the same Thread in a new process", async () => {
    const fixture = await runtimeFixture();
    const first = await fixture.custody.accept(delivery(fixture.runtime, "delivery-1", "first"));
    await first.onAcceptedSent?.();
    const firstReport = await fixture.waitForReport(0);

    expect(fixture.logs).toEqual([]);
    expect(firstReport.errorReason).toBeUndefined();
    expect(firstReport).toMatchObject({
      deliveryId: "delivery-1",
      outcome: "completed",
      executionEffects: "completed",
      finalText: "answer-1",
    });
    expect(fixture.clients).toHaveLength(1);
    expect(fixture.clients[0]?.methods).toContain("thread/start");
    expect(fixture.clients[0]?.methods).not.toContain("thread/resume");
    expect(await fixture.store.read("agent-1", "session-1")).toMatchObject({
      providerThreadId: "thread-1",
      unresolvedTurn: { phase: "reporting", report: firstReport, resultHash: firstReport.resultHash },
    });
    expect(fixture.custody.admission.snapshot().client).toBe(1);

    await fixture.record(firstReport);
    await vi.waitFor(() => expect(fixture.custody.admission.snapshot().client).toBe(0));
    const firstRecorded = await fixture.store.read("agent-1", "session-1");
    expect(firstRecorded?.unresolvedTurn).toBeUndefined();
    expect(firstRecorded?.recentRecordedInputs.at(-1)?.report).toEqual(firstReport);

    const second = await fixture.custody.accept(delivery(fixture.runtime, "delivery-2", "second"));
    await second.onAcceptedSent?.();
    const secondReport = await fixture.waitForReport(1);
    expect(secondReport.finalText).toBe("answer-2");
    expect(fixture.clients).toHaveLength(2);
    expect(fixture.clients[1]?.methods).toContain("thread/resume");
    expect(fixture.clients[1]?.threadId).toBe("thread-1");
    expect(fixture.clients[0]?.cwd).toBe(fixture.clients[1]?.cwd);

    await fixture.record(secondReport);
    await vi.waitFor(() => expect(fixture.custody.admission.snapshot().client).toBe(0));
    const recorded = (await fixture.store.read("agent-1", "session-1"))?.recentRecordedInputs;
    expect(recorded).toHaveLength(2);
    expect(recorded?.at(-1)?.report).toEqual(secondReport);
  });

  it("D-19/D-26 keeps the Provider alive across a mid-turn socket outage and reports after reconnect", async () => {
    let releaseTerminal: (() => void) | undefined;
    const terminalGate = new Promise<void>((resolveGate) => {
      releaseTerminal = resolveGate;
    });
    const fixture = await runtimeFixture(terminalGate);
    const accepted = await fixture.custody.accept(delivery(fixture.runtime, "delivery-1", "offline"));
    await accepted.onAcceptedSent?.();
    await vi.waitFor(async () => {
      expect((await fixture.store.read("agent-1", "session-1"))?.unresolvedTurn?.phase).toBe("running");
    });

    fixture.connection.setState("stopped");
    releaseTerminal?.();
    await vi.waitFor(() => expect(fixture.reportOwner.pendingCount).toBe(1));
    expect(fixture.connection.reports()).toHaveLength(0);
    expect(fixture.clients[0]?.interrupts).toBe(0);
    expect(fixture.clients[0]?.closed).toBe(true);

    fixture.connection.setState("registered");
    const report = await fixture.waitForReport(0);
    expect(report.finalText).toBe("answer-1");
    await fixture.record(report);
    await vi.waitFor(() => expect(fixture.custody.admission.snapshot().client).toBe(0));
  });
});

async function runtimeFixture(terminalGate: Promise<void> = Promise.resolve()) {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-turn-integration-"));
  directories.push(home);
  const computerId = randomUUID();
  const runtime = snapshot();
  const store = new SessionBindingStore({ home, providerHomeIdentity: "a".repeat(64) });
  const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
  const reconciler = new SessionReconciler({ computerId, preparation: workspace });
  const connection = new FakeConnection();
  const reportOwner = new TurnReportOwner({ connection });
  const clients: ScriptedTurnClient[] = [];
  const logs: string[] = [];
  const adapter = new CodexAdapter({
    clientVersion: "0.0.1",
    createClient: (cwd) => {
      const client = new ScriptedTurnClient(cwd, clients.length + 1, terminalGate);
      clients.push(client);
      return client;
    },
  });
  let runner: CodexTurnRunner;
  const custody = new TurnCustodyOwner({
    bindingStore: store,
    reconciler,
    id: (() => {
      let next = 0;
      return () => {
        next += 1;
        return `turn-${next}`;
      };
    })(),
    start: (owner) => runner.start(owner),
  });
  runner = new CodexTurnRunner({
    adapter,
    bindingStore: store,
    connection,
    custody,
    reportOwner,
    workspace,
    log: (message) => logs.push(message),
  });
  const reconcile: SessionReconcileRequest = {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
  await reconciler.reconcile(reconcile);

  const waitForReport = async (index: number): Promise<TurnReportRequest> => {
    await vi.waitFor(() => expect(connection.reports().length).toBeGreaterThan(index));
    const report = connection.reports()[index];
    if (!report) throw new Error("Expected a Turn Report");
    return report;
  };
  const record = (report: TurnReportRequest) =>
    reportOwner.handleResult({
      type: "turn:report:result",
      requestId: report.requestId,
      turnId: report.turnId,
      status: "recorded",
      resultHash: report.resultHash,
    });
  return {
    clients,
    connection,
    custody,
    logs,
    record,
    reconciler,
    reportOwner,
    runner,
    runtime,
    store,
    waitForReport,
    workspace,
  };
}

class FakeConnection {
  readonly sent: unknown[] = [];
  readonly #listeners = new Set<(state: RuntimeConnectionState) => void>();
  state: RuntimeConnectionState = "registered";

  subscribeState(listener: (state: RuntimeConnectionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  async send(frame: unknown): Promise<void> {
    if (this.state !== "registered") throw new Error("socket unavailable");
    this.sent.push(frame);
  }

  setState(state: RuntimeConnectionState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }

  reports(): TurnReportRequest[] {
    return this.sent.filter(
      (frame): frame is TurnReportRequest => (frame as { type?: unknown }).type === "turn:report",
    );
  }
}

class ScriptedTurnClient implements CodexAppServerClient {
  readonly cwd: string;
  readonly methods: string[] = [];
  readonly #number: number;
  readonly #terminalGate: Promise<void>;
  #listener?: (message: CodexAppServerMessage) => void;
  closed = false;
  interrupts = 0;
  threadId?: string;

  constructor(cwd: string, number: number, terminalGate: Promise<void>) {
    this.cwd = cwd;
    this.#number = number;
    this.#terminalGate = terminalGate;
  }

  async initialize(): Promise<void> {
    this.methods.push("initialize", "initialized");
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.methods.push(method);
    if (method === "thread/start" || method === "thread/resume") {
      const input = params as { cwd: string; threadId?: string };
      this.threadId = input.threadId ?? "thread-1";
      return {
        thread: { id: this.threadId, ephemeral: false },
        cwd: input.cwd,
        approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", networkAccess: false },
        instructionSources: [resolve(input.cwd, "AGENTS.md")],
        model: "default-model",
      };
    }
    if (method === "turn/start") {
      const turnId = `provider-turn-${this.#number}`;
      void this.#terminalGate.then(() => {
        this.#listener?.({
          method: "turn/completed",
          params: {
            threadId: this.threadId,
            turn: {
              id: turnId,
              status: "completed",
              items: [
                {
                  id: `answer-${this.#number}`,
                  type: "agentMessage",
                  phase: "final_answer",
                  text: `answer-${this.#number}`,
                },
              ],
            },
          },
        });
      });
      return { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    throw new Error(`Unexpected method ${method}`);
  }

  async notify(): Promise<void> {}

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function delivery(runtime: EffectiveRuntimeSnapshot, deliveryId: string, text: string): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: `message-${deliveryId}`,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text },
    runtime,
  };
}
