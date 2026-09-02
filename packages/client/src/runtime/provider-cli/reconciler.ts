import type {
  ImCliReadinessStatus,
  ProviderCliArtifactStatusFrame,
  ProviderCliCancelFrame,
  ProviderCliPrewarmFrame,
  ProviderCliRequirementFrame,
  ProviderCliValidationGrantFrame,
  ProviderCliValidationResultFrame,
} from "@opentag/shared";
import {
  ProviderCliCancelFrameSchema,
  ProviderCliPrewarmFrameSchema,
  ProviderCliRequirementFrameSchema,
  ProviderCliValidationGrantFrameSchema,
  RUNTIME_CAPABILITY,
} from "@opentag/shared";
import { createLogger } from "../../observability/logger.js";
import type { RuntimeBusinessFrame, RuntimeConnection } from "../runtime-connection.js";
import type { ProviderCliManager } from "./manager.js";
import {
  type ProviderCliSelectionRecord,
  providerCliSelectionTargetPath,
  readProviderCliSelection,
} from "./selection-store.js";
import { managedArtifactDigest } from "./turn-plan.js";
import type {
  ProviderCliEnsureResult,
  ProviderCliInspection,
  ProviderCliProvider,
  ProviderCliReadySelection,
} from "./types.js";
import type { ProviderCliValidationRequest, ProviderCliValidationRunner } from "./validation-runner.js";

const UNREPAIRABLE = new Set(["unsupported_platform", "global_bin_unavailable"]);
const GRANT_REPLAY_RETENTION_MS = 60_000;
const logger = createLogger("runtime-provider-cli-reconciler");

/**
 * A foreground targeted connect is the sole first-setup installer and holds the per-provider
 * lock while it works. A daemon reconcile that loses that race waits the foreground operation
 * out instead of reporting a verdict: the delay is one lock-acquire budget, and the attempt
 * bound comfortably covers the installer's own download deadline.
 */
