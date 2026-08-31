import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeProvider,
  type AgentRuntimeTestCancelFrame,
  type AgentRuntimeTestFailureCode,
  type AgentRuntimeTestRequestFrame,
  type AgentRuntimeTestResponse,
  type AgentRuntimeTestResultFrame,
  AgentRuntimeTestResultFrameSchema,
  RUNTIME_AGENT_RUNTIME_TEST_MAX_PENDING,
  RUNTIME_AGENT_RUNTIME_TEST_TTL_MS,
  RUNTIME_CAPABILITY,
} from "@opentag/shared";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeBusinessContext, RuntimeBusinessOptions } from "./runtime-session.js";

export interface AgentRuntimeTestDispatchInput {
  computerId: string;
  model?: string;
  provider: AgentRuntimeProvider;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

interface PendingTest {
  instanceId: string;
  promise: Promise<AgentRuntimeTestResponse>;
  requestId: string;
  resolve(result: AgentRuntimeTestResponse): void;
  timer: ReturnType<typeof setTimeout>;
  workspaceComputerId: string;
}

function failed(code: AgentRuntimeTestFailureCode): AgentRuntimeTestResponse {
  return { status: "failed", code };
}

export class AgentRuntimeTestOwner {
  readonly #registry: ConnectionRegistry;
  readonly #maxPending: number;
  readonly #ttlMs: number;
  readonly #pending = new Map<string, PendingTest>();
  readonly #computers = new Set<string>();

  constructor(registry: ConnectionRegistry, options: { maxPending?: number; ttlMs?: number } = {}) {
    this.#registry = registry;
    this.#maxPending = options.maxPending ?? RUNTIME_AGENT_RUNTIME_TEST_MAX_PENDING;
    this.#ttlMs = options.ttlMs ?? RUNTIME_AGENT_RUNTIME_TEST_TTL_MS;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new Error("Agent Runtime test pending limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new Error("Agent Runtime test TTL must be a positive safe integer");
    }
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  hasComputerInFlight(workspaceComputerId: string): boolean {
    return this.#computers.has(workspaceComputerId);
  }

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const parsed = AgentRuntimeTestResultFrameSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      laneKey: (frame) => `request:${(frame as AgentRuntimeTestResultFrame).requestId}`,
      handle: (frame, context) => this.#complete(frame as AgentRuntimeTestResultFrame, context),
      failureResult: () => undefined,
      overloadResult: () => undefined,
    };
  }

  async start(workspaceComputerId: string, input: AgentRuntimeTestDispatchInput): Promise<AgentRuntimeTestResponse> {
    const instanceId = this.#registry.currentInstanceId(workspaceComputerId);
    if (!instanceId) return failed("computer_unavailable");
    if (!this.#registry.supportsCapability(workspaceComputerId, instanceId, RUNTIME_CAPABILITY.agentRuntimeTest)) {
      return failed("capability_missing");
    }
    if (this.#computers.has(workspaceComputerId) || this.#pending.size >= this.#maxPending) {
      return failed("busy");
    }

    const requestId = randomUUID();
    const request: AgentRuntimeTestRequestFrame = {
      type: "agent-runtime:test",
      requestId,
      computerId: input.computerId,
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    };

    let resolvePromise: (result: AgentRuntimeTestResponse) => void = () => undefined;
    const promise = new Promise<AgentRuntimeTestResponse>((resolve) => {
      resolvePromise = resolve;
    });
    const timer = setTimeout(() => {
      this.#finish(requestId, failed("timeout"), true);
    }, this.#ttlMs);
    timer.unref();
    const pending: PendingTest = {
      instanceId,
      promise,
      requestId,
      resolve: resolvePromise,
      timer,
      workspaceComputerId,
    };
    this.#pending.set(requestId, pending);
    this.#computers.add(workspaceComputerId);

    const onAbort = () => {
      this.#finish(requestId, failed("cancelled"), true);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (input.signal?.aborted) {
        onAbort();
      } else {
        await this.#registry.send(workspaceComputerId, instanceId, request);
      }
    } catch {
      this.#finish(requestId, failed("computer_unavailable"), false);
    }
    try {
      return await promise;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#finish(requestId, failed("cancelled"), true);
    }
  }

  async #complete(frame: AgentRuntimeTestResultFrame, context: RuntimeBusinessContext): Promise<undefined> {
    const pending = this.#pending.get(frame.requestId);
    if (!pending) return undefined;
    if (pending.workspaceComputerId !== context.workspaceComputerId || pending.instanceId !== context.instanceId) {
      return undefined;
    }
    const result: AgentRuntimeTestResponse =
      frame.status === "passed" ? { status: "passed" } : failed(frame.code ?? "provider_failed");
    this.#finish(frame.requestId, result, false);
    return undefined;
  }

  #finish(requestId: string, result: AgentRuntimeTestResponse, cancelDaemon: boolean): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    this.#computers.delete(pending.workspaceComputerId);
    clearTimeout(pending.timer);
    pending.resolve(result);
    if (cancelDaemon) {
      const cancel: AgentRuntimeTestCancelFrame = { type: "agent-runtime:test:cancel", requestId };
      void this.#registry.send(pending.workspaceComputerId, pending.instanceId, cancel).catch(() => undefined);
    }
  }
}
