import type {
  ProviderCliArtifactStatusFrame,
  ProviderCliCancelFrame,
  ProviderCliRequirementFrame,
  ProviderCliValidationGrantFrame,
  ProviderCliValidationResultFrame,
} from "@opentag/shared";
import {
  ProviderCliCancelFrameSchema,
  ProviderCliRequirementFrameSchema,
  ProviderCliValidationGrantFrameSchema,
} from "@opentag/shared";
import type { RuntimeBusinessFrame, RuntimeConnection } from "../runtime-connection.js";
import type { ProviderCliManager } from "./manager.js";
import {
  type ProviderCliSelectionRecord,
  providerCliSelectionTargetPath,
  readProviderCliSelection,
} from "./selection-store.js";
import { managedArtifactDigest } from "./turn-plan.js";
import type { ProviderCliInspection, ProviderCliProvider } from "./types.js";
import type { ProviderCliValidationRequest, ProviderCliValidationRunner } from "./validation-runner.js";

const UNREPAIRABLE = new Set(["unsupported_platform", "global_bin_unavailable"]);
const GRANT_REPLAY_RETENTION_MS = 60_000;

export interface ProviderCliReconcilerOptions {
  readonly connection: Pick<RuntimeConnection, "send" | "subscribeBusinessFrames" | "capabilityVersion">;
  readonly manager: Pick<ProviderCliManager, "ensure" | "inspect" | "layout">;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly validation: Pick<ProviderCliValidationRunner, "run" | "cleanupAll">;
}

interface TrackedRequirement {
  readonly agentId: string;
  readonly credentialGeneration: number;
  readonly expectedIdentity: ProviderCliRequirementFrame["expectedIdentity"];
  readonly integrationId: string;
  readonly provider: ProviderCliProvider;
  readonly requestId: string;
}

interface ReadySelection {
  readonly fingerprint: string;
  readonly generation: number;
  readonly managedDigest?: string;
  readonly path: string;
  readonly version: string;
}

interface GrantState {
  readonly abort: AbortController;
  consumed: boolean;
  readonly expiresAt: number;
  inflight: boolean;
  readonly requirementRequestId: string;
}

export class ProviderCliReconciler {
  readonly #connection: ProviderCliReconcilerOptions["connection"];
  readonly #current = new Map<string, TrackedRequirement>();
  readonly #grants = new Map<string, GrantState>();
  readonly #manager: ProviderCliReconcilerOptions["manager"];
  readonly #now: () => number;
  readonly #providerJobs = new Map<ProviderCliProvider, Promise<ProviderCliArtifactStatusFrame["status"]>>();
  readonly #readySelection = new Map<ProviderCliProvider, ReadySelection>();
  readonly #signal?: AbortSignal;
  readonly #unsubscribe: () => void;
  readonly #validation: ProviderCliReconcilerOptions["validation"];
  #closed = false;

  constructor(options: ProviderCliReconcilerOptions) {
    this.#connection = options.connection;
    this.#manager = options.manager;
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal;
    this.#validation = options.validation;
    this.#unsubscribe = this.#connection.subscribeBusinessFrames((frame) => this.#handleFrame(frame));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#abortAll();
    await this.#validation.cleanupAll();
  }

  async #handleFrame(frame: RuntimeBusinessFrame): Promise<void> {
    if (this.#closed) return;
    const cancel = ProviderCliCancelFrameSchema.safeParse(frame);
    if (cancel.success) {
      this.#handleCancel(cancel.data);
      return;
    }
    if (this.#signal?.aborted) return;
    const requirement = ProviderCliRequirementFrameSchema.safeParse(frame);
    if (requirement.success) {
      await this.#handleRequirement(requirement.data);
      return;
    }
    const grant = ProviderCliValidationGrantFrameSchema.safeParse(frame);
    if (grant.success) await this.#handleGrant(grant.data);
  }

  #handleCancel(frame: ProviderCliCancelFrame): void {
    const current = this.#current.get(frame.integrationId);
    if (
      !current ||
      current.requestId !== frame.requirementRequestId ||
      current.agentId !== frame.agentId ||
      current.provider !== frame.provider ||
      current.credentialGeneration !== frame.credentialGeneration
    ) {
      return;
    }
    this.#abortGrants(frame.requirementRequestId);
    this.#current.delete(frame.integrationId);
  }

