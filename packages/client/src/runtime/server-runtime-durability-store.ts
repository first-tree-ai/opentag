import {
  type RuntimeDurableWorkKind,
  RuntimeDurableWorkKindSchema,
  type RuntimeDurableWorkRecord,
  RuntimeDurableWorkRecordSchema,
} from "@opentag/shared";
import type { OpenTagApi } from "../api.js";
import type { DurableWorkKind, DurableWorkRecord, RuntimeDurabilityStore } from "./runtime-durability.js";

export interface ServerRuntimeDurabilityStoreOptions {
  api: Pick<OpenTagApi, "listRuntimeDurableWork" | "writeRuntimeDurableWork">;
  machineToken: string;
  now?: () => number;
}

/** Runtime durability adapter backed by the authenticated Computer's Server rows. */
export class ServerRuntimeDurabilityStore implements RuntimeDurabilityStore {
  readonly #api: ServerRuntimeDurabilityStoreOptions["api"];
  readonly #machineToken: string;
  readonly #now: () => number;

  constructor(options: ServerRuntimeDurabilityStoreOptions) {
    this.#api = options.api;
    this.#machineToken = options.machineToken;
    this.#now = options.now ?? Date.now;
    if (!this.#machineToken) throw new Error("A machine token is required for Server Runtime durability");
  }

  async list<T = unknown>(kind: DurableWorkKind): Promise<DurableWorkRecord<T>[]> {
    const parsedKind = RuntimeDurableWorkKindSchema.parse(kind);
    const records = await this.#api.listRuntimeDurableWork(this.#machineToken, parsedKind);
    return records.map((record) => RuntimeDurableWorkRecordSchema.parse(record) as DurableWorkRecord<T>);
  }

  async write<T>(record: DurableWorkRecord<T>): Promise<void> {
    const parsed = RuntimeDurableWorkRecordSchema.parse(record);
    // Keep the seam's clock injectable for deterministic adapters and future lease metadata.
    this.#now();
    await this.#api.writeRuntimeDurableWork(this.#machineToken, parsed as RuntimeDurableWorkRecord);
  }
}

export type { RuntimeDurableWorkKind };