export const PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS = 5_000;
export const PROVIDER_CLI_LOCK_BUSY_MAX_ATTEMPTS = 30;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ProviderCliReconcilerOptions {
  readonly connection: Pick<
    RuntimeConnection,
    "send" | "subscribeBusinessFrames" | "capabilityVersion" | "setImCliReadiness"
  >;
  readonly manager: Pick<ProviderCliManager, "ensure" | "inspect" | "layout">;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Test hook: replaces the busy-lock retry wait. */
  readonly sleep?: (ms: number) => Promise<void>;
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
  readonly #frameJobs = new Set<Promise<void>>();
  readonly #imCliPublished = new Map<ProviderCliProvider, ImCliReadinessStatus>();
  readonly #inspectionJobs = new Map<ProviderCliProvider, Promise<ImCliReadinessStatus>>();
  readonly #providerJobs = new Map<string, Promise<ProviderCliArtifactStatusFrame["status"]>>();
  readonly #readySelection = new Map<ProviderCliProvider, ProviderCliReadySelection>();
  readonly #signal?: AbortSignal;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #unsubscribe: () => void;
  readonly #validation: ProviderCliReconcilerOptions["validation"];
  #closePromise?: Promise<void>;
  #closed = false;

  constructor(options: ProviderCliReconcilerOptions) {
    this.#connection = options.connection;
    this.#manager = options.manager;
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#validation = options.validation;
    this.#unsubscribe = this.#connection.subscribeBusinessFrames((frame) => this.#trackFrame(frame));
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  /** Re-inspect each published CLI so heartbeat freshness reflects current local state. */
  async refreshPublishedImCliReadiness(): Promise<void> {
    if (this.#closed || this.#signal?.aborted) return;
    await Promise.all([...this.#imCliPublished.keys()].map((provider) => this.#refreshImCli(provider)));
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe();
    this.#imCliPublished.clear();
    this.#abortAll();
    await Promise.allSettled([...this.#frameJobs, ...this.#inspectionJobs.values()]);
    await this.#validation.cleanupAll();
  }

  #trackFrame(frame: RuntimeBusinessFrame): Promise<void> {
    const job = this.#handleFrame(frame).finally(() => {
      this.#frameJobs.delete(job);
    });
    this.#frameJobs.add(job);
    return job;
  }

  /**
   * Return the exact selection already accepted by daemon readiness. A local
   * selection drift first republishes artifact checking, repairs if possible,
   * and only then exposes the new selection to a visible Run.
   */
  async readySelectionForRun(provider: ProviderCliProvider): Promise<ProviderCliReadySelection | undefined> {
    if (this.#closed || this.#signal?.aborted) return undefined;
    const inspection = await this.#manager.inspect(provider).catch((error: unknown) => {
      logger.debug(
        { code: "ready_inspection_failed", provider, error: String(error) },
        "Provider CLI readiness inspection failed",
      );
      return undefined;
    });
    const live = inspection ? await readySelectionFromInspect(this.#manager.layout, provider, inspection) : undefined;
    const accepted = this.#readySelection.get(provider);
    if (accepted && live && selectionsMatch(accepted, live)) return { ...live };

    await this.#publishCurrentProvider(provider, "checking");
    const status = await this.#reconcileProvider(provider);
    await this.#publishCurrentProvider(provider, status);
    // Do not admit the Run that discovered drift. The Server must first consume
    // the checking/ready transition and complete a fresh credential validation;
    // a normal delivery retry can then obtain a grant and use the new selection.
    return undefined;
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
    const prewarm = ProviderCliPrewarmFrameSchema.safeParse(frame);
    if (prewarm.success) {
      await this.#handlePrewarm(prewarm.data);
      return;
    }
    const grant = ProviderCliValidationGrantFrameSchema.safeParse(frame);
    if (grant.success) await this.#handleGrant(grant.data);
  }

  async #handlePrewarm(frame: ProviderCliPrewarmFrame): Promise<void> {
    if (this.#closed || this.#signal?.aborted) return;
    if (this.#connection.capabilityVersion(RUNTIME_CAPABILITY.providerCliPrewarm) === undefined) return;
    await Promise.all(frame.providers.map((provider) => this.#prewarmProvider(provider)));
  }

  async #prewarmProvider(provider: ProviderCliProvider): Promise<void> {
    await this.#refreshImCli(provider);
  }

  async #refreshImCli(provider: ProviderCliProvider): Promise<void> {
    this.#publishImCli(provider, "checking");
    const status = await this.#inspectImCli(provider);
    this.#publishImCli(provider, status);
  }

  #inspectImCli(provider: ProviderCliProvider): Promise<ImCliReadinessStatus> {
    const existing = this.#inspectionJobs.get(provider);
    if (existing) return existing;
    const job = this.#manager
      .inspect(provider)
      .then((inspection) => inspection.readiness)
      .catch(() => "unavailable" as const)
      .finally(() => {
        if (this.#inspectionJobs.get(provider) === job) this.#inspectionJobs.delete(provider);
      });
    this.#inspectionJobs.set(provider, job);
    return job;
  }

  #publishImCli(provider: ProviderCliProvider, status: ImCliReadinessStatus): void {
    if (this.#closed || this.#signal?.aborted) return;
    this.#imCliPublished.set(provider, status);
    this.#connection.setImCliReadiness({ provider, status });
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

  async #reconcileProvider(
    provider: ProviderCliProvider,
    mode: "auto" | "managed-only" = "managed-only",
  ): Promise<ProviderCliArtifactStatusFrame["status"]> {
    const key = `${provider}:${mode}`;
    const existing = this.#providerJobs.get(key);
    if (existing) return existing;
    const job = this.#runProvider(provider, mode).finally(() => {
      if (this.#providerJobs.get(key) === job) this.#providerJobs.delete(key);
    });
    this.#providerJobs.set(key, job);
    return job;
  }

  async #runProvider(
    provider: ProviderCliProvider,
    mode: "auto" | "managed-only",
  ): Promise<ProviderCliArtifactStatusFrame["status"]> {
    try {
      let inspection = await this.#manager.inspect(provider);
      if (inspection.readiness !== "ready") {
        if (inspection.diagnostic && UNREPAIRABLE.has(inspection.diagnostic.code)) return "unavailable";
        await this.#ensureConverging(provider, mode);
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
      this.#readySelection.delete(provider);
      return "unavailable";
    } catch (error) {
      logger.debug(
        { code: "provider_reconcile_failed", provider, error: String(error) },
        "Provider CLI reconciliation failed",
      );
      this.#readySelection.delete(provider);
      return "unavailable";
    }
  }

  /**
   * Ensure, waiting out a foreground installer's lock instead of converting the race into a
   * verdict: losing the cross-process provider lock is transient, so the artifact stays in its
   * published "checking" state while the foreground operation finishes, and the outcome is then
   * re-read so the connection converges on a terminal status without waiting for a reconnect.
   */
  async #ensureConverging(
    provider: ProviderCliProvider,
    mode: "auto" | "managed-only",
  ): Promise<ProviderCliEnsureResult> {
    let outcome = await this.#manager.ensure(provider, { mode });
    for (let attempt = 0; outcome.diagnostic?.code === "operation_in_progress"; attempt += 1) {
      if (attempt >= PROVIDER_CLI_LOCK_BUSY_MAX_ATTEMPTS || this.#closed || this.#signal?.aborted) break;
      await this.#sleepBusy();
      // The shutdown signal may win the wait; do not start another ensure after it.
      if (this.#closed || this.#signal?.aborted) break;
      outcome = await this.#manager.ensure(provider, { mode });
    }
    return outcome;
  }

  /** Bounded wait between lock-busy retries; returns early when the daemon is shutting down. */
  #sleepBusy(): Promise<void> {
    const signal = this.#signal;
    const wait = this.#sleep(PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS);
    if (!signal) return wait;
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => finish();
      signal.addEventListener("abort", onAbort, { once: true });
      // Close the check-to-listener race if shutdown happened between the guard above and add.
      if (signal.aborted) onAbort();
      void wait.then(() => finish(), finish);
    });
  }

  async #publishCurrentProvider(
    provider: ProviderCliProvider,
    status: ProviderCliArtifactStatusFrame["status"],
  ): Promise<void> {
    const current = [...this.#current.values()].filter((requirement) => requirement.provider === provider);
    await Promise.all(current.map((requirement) => this.#publishArtifact(requirement, status)));
  }

  async #handleGrant(frame: ProviderCliValidationGrantFrame): Promise<void> {
    this.#pruneGrants();
    if (!this.#acceptsGrant(frame)) return;
    if (Date.parse(frame.expiresAt) <= this.#now()) {
      this.#rememberGrant(frame, new AbortController(), true, false);
      await this.#publishValidation(frame, { status: "retrying", reason: "validation_expired" });
      return;
    }
    const inspection = await this.#manager.inspect(frame.provider);
    const ready = this.#readySelection.get(frame.provider);
    const live = await readySelectionFromInspect(this.#manager.layout, frame.provider, inspection);
    if (!ready || !live || !selectionsMatch(ready, live)) {
      this.#rememberGrant(frame, new AbortController(), true, false);
      await this.#publishValidation(frame, { status: "retrying", reason: "artifact_changed" });
      return;
    }
    await this.#runValidation(frame, live);
  }

  #acceptsGrant(frame: ProviderCliValidationGrantFrame): boolean {
    if (this.#closed || this.#signal?.aborted) return false;
    const current = this.#current.get(frame.integrationId);
    if (!current || current.requestId !== frame.requirementRequestId) return false;
    if (current.agentId !== frame.agentId || current.provider !== frame.provider) return false;
    if (current.credentialGeneration !== frame.credentialGeneration) return false;
    if (!expectedIdentitiesMatch(current.expectedIdentity, frame.expectedIdentity)) return false;
    const existing = this.#grants.get(frame.requestId);
    return !existing?.consumed && !existing?.inflight;
  }

  #rememberGrant(
    frame: ProviderCliValidationGrantFrame,
    abort: AbortController,
    consumed: boolean,
    inflight: boolean,
  ): void {
    this.#grants.set(frame.requestId, {
      abort,
      consumed,
      expiresAt: Date.parse(frame.expiresAt),
      inflight,
      requirementRequestId: frame.requirementRequestId,
    });
  }

  async #runValidation(frame: ProviderCliValidationGrantFrame, live: ProviderCliReadySelection): Promise<void> {
    const abort = new AbortController();
    this.#rememberGrant(frame, abort, false, true);
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
      if (!this.#finishGrant(frame, abort)) return;
      await this.#publishValidation(frame, result);
    } catch (error) {
      logger.debug(
        {
          code: "validation_failed",
          provider: frame.provider,
          error: String(error),
        },
        "Provider CLI validation failed",
      );
      if (!this.#finishGrant(frame, abort)) return;
      await this.#publishValidation(frame, { status: "needs_attention" });
    }
  }

  #finishGrant(frame: ProviderCliValidationGrantFrame, abort: AbortController): boolean {
    if (this.#closed || this.#signal?.aborted || abort.signal.aborted) return false;
    const state = this.#grants.get(frame.requestId);
    if (!state || this.#current.get(frame.integrationId)?.requestId !== frame.requirementRequestId) return false;
    state.consumed = true;
    state.inflight = false;
    return true;
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
): Promise<ProviderCliReadySelection | undefined> {
  if (inspection.readiness !== "ready" || !inspection.selection || !inspection.fingerprint) return undefined;
  let record: ProviderCliSelectionRecord | undefined;
  try {
    record = await readProviderCliSelection(layout, provider);
  } catch (error) {
    logger.debug(
      { code: "selection_read_failed", provider, error: String(error) },
      "Provider CLI selection read failed",
    );
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

function selectionsMatch(left: ProviderCliReadySelection, right: ProviderCliReadySelection): boolean {
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
