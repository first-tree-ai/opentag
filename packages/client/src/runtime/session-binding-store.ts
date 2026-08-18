import {
  computeRuntimeSnapshotHashes,
  type DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshotSchema,
  RuntimeSha256Schema,
  type RuntimeSnapshotHashes,
  type SessionReconcileRequest,
} from "@opentag/shared";
import {
  ensurePrivateDirectory,
  RuntimeStorageError,
  readDurableJson,
  writeDurableJson,
} from "../storage/durable-file.js";
import { agentRuntimePaths, sessionBindingPath, snapshotPath } from "./runtime-paths.js";

export const SESSION_BINDING_SCHEMA_VERSION = 1 as const;
export const SESSION_RECORDED_INPUT_LIMIT = 64;

export type UnresolvedTurnPhase = "accepted" | "starting" | "running" | "reporting";

export interface RecordedInput {
  deliveryId: string;
  inputHash: string;
  resultHash: string;
  turnId: string;
}

export interface UnresolvedTurn {
  requestId: string;
  deliveryId: string;
  inputHash: string;
  turnId: string;
  phase: UnresolvedTurnPhase;
  providerTurnId?: string;
  resultHash?: string;
}

export interface LocalSessionBinding {
  schemaVersion: typeof SESSION_BINDING_SCHEMA_VERSION;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  placementGeneration: number;
  provider: "codex";
  providerHomeIdentity: string;
  providerThreadId?: string;
  appliedSessionRevisionSequence: number;
  appliedSessionRevisionId: string;
  sessionConfigHash: string;
  lastEffectiveSnapshotHash: string;
  recentRecordedInputs: RecordedInput[];
  unresolvedTurn?: UnresolvedTurn;
}

export interface SessionPreparationResult {
  binding: LocalSessionBinding;
  unresolvedTurn?: UnresolvedTurn;
}

export type CustodyResult =
  | { status: "committed"; binding: LocalSessionBinding; unresolvedTurn: UnresolvedTurn }
  | { status: "existing"; binding: LocalSessionBinding; unresolvedTurn: UnresolvedTurn }
  | { status: "recorded"; binding: LocalSessionBinding; recorded: RecordedInput };

export class SessionBindingConflictError extends Error {
  constructor(
    readonly code: "conflict" | "recovery_required" | "stale",
    message: string,
  ) {
    super(message);
    this.name = "SessionBindingConflictError";
  }
}

export interface SessionBindingStoreOptions {
  home: string;
  providerHomeIdentity: string;
  recordedInputLimit?: number;
}

export class SessionBindingStore {
  readonly #home: string;
  readonly #providerHomeIdentity: string;
  readonly #recordedInputLimit: number;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: SessionBindingStoreOptions) {
    this.#home = options.home;
    this.#providerHomeIdentity = RuntimeSha256Schema.parse(options.providerHomeIdentity);
    this.#recordedInputLimit = options.recordedInputLimit ?? SESSION_RECORDED_INPUT_LIMIT;
    if (!Number.isSafeInteger(this.#recordedInputLimit) || this.#recordedInputLimit < 1) {
      throw new Error("recordedInputLimit must be a positive safe integer");
    }
  }

