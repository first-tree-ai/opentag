import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { agents, imBindings, imMessages } from "../../../db/schema/index.js";
import type { BackgroundFailureSupervisor } from "../../../observability/background-failure-supervisor.js";
import {
  emitRootSpan,
  imAttrs,
  outcomeAttrs,
  runtimeAttrs,
  setActiveSpanAttributes,
  traceFeishuInbound,
  withRootSpan,
} from "../../../observability/index.js";
import { ExternalCallPolicy } from "../../im/external-call-policy.js";
import { classifyImInboundPersistenceError, type ImMessageInbox } from "../../im/index.js";
import type { ImBindingService, VerifiedFeishuBinding } from "../im-binding-service.js";
import { FeishuAdapter, type FeishuChannel, feishuEnvelopeEventId, feishuSenderOpenId } from "./adapter.js";
import { FeishuCandidateExpiredError, FeishuOperationError, safeFeishuConnectionErrorCode } from "./errors.js";
import type { FeishuInboundReceiptStore } from "./inbound-receipt-store.js";
import { classifyFeishuProbeFailure, type FeishuCandidateCheckOutcome, missingRequiredScopes } from "./setup-check.js";
import type { FeishuBindingActivation } from "./setup-service.js";

type FeishuActivationInput = Parameters<FeishuBindingActivation["activateAtomicAttempt"]>[0];
type FeishuInboundReceiptStoreLike = Pick<FeishuInboundReceiptStore, "claim" | "markProcessed" | "markFailed">;

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAINTENANCE_MS = 10_000;
const CONNECTION_SCAN_PAGE_SIZE = 100;
/** The channel-free Bot info probe is a bounded metadata read, not channel work. */
const CANDIDATE_BOT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The documented `bot/v3/info` activate_status values that prove an App is not enabled: 0 install
 * pending, 1 tenant-disabled, 3 installed-pending-enable, 4 upgrade-pending-enable, 5 license
 * expired, 6 plan expired or downgraded. Only 2 is enabled; an omitted field carries no evidence.
 */
const KNOWN_NON_ENABLED_ACTIVATE_STATUS: ReadonlySet<number> = new Set([0, 1, 3, 4, 5, 6]);

interface OwnedChannel {
  adapter: FeishuAdapter;
  epoch: number;
  generation: number;
  appId: string;
}

function diagnosticCode(error: unknown): string {
  return safeFeishuConnectionErrorCode(error);
}

