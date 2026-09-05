import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { hasRequiredFeishuTenantScopes } from "@opentag/shared";
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
import { FeishuAdapter, feishuEnvelopeEventId, feishuSenderOpenId } from "./adapter.js";
import { FeishuOperationError, safeFeishuConnectionErrorCode } from "./errors.js";
import type { FeishuInboundReceiptStore } from "./inbound-receipt-store.js";
import type { FeishuBindingActivation } from "./setup-service.js";

type FeishuActivationInput = Parameters<FeishuBindingActivation["activateAtomicAttempt"]>[0];
type FeishuInboundReceiptStoreLike = Pick<FeishuInboundReceiptStore, "claim" | "markProcessed" | "markFailed">;

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAINTENANCE_MS = 10_000;
const CONNECTION_SCAN_PAGE_SIZE = 100;

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

  async #activateAtomicAttempt(input: FeishuActivationInput): Promise<VerifiedFeishuBinding> {
    const candidate = this.#createAdapter({
      appId: input.appId,
      appSecret: input.appSecret,
      teamId: null,
      teamBrand: input.teamBrand,
    });
    let handoff: { imBindingId: string; epoch: number; generation: number; appId: string } | undefined;
    const detachHandlers = this.#attachHandlers(candidate, () => handoff);
    try {
      const identity = await this.#policy.run("feishu.binding.validate", () => candidate.validateBinding(), {
        maxAttempts: 1,
        circuitKey: `feishu:binding:${input.appId}`,
      });
      if (identity.externalAppId !== input.appId) throw new FeishuOperationError("FEISHU_APP_IDENTITY_MISMATCH");
      const grantedScopes = await this.#policy.run(
        "feishu.binding.scopes",
        () => candidate.listGrantedWorkspaceScopes(),
        {
          maxAttempts: 1,
          circuitKey: `feishu:binding:${input.appId}`,
        },
      );
      if (!hasRequiredFeishuTenantScopes(grantedScopes)) {
        throw new FeishuOperationError("FEISHU_SCOPE_REAUTH_REQUIRED");
      }
      if (!(await this.#runtimeReady(input.agentId))) {
        throw new FeishuOperationError("FEISHU_RUNTIME_TOOL_UNAVAILABLE");
      }
      const verified: VerifiedFeishuBinding = {
        agentId: input.agentId,
        appId: input.appId,
        teamId: identity.externalTeamId === input.appId ? null : identity.externalTeamId,
        botOpenId: identity.externalBotId,
        teamBrand: input.teamBrand,
        appSecret: input.appSecret,
        grantedScopes,
      };
      const committed = await this.#database.transaction(async (transaction) => {
        const [agent] = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.status, "active")))
          .limit(1)
          .for("update");
        if (!agent) throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
        await this.#afterActivationAgentLocked?.();
        const [slot] = await transaction
          .select({ id: imBindings.id })
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
                  eq(imBindings.setupState, "validating"),
                ),
          )
          .returning({ id: imBindings.id });
        if (!completed) throw new FeishuOperationError("FEISHU_SETUP_FENCE_STALE");
        const material = await this.#imBindings.getFeishuConnectionMaterial(imBindingId, transaction);
        if (!material) throw new FeishuOperationError("FEISHU_BINDING_NOT_ACTIVE");
        handoff = {
          imBindingId,
          epoch: lease.epoch,
          generation: material.generation,
          appId: material.appId,
        };
        return { imBindingId, epoch: lease.epoch, material };
      });
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
      await this.#imBindings.notifyProviderCliRequirementChanged(input.agentId).catch(() => undefined);
      setActiveSpanAttributes(imAttrs({ provider: "feishu", bindingId: committed.imBindingId }));
      const previous = this.#owned.get(committed.imBindingId);
      this.#owned.set(committed.imBindingId, next);
      if (previous && previous.adapter !== candidate) {
        await previous.adapter.channel
          .disconnect()
          .catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
        this.#emitDisconnected(committed.imBindingId, "FEISHU_CONNECTION_REPLACED");
      }
      return verified;
    } catch (error) {
      detachHandlers?.();
      await candidate.channel.disconnect().catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
      throw error;
    }
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
            () => createdAdapter.validateBinding(),
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
