import { dirname } from "node:path";
import {
  computeRuntimeImMessageSemanticHash,
  computeRuntimeSnapshotHashes,
  type DirectImMessageDeliveryRequest,
  EffectiveRuntimeSnapshotSchema,
  type RuntimeImSteerRequest,
  RuntimeRequestIdSchema,
  RuntimeSha256Schema,
  type RuntimeSnapshotHashes,
  type SessionReconcileRequest,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { isAgentRuntimeProviderId } from "../agent-runtime/provider-id.js";
import { AGENT_RUNTIME_BINDING_MAX_BYTES, type AgentRuntimeBinding } from "../agent-runtime/types.js";
import { assertJsonValue } from "../agent-runtime/validation.js";
import {
  ensurePrivateDirectory,
  RuntimeStorageError,
  readDurableJson,
  validatePrivateDirectory,
  writeDurableJson,
} from "../storage/durable-file.js";
import { agentRuntimePaths, sessionBindingPath, snapshotPath } from "./runtime-paths.js";

export const SESSION_BINDING_SCHEMA_VERSION = 3 as const;
export const SESSION_RECORDED_INPUT_LIMIT = 64;

export type UnresolvedTurnPhase = "accepted" | "starting" | "running" | "reporting";

export interface RecordedTurnInput {
  kind: "turn";
  deliveryId: string;
  inputHash: string;
  requestId?: string;
  report?: TurnReportRequest;
  resultHash: string;
  turnId: string;
}

export interface RecordedSteerInput {
  kind: "steer";
  deliveryId: string;
  inputHash: string;
  requestId: string;
  rootDeliveryId: string;
  turnId: string;
  report?: undefined;
  resultHash?: undefined;
}

export type RecordedInput = RecordedTurnInput | RecordedSteerInput;

export interface UnresolvedTurn {
  requestId: string;
  deliveryId: string;
  inputHash: string;
  turnId: string;
  phase: UnresolvedTurnPhase;
  providerTurnId?: string;
  report?: TurnReportRequest;
  resultHash?: string;
}

export interface LocalSessionBinding {
  schemaVersion: typeof SESSION_BINDING_SCHEMA_VERSION;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  placementGeneration: number;
  provider: string;
  /** Persisted field name retained for schema-v1/v2 compatibility; value identifies the Provider artifact boundary. */
  providerHomeIdentity: string;
  runtimeBinding?: AgentRuntimeBinding;
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
  | { status: "recorded"; binding: LocalSessionBinding; recorded: RecordedTurnInput }
  | { status: "absorbed"; binding: LocalSessionBinding; recorded: RecordedSteerInput };

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
  providerArtifactIdentity(providerId: string): string | undefined;
  recordedInputLimit?: number;
}

export class SessionBindingStore {
  readonly #home: string;
  readonly #providerArtifactIdentity: SessionBindingStoreOptions["providerArtifactIdentity"];
  readonly #recordedInputLimit: number;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: SessionBindingStoreOptions) {
    this.#home = options.home;
    this.#providerArtifactIdentity = options.providerArtifactIdentity;
    this.#recordedInputLimit = options.recordedInputLimit ?? SESSION_RECORDED_INPUT_LIMIT;
    if (!Number.isSafeInteger(this.#recordedInputLimit) || this.#recordedInputLimit < 1) {
      throw new Error("recordedInputLimit must be a positive safe integer");
    }
  }

  read(agentId: string, sessionId: string): Promise<LocalSessionBinding | undefined> {
    return this.#readBinding(sessionBindingPath(this.#home, agentId, sessionId));
  }

  prepare(request: SessionReconcileRequest, hashes: RuntimeSnapshotHashes): Promise<SessionPreparationResult> {
    return this.#withSessionLock(request.sessionId, async () => {
      const runtime = request.runtime;
      if (!runtime) throw new SessionBindingConflictError("conflict", "A ready binding requires a runtime snapshot");
      const paths = agentRuntimePaths(this.#home, request.agentId);
      await ensurePrivateDirectory(this.#home, paths.sessions);
      await ensurePrivateDirectory(this.#home, paths.snapshots);
      const bindingPath = sessionBindingPath(this.#home, request.agentId, request.sessionId);
      const current = await this.#readBinding(bindingPath);
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
        providerHomeIdentity: this.#artifactIdentity(runtime.provider),
        ...(current && current.lastEffectiveSnapshotHash === hashes.effectiveSnapshotHash && current.runtimeBinding
          ? { runtimeBinding: current.runtimeBinding }
          : {}),
        appliedSessionRevisionSequence: runtime.revision.session.sequence,
        appliedSessionRevisionId: runtime.revision.session.id,
        sessionConfigHash: hashes.sessionConfigHash,
        lastEffectiveSnapshotHash: hashes.effectiveSnapshotHash,
        recentRecordedInputs: current?.recentRecordedInputs ?? [],
      };
      await this.#writeBinding(bindingPath, binding);
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
        if (recorded.kind === "steer") {
          if (recorded.inputHash !== computeRuntimeImMessageSemanticHash(request)) {
            throw new SessionBindingConflictError("conflict", "The delivery ID is recorded with different input");
          }
          return { status: "absorbed", binding, recorded };
        }
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
      await this.#writeBinding(path, updated);
      return { status: "committed", binding: updated, unresolvedTurn };
    });
  }

  getSteerReceipt(request: RuntimeImSteerRequest, inputHash: string): Promise<RecordedSteerInput | undefined> {
    return this.#withSessionLock(request.sessionId, async () => {
      RuntimeSha256Schema.parse(inputHash);
      const binding = await this.#requireBinding(request.agentId, request.sessionId);
      this.#validateSteerBinding(binding, request);
      const recorded = binding.recentRecordedInputs.find((entry) => entry.deliveryId === request.deliveryId);
      if (!recorded) return undefined;
      if (
        recorded.kind !== "steer" ||
        recorded.inputHash !== inputHash ||
        recorded.rootDeliveryId !== request.rootDeliveryId ||
        recorded.turnId !== request.expectedTurnId
      ) {
        throw new SessionBindingConflictError("conflict", "The steer delivery ID is recorded with different input");
      }
      return recorded;
    });
  }

  getAbsorbedReceipt(request: DirectImMessageDeliveryRequest): Promise<RecordedSteerInput | undefined> {
    return this.#withSessionLock(request.sessionId, async () => {
      const binding = await this.#requireBinding(request.agentId, request.sessionId);
      this.#validateDeliveryBinding(binding, request);
      const recorded = binding.recentRecordedInputs.find((entry) => entry.deliveryId === request.deliveryId);
      if (!recorded) return undefined;
      if (recorded.kind !== "steer" || recorded.inputHash !== computeRuntimeImMessageSemanticHash(request)) {
        throw new SessionBindingConflictError("conflict", "The delivery ID is recorded with different input");
      }
      return recorded;
    });
  }

  recordSteer(request: RuntimeImSteerRequest, inputHash: string): Promise<RecordedSteerInput> {
    return this.#withSessionLock(request.sessionId, async () => {
      RuntimeSha256Schema.parse(inputHash);
      const path = sessionBindingPath(this.#home, request.agentId, request.sessionId);
      const binding = await this.#requireBinding(request.agentId, request.sessionId);
      this.#validateSteerBinding(binding, request);
      const existing = binding.recentRecordedInputs.find((entry) => entry.deliveryId === request.deliveryId);
      if (existing) {
        if (
          existing.kind === "steer" &&
          existing.inputHash === inputHash &&
          existing.rootDeliveryId === request.rootDeliveryId &&
          existing.turnId === request.expectedTurnId
        ) {
          return existing;
        }
        throw new SessionBindingConflictError("conflict", "The steer delivery ID is recorded with different input");
      }
      const unresolved = binding.unresolvedTurn;
      if (
        !unresolved ||
        unresolved.deliveryId !== request.rootDeliveryId ||
        unresolved.turnId !== request.expectedTurnId
      ) {
        throw new SessionBindingConflictError("conflict", "The steer target does not match the unresolved Turn");
      }
      const recorded: RecordedSteerInput = {
        kind: "steer",
        deliveryId: request.deliveryId,
        inputHash,
        requestId: request.requestId,
        rootDeliveryId: request.rootDeliveryId,
        turnId: request.expectedTurnId,
      };
      const recentRecordedInputs = [
        ...binding.recentRecordedInputs.filter((entry) => entry.deliveryId !== recorded.deliveryId),
        recorded,
      ].slice(-this.#recordedInputLimit);
      await this.#writeBinding(path, { ...binding, recentRecordedInputs });
      return recorded;
    });
  }

  updateUnresolved(
    agentId: string,
    sessionId: string,
    turnId: string,
    phase: UnresolvedTurnPhase,
    fields: {
      providerTurnId?: string;
      report?: TurnReportRequest;
      resultHash?: string;
    } = {},
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
      const report = fields.report ? TurnReportRequestSchema.parse(fields.report) : undefined;
      if (report) this.#validateReport(binding, unresolved, report);
      if (report && fields.resultHash !== undefined && fields.resultHash !== report.resultHash) {
        throw new SessionBindingConflictError("conflict", "The Turn Report result hash does not match the update");
      }
      if (unresolved.report && report && unresolved.report.requestId !== report.requestId) {
        throw new SessionBindingConflictError("conflict", "The immutable Turn Report cannot be replaced");
      }
      if (unresolved.report && fields.resultHash && unresolved.report.resultHash !== fields.resultHash) {
        throw new SessionBindingConflictError("conflict", "The Turn Report result hash cannot be replaced");
      }
      const updated: LocalSessionBinding = {
        ...binding,
        unresolvedTurn: {
          ...unresolved,
          phase,
          ...(fields.providerTurnId ? { providerTurnId: fields.providerTurnId } : {}),
          ...(report ? { report } : {}),
          ...(fields.resultHash ? { resultHash: fields.resultHash } : {}),
        },
      };
      await this.#writeBinding(path, updated);
      return updated;
    });
  }

  saveRuntimeBinding(
    agentId: string,
    sessionId: string,
    effectiveSnapshotHash: string,
    runtimeBinding: AgentRuntimeBinding,
  ): Promise<LocalSessionBinding> {
    return this.#withSessionLock(sessionId, async () => {
      RuntimeSha256Schema.parse(effectiveSnapshotHash);
      validateRuntimeBinding(runtimeBinding);
      const path = sessionBindingPath(this.#home, agentId, sessionId);
      const binding = await this.#requireBinding(agentId, sessionId);
      if (
        binding.lastEffectiveSnapshotHash !== effectiveSnapshotHash ||
        binding.provider !== runtimeBinding.providerId
      ) {
        throw new SessionBindingConflictError("conflict", "The Agent Runtime binding does not match the Session");
      }
      const updated = { ...binding, runtimeBinding };
      await this.#writeBinding(path, updated);
      return updated;
    });
  }

  recordResult(agentId: string, sessionId: string, turnId: string, resultHash: string): Promise<LocalSessionBinding> {
    return this.#withSessionLock(sessionId, async () => {
      RuntimeSha256Schema.parse(resultHash);
      const path = sessionBindingPath(this.#home, agentId, sessionId);
      const binding = await this.#requireBinding(agentId, sessionId);
      const alreadyRecorded = binding.recentRecordedInputs.find(
        (entry): entry is RecordedTurnInput => entry.kind === "turn" && entry.turnId === turnId,
      );
      if (alreadyRecorded) {
        if (alreadyRecorded.resultHash === resultHash) return binding;
        throw new SessionBindingConflictError("conflict", "The recorded result hash cannot be replaced");
      }
      const unresolved = binding.unresolvedTurn;
      if (!unresolved) {
        throw new SessionBindingConflictError("conflict", "The recorded result does not match the Session binding");
      }
      if (unresolved.turnId !== turnId || unresolved.resultHash !== resultHash) {
        throw new SessionBindingConflictError("conflict", "The recorded result does not match the unresolved turn");
      }
      const recorded: RecordedTurnInput = {
        kind: "turn",
        deliveryId: unresolved.deliveryId,
        inputHash: unresolved.inputHash,
        requestId: unresolved.requestId,
        ...(unresolved.report ? { report: unresolved.report } : {}),
        resultHash,
        turnId,
      };
      const recentRecordedInputs = [
        ...binding.recentRecordedInputs.filter((entry) => entry.deliveryId !== recorded.deliveryId),
        recorded,
      ].slice(-this.#recordedInputLimit);
      const updated = { ...binding, recentRecordedInputs };
      delete updated.unresolvedTurn;
      await this.#writeBinding(path, updated);
      return updated;
    });
  }

  async #requireBinding(agentId: string, sessionId: string): Promise<LocalSessionBinding> {
    const binding = await this.read(agentId, sessionId);
    if (!binding) throw new SessionBindingConflictError("conflict", "The Session binding does not exist");
    return binding;
  }

  async #readBinding(path: string): Promise<LocalSessionBinding | undefined> {
    if (!(await validatePrivateDirectory(this.#home, dirname(path)))) return undefined;
    return readDurableJson(path, parseLocalSessionBinding);
  }

  async #writeBinding(path: string, binding: LocalSessionBinding): Promise<void> {
    if (!(await validatePrivateDirectory(this.#home, dirname(path)))) {
      throw new RuntimeStorageError("unsafe", "The Session binding directory does not exist");
    }
    await writeDurableJson(path, binding);
  }

  #validateIdentity(binding: LocalSessionBinding, request: SessionReconcileRequest): void {
    if (
      binding.sessionId !== request.sessionId ||
      binding.agentId !== request.agentId ||
      (request.runtime && binding.provider !== request.runtime.provider) ||
      binding.providerHomeIdentity !== this.#artifactIdentity(binding.provider) ||
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
      binding.providerHomeIdentity !== this.#artifactIdentity(binding.provider)
    ) {
      throw new SessionBindingConflictError("conflict", "The delivery does not match the Session binding");
    }
  }

  #validateSteerBinding(binding: LocalSessionBinding, request: RuntimeImSteerRequest): void {
    if (
      binding.agentId !== request.agentId ||
      binding.sessionId !== request.sessionId ||
      binding.placementGeneration !== request.placementGeneration ||
      binding.providerHomeIdentity !== this.#artifactIdentity(binding.provider)
    ) {
      throw new SessionBindingConflictError("conflict", "The steer delivery does not match the Session binding");
    }
  }

  #artifactIdentity(providerId: string): string {
    const identity = this.#providerArtifactIdentity(providerId);
    if (identity === undefined) {
      throw new SessionBindingConflictError("conflict", `Provider artifact identity is unavailable: ${providerId}`);
    }
    return RuntimeSha256Schema.parse(identity);
  }

  #validateReport(binding: LocalSessionBinding, unresolved: UnresolvedTurn, report: TurnReportRequest): void {
    if (
      report.requestId.length === 0 ||
      report.deliveryId !== unresolved.deliveryId ||
      report.turnId !== unresolved.turnId ||
      report.sessionId !== binding.sessionId ||
      report.agentId !== binding.agentId ||
      report.placementGeneration !== binding.placementGeneration ||
      (unresolved.resultHash !== undefined && unresolved.resultHash !== report.resultHash)
    ) {
      throw new SessionBindingConflictError("conflict", "The Turn Report does not match the unresolved custody");
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
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== SESSION_BINDING_SCHEMA_VERSION)
  ) {
    throw new RuntimeStorageError("invalid", "Unsupported Session binding schema");
  }
  const isLegacy = value.schemaVersion === 1;
  const hasInputKinds = value.schemaVersion === SESSION_BINDING_SCHEMA_VERSION;
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
  const optional = isLegacy ? ["providerThreadId", "unresolvedTurn"] : ["runtimeBinding", "unresolvedTurn"];
  if (!hasOnlyKeys(value, [...required, ...optional]) || required.some((key) => !(key in value))) {
    throw new RuntimeStorageError("invalid", "Session binding fields are invalid");
  }
  if (
    !isString(value.sessionId) ||
    !isString(value.agentId) ||
    !isString(value.workspaceId) ||
    !isSequence(value.placementGeneration) ||
    !isAgentRuntimeProviderId(value.provider) ||
    (isLegacy && value.provider !== "codex") ||
    !RuntimeSha256Schema.safeParse(value.providerHomeIdentity).success ||
    !isSequence(value.appliedSessionRevisionSequence) ||
    !isString(value.appliedSessionRevisionId) ||
    !RuntimeSha256Schema.safeParse(value.sessionConfigHash).success ||
    !RuntimeSha256Schema.safeParse(value.lastEffectiveSnapshotHash).success ||
    (isLegacy && value.providerThreadId !== undefined && !isString(value.providerThreadId)) ||
    !Array.isArray(value.recentRecordedInputs)
  ) {
    throw new RuntimeStorageError("invalid", "Session binding values are invalid");
  }
  const recentRecordedInputs = value.recentRecordedInputs.map((entry) =>
    parseRecordedInput(
      entry,
      value.sessionId as string,
      value.agentId as string,
      value.placementGeneration as number,
      hasInputKinds,
    ),
  );
  if (recentRecordedInputs.length > SESSION_RECORDED_INPUT_LIMIT) {
    throw new RuntimeStorageError("invalid", "Session binding has too many recorded inputs");
  }
  const unresolvedTurn =
    value.unresolvedTurn === undefined
      ? undefined
      : parseUnresolvedTurn(
          value.unresolvedTurn,
          value.sessionId as string,
          value.agentId as string,
          value.placementGeneration as number,
        );
  let runtimeBinding: AgentRuntimeBinding | undefined;
  if (isLegacy && value.providerThreadId) {
    runtimeBinding = {
      providerId: "codex",
      schemaVersion: 1,
      payload: { threadId: value.providerThreadId as string },
    };
  } else if (!isLegacy && value.runtimeBinding !== undefined) {
    runtimeBinding = validateRuntimeBinding(value.runtimeBinding);
    if (runtimeBinding.providerId !== value.provider) {
      throw new RuntimeStorageError("invalid", "Agent Runtime binding provider does not match the Session");
    }
  }
  return {
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    sessionId: value.sessionId,
    agentId: value.agentId,
    workspaceId: value.workspaceId,
    placementGeneration: value.placementGeneration,
    provider: value.provider,
    providerHomeIdentity: value.providerHomeIdentity as string,
    ...(runtimeBinding ? { runtimeBinding } : {}),
    appliedSessionRevisionSequence: value.appliedSessionRevisionSequence,
    appliedSessionRevisionId: value.appliedSessionRevisionId,
    sessionConfigHash: value.sessionConfigHash as string,
    lastEffectiveSnapshotHash: value.lastEffectiveSnapshotHash as string,
    recentRecordedInputs,
    ...(unresolvedTurn ? { unresolvedTurn } : {}),
  };
}