  async #handleRequirement(frame: ProviderCliRequirementFrame): Promise<void> {
    const previous = this.#current.get(frame.integrationId);
    if (previous) {
      if (previous.requestId === frame.requestId) return;
      if (frame.credentialGeneration < previous.credentialGeneration) return;
      this.#abortGrants(previous.requestId);
    }
    const tracked: TrackedRequirement = {
      agentId: frame.agentId,
      credentialGeneration: frame.credentialGeneration,
      expectedIdentity: frame.expectedIdentity,
      integrationId: frame.integrationId,
      provider: frame.provider,
      requestId: frame.requestId,
    };
    this.#current.set(frame.integrationId, tracked);
    await this.#publishArtifact(tracked, "checking");
    const status = await this.#reconcileProvider(frame.provider);
    await this.#publishCurrentProvider(frame.provider, status);
  }

  async #reconcileProvider(provider: ProviderCliProvider): Promise<ProviderCliArtifactStatusFrame["status"]> {
    const existing = this.#providerJobs.get(provider);
    if (existing) return existing;
    const job = this.#runProvider(provider).finally(() => {
      if (this.#providerJobs.get(provider) === job) this.#providerJobs.delete(provider);
    });
    this.#providerJobs.set(provider, job);
    return job;
  }

  async #runProvider(provider: ProviderCliProvider): Promise<ProviderCliArtifactStatusFrame["status"]> {
    try {
      let inspection = await this.#manager.inspect(provider);
      if (inspection.readiness !== "ready") {
        if (inspection.diagnostic && UNREPAIRABLE.has(inspection.diagnostic.code)) return "unavailable";
        await this.#manager.ensure(provider, { mode: "managed-only" });
        inspection = await this.#manager.inspect(provider);
      }
      if (inspection.readiness === "ready") {
        const ready = await readySelectionFromInspect(this.#manager.layout, provider, inspection);
        if (!ready) {
          this.#readySelection.delete(provider);
          return "unavailable";
        }
        this.#readySelection.set(provider, ready);
        return "ready";
      }
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async #publishCurrentProvider(
    provider: ProviderCliProvider,
    status: ProviderCliArtifactStatusFrame["status"],
  ): Promise<void> {
    const current = [...this.#current.values()].filter((requirement) => requirement.provider === provider);
    await Promise.all(current.map((requirement) => this.#publishArtifact(requirement, status)));
  }

  async #handleGrant(frame: ProviderCliValidationGrantFrame): Promise<void> {
    if (this.#closed || this.#signal?.aborted) return;
    this.#pruneGrants();
    const current = this.#current.get(frame.integrationId);
    if (!current || current.requestId !== frame.requirementRequestId) return;
    if (
      current.agentId !== frame.agentId ||
      current.provider !== frame.provider ||
      current.credentialGeneration !== frame.credentialGeneration
    ) {
      return;
    }
    if (!expectedIdentitiesMatch(current.expectedIdentity, frame.expectedIdentity)) return;
    const existing = this.#grants.get(frame.requestId);
    if (existing?.consumed || existing?.inflight) return;
    if (Date.parse(frame.expiresAt) <= this.#now()) {
      this.#grants.set(frame.requestId, {
        abort: new AbortController(),
        consumed: true,
        expiresAt: Date.parse(frame.expiresAt),
        inflight: false,
        requirementRequestId: frame.requirementRequestId,
      });
      await this.#publishValidation(frame, { status: "retrying", reason: "validation_expired" });
      return;
    }
    const inspection = await this.#manager.inspect(frame.provider);
    const ready = this.#readySelection.get(frame.provider);
    const live = await readySelectionFromInspect(this.#manager.layout, frame.provider, inspection);
    if (!ready || !live || !selectionsMatch(ready, live)) {
      this.#grants.set(frame.requestId, {
        abort: new AbortController(),
        consumed: true,
        expiresAt: Date.parse(frame.expiresAt),
        inflight: false,
        requirementRequestId: frame.requirementRequestId,
      });
      await this.#publishValidation(frame, { status: "retrying", reason: "artifact_changed" });
      return;
    }
    const abort = new AbortController();
    this.#grants.set(frame.requestId, {
      abort,
      consumed: false,
      expiresAt: Date.parse(frame.expiresAt),
      inflight: true,
      requirementRequestId: frame.requirementRequestId,
    });
    const signal = this.#signal ? AbortSignal.any([this.#signal, abort.signal]) : abort.signal;
    try {
      const request: ProviderCliValidationRequest = {
        expectedFingerprint: live.fingerprint,
        expectedIdentity: frame.expectedIdentity,
        expiresAt: frame.expiresAt,
        grant: frame.grant,
        requestId: frame.requestId,
        targetPath: live.path,
        version: live.version,
        ...(live.managedDigest ? { managedDigest: live.managedDigest } : {}),
      };
      const result = await this.#validation.run(
        request,
        {
          requestId: frame.requestId,
          provider: frame.provider,
          agentId: frame.agentId,
          integrationId: frame.integrationId,
          credentialGeneration: frame.credentialGeneration,
        },
        signal,
      );
      if (this.#closed || this.#signal?.aborted || abort.signal.aborted) return;
      const state = this.#grants.get(frame.requestId);
      if (!state || this.#current.get(frame.integrationId)?.requestId !== frame.requirementRequestId) return;
      state.consumed = true;
      state.inflight = false;
      await this.#publishValidation(frame, result);
    } catch {
      if (this.#closed || this.#signal?.aborted || abort.signal.aborted) return;
      const state = this.#grants.get(frame.requestId);
      if (!state || this.#current.get(frame.integrationId)?.requestId !== frame.requirementRequestId) return;
      state.consumed = true;
      state.inflight = false;
      await this.#publishValidation(frame, { status: "needs_attention" });
    }
  }

  #abortGrants(requirementRequestId: string): void {
    for (const [grantId, state] of [...this.#grants]) {
      if (state.requirementRequestId !== requirementRequestId) continue;
      state.abort.abort();
      this.#grants.delete(grantId);
    }
  }

  #pruneGrants(): void {
    const now = this.#now();
    for (const [grantId, state] of this.#grants) {
      if (!state.inflight && state.expiresAt + GRANT_REPLAY_RETENTION_MS <= now) this.#grants.delete(grantId);
    }
  }

  #abortAll(): void {
    for (const state of this.#grants.values()) state.abort.abort();
    this.#grants.clear();
    this.#current.clear();
  }

  async #publishArtifact(frame: TrackedRequirement, status: ProviderCliArtifactStatusFrame["status"]): Promise<void> {
    const current = this.#current.get(frame.integrationId);
    if (!current || current.requestId !== frame.requestId) return;
    const payload: ProviderCliArtifactStatusFrame = {
      type: "provider-cli:artifact:status",
      requestId: frame.requestId,
      provider: frame.provider,
      agentId: frame.agentId,
      integrationId: frame.integrationId,
      credentialGeneration: frame.credentialGeneration,
      status,
    };
    await this.#connection.send(payload, { priority: "result" });
  }

  async #publishValidation(
    frame: ProviderCliValidationGrantFrame,
    result: Pick<ProviderCliValidationResultFrame, "status" | "reason">,
  ): Promise<void> {
    const payload: ProviderCliValidationResultFrame = {
      type: "provider-cli:validation:result",
      requestId: frame.requestId,
      provider: frame.provider,
      agentId: frame.agentId,
      integrationId: frame.integrationId,
      credentialGeneration: frame.credentialGeneration,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    await this.#connection.send(payload, { priority: "result" });
  }
}

