import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  type SlackAutoSetupRuntimeRequest,
  type SlackAutoSetupRuntimeResult,
  SlackAutoSetupRuntimeResultSchema,
} from "@opentag/shared";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeBusinessOptions } from "./runtime-session.js";

/** Bounded requests on the existing authenticated Computer connection, not workflow storage. */
export class SlackAutoSetupOwner {
  #pending = new Map<
    string,
    { computerId: string; instanceId: string; finish: (result: SlackAutoSetupRuntimeResult["result"]) => void }
  >();
  constructor(
    readonly registry: ConnectionRegistry,
    readonly timeoutMs = 300_000,
  ) {}
  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const value = SlackAutoSetupRuntimeResultSchema.safeParse(input);
        return value.success ? value.data : undefined;
      },
      laneKey: (frame) => `slack-setup:${SlackAutoSetupRuntimeResultSchema.parse(frame).requestId}`,
      handle: async (frame, context) => {
        const value = SlackAutoSetupRuntimeResultSchema.parse(frame);
        const pending = this.#pending.get(value.requestId);
        if (pending?.computerId === context.computerId && pending.instanceId === context.instanceId)
          pending.finish(value.result);
        return undefined;
      },
      failureResult: () => undefined,
      overloadResult: () => undefined,
    };
  }
  async start(
    input: Omit<SlackAutoSetupRuntimeRequest, "type" | "requestId">,
  ): Promise<SlackAutoSetupRuntimeResult["result"]> {
    const instanceId = this.registry.currentInstanceId(input.computerId);
    if (this.registry.currentControlIdentity(input.computerId)?.kind === "cloud")
      return { status: "failed", code: "capability_missing" };
    if (!instanceId) return { status: "failed", code: "computer_unavailable" };
    if (!this.registry.supportsCapability(input.computerId, instanceId, RUNTIME_CAPABILITY.slackAutoSetup))
      return { status: "failed", code: "capability_missing" };
    if (this.#pending.size >= 32 || [...this.#pending.values()].some((x) => x.computerId === input.computerId))
      return { status: "failed", code: "busy" };
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ status: "failed", code: "computer_unavailable" }), this.timeoutMs);
      timer.unref();
      const finish = (result: SlackAutoSetupRuntimeResult["result"]) => {
        if (!this.#pending.has(requestId)) return;
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve(result);
      };
      this.#pending.set(requestId, { computerId: input.computerId, instanceId, finish });
      void this.registry
        .send(input.computerId, instanceId, { ...input, type: "slack:auto-setup", requestId })
        .catch(() => finish({ status: "failed", code: "computer_unavailable" }));
    });
  }
  close(): void {
    for (const value of [...this.#pending.values()]) value.finish({ status: "failed", code: "computer_unavailable" });
  }
}
