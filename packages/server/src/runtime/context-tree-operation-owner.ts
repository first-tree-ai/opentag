import { randomUUID } from "node:crypto";
import {
  type ContextTreeOperationFrame,
  type ContextTreeOperationResponse,
  ContextTreeOperationResultFrameSchema,
  RUNTIME_CAPABILITY,
} from "@opentag/shared";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeBusinessOptions } from "./runtime-session.js";

export class ContextTreeOperationOwner {
  readonly #pending = new Map<
    string,
    { computerId: string; instanceId: string; finish: (result: ContextTreeOperationResponse) => void }
  >();
  constructor(readonly registry: ConnectionRegistry) {}

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const parsed = ContextTreeOperationResultFrameSchema.safeParse(input);
        return parsed.success ? parsed.data : undefined;
      },
      laneKey: (frame) => `context-tree:${ContextTreeOperationResultFrameSchema.parse(frame).requestId}`,
      handle: async (frame, context) => {
        const parsed = ContextTreeOperationResultFrameSchema.parse(frame);
        const pending = this.#pending.get(parsed.requestId);
        if (pending?.computerId === context.computerId && pending.instanceId === context.instanceId)
          pending.finish(parsed.result);
        return undefined;
      },
      failureResult: () => undefined,
      overloadResult: () => undefined,
    };
  }

  async start(input: Omit<ContextTreeOperationFrame, "type" | "requestId">): Promise<ContextTreeOperationResponse> {
    const instanceId = this.registry.currentInstanceId(input.computerId);
    if (!instanceId) return { status: "failed", code: "computer_unavailable" };
    if (!this.registry.supportsCapability(input.computerId, instanceId, RUNTIME_CAPABILITY.contextTreeSettings))
      return { status: "failed", code: "capability_missing" };
    if (
      this.#pending.size >= 32 ||
      [...this.#pending.values()].some((pending) => pending.computerId === input.computerId)
    )
      return { status: "failed", code: "busy" };
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          finish({
            status: "failed",
            code: input.input.action === "create" ? "publication_uncertain" : "computer_unavailable",
          }),
        300_000,
      );
      timer.unref();
      const finish = (result: ContextTreeOperationResponse) => {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve(result);
      };
      this.#pending.set(requestId, { computerId: input.computerId, instanceId, finish });
      void this.registry
        .send(input.computerId, instanceId, { ...input, type: "context-tree:operation", requestId })
        .catch(() => finish({ status: "failed", code: "computer_unavailable" }));
    });
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.finish({ status: "failed", code: "publication_uncertain" });
  }
}