async function readySelectionFromInspect(
  layout: ProviderCliManager["layout"],
  provider: ProviderCliProvider,
  inspection: ProviderCliInspection,
): Promise<ReadySelection | undefined> {
  if (inspection.readiness !== "ready" || !inspection.selection || !inspection.fingerprint) return undefined;
  let record: ProviderCliSelectionRecord | undefined;
  try {
    record = await readProviderCliSelection(layout, provider);
  } catch {
    return undefined;
  }
  if (!record) return undefined;
  const path = providerCliSelectionTargetPath(record.selection);
  if (
    record.generation !== inspection.selection.generation ||
    record.selection.kind !== inspection.selection.kind ||
    record.selection.version !== inspection.selection.version ||
    record.selection.fingerprint !== inspection.fingerprint ||
    path !== inspection.selection.path
  ) {
    return undefined;
  }
  const managedDigest =
    record.selection.kind === "managed" ? managedArtifactDigest(record.selection.artifactId) : undefined;
  return {
    fingerprint: inspection.fingerprint,
    generation: record.generation,
    path,
    version: record.selection.version,
    ...(managedDigest ? { managedDigest } : {}),
  };
}

function selectionsMatch(left: ReadySelection, right: ReadySelection): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.generation === right.generation &&
    left.path === right.path &&
    left.version === right.version
  );
}

function expectedIdentitiesMatch(
  left: ProviderCliRequirementFrame["expectedIdentity"],
  right: ProviderCliRequirementFrame["expectedIdentity"],
): boolean {
  if (left.provider !== right.provider) return false;
  if (left.provider === "feishu" && right.provider === "feishu") {
    return left.appId === right.appId && left.botOpenId === right.botOpenId && left.teamBrand === right.teamBrand;
  }
  if (left.provider === "slack" && right.provider === "slack") {
    return left.teamId === right.teamId && left.botUserId === right.botUserId && left.botId === right.botId;
  }
  return false;
}