export class FeishuConnectionManager implements FeishuBindingActivation {
  readonly #database: DatabaseClient;
  readonly #inbox: ImMessageInbox;
  readonly #instanceId: string;
  readonly #imBindings: ImBindingService;
  readonly #createAdapter: (input: {
    appId: string;
    appSecret: string;
    teamId: string | null;
    teamBrand?: "feishu" | "lark" | null;
    /* type-only */ channel?: FeishuChannel | null;
    /* type-only */ policy?: ExternalCallPolicy;
  }) => FeishuAdapter;
  readonly #leaseMs: number;
  readonly #maintenanceMs: number;
  readonly #onDiagnostic: (code: string) => void;
  readonly #supervisor?: BackgroundFailureSupervisor;
  readonly #runtimeReady: (agentId: string) => Promise<boolean>;
  readonly #policy: ExternalCallPolicy;
  readonly #receipts: FeishuInboundReceiptStoreLike | undefined;
  readonly #maintenanceBackoffBaseMs: number;
  readonly #maintenanceBackoffMaxMs: number;
  readonly #now: () => Date;
  readonly #afterActivationAgentLocked: (() => Promise<void>) | undefined;
  readonly #owned = new Map<string, OwnedChannel>();
  readonly #maintenanceControllers = new Map<string, AbortController>();
  readonly #maintenanceFailures = new Map<string, number>();
  readonly #maintenanceNextAt = new Map<string, number>();
  #maintaining = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = true;
  #shutdownEpoch = 0;

  constructor(input: {
    database: DatabaseClient;
    inbox: ImMessageInbox;
    instanceId: string;
    imBindings: ImBindingService;
    createAdapter?: (input: {
      appId: string;
      appSecret: string;
      teamId: string | null;
      teamBrand?: "feishu" | "lark" | null;
      /* type-only */ channel?: FeishuChannel | null;
      /* type-only */ policy?: ExternalCallPolicy;
    }) => FeishuAdapter;
    leaseMs?: number;
    maintenanceMs?: number;
    runtimeReady?: (agentId: string) => Promise<boolean> | boolean;
    onDiagnostic?: (code: string) => void;
    supervisor?: BackgroundFailureSupervisor;
    receipts?: FeishuInboundReceiptStoreLike;
    afterActivationAgentLocked?: () => Promise<void>;
    /* type-only */ policy?: ExternalCallPolicy;
    /* type-only */ maintenanceBackoffBaseMs?: number;
    /* type-only */ maintenanceBackoffMaxMs?: number;
    /* type-only */ now?: () => Date;
  }) {
    this.#database = input.database;
    this.#inbox = input.inbox;
    this.#instanceId = input.instanceId;
    this.#imBindings = input.imBindings;
    this.#createAdapter = input.createAdapter ?? ((options) => new FeishuAdapter({ ...options, policy: this.#policy }));
    this.#leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maintenanceMs = input.maintenanceMs ?? DEFAULT_MAINTENANCE_MS;
    this.#runtimeReady = async (agentId) => (await input.runtimeReady?.(agentId)) ?? true;
    this.#policy =
      input.policy ??
      new ExternalCallPolicy({
        allowedHosts: ["open.feishu.cn", "open.larksuite.com"],
      });
    this.#maintenanceBackoffBaseMs = Math.max(1, input.maintenanceBackoffBaseMs ?? 500);
    this.#maintenanceBackoffMaxMs = Math.max(this.#maintenanceBackoffBaseMs, input.maintenanceBackoffMaxMs ?? 30_000);
    this.#now = input.now ?? (() => new Date());
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
    this.#supervisor = input.supervisor;
    this.#receipts = input.receipts;
    this.#afterActivationAgentLocked = input.afterActivationAgentLocked;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#scheduleMaintenance();
    this.#timer = setInterval(() => this.#scheduleMaintenance(), this.#maintenanceMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#shutdownEpoch += 1;
    for (const controller of this.#maintenanceControllers.values()) controller.abort();
    this.#maintenanceControllers.clear();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const owned = [...this.#owned.entries()];
    this.#owned.clear();
    await Promise.allSettled(
      owned.map(async ([imBindingId, entry]) => {
        await entry.adapter.channel.disconnect().catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
        this.#emitDisconnected(imBindingId, "FEISHU_CONNECTION_STOPPED");
      }),
    );
    await this.#database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: null,
        connectionLeaseExpiresAt: null,
        observedConnectedAt: null,
        observedAt: new Date(),
      })
      .where(eq(imBindings.connectionOwnerInstanceId, this.#instanceId));
  }

  /**
   * A bounded, channel-free readiness probe for one durable candidate. It performs the same tenant
   * scope query and runtime readiness observation activation would, plus the official Bot info read
   * that distinguishes an installed-but-not-enabled App, and deliberately never opens the message
   * channel: a candidate that is still waiting must not hold a socket.
   */
  async checkCandidate(input: {
    agentId: string;
    appId: string;
    appSecret: string;
    teamBrand?: "feishu" | "lark";
    signal?: AbortSignal;
  }): Promise<FeishuCandidateCheckOutcome> {
    input.signal?.throwIfAborted();
    const now = this.#now().getTime();
    const probe = this.#createAdapter({
      appId: input.appId,
      appSecret: input.appSecret,
      teamId: null,
      teamBrand: input.teamBrand,
      channel: null,
    });
    let grantedScopes: string[];
    try {
      grantedScopes = await this.#policy.run("feishu.binding.scopes", () => probe.listGrantedWorkspaceScopes(), {
        signal: input.signal,
        maxAttempts: 1,
        circuitKey: `feishu:binding:${input.appId}`,
      });
    } catch (error) {
      return classifyFeishuProbeFailure(error, now);
    }
    const missingScopes = missingRequiredScopes(grantedScopes);
    if (missingScopes.length > 0) {
      return { status: "waiting", reason: "permissions_pending", missingScopes };
    }
    if (
      !(await this.#policy.run("feishu.binding.runtime", async () => this.#runtimeReady(input.agentId), {
        signal: input.signal,
        maxAttempts: 1,
        timeoutMs: CANDIDATE_BOT_PROBE_TIMEOUT_MS,
      }))
    ) {
      return { status: "waiting", reason: "runtime_unavailable", missingScopes: [] };
    }
    const probeBotIdentity = (probe as { probeBotIdentity?: () => Promise<{ activateStatus: number | null }> })
      .probeBotIdentity;
    if (probeBotIdentity) {
      try {
        const bot = await this.#policy.run("feishu.binding.bot", () => probeBotIdentity.call(probe), {
          signal: input.signal,
          maxAttempts: 1,
          timeoutMs: CANDIDATE_BOT_PROBE_TIMEOUT_MS,
          circuitKey: `feishu:binding:${input.appId}`,
        });
        // Only an explicit documented non-enabled status is evidence against the App: the endpoint
        // may omit the optional field while still proving the Bot identity, and an undocumented
        // value is decided by the mandatory atomic channel activation, never guessed here.
        if (bot.activateStatus !== null && KNOWN_NON_ENABLED_ACTIVATE_STATUS.has(bot.activateStatus)) {
          return { status: "waiting", reason: "app_unavailable", missingScopes: [] };
        }
      } catch (error) {
        const classified = classifyFeishuProbeFailure(error, now);
        if (classified.status === "terminal") return classified;
        if (!isKnownBotUnavailable(error)) return classified;
        return { status: "waiting", reason: "app_unavailable", missingScopes: [] };
      }
    }
    return { status: "ready" };
  }

  async activateAtomicAttempt(input: FeishuActivationInput): Promise<VerifiedFeishuBinding> {
    return withRootSpan(
      "feishu.connection.connect",
      { ...imAttrs({ provider: "feishu" }), ...runtimeAttrs({ agentId: input.agentId }) },
      async () => {
        try {
          const result = await this.#activateAtomicAttempt(input);
          setActiveSpanAttributes(outcomeAttrs("connected"));
          return result;
        } catch (error) {
          const code = diagnosticCode(error);
          setActiveSpanAttributes(outcomeAttrs(connectionOutcome(code), code));
          throw error;
        }
      },
    );
  }

  /** The channel-free admission checks every activation must pass before a socket is created. */
  async #assertActivationPrerequisites(input: {
    agentId: string;
    appId: string;
    appSecret: string;
    teamBrand?: "feishu" | "lark";
    signal?: AbortSignal;
  }): Promise<void> {
    input.signal?.throwIfAborted();
    const probe = this.#createAdapter({
      appId: input.appId,
      appSecret: input.appSecret,
      teamId: null,
      teamBrand: input.teamBrand,
      channel: null,
    });
    const grantedScopes = await this.#policy.run("feishu.binding.scopes", () => probe.listGrantedWorkspaceScopes(), {
      signal: input.signal,
      maxAttempts: 1,
      circuitKey: `feishu:binding:${input.appId}`,
    });
    const missingScopes = missingRequiredScopes(grantedScopes);
    if (missingScopes.length > 0) {
      throw new FeishuOperationError("FEISHU_SCOPE_REAUTH_REQUIRED", missingScopes);
    }
    if (
      !(await this.#policy.run("feishu.binding.runtime", async () => this.#runtimeReady(input.agentId), {
        signal: input.signal,
        maxAttempts: 1,
        timeoutMs: CANDIDATE_BOT_PROBE_TIMEOUT_MS,
      }))
    ) {
      throw new FeishuOperationError("FEISHU_RUNTIME_TOOL_UNAVAILABLE");
    }
  }

  /** Recheck the durable claim after prerequisite I/O and before opening a socket. */
  async #assertActivationClaim(input: FeishuActivationInput): Promise<void> {
    assertLiveCandidate(input, this.#now());
    const [slot] = await this.#database
      .select({ intent: imBindings.setupIntent, appId: imBindings.externalAppId })
      .from(imBindings)
      .where(
        and(
          eq(imBindings.agentId, input.agentId),
          eq(imBindings.setupAttemptId, input.attemptId),
          eq(imBindings.setupOwnerInstanceId, input.ownerInstanceId),
          eq(imBindings.setupState, "validating"),
        ),
      )
      .limit(1);
    if (!slot) throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
    assertCandidateIdentity(input, slot);
    assertLiveCandidate(input, this.#now());
  }

  async #activateAtomicAttempt(input: FeishuActivationInput): Promise<VerifiedFeishuBinding> {
    const shutdownEpoch = this.#shutdownEpoch;
    // Scopes and runtime readiness are admission conditions, not channel work: they are checked
    // against a channel-free probe so an unapproved or environment-blocked candidate never opens a
    // socket. Only after both pass is the message channel adapter created and identity-validated.
    await this.#assertActivationPrerequisites(input);
    await this.#assertActivationClaim(input);
    this.#assertActivationRunning(input, shutdownEpoch);
    const candidate = this.#createAdapter({
      appId: input.appId,
      appSecret: input.appSecret,
      teamId: null,
      teamBrand: input.teamBrand,
    });
    let handoff: { imBindingId: string; epoch: number; generation: number; appId: string } | undefined;
    let committedLease: { imBindingId: string; epoch: number } | undefined;
    const detachHandlers = this.#attachHandlers(candidate, () => handoff);
    try {
      const identity = await this.#policy.run(
        "feishu.binding.validate",
        (signal) => candidate.validateBinding(signal),
        {
          signal: input.signal,
          maxAttempts: 1,
          circuitKey: `feishu:binding:${input.appId}`,
        },
      );
      if (identity.externalAppId !== input.appId) throw new FeishuOperationError("FEISHU_APP_IDENTITY_MISMATCH");
      const grantedScopes = await this.#policy.run(
        "feishu.binding.scopes",
        () => candidate.listGrantedWorkspaceScopes(),
        {
          signal: input.signal,
          maxAttempts: 1,
          circuitKey: `feishu:binding:${input.appId}`,
        },
      );
      const missingScopes = missingRequiredScopes(grantedScopes);
      if (missingScopes.length > 0) {
        throw new FeishuOperationError("FEISHU_SCOPE_REAUTH_REQUIRED", missingScopes);
      }
      let profile: VerifiedFeishuBinding["profile"];
      try {
        const bot = await this.#policy.run("feishu.binding.profile", () => candidate.probeBotIdentity(), {
          signal: input.signal,
          maxAttempts: 1,
          timeoutMs: 10_000,
          circuitKey: `feishu:profile:${input.appId}`,
        });
        if (bot.openId === identity.externalBotId) profile = bot.profile;
        else this.#onDiagnostic("FEISHU_BOT_PROFILE_IDENTITY_MISMATCH");
      } catch {
        this.#onDiagnostic("FEISHU_BOT_PROFILE_UNAVAILABLE");
      }
      const verified: VerifiedFeishuBinding = {
        profile,
        agentId: input.agentId,
        appId: input.appId,
        teamId: identity.externalTeamId === input.appId ? null : identity.externalTeamId,
        botOpenId: identity.externalBotId,
        teamBrand: input.teamBrand,
        appSecret: input.appSecret,
        grantedScopes,
      };
      const committed = await this.#database.transaction(async (transaction) => {
        input.signal?.throwIfAborted();
        const [agent] = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.status, "active")))
          .limit(1)
          .for("update");
        if (!agent) throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
        await this.#afterActivationAgentLocked?.();
        const [slot] = await transaction
          .select({ id: imBindings.id, intent: imBindings.setupIntent, appId: imBindings.externalAppId })
          .from(imBindings)
          .where(
            and(
              eq(imBindings.setupAttemptId, input.attemptId),
              eq(imBindings.agentId, input.agentId),
              eq(imBindings.setupOwnerInstanceId, input.ownerInstanceId),
              eq(imBindings.setupState, "validating"),
            ),
          )
          .limit(1)
          .for("update");
        if (!slot) throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
        assertCandidateIdentity(input, slot);
        // The candidate retention deadline is re-checked inside the activation transaction: a
        // candidate that lapsed while provider or channel work was in flight must not activate
        // even though it was still pending on the read path. Legacy QR attempts carry no candidate
        // deadline.
        assertLiveCandidate(input, this.#now());
        input.signal?.throwIfAborted();
        const imBindingId = await this.#imBindings.activateFeishu(verified, transaction);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.#leaseMs);
        const [lease] = await transaction
          .update(imBindings)
          .set({
            connectionOwnerInstanceId: this.#instanceId,
            connectionFencingEpoch: sql`${imBindings.connectionFencingEpoch} + 1`,
            connectionLeaseExpiresAt: expiresAt,
            observedConnectedAt: now,
            observedAt: now,
            updatedAt: now,
          })
          .where(and(eq(imBindings.id, imBindingId), eq(imBindings.status, "active")))
          .returning({ epoch: imBindings.connectionFencingEpoch });
        if (!lease) throw new FeishuOperationError("FEISHU_CONNECTION_LEASE_UNAVAILABLE");
        const [completed] = await transaction
          .update(imBindings)
          .set({
            setupState: "succeeded",
            setupOwnerInstanceId: null,
            setupOwnerHeartbeatAt: null,
            encryptedSetupContext: null,
            setupExpiresAt: null,
            lastErrorCode: null,
            updatedAt: now,
          })
          .where(
            imBindingId === slot.id
              ? and(
                  eq(imBindings.id, slot.id),
                  eq(imBindings.setupAttemptId, input.attemptId),
                  eq(imBindings.setupOwnerInstanceId, input.ownerInstanceId),
                  eq(imBindings.setupState, "validating"),
                )
              : and(
                  eq(imBindings.id, slot.id),
                  eq(imBindings.status, "disabled"),
                  eq(imBindings.setupAttemptId, input.attemptId),
                  eq(imBindings.setupState, "canceled"),
                ),
          )
          .returning({ id: imBindings.id });
        if (!completed) throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
        const material = await this.#imBindings.getFeishuConnectionMaterial(imBindingId, transaction);
        if (!material) throw new FeishuOperationError("FEISHU_BINDING_NOT_ACTIVE");
        this.#assertActivationRunning(input, shutdownEpoch);
        assertLiveCandidate(input, this.#now());
        handoff = {
          imBindingId,
          epoch: lease.epoch,
          generation: material.generation,
          appId: material.appId,
        };
        return { imBindingId, epoch: lease.epoch, material };
      });
      committedLease = committed;
      this.#assertActivationRunning(input, shutdownEpoch);
      handoff = {
        imBindingId: committed.imBindingId,
        epoch: committed.epoch,
        generation: committed.material.generation,
        appId: committed.material.appId,
      };
      const next = {
        adapter: candidate,
        epoch: committed.epoch,
        generation: committed.material.generation,
        appId: committed.material.appId,
      };
      setActiveSpanAttributes(imAttrs({ provider: "feishu", bindingId: committed.imBindingId }));
      const previous = this.#owned.get(committed.imBindingId);
      // Transfer ownership synchronously after commit. Shutdown must see the channel even when
      // the following runtime notification is slow, and a pre-shutdown commit cannot install late.
      this.#owned.set(committed.imBindingId, next);
      if (previous && previous.adapter !== candidate) {
        await previous.adapter.channel
          .disconnect()
          .catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
        this.#emitDisconnected(committed.imBindingId, "FEISHU_CONNECTION_REPLACED");
      }
      await this.#imBindings.notifyProviderCliRequirementChanged(input.agentId).catch(() => undefined);
      return verified;
    } catch (error) {
      detachHandlers?.();
      await candidate.channel.disconnect().catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
      if (committedLease) {
        if (this.#owned.get(committedLease.imBindingId)?.adapter === candidate) {
          this.#owned.delete(committedLease.imBindingId);
        }
        await this.#release(committedLease.imBindingId, committedLease.epoch);
      }
      throw error;
    }
  }

  #assertActivationRunning(input: FeishuActivationInput, shutdownEpoch: number): void {
    input.signal?.throwIfAborted();
    if (shutdownEpoch !== this.#shutdownEpoch) throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
  }

  async maintain(): Promise<void> {
    if (this.#stopped || this.#maintaining) return;
    this.#maintaining = true;
    try {
      await this.#maintainOnce();
    } finally {
      this.#maintaining = false;
    }
  }

  async #maintainOnce(): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.#leaseMs);
    for (const [imBindingId, owned] of [...this.#owned]) {
      const material = await this.#imBindings.getFeishuConnectionMaterial(imBindingId);
      if (!material || material.generation !== owned.generation || material.appId !== owned.appId) {
        this.#owned.delete(imBindingId);
        await owned.adapter.channel.disconnect().catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
        this.#emitDisconnected(imBindingId, "FEISHU_BINDING_CHANGED");
        await this.#release(imBindingId, owned.epoch);
        continue;
      }
      const [renewed] = await this.#database
        .update(imBindings)
        .set({ connectionLeaseExpiresAt: expiresAt, observedAt: now })
        .where(
          and(
            eq(imBindings.id, imBindingId),
            eq(imBindings.connectionOwnerInstanceId, this.#instanceId),
            eq(imBindings.connectionFencingEpoch, owned.epoch),
            eq(imBindings.status, "active"),
          ),
        )
        .returning({ imBindingId: imBindings.id });
      if (renewed) continue;
      this.#owned.delete(imBindingId);
      await owned.adapter.channel.disconnect().catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
      this.#emitDisconnected(imBindingId, "FEISHU_CONNECTION_LEASE_LOST");
    }

    let afterId: string | undefined;
    while (!this.#stopped) {
      const candidates = await this.#imBindings.listFeishuConnectionIds(afterId, CONNECTION_SCAN_PAGE_SIZE);
      for (const imBindingId of candidates) {
        if (this.#owned.has(imBindingId)) continue;
        const nextAt = this.#maintenanceNextAt.get(imBindingId) ?? 0;
        if (nextAt > this.#now().getTime()) continue;
        const epoch = await this.#claim(imBindingId, false);
        if (epoch === undefined) continue;
        const controller = new AbortController();
        this.#maintenanceControllers.set(imBindingId, controller);
        await this.#connectClaimed(imBindingId, epoch, controller.signal)
          .then(() => {
            this.#maintenanceFailures.delete(imBindingId);
            this.#maintenanceNextAt.delete(imBindingId);
          })
          .catch(async (error) => {
            const failures = (this.#maintenanceFailures.get(imBindingId) ?? 0) + 1;
            this.#maintenanceFailures.set(imBindingId, failures);
            const delay = Math.min(this.#maintenanceBackoffMaxMs, this.#maintenanceBackoffBaseMs * 2 ** (failures - 1));
            this.#maintenanceNextAt.set(imBindingId, this.#now().getTime() + delay);
            await this.#imBindings.recordDiagnosticError(imBindingId, diagnosticCode(error));
            await this.#release(imBindingId, epoch);
          })
          .finally(() => {
            this.#maintenanceControllers.delete(imBindingId);
          });
      }
      if (candidates.length < CONNECTION_SCAN_PAGE_SIZE) break;
      afterId = candidates.at(-1);
    }
  }

  async #claim(imBindingId: string, forceTakeover: boolean): Promise<number | undefined> {
    return this.#database.transaction(async (transaction) => {
      const now = new Date();
      const [row] = await transaction
        .select()
        .from(imBindings)
        .where(eq(imBindings.id, imBindingId))
        .limit(1)
        .for("update");
      if (row?.status !== "active" || row.provider !== "feishu") return undefined;
      if (
        !forceTakeover &&
        row.connectionOwnerInstanceId !== null &&
        row.connectionLeaseExpiresAt !== null &&
        row.connectionLeaseExpiresAt > now
      ) {
        return undefined;
      }
      const [claimed] = await transaction
        .update(imBindings)
        .set({
          connectionOwnerInstanceId: this.#instanceId,
          connectionFencingEpoch: row.connectionFencingEpoch + 1,
          connectionLeaseExpiresAt: new Date(now.getTime() + this.#leaseMs),
          observedConnectedAt: null,
          observedAt: now,
        })
        .where(eq(imBindings.id, imBindingId))
        .returning({ epoch: imBindings.connectionFencingEpoch });
      return claimed?.epoch;
    });
  }

  async #connectClaimed(imBindingId: string, epoch: number, signal?: AbortSignal): Promise<void> {
    await withRootSpan(
      "feishu.connection.connect",
      imAttrs({ provider: "feishu", bindingId: imBindingId }),
      async () => {
        let adapter: FeishuAdapter | undefined;
        try {
          const material = await this.#imBindings.getFeishuConnectionMaterial(imBindingId);
          if (!material) throw new FeishuOperationError("FEISHU_BINDING_NOT_ACTIVE");
          const createdAdapter = this.#createAdapter({
            appId: material.appId,
            appSecret: material.appSecret,
            teamId: material.teamId,
            teamBrand: material.teamBrand,
          });
          adapter = createdAdapter;
          const identity = await this.#policy.run(
            "feishu.connection.validate",
            (signal) => createdAdapter.validateBinding(signal),
            {
              maxAttempts: 1,
              signal,
              circuitKey: `feishu:binding:${imBindingId}`,
            },
          );
          if (identity.externalBotId !== material.botOpenId) {
            throw new FeishuOperationError("FEISHU_BOT_IDENTITY_MISMATCH");
          }
          await this.#replaceOwned(imBindingId, {
            adapter: createdAdapter,
            epoch,
            generation: material.generation,
            appId: material.appId,
          });
          setActiveSpanAttributes(outcomeAttrs("connected"));
        } catch (error) {
          await adapter?.channel.disconnect().catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
          const code = diagnosticCode(error);
          setActiveSpanAttributes(outcomeAttrs(connectionOutcome(code), code));
          throw error;
        }
      },
    );
  }

  async #replaceOwned(imBindingId: string, next: OwnedChannel): Promise<void> {
    this.#attachHandlers(next.adapter, () => ({
      imBindingId,
      epoch: next.epoch,
      generation: next.generation,
      appId: next.appId,
    }));
    const previous = this.#owned.get(imBindingId);
    const now = new Date();
    const [observed] = await this.#database
      .update(imBindings)
      .set({ observedConnectedAt: now, observedAt: now })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.connectionOwnerInstanceId, this.#instanceId),
          eq(imBindings.connectionFencingEpoch, next.epoch),
          eq(imBindings.status, "active"),
        ),
      )
      .returning({ imBindingId: imBindings.id });
    if (!observed) throw new FeishuOperationError("FEISHU_CONNECTION_LEASE_STALE");
    this.#owned.set(imBindingId, next);
    if (previous && previous.adapter !== next.adapter) {
      await previous.adapter.channel
        .disconnect()
        .catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
      this.#emitDisconnected(imBindingId, "FEISHU_CONNECTION_REPLACED");
    }
  }

  #attachHandlers(
    adapter: FeishuAdapter,
    resolveHandoff: () => { imBindingId: string; epoch: number; generation: number; appId: string } | undefined,
  ): (() => void) | undefined {
    return adapter.channel.on({
      message: async (message: NormalizedMessage) => {
        await traceFeishuInbound(async (setFailureCode) => {
          setFailureCode("FEISHU_INBOUND_ADMISSION_FAILED");
          const handoff = resolveHandoff();
          if (!handoff) throw new FeishuOperationError("FEISHU_ADMISSION_NOT_READY");
          setActiveSpanAttributes(imAttrs({ provider: "feishu", bindingId: handoff.imBindingId }));
          setFailureCode("FEISHU_INBOUND_NORMALIZE_FAILED");
          const events = adapter.normalizeInbound({ appId: handoff.appId, teamId: null, message });
          const senderOpenId = feishuSenderOpenId(message);
          for (const event of events) {
            const result = await this.#processInboundEvent(event, handoff, setFailureCode);
            const messageId = result?.messageId;
            if (
              messageId &&
              senderOpenId &&
              event.message.author.kind === "human" &&
              !event.message.author.displayName
            ) {
              this.#trackDetached(
                "FEISHU_SENDER_NAME_ENRICHMENT_FAILED",
                this.#enrichSenderName(adapter, {
                  imBindingId: handoff.imBindingId,
                  messageId,
                  chatId: event.conversation.externalId,
                  senderOpenId,
                }),
                "provider",
                messageId,
              );
            }
          }
        });
      },
      reconnecting: () => {
        const handoff = resolveHandoff();
        if (handoff) {
          emitRootSpan("feishu.connection.transition", {
            ...imAttrs({ provider: "feishu", bindingId: handoff.imBindingId }),
            ...outcomeAttrs("reconnecting"),
          });
          this.#trackDetached(
            "FEISHU_CONNECTION_OBSERVATION_FAILED",
            this.#observeDisconnected(handoff.imBindingId, handoff.epoch),
            "socket",
            handoff.imBindingId,
          );
        }
      },
      reconnected: () => {
        const handoff = resolveHandoff();
        if (handoff) {
          emitRootSpan("feishu.connection.transition", {
            ...imAttrs({ provider: "feishu", bindingId: handoff.imBindingId }),
            ...outcomeAttrs("reconnected"),
          });
          this.#trackDetached(
            "FEISHU_CONNECTION_OBSERVATION_FAILED",
            this.#observeConnected(handoff.imBindingId, handoff.epoch),
            "socket",
            handoff.imBindingId,
          );
        }
      },
      error: (error: unknown) => {
        const handoff = resolveHandoff();
        if (handoff) {
          const code = diagnosticCode(error);
          emitRootSpan(
            "feishu.connection.error",
            {
              ...imAttrs({ provider: "feishu", bindingId: handoff.imBindingId }),
              ...outcomeAttrs("failed", code),
            },
            new Error(code),
          );
          this.#trackDetached(
            "FEISHU_CONNECTION_DIAGNOSTIC_FAILED",
            this.#imBindings.recordDiagnosticError(handoff.imBindingId, code),
            "provider",
            handoff.imBindingId,
          );
        }
      },
    });
  }

  async #processInboundEvent(
    event: Parameters<ImMessageInbox["ingest"]>[2],
    handoff: { imBindingId: string; epoch: number; generation: number; appId: string },
    setFailureCode: (
      code: "FEISHU_INBOUND_DATABASE_FAILED" | "FEISHU_INBOUND_FENCE_STALE" | "FEISHU_INBOUND_IDENTITY_MISMATCH",
    ) => void,
  ): Promise<Awaited<ReturnType<ImMessageInbox["ingest"]>> | undefined> {
    setActiveSpanAttributes(
      imAttrs({
        provider: "feishu",
        bindingId: handoff.imBindingId,
        providerEventId: event.providerEventId,
        externalMessageId: event.message.externalId,
      }),
    );
    const receiptEventId = feishuEnvelopeEventId(event);
    const receiptId = await this.#claimInboundReceipt(event, handoff, receiptEventId, setFailureCode);
    if (receiptId === null) return undefined;
    const result = await this.#persistInboundEvent(event, handoff, receiptId, setFailureCode);
    if (receiptId) await this.#receipts?.markProcessed(receiptId);
    if (result.duplicate)
      emitInboundDuplicate(handoff.imBindingId, receiptEventId ?? event.providerEventId, event.message.externalId);
    setActiveSpanAttributes({
      ...imAttrs({
        messageId: result.messageId,
        deliveryCount: result.deliveryIds.length,
        duplicate: result.duplicate,
      }),
      ...outcomeAttrs(result.duplicate ? "duplicate" : result.deliveryIds.length > 0 ? "persisted" : "no_delivery"),
    });
    return result;
  }

  async #enrichSenderName(
    adapter: FeishuAdapter,
    input: { imBindingId: string; messageId: string; chatId: string; senderOpenId: string },
  ): Promise<void> {
    const resolved = await adapter.resolveSenderName({ chatId: input.chatId, senderOpenId: input.senderOpenId });
    const displayName = resolved?.trim();
    if (!displayName) return;
    if (displayName.length > 512) throw new Error("FEISHU_SENDER_NAME_INVALID");
    await this.#database
      .update(imMessages)
      .set({ authorDisplayName: displayName })
      .where(
        and(
          eq(imMessages.id, input.messageId),
          eq(imMessages.imBindingId, input.imBindingId),
          eq(imMessages.authorExternalId, input.senderOpenId),
          isNull(imMessages.authorDisplayName),
        ),
      );
  }

  async #persistInboundEvent(
    event: Parameters<ImMessageInbox["ingest"]>[2],
    handoff: { imBindingId: string; epoch: number; generation: number; appId: string },
    receiptId: string | undefined,
    setFailureCode: (
      code: "FEISHU_INBOUND_DATABASE_FAILED" | "FEISHU_INBOUND_FENCE_STALE" | "FEISHU_INBOUND_IDENTITY_MISMATCH",
    ) => void,
  ): Promise<Awaited<ReturnType<ImMessageInbox["ingest"]>>> {
    try {
      setFailureCode("FEISHU_INBOUND_DATABASE_FAILED");
      return await this.#inbox.ingest(handoff.imBindingId, handoff.generation, event, {
        provider: "feishu",
        holderInstanceId: this.#instanceId,
        fencingEpoch: handoff.epoch,
      });
    } catch (error) {
      if (receiptId) await this.#receipts?.markFailed(receiptId, processingErrorCode(error)).catch(() => undefined);
      const code = classifyImInboundPersistenceError(error);
      setFailureCode(
        code === "IM_INBOUND_FENCE_STALE" || code === "IM_INBOUND_BINDING_STALE"
          ? "FEISHU_INBOUND_FENCE_STALE"
          : code === "IM_INBOUND_IDENTITY_MISMATCH"
            ? "FEISHU_INBOUND_IDENTITY_MISMATCH"
            : "FEISHU_INBOUND_DATABASE_FAILED",
      );
      throw error;
    }
  }

  async #claimInboundReceipt(
    event: Parameters<ImMessageInbox["ingest"]>[2],
    handoff: { imBindingId: string; epoch: number; generation: number; appId: string },
    receiptEventId: string | null,
    setFailureCode: (
      code: "FEISHU_INBOUND_DATABASE_FAILED" | "FEISHU_INBOUND_FENCE_STALE" | "FEISHU_INBOUND_IDENTITY_MISMATCH",
    ) => void,
  ): Promise<string | null | undefined> {
    if (!this.#receipts || !receiptEventId) return undefined;
    setFailureCode("FEISHU_INBOUND_DATABASE_FAILED");
    const claim = await this.#receipts.claim({
      bindingId: handoff.imBindingId,
      credentialGeneration: handoff.generation,
      eventId: receiptEventId,
    });
    if (claim.accepted && claim.receiptId) return claim.receiptId;
    emitInboundDuplicate(handoff.imBindingId, receiptEventId, event.message.externalId);
    setActiveSpanAttributes({
      ...imAttrs({ providerEventId: receiptEventId, externalMessageId: event.message.externalId, duplicate: true }),
      ...outcomeAttrs("duplicate"),
    });
    return null;
  }

  async #observeConnected(imBindingId: string, epoch: number): Promise<void> {
    const now = new Date();
    await this.#database
      .update(imBindings)
      .set({ observedConnectedAt: now, observedAt: now })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.connectionOwnerInstanceId, this.#instanceId),
          eq(imBindings.connectionFencingEpoch, epoch),
        ),
      );
  }

  async #observeDisconnected(imBindingId: string, epoch: number): Promise<void> {
    await this.#database
      .update(imBindings)
      .set({ observedConnectedAt: null, observedAt: new Date() })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.connectionOwnerInstanceId, this.#instanceId),
          eq(imBindings.connectionFencingEpoch, epoch),
        ),
      );
  }

  async #release(imBindingId: string, epoch: number): Promise<void> {
    await this.#database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: null,
        connectionLeaseExpiresAt: null,
        observedConnectedAt: null,
        observedAt: new Date(),
      })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.connectionOwnerInstanceId, this.#instanceId),
          eq(imBindings.connectionFencingEpoch, epoch),
        ),
      );
  }

  #emitDisconnected(imBindingId: string, reason: string): void {
    emitRootSpan("feishu.connection.transition", {
      ...imAttrs({ provider: "feishu", bindingId: imBindingId }),
      ...outcomeAttrs("disconnected", reason),
    });
  }

  #scheduleMaintenance(): void {
    this.#trackDetached("FEISHU_CONNECTION_MAINTENANCE_FAILED", this.maintain(), "scheduler");
  }

  #trackDetached(
    code: string,
    operation: Promise<unknown>,
    phase: "provider" | "scheduler" | "socket",
    requestId?: string,
  ): void {
    const observed = operation.catch((error: unknown) => {
      this.#onDiagnostic(code);
      throw error;
    });
    if (this.#supervisor) {
      this.#supervisor.track(observed, {
        code,
        category: phase === "provider" ? "dependency" : "internal",
        retryability: "backoff",
        phase,
        ...(requestId ? { requestId } : {}),
        operation: "feishu.connection",
      });
      return;
    }
    void observed.catch(() => undefined);
  }
}

function processingErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "FEISHU_EVENT_PROCESSING_FAILED";
}

function assertCandidateIdentity(
  input: FeishuActivationInput,
  slot: { intent: string | null; appId: string | null },
): void {
  if (slot.intent === "reauthorize" && slot.appId !== input.appId) {
    throw new FeishuOperationError("FEISHU_APP_IDENTITY_MISMATCH");
  }
}

function assertLiveCandidate(input: FeishuActivationInput, now: Date): void {
  input.signal?.throwIfAborted();
  if (input.candidateExpiresAt !== undefined && input.candidateExpiresAt <= now) {
    throw new FeishuCandidateExpiredError();
  }
}

/** The adapter's own signal that the App has no usable Bot, distinct from a transport failure. */
function isKnownBotUnavailable(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; message?: unknown };
    if (candidate.code === "FEISHU_BOT_IDENTITY_MISSING") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function emitInboundDuplicate(bindingId: string, providerEventId: string, externalMessageId: string): void {
  emitRootSpan("feishu.inbound.deduplicated", {
    ...imAttrs({
      provider: "feishu",
      bindingId,
      providerEventId,
      externalMessageId,
      duplicate: true,
    }),
    ...outcomeAttrs("duplicate"),
  });
}

function connectionOutcome(code: string): string {
  if (code.includes("STALE") || code.includes("FENCE") || code.includes("LEASE")) return "stale";
  if (code.includes("SCOPE") || code.includes("IDENTITY") || code.includes("CREDENTIAL")) {
    return "credential_failed";
  }
  return "transient_failed";
}
