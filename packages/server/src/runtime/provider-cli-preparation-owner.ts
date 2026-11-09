import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  type ProviderCliPrewarmFrame,
  type ProviderCliPrewarmResultFrame,
  RUNTIME_CAPABILITY,
} from "@opentag/shared";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { ProviderCliReconcileBindingSource } from "./provider-cli-reconcile-owner.js";

type PreparationTarget = {
  computerId: string;
  installationId: string;
  instanceId: string;
  runtimeProvider: AgentRuntimeProvider;
};
interface Preparation extends PreparationTarget {
  requestId: string;
  controller: AbortController;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  pending: boolean;
  checking: boolean;
}

export class ProviderCliPreparationOwner {
  readonly #current = new Map<string, Preparation>();
  readonly #operations = new Set<Preparation>();
  readonly #tasks = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;
  #closed = false;
  constructor(
    readonly registry: ConnectionRegistry,
    readonly source: Pick<ProviderCliReconcileBindingSource, "shouldPrewarmOfficialProviderClis">,
    readonly options: { now: () => number; timeoutMs?: number },
  ) {}

  inspect(input: Omit<PreparationTarget, "runtimeProvider">): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    return this.#track(this.#dispatch(input));
  }

  async prepare(input: PreparationTarget, retry: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
    if (this.#closed) throw new Error("The Computer preparation owner is closed");
    let rejectDeadline: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const current: Preparation = {
      ...input,
      requestId: randomUUID(),
      controller: new AbortController(),
      reject: rejectDeadline,
      pending: true,
      checking: false,
    };
    this.#operations.add(current);
    // One existing preparation budget covers dispatch waiting and the readiness fallback.
    current.timer = setTimeout(
      () => this.#cancel(current, new Error("The Computer preparation operation timed out")),
      this.options.timeoutMs ?? 5 * 60_000,
    );
    current.timer.unref();
    try {
      await Promise.race([this.#track(this.#prepare(current, retry)), deadline]);
    } finally {
      current.pending = false;
      this.#release(current);
    }
  }

  async #prepare(current: Preparation, retry: (signal: AbortSignal) => Promise<boolean>): Promise<void> {
    const startedPrewarm = await this.#dispatch(current, current);
    current.controller.signal.throwIfAborted();
    const startedRetry = await retry(current.controller.signal);
    current.controller.signal.throwIfAborted();
    if (!startedPrewarm && !startedRetry) throw new Error("The Computer preparation operation could not be started");
  }

  async #dispatch(input: Omit<PreparationTarget, "runtimeProvider">, current?: Preparation): Promise<boolean> {
    if (this.#closed) return false;
    if (!this.registry.supportsCapability(input.computerId, input.instanceId, RUNTIME_CAPABILITY.providerCliPrewarm))
      return false;
    let shouldPrewarm = false;
    try {
      shouldPrewarm = (await this.source.shouldPrewarmOfficialProviderClis?.(input.computerId)) === true;
    } catch {
      return false;
    }
    current?.controller.signal.throwIfAborted();
    if (this.#closed || !shouldPrewarm) return false;
    const frame: ProviderCliPrewarmFrame = {
      type: "provider-cli:prewarm",
      requestId: current?.requestId ?? randomUUID(),
      providers: [...IM_CLI_PROVIDERS],
      ...(current ? { mode: "ensure", runtimeProvider: current.runtimeProvider } : {}),
    };
    if (current && !this.#begin(current)) return false;
    try {
      await this.registry.send(input.computerId, input.instanceId, frame);
    } catch {
      if (current && this.#current.get(current.computerId) === current) {
        this.#fail(current);
        current.checking = false;
      }
      return false;
    }
    current?.controller.signal.throwIfAborted();
    return true;
  }

  #begin(current: Preparation): boolean {
    if (
      !this.registry.beginPreparation(
        current.computerId,
        current.instanceId,
        current.requestId,
        current.runtimeProvider,
        IM_CLI_PROVIDERS,
        this.options.now(),
      )
    )
      return false;
    const previous = this.#current.get(current.computerId);
    if (previous) {
      previous.checking = false;
      this.#release(previous);
    }
    current.checking = true;
    this.#current.set(current.computerId, current);
    return true;
  }

  complete(computerId: string, instanceId: string, frame: ProviderCliPrewarmResultFrame): void {
    const completed = this.registry.completePreparation(computerId, instanceId, frame, this.options.now());
    const current = this.#current.get(computerId);
    if (!completed || frame.providers === undefined || current?.requestId !== frame.requestId) return;
    current.checking = false;
    this.#release(current);
  }

  reset(computerId: string): void {
    for (const current of this.#operations) {
      if (current.computerId === computerId)
        this.#cancel(current, new Error("The Computer preparation operation was replaced"));
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const current of this.#operations)
      this.#cancel(current, new Error("The Computer preparation owner is closed"));
    this.#closing = Promise.allSettled([...this.#tasks]).then(() => undefined);
    return this.#closing;
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#tasks.add(operation);
    void operation.then(
      () => this.#tasks.delete(operation),
      () => this.#tasks.delete(operation),
    );
    return operation;
  }

  #cancel(current: Preparation, error: Error): void {
    if (!this.#operations.has(current)) return;
    this.#fail(current);
    if (current.timer) clearTimeout(current.timer);
    this.#operations.delete(current);
    if (this.#current.get(current.computerId) === current) this.#current.delete(current.computerId);
    current.controller.abort(error);
    current.reject(error);
  }

  #release(current: Preparation): void {
    if (current.pending || current.checking) return;
    if (current.timer) clearTimeout(current.timer);
    this.#operations.delete(current);
    if (this.#current.get(current.computerId) === current) this.#current.delete(current.computerId);
  }

  #fail(current: Preparation): void {
    if (!current.checking) return;
    this.registry.completePreparation(
      current.computerId,
      current.instanceId,
      {
        requestId: current.requestId,
        runtime: { provider: current.runtimeProvider, status: "unavailable" },
        providers: IM_CLI_PROVIDERS.map((provider) => ({ provider, status: "unavailable" })),
      },
      this.options.now(),
      { quarantine: true },
    );
  }
}
