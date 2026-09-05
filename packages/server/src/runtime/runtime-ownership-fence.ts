interface FenceRegistry {
  fenceAll(reason?: string): void;
  unfence(): void;
}

interface FenceDomainOwner {
  close(): void;
}

interface FenceDeliveryWorker {
  pause(): void;
  resume(): void;
}

interface FenceRuntimeTestOwner {
  close(): void;
}

export interface RuntimeOwnershipFenceOptions {
  registry: FenceRegistry;
  domainOwner: FenceDomainOwner;
  deliveryWorker: FenceDeliveryWorker;
  runtimeTestOwner?: FenceRuntimeTestOwner;
}

/**
 * Quiesces all local runtime dispatch paths while the PostgreSQL ownership lease is unavailable.
 * The fence is synchronous so a lease-loss callback can close sockets before starting recovery.
 */
export class RuntimeOwnershipFence {
  readonly #registry: FenceRegistry;
  readonly #domainOwner: FenceDomainOwner;
  readonly #deliveryWorker: FenceDeliveryWorker;
  readonly #runtimeTestOwner?: FenceRuntimeTestOwner;
  #fenced = false;

  constructor(options: RuntimeOwnershipFenceOptions) {
    this.#registry = options.registry;
    this.#domainOwner = options.domainOwner;
    this.#deliveryWorker = options.deliveryWorker;
    this.#runtimeTestOwner = options.runtimeTestOwner;
  }

  isAvailable(): boolean {
    return !this.#fenced;
  }

  fence(): void {
    if (this.#fenced) return;
    this.#fenced = true;
    this.#registry.fenceAll("Runtime ownership lease lost");
    this.#domainOwner.close();
    this.#deliveryWorker.pause();
    this.#runtimeTestOwner?.close();
  }

  resume(): void {
    if (!this.#fenced) return;
    this.#registry.unfence();
    this.#fenced = false;
    this.#deliveryWorker.resume();
  }
}
