import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeOptions,
  type AgentRuntimeOptionsRequestFrame,
  AgentRuntimeOptionsResultFrameSchema,
  RUNTIME_CAPABILITY,
} from "@opentag/shared";
import { AgentServiceError } from "../services/agents/errors.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeBusinessOptions } from "./runtime-session.js";

export class AgentRuntimeOptionsOwner {
  readonly #pending = new Map<
    string,
    { computerId: string; instanceId: string; finish(options?: AgentRuntimeOptions, error?: Error): void }
  >();
  constructor(
    readonly registry: ConnectionRegistry,
    readonly ttlMs = 20_000,
  ) {}

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const parsed = AgentRuntimeOptionsResultFrameSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      laneKey: (frame) => `runtime-options:${AgentRuntimeOptionsResultFrameSchema.parse(frame).requestId}`,
      handle: async (frame, context) => {
        const parsed = AgentRuntimeOptionsResultFrameSchema.parse(frame);
        const pending = this.#pending.get(parsed.requestId);
        if (
          pending?.computerId === context.computerId &&
          pending.instanceId === context.instanceId &&
          this.registry.currentInstanceId(context.computerId) === context.instanceId
        ) {
          if (parsed.result.status === "completed") pending.finish(parsed.result.options);
          else pending.finish(undefined, unavailable(parsed.result.code === "capability_missing" ? 501 : 503));
        }
        return undefined;
      },
      failureResult: () => undefined,
      overloadResult: () => undefined,
    };
  }

  async start(
    input: Omit<AgentRuntimeOptionsRequestFrame, "type" | "requestId">,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeOptions> {
    signal?.throwIfAborted();
    const instanceId = this.registry.currentInstanceId(input.computerId);
    if (!instanceId) throw unavailable(503);
    if (!this.registry.supportsCapability(input.computerId, instanceId, RUNTIME_CAPABILITY.agentRuntimeOptions))
      throw unavailable(501);
    if (this.#pending.size >= 32) throw unavailable(503);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        void this.registry
          .send(input.computerId, instanceId, { type: "agent-runtime:options:cancel", requestId })
          .catch(() => undefined);
      };
      const finish = (options?: AgentRuntimeOptions, error?: Error) => {
        if (!this.#pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          cancel();
          reject(error);
        } else if (options) resolve(options);
      };
      const onAbort = () => finish(undefined, unavailable(503));
      const timer = setTimeout(() => finish(undefined, unavailable(504)), this.ttlMs);
      timer.unref();
      this.#pending.set(requestId, { computerId: input.computerId, instanceId, finish });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else
        void this.registry
          .send(input.computerId, instanceId, { ...input, type: "agent-runtime:options", requestId })
          .catch(() => finish(undefined, unavailable(503)));
    });
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.finish(undefined, unavailable(503));
  }
}

function unavailable(status: number) {
  return new AgentServiceError(
    status === 501 ? "PROTOCOL_CAPABILITY_UNSUPPORTED" : "SERVICE_UNAVAILABLE",
    "transient",
    "Local runtime options are unavailable",
    status,
  );
}
