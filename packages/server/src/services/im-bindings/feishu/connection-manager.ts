import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { hasRequiredFeishuTenantScopes } from "@opentag/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { agents, imBindings } from "../../../db/schema/index.js";
import type { ImMessageInbox } from "../../im/index.js";
import type { ImBindingService, VerifiedFeishuBinding } from "../im-binding-service.js";
import { FeishuAdapter } from "./adapter.js";
import type { FeishuBindingActivation } from "./setup-service.js";

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
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    if (/^FEISHU_[A-Z0-9_]{1,112}$/.test(error.code)) return error.code;
  }
  if (error instanceof Error && /^FEISHU_[A-Z0-9_]+$/.test(error.message)) return error.message.slice(0, 120);
  return "FEISHU_CONNECTION_ERROR";
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
  }) => FeishuAdapter;
  readonly #leaseMs: number;
  readonly #maintenanceMs: number;
  readonly #onDiagnostic: (code: string) => void;
  readonly #runtimeReady: (agentId: string) => Promise<boolean>;
  readonly #afterActivationAgentLocked: (() => Promise<void>) | undefined;
  readonly #owned = new Map<string, OwnedChannel>();
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
    }) => FeishuAdapter;
    leaseMs?: number;
    maintenanceMs?: number;
    runtimeReady?: (agentId: string) => Promise<boolean> | boolean;
    onDiagnostic?: (code: string) => void;
    afterActivationAgentLocked?: () => Promise<void>;
  }) {
    this.#database = input.database;
    this.#inbox = input.inbox;
    this.#instanceId = input.instanceId;
    this.#imBindings = input.imBindings;
    this.#createAdapter = input.createAdapter ?? ((options) => new FeishuAdapter(options));
    this.#leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maintenanceMs = input.maintenanceMs ?? DEFAULT_MAINTENANCE_MS;
    this.#runtimeReady = async (agentId) => (await input.runtimeReady?.(agentId)) ?? true;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
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
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const owned = [...this.#owned.values()];
    this.#owned.clear();
    await Promise.allSettled(owned.map((entry) => entry.adapter.channel.disconnect()));
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

  async activateAtomicAttempt(input: {
    attemptId: string;
    ownerInstanceId: string;
    agentId: string;
    appId: string;
    appSecret: string;
    teamBrand?: "feishu" | "lark";
  }): Promise<VerifiedFeishuBinding> {
    const candidate = this.#createAdapter({
      appId: input.appId,
      appSecret: input.appSecret,
      teamId: null,
      teamBrand: input.teamBrand,
    });
    let handoff: { imBindingId: string; epoch: number; generation: number; appId: string } | undefined;
    const detachHandlers = this.#attachHandlers(candidate, () => handoff);
    try {
      const identity = await candidate.validateBinding();
      if (identity.externalAppId !== input.appId) throw new Error("FEISHU_APP_IDENTITY_MISMATCH");
      const grantedScopes = await candidate.listGrantedTeamScopes();
      if (!hasRequiredFeishuTenantScopes(grantedScopes)) {
        throw new Error("FEISHU_SCOPE_REAUTH_REQUIRED");
      }
      if (!(await this.#runtimeReady(input.agentId))) throw new Error("FEISHU_RUNTIME_TOOL_UNAVAILABLE");
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
          .where(eq(agents.id, input.agentId))
          .limit(1)
          .for("update");
        if (!agent) throw new Error("FEISHU_SETUP_FENCE_STALE");
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
        if (!slot) throw new Error("FEISHU_SETUP_FENCE_STALE");
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
        if (!lease) throw new Error("FEISHU_CONNECTION_LEASE_UNAVAILABLE");
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
        if (!completed) throw new Error("FEISHU_SETUP_FENCE_STALE");
        const material = await this.#imBindings.getFeishuConnectionMaterial(imBindingId, transaction);
        if (!material) throw new Error("FEISHU_BINDING_NOT_ACTIVE");
        handoff = { imBindingId, epoch: lease.epoch, generation: material.generation, appId: material.appId };
        return { imBindingId, epoch: lease.epoch, material };
      });
      const next = {
        adapter: candidate,
        epoch: committed.epoch,
        generation: committed.material.generation,
        appId: committed.material.appId,
      };
      const previous = this.#owned.get(committed.imBindingId);
      this.#owned.set(committed.imBindingId, next);
      if (previous && previous.adapter !== candidate) {
        await previous.adapter.channel
          .disconnect()
          .catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
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
    }

    let afterId: string | undefined;
    while (!this.#stopped) {
      const candidates = await this.#imBindings.listFeishuConnectionIds(afterId, CONNECTION_SCAN_PAGE_SIZE);
      for (const imBindingId of candidates) {
        if (this.#owned.has(imBindingId)) continue;
        const epoch = await this.#claim(imBindingId, false);
        if (epoch === undefined) continue;
        await this.#connectClaimed(imBindingId, epoch).catch(async (error) => {
          await this.#imBindings.recordDiagnosticError(imBindingId, diagnosticCode(error));
          await this.#release(imBindingId, epoch);
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

  async #connectClaimed(imBindingId: string, epoch: number): Promise<void> {
    const material = await this.#imBindings.getFeishuConnectionMaterial(imBindingId);
    if (!material) throw new Error("FEISHU_BINDING_NOT_ACTIVE");
    const adapter = this.#createAdapter({
      appId: material.appId,
      appSecret: material.appSecret,
      teamId: material.teamId,
      teamBrand: material.teamBrand,
    });
    const identity = await adapter.validateBinding();
    if (identity.externalBotId !== material.botOpenId) throw new Error("FEISHU_BOT_IDENTITY_MISMATCH");
    await this.#replaceOwned(imBindingId, {
      adapter,
      epoch,
      generation: material.generation,
      appId: material.appId,
    });
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
    if (!observed) throw new Error("FEISHU_CONNECTION_LEASE_STALE");
    this.#owned.set(imBindingId, next);
    if (previous && previous.adapter !== next.adapter) {
      await previous.adapter.channel
        .disconnect()
        .catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DISCONNECT_FAILED"));
    }
  }

  #attachHandlers(
    adapter: FeishuAdapter,
    resolveHandoff: () => { imBindingId: string; epoch: number; generation: number; appId: string } | undefined,
  ): (() => void) | undefined {
    return adapter.channel.on({
      message: async (message: NormalizedMessage) => {
        const handoff = resolveHandoff();
        if (!handoff) throw new Error("FEISHU_ADMISSION_NOT_READY");
        const events = adapter.normalizeInbound({ appId: handoff.appId, teamId: null, message });
        for (const event of events) {
          await this.#inbox.ingest(handoff.imBindingId, handoff.generation, event, {
            provider: "feishu",
            holderInstanceId: this.#instanceId,
            fencingEpoch: handoff.epoch,
          });
        }
      },
      reconnecting: () => {
        const handoff = resolveHandoff();
        if (handoff) {
          void this.#observeDisconnected(handoff.imBindingId, handoff.epoch).catch(() =>
            this.#onDiagnostic("FEISHU_CONNECTION_OBSERVATION_FAILED"),
          );
        }
      },
      reconnected: () => {
        const handoff = resolveHandoff();
        if (handoff) {
          void this.#observeConnected(handoff.imBindingId, handoff.epoch).catch(() =>
            this.#onDiagnostic("FEISHU_CONNECTION_OBSERVATION_FAILED"),
          );
        }
      },
      error: (error: unknown) => {
        const handoff = resolveHandoff();
        if (handoff) {
          void this.#imBindings
            .recordDiagnosticError(handoff.imBindingId, diagnosticCode(error))
            .catch(() => this.#onDiagnostic("FEISHU_CONNECTION_DIAGNOSTIC_FAILED"));
        }
      },
    });
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

  #scheduleMaintenance(): void {
    void this.maintain().catch(() => this.#onDiagnostic("FEISHU_CONNECTION_MAINTENANCE_FAILED"));
  }
}