  read(agentId: string, sessionId: string): Promise<LocalSessionBinding | undefined> {
    return readDurableJson(sessionBindingPath(this.#home, agentId, sessionId), parseLocalSessionBinding);
  }

  prepare(request: SessionReconcileRequest, hashes: RuntimeSnapshotHashes): Promise<SessionPreparationResult> {
    return this.#withSessionLock(request.sessionId, async () => {
      const runtime = request.runtime;
      if (!runtime) throw new SessionBindingConflictError("conflict", "A ready binding requires a runtime snapshot");
      const paths = agentRuntimePaths(this.#home, request.agentId);
      await ensurePrivateDirectory(this.#home, paths.sessions);
      await ensurePrivateDirectory(this.#home, paths.snapshots);
      const bindingPath = sessionBindingPath(this.#home, request.agentId, request.sessionId);
      const current = await readDurableJson(bindingPath, parseLocalSessionBinding);
      if (current) this.#validateIdentity(current, request);
      if (current?.unresolvedTurn) {
        if (
          current.placementGeneration !== request.placementGeneration ||
          current.lastEffectiveSnapshotHash !== hashes.effectiveSnapshotHash
        ) {
          throw new SessionBindingConflictError("recovery_required", "An unresolved turn fences binding changes");
        }
        return { binding: current, unresolvedTurn: current.unresolvedTurn };
      }
      if (current && request.placementGeneration < current.placementGeneration) {
        throw new SessionBindingConflictError("stale", "The placement generation is stale");
      }
      if (
        current &&
        request.placementGeneration === current.placementGeneration &&
        runtime.revision.session.sequence < current.appliedSessionRevisionSequence
      ) {
        throw new SessionBindingConflictError("stale", "The Session runtime revision is stale");
      }
      if (
        current &&
        request.placementGeneration === current.placementGeneration &&
        runtime.revision.session.sequence === current.appliedSessionRevisionSequence &&
        (runtime.revision.session.id !== current.appliedSessionRevisionId ||
          hashes.sessionConfigHash !== current.sessionConfigHash)
      ) {
        throw new SessionBindingConflictError("conflict", "The Session runtime revision conflicts with the binding");
      }

      const snapshot = EffectiveRuntimeSnapshotSchema.parse(runtime);
      const storedSnapshot = snapshotPath(this.#home, request.agentId, hashes.effectiveSnapshotHash);
      const existingSnapshot = await readDurableJson(storedSnapshot, EffectiveRuntimeSnapshotSchema.parse);
      if (existingSnapshot) {
        if (computeRuntimeSnapshotHashes(existingSnapshot).effectiveSnapshotHash !== hashes.effectiveSnapshotHash) {
          throw new SessionBindingConflictError("conflict", "The stored runtime snapshot hash conflicts");
        }
      } else {
        await writeDurableJson(storedSnapshot, snapshot);
      }

      const binding: LocalSessionBinding = {
        schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
        sessionId: request.sessionId,
        agentId: request.agentId,
        workspaceId: runtime.workspace.workspaceId,
        placementGeneration: request.placementGeneration,
        provider: runtime.provider,
        providerHomeIdentity: this.#providerHomeIdentity,
        ...(current?.providerThreadId ? { providerThreadId: current.providerThreadId } : {}),
        appliedSessionRevisionSequence: runtime.revision.session.sequence,
        appliedSessionRevisionId: runtime.revision.session.id,
        sessionConfigHash: hashes.sessionConfigHash,
        lastEffectiveSnapshotHash: hashes.effectiveSnapshotHash,
        recentRecordedInputs: current?.recentRecordedInputs ?? [],
      };
      await writeDurableJson(bindingPath, binding);
      return { binding };
    });
  }

  recordAccepted(request: DirectImMessageDeliveryRequest, inputHash: string, turnId: string): Promise<CustodyResult> {
    return this.#withSessionLock(request.sessionId, async () => {
      RuntimeSha256Schema.parse(inputHash);
      const path = sessionBindingPath(this.#home, request.agentId, request.sessionId);
      const binding = await this.#requireBinding(request.agentId, request.sessionId);
      this.#validateDeliveryBinding(binding, request);
      const recorded = binding.recentRecordedInputs.find((entry) => entry.deliveryId === request.deliveryId);
      if (recorded) {
        if (recorded.inputHash !== inputHash) {
          throw new SessionBindingConflictError("conflict", "The delivery ID is recorded with different input");
        }
        return { status: "recorded", binding, recorded };
      }
      if (binding.unresolvedTurn) {
        if (
          binding.unresolvedTurn.deliveryId !== request.deliveryId ||
          binding.unresolvedTurn.inputHash !== inputHash ||
          binding.unresolvedTurn.turnId !== turnId
        ) {
          throw new SessionBindingConflictError("recovery_required", "Another unresolved turn owns the Session");
        }
        return { status: "existing", binding, unresolvedTurn: binding.unresolvedTurn };
      }
      const unresolvedTurn: UnresolvedTurn = {
        requestId: request.requestId,
        deliveryId: request.deliveryId,
        inputHash,
        turnId,
        phase: "accepted",
      };
      const updated = { ...binding, unresolvedTurn };
      await writeDurableJson(path, updated);
      return { status: "committed", binding: updated, unresolvedTurn };
    });
  }

  updateUnresolved(
    agentId: string,
    sessionId: string,
    turnId: string,
    phase: UnresolvedTurnPhase,
    fields: { providerThreadId?: string; providerTurnId?: string; resultHash?: string } = {},
  ): Promise<LocalSessionBinding> {
    return this.#withSessionLock(sessionId, async () => {
      const path = sessionBindingPath(this.#home, agentId, sessionId);
      const binding = await this.#requireBinding(agentId, sessionId);
      const unresolved = binding.unresolvedTurn;
      if (!unresolved || unresolved.turnId !== turnId) {
        throw new SessionBindingConflictError("conflict", "The unresolved turn does not match");
      }
      if (phaseOrder(phase) < phaseOrder(unresolved.phase)) {
        throw new SessionBindingConflictError("conflict", "The unresolved turn phase cannot move backwards");
      }
      const updated: LocalSessionBinding = {
        ...binding,
        ...(fields.providerThreadId ? { providerThreadId: fields.providerThreadId } : {}),
        unresolvedTurn: {
          ...unresolved,
          phase,
          ...(fields.providerTurnId ? { providerTurnId: fields.providerTurnId } : {}),
          ...(fields.resultHash ? { resultHash: fields.resultHash } : {}),
        },
      };
      await writeDurableJson(path, updated);
      return updated;
    });
  }

  recordResult(agentId: string, sessionId: string, turnId: string, resultHash: string): Promise<LocalSessionBinding> {
    return this.#withSessionLock(sessionId, async () => {
      RuntimeSha256Schema.parse(resultHash);
      const path = sessionBindingPath(this.#home, agentId, sessionId);
      const binding = await this.#requireBinding(agentId, sessionId);
      const unresolved = binding.unresolvedTurn;
      if (!unresolved || unresolved.turnId !== turnId || unresolved.resultHash !== resultHash) {
        throw new SessionBindingConflictError("conflict", "The recorded result does not match the unresolved turn");
      }
      const recorded: RecordedInput = {
        deliveryId: unresolved.deliveryId,
        inputHash: unresolved.inputHash,
        resultHash,
        turnId,
      };
      const recentRecordedInputs = [
        ...binding.recentRecordedInputs.filter((entry) => entry.deliveryId !== recorded.deliveryId),
        recorded,
      ].slice(-this.#recordedInputLimit);
      const updated = { ...binding, recentRecordedInputs };
      delete updated.unresolvedTurn;
      await writeDurableJson(path, updated);
      return updated;
    });
  }

  async #requireBinding(agentId: string, sessionId: string): Promise<LocalSessionBinding> {
    const binding = await this.read(agentId, sessionId);
    if (!binding) throw new SessionBindingConflictError("conflict", "The Session binding does not exist");
    return binding;
  }

  #validateIdentity(binding: LocalSessionBinding, request: SessionReconcileRequest): void {
    if (
      binding.sessionId !== request.sessionId ||
      binding.agentId !== request.agentId ||
      binding.provider !== "codex" ||
      binding.providerHomeIdentity !== this.#providerHomeIdentity ||
      (request.runtime && binding.workspaceId !== request.runtime.workspace.workspaceId)
    ) {
      throw new SessionBindingConflictError("conflict", "The Session binding identity cannot be changed");
    }
  }

  #validateDeliveryBinding(binding: LocalSessionBinding, request: DirectImMessageDeliveryRequest): void {
    const hashes = computeRuntimeSnapshotHashes(request.runtime);
    if (
      binding.agentId !== request.agentId ||
      binding.workspaceId !== request.runtime.workspace.workspaceId ||
      binding.placementGeneration !== request.placementGeneration ||
      binding.lastEffectiveSnapshotHash !== hashes.effectiveSnapshotHash ||
      binding.providerHomeIdentity !== this.#providerHomeIdentity
    ) {
      throw new SessionBindingConflictError("conflict", "The delivery does not match the Session binding");
    }
  }