function validateRuntimeBinding(value: unknown): AgentRuntimeBinding {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["providerId", "schemaVersion", "payload"]) ||
    !isAgentRuntimeProviderId(value.providerId) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 1 ||
    !("payload" in value)
  ) {
    throw new RuntimeStorageError("invalid", "Agent Runtime binding is invalid");
  }
  try {
    assertJsonValue(value.payload, "runtimeBinding.payload", "binding_incompatible");
  } catch {
    throw new RuntimeStorageError("invalid", "Agent Runtime binding payload is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > AGENT_RUNTIME_BINDING_MAX_BYTES) {
    throw new RuntimeStorageError("invalid", "Agent Runtime binding exceeds the size limit");
  }
  return value as unknown as AgentRuntimeBinding;
}

function parseRecordedInput(
  value: unknown,
  sessionId: string,
  agentId: string,
  placementGeneration: number,
  hasInputKinds: boolean,
): RecordedInput {
  if (hasInputKinds && isRecord(value) && value.kind === "steer") {
    if (
      !hasOnlyKeys(value, ["kind", "deliveryId", "inputHash", "requestId", "rootDeliveryId", "turnId"]) ||
      !isString(value.deliveryId) ||
      !RuntimeSha256Schema.safeParse(value.inputHash).success ||
      !RuntimeRequestIdSchema.safeParse(value.requestId).success ||
      !isString(value.rootDeliveryId) ||
      !isString(value.turnId)
    ) {
      throw new RuntimeStorageError("invalid", "Recorded steer input is invalid");
    }
    return {
      kind: "steer",
      deliveryId: value.deliveryId,
      inputHash: value.inputHash as string,
      requestId: value.requestId as string,
      rootDeliveryId: value.rootDeliveryId,
      turnId: value.turnId,
    };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "deliveryId", "inputHash", "requestId", "turnId", "resultHash", "report"]) ||
    (hasInputKinds ? value.kind !== "turn" : value.kind !== undefined) ||
    !isString(value.deliveryId) ||
    !RuntimeSha256Schema.safeParse(value.inputHash).success ||
    !isString(value.turnId) ||
    !RuntimeSha256Schema.safeParse(value.resultHash).success ||
    (value.requestId !== undefined && !RuntimeRequestIdSchema.safeParse(value.requestId).success)
  ) {
    throw new RuntimeStorageError("invalid", "Recorded input is invalid");
  }
  const report = value.report === undefined ? undefined : TurnReportRequestSchema.parse(value.report);
  if (
    report &&
    (report.deliveryId !== value.deliveryId ||
      report.turnId !== value.turnId ||
      report.sessionId !== sessionId ||
      report.agentId !== agentId ||
      report.placementGeneration !== placementGeneration ||
      report.resultHash !== value.resultHash)
  ) {
    throw new RuntimeStorageError("invalid", "Recorded Turn Report identity is invalid");
  }
  return {
    kind: "turn",
    deliveryId: value.deliveryId,
    inputHash: value.inputHash as string,
    ...(value.requestId ? { requestId: value.requestId as string } : {}),
    ...(report ? { report } : {}),
    resultHash: value.resultHash as string,
    turnId: value.turnId,
  };
}

function parseUnresolvedTurn(
  value: unknown,
  sessionId: string,
  agentId: string,
  placementGeneration: number,
): UnresolvedTurn {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "requestId",
      "deliveryId",
      "inputHash",
      "turnId",
      "phase",
      "providerTurnId",
      "report",
      "resultHash",
    ]) ||
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
  const report = value.report === undefined ? undefined : TurnReportRequestSchema.parse(value.report);
  if (
    report &&
    (report.deliveryId !== value.deliveryId ||
      report.turnId !== value.turnId ||
      report.sessionId !== sessionId ||
      report.agentId !== agentId ||
      report.placementGeneration !== placementGeneration ||
      report.resultHash !== value.resultHash)
  ) {
    throw new RuntimeStorageError("invalid", "Unresolved Turn Report identity is invalid");
  }
  return {
    requestId: value.requestId,
    deliveryId: value.deliveryId,
    inputHash: value.inputHash as string,
    turnId: value.turnId,
    phase: value.phase,
    ...(value.providerTurnId ? { providerTurnId: value.providerTurnId } : {}),
    ...(report ? { report } : {}),
    ...(value.resultHash ? { resultHash: value.resultHash as string } : {}),
  };
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
