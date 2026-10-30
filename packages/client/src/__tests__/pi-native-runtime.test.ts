import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, CreateAgentRuntimeRequest } from "../agent-runtime/types.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import type { PiRpcClient } from "../providers/pi/rpc-wire.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_FILE = `/sessions/${SESSION_ID}.jsonl`;
const input = (text: string) => ({ items: [{ type: "text" as const, text }] });
const STARTUP_ERROR = "Pi emitted model activity before the requested prompt";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class PhaseClient implements PiRpcClient {
  readonly commands: Readonly<Record<string, unknown>>[] = [];
  readonly listeners = new Set<(message: Readonly<Record<string, unknown>>) => void>();
  readonly promptCalled = deferred();
  readonly promptAck = deferred();
  readonly fenceCalled = deferred();
  readonly fence = deferred();
  startup?: () => void;
  initialState: Record<string, unknown> = {};
  nextState: Record<string, unknown> = {};
  closed = false;
  #initialState = true;

  async request(command: Readonly<Record<string, unknown>>) {
    this.commands.push(command);
    if (command.type === "get_state") {
      const initial = this.#initialState;
      this.#initialState = false;
      if (initial) this.startup?.();
      else {
        this.fenceCalled.resolve();
        await this.fence.promise;
      }
      return {
        sessionId: SESSION_ID,
        sessionFile: SESSION_FILE,
        messageCount: 2,
        pendingMessageCount: 0,
        isStreaming: false,
        isCompacting: false,
        ...(initial ? this.initialState : this.nextState),
      };
    }
    if (command.type === "prompt") {
      this.promptCalled.resolve();
      await this.promptAck.promise;
    }
    return undefined;
  }
  subscribe(listener: (message: Readonly<Record<string, unknown>>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(message: Readonly<Record<string, unknown>>) {
    for (const listener of this.listeners) listener(message);
  }
  complete() {
    const message = { role: "assistant", content: [{ type: "text", text: "owned output" }], stopReason: "stop" };
    for (const event of [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message },
      { type: "message_end", message },
      { type: "turn_end", message },
      { type: "agent_settled" },
    ])
      this.emit(event);
  }
  async close() {
    this.closed = true;
    this.#initialState = true;
  }
}

async function open(client: PhaseClient, events: AgentRuntimeEvent[]) {
  const request: CreateAgentRuntimeRequest = {
    workspace: { cwd: "/workspace" },
    systemPrompt: "fixture",
    policy: { approvals: "never", fileSystem: "unrestricted", network: "enabled", tools: { mode: "provider-default" } },
    eventSink: (event) => {
      events.push(event);
    },
  };
  return new PiAgentRuntimeFactory({ nativeResources: true, createClient: () => client }).resume({
    ...request,
    binding: {
      providerId: "pi",
      schemaVersion: 1,
      payload: { sessionId: SESSION_ID, sessionFileHash: createHash("sha256").update(SESSION_FILE).digest("hex") },
    },
  });
}

describe("Local Pi prompt ownership", () => {
  it.each([
    { type: "agent_start" },
    { type: "agent_settled" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "user" } },
    { type: "message_start" },
    { type: "message_update" },
    { type: "compaction_start" },
    { type: "tool_execution_start" },
  ])("rejects startup model activity before it owns a Run: $type", async (event) => {
    const client = new PhaseClient();
    client.startup = () => client.emit(event);
    const events: AgentRuntimeEvent[] = [];
    const runtime = await open(client, events);
    const result = await runtime.prompt({ runId: "requested", input: input("requested input") });
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "provider_protocol_error", message: STARTUP_ERROR },
    });
    expect(client.commands.some((command) => command.type === "prompt")).toBe(false);
    expect(events.some((entry) => entry.type === "model_turn_started" || entry.type === "run_completed")).toBe(false);
    await runtime.close();
  });

  it("does not return a completed startup turn as the requested prompt's output", async () => {
    const client = new PhaseClient();
    client.startup = () => client.complete();
    client.promptAck.resolve();
    client.fence.resolve();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await open(client, events);
    await expect(runtime.prompt({ runId: "requested", input: input("/consumed") })).resolves.toMatchObject({
      status: "failed",
      error: { message: STARTUP_ERROR },
    });
    expect(events.filter((event) => event.type === "message_completed")).toHaveLength(0);
    await runtime.close();
  });

  it.each([{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }])(
    "rejects active initial native state even when startup events were not observed: %o",
    async (state) => {
      const client = new PhaseClient();
      client.initialState = state;
      const runtime = await open(client, []);
      await expect(runtime.prompt({ runId: "busy", input: input("requested") })).resolves.toMatchObject({
        status: "failed",
        error: { code: "provider_protocol_error", message: expect.stringContaining("before the requested prompt") },
      });
      expect(client.commands.some((command) => command.type === "prompt")).toBe(false);
      await runtime.close();
    },
  );

  it.each([false, true])("fences concurrent steer across acknowledgement (owned model: %s)", async (owned) => {
    const client = new PhaseClient();
    client.nextState = { isStreaming: owned };
    const events: AgentRuntimeEvent[] = [];
    const runtime = await open(client, events);
    const run = runtime.prompt({ runId: "requested", input: input(owned ? "hello" : "/consumed") });
    await client.promptCalled.promise;
    let steerSettled = false;
    const steer = runtime
      .steer({ expectedRunId: "requested", input: input("follow-up") })
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      )
      .finally(() => {
        steerSettled = true;
      });
    client.promptAck.resolve();
    await client.fenceCalled.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(steerSettled).toBe(false);
    expect(client.commands.some((command) => command.type === "steer")).toBe(false);
    client.fence.resolve();
    if (owned) {
      await expect(steer).resolves.toEqual({ ok: true });
      expect(events.some((event) => event.type === "input_accepted")).toBe(true);
      client.complete();
      await expect(run).resolves.toMatchObject({ status: "completed" });
    } else {
      await expect(run).resolves.toMatchObject({ status: "failed", error: { code: "provider_request_rejected" } });
      await expect(steer).resolves.toMatchObject({ ok: false, error: { code: "provider_request_rejected" } });
      expect(events.some((event) => event.type === "input_accepted")).toBe(false);
      expect(client.commands.some((command) => command.type === "steer")).toBe(false);
    }
    await runtime.close();
  });

  it("does not send a waiting steer after the owned model has settled at the fence", async () => {
    const client = new PhaseClient();
    const runtime = await open(client, []);
    const run = runtime.prompt({ runId: "requested", input: input("hello") });
    await client.promptCalled.promise;
    const steer = runtime
      .steer({ expectedRunId: "requested", input: input("late follow-up") })
      .catch((error: unknown) => error);
    client.complete();
    client.promptAck.resolve();
    client.fence.resolve();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    await expect(steer).resolves.toMatchObject({ code: "run_mismatch" });
    expect(client.commands.some((command) => command.type === "steer")).toBe(false);
    await runtime.close();
  });

  it("resets prompt ownership before the next Run on the same runtime", async () => {
    const client = new PhaseClient();
    const events: AgentRuntimeEvent[] = [];
    const runtime = await open(client, events);
    const first = runtime.prompt({ runId: "first", input: input("hello") });
    await client.promptCalled.promise;
    client.complete();
    client.promptAck.resolve();
    client.fence.resolve();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    client.startup = () => client.complete();
    const promptCount = client.commands.filter((command) => command.type === "prompt").length;
    await expect(runtime.prompt({ runId: "second", input: input("/consumed") })).resolves.toMatchObject({
      status: "failed",
      error: { message: STARTUP_ERROR },
    });
    expect(client.commands.filter((command) => command.type === "prompt")).toHaveLength(promptCount);
    expect(events.some((event) => event.type === "run_completed" && event.runId === "second")).toBe(false);
    await runtime.close();
  });

  it("preserves custom startup messages outside model turns", async () => {
    const client = new PhaseClient();
    const custom = { role: "custom", content: "startup custom content", customType: "fixture", display: true };
    client.startup = () => {
      client.emit({ type: "message_start", message: custom });
      client.emit({ type: "message_end", message: custom });
    };
    const events: AgentRuntimeEvent[] = [];
    const runtime = await open(client, events);
    const run = runtime.prompt({ runId: "requested", input: input("hello") });
    await client.promptCalled.promise;
    client.complete();
    client.promptAck.resolve();
    client.fence.resolve();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    expect(
      events.filter(
        (event) =>
          event.type === "provider_event" &&
          (event.payload as { message?: { role?: string } }).message?.role === "custom",
      ),
    ).toHaveLength(2);
    await runtime.close();
  });

  it.each(["set_editor_text", "notify"])("accepts native startup fire-and-forget UI: %s", async (method) => {
    const client = new PhaseClient();
    client.startup = () => client.emit({ type: "extension_ui_request", method, id: "startup-ui", text: "native text" });
    const events: AgentRuntimeEvent[] = [];
    const runtime = await open(client, events);
    const run = runtime.prompt({ runId: "requested", input: input("hello") });
    await vi.waitFor(() => expect(client.commands.some((command) => command.type === "prompt")).toBe(true));
    client.complete();
    client.promptAck.resolve();
    client.fence.resolve();
    await expect(run).resolves.toMatchObject({ status: "completed" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "provider_event", payload: expect.objectContaining({ method }) }),
    );
    await runtime.close();
  });
});