  async #withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(sessionId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release?.();
      if (this.#tails.get(sessionId) === tail) this.#tails.delete(sessionId);
    }
  }
}

function parseLocalSessionBinding(value: unknown): LocalSessionBinding {
  if (!isRecord(value) || value.schemaVersion !== SESSION_BINDING_SCHEMA_VERSION) {
    throw new RuntimeStorageError("invalid", "Unsupported Session binding schema");
  }
  const required = [
    "schemaVersion",
    "sessionId",
    "agentId",
    "workspaceId",
    "placementGeneration",
    "provider",
    "providerHomeIdentity",
    "appliedSessionRevisionSequence",
    "appliedSessionRevisionId",
    "sessionConfigHash",
    "lastEffectiveSnapshotHash",
    "recentRecordedInputs",
  ];
  const optional = ["providerThreadId", "unresolvedTurn"];
  if (!hasOnlyKeys(value, [...required, ...optional]) || required.some((key) => !(key in value))) {
    throw new RuntimeStorageError("invalid", "Session binding fields are invalid");
  }
  if (
    !isString(value.sessionId) ||
    !isString(value.agentId) ||
    !isString(value.workspaceId) ||
    !isSequence(value.placementGeneration) ||
    value.provider !== "codex" ||
    !RuntimeSha256Schema.safeParse(value.providerHomeIdentity).success ||
    !isSequence(value.appliedSessionRevisionSequence) ||
    !isString(value.appliedSessionRevisionId) ||
    !RuntimeSha256Schema.safeParse(value.sessionConfigHash).success ||
    !RuntimeSha256Schema.safeParse(value.lastEffectiveSnapshotHash).success ||
    (value.providerThreadId !== undefined && !isString(value.providerThreadId)) ||
    !Array.isArray(value.recentRecordedInputs)
  ) {
    throw new RuntimeStorageError("invalid", "Session binding values are invalid");
  }
  const recentRecordedInputs = value.recentRecordedInputs.map(parseRecordedInput);
  if (recentRecordedInputs.length > SESSION_RECORDED_INPUT_LIMIT) {
    throw new RuntimeStorageError("invalid", "Session binding has too many recorded inputs");
  }
  const unresolvedTurn = value.unresolvedTurn === undefined ? undefined : parseUnresolvedTurn(value.unresolvedTurn);
  return {
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    sessionId: value.sessionId,
    agentId: value.agentId,
    workspaceId: value.workspaceId,
    placementGeneration: value.placementGeneration,
    provider: "codex",
    providerHomeIdentity: value.providerHomeIdentity as string,
    ...(value.providerThreadId ? { providerThreadId: value.providerThreadId } : {}),
    appliedSessionRevisionSequence: value.appliedSessionRevisionSequence,
    appliedSessionRevisionId: value.appliedSessionRevisionId,
    sessionConfigHash: value.sessionConfigHash as string,
    lastEffectiveSnapshotHash: value.lastEffectiveSnapshotHash as string,
    recentRecordedInputs,
    ...(unresolvedTurn ? { unresolvedTurn } : {}),
  };
}

function parseRecordedInput(value: unknown): RecordedInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["deliveryId", "inputHash", "turnId", "resultHash"]) ||
    !isString(value.deliveryId) ||
    !RuntimeSha256Schema.safeParse(value.inputHash).success ||
    !isString(value.turnId) ||
    !RuntimeSha256Schema.safeParse(value.resultHash).success
  ) {
    throw new RuntimeStorageError("invalid", "Recorded input is invalid");
  }
  return value as unknown as RecordedInput;
}

function parseUnresolvedTurn(value: unknown): UnresolvedTurn {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["requestId", "deliveryId", "inputHash", "turnId", "phase", "providerTurnId", "resultHash"]) ||
    !isString(value.requestId) ||
    !isString(value.deliveryId) ||
    !RuntimeSha256Schema.safeParse(value.inputHash).success ||
    !isString(value.turnId) ||
    !isPhase(value.phase) ||
    (value.providerTurnId !== undefined && !isString(value.providerTurnId)) ||
    (value.resultHash !== undefined && !RuntimeSha256Schema.safeParse(value.resultHash).success)
  ) {
    throw new RuntimeStorageError("invalid", "Unresolved turn is invalid");
  }
  return value as unknown as UnresolvedTurn;
}

function phaseOrder(phase: UnresolvedTurnPhase): number {
  return ["accepted", "starting", "running", "reporting"].indexOf(phase);
}

function isPhase(value: unknown): value is UnresolvedTurnPhase {
  return value === "accepted" || value === "starting" || value === "running" || value === "reporting";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}
