import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { and, eq, lt, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { feishuConnectionLeases, feishuSetupAttempts } from "../../../db/schema/index.js";
import type { ImMessageInbox } from "../../im/index.js";
import type { IntegrationService, VerifiedFeishuBinding } from "../integration-service.js";
import type { ImProviderAdapter } from "../provider-adapter.js";
import { FeishuAdapter } from "./adapter.js";
import type { FeishuBindingActivation } from "./setup-service.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAINTENANCE_MS = 10_000;

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

/**
 * Owns Feishu Channel resources behind a database lease. Provider callbacks
 * re-check the epoch before durable admission, so a stale process cannot
 * continue routing after another replica takes over.
 */
export class FeishuConnectionManager implements FeishuBindingActivation {
  readonly #database: DatabaseClient;
  readonly #inbox: ImMessageInbox;
  readonly #instanceId: string;
  readonly #integrations: IntegrationService;
  readonly #createAdapter: (input: {
    appId: string;
    appSecret: string;
    tenantKey: string | null;
    tenantBrand?: "feishu" | "lark" | null;
  }) => FeishuAdapter;
  readonly #leaseMs: number;
  readonly #maintenanceMs: number;
  readonly #runtimeReady: (agentId: string) => Promise<boolean>;
  readonly #owned = new Map<string, OwnedChannel>();
  #maintaining = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = true;

  constructor(input: {
    database: DatabaseClient;
    inbox: ImMessageInbox;
    instanceId: string;
    integrations: IntegrationService;
    createAdapter?: (input: {
      appId: string;
      appSecret: string;
      tenantKey: string | null;
      tenantBrand?: "feishu" | "lark" | null;
    }) => FeishuAdapter;
    leaseMs?: number;
    maintenanceMs?: number;
    runtimeReady?: (agentId: string) => Promise<boolean> | boolean;
  }) {
    this.#database = input.database;
    this.#inbox = input.inbox;
    this.#instanceId = input.instanceId;
    this.#integrations = input.integrations;
    this.#createAdapter = input.createAdapter ?? ((options) => new FeishuAdapter(options));
    this.#leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maintenanceMs = input.maintenanceMs ?? DEFAULT_MAINTENANCE_MS;
    this.#runtimeReady = async (agentId) => (await input.runtimeReady?.(agentId)) ?? true;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.maintain().catch(() => undefined);
    this.#timer = setInterval(() => void this.maintain().catch(() => undefined), this.#maintenanceMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const owned = [...this.#owned.values()];
    this.#owned.clear();
    await Promise.allSettled(owned.map((entry) => entry.adapter.channel.disconnect()));
    await this.#database
      .delete(feishuConnectionLeases)
      .where(eq(feishuConnectionLeases.holderInstanceId, this.#instanceId));
  }

  async activateAtomicAttempt(input: {
    attemptId: string;
    ownerInstanceId: string;
    agentId: string;
    appId: string;
    appSecret: string;
    tenantBrand?: "feishu" | "lark";
    requestedScopes: string[];
  }): Promise<VerifiedFeishuBinding> {
    const candidate = this.#createAdapter({
      appId: input.appId,
      appSecret: input.appSecret,
      tenantKey: null,
      tenantBrand: input.tenantBrand,
    });
    let handoff: { integrationId: string; epoch: number; generation: number; appId: string } | undefined;
    const detachHandlers = this.#attachHandlers(candidate, () => handoff);
    try {
      const identity = await candidate.validateBinding();
      if (identity.externalAppId !== input.appId) throw new Error("FEISHU_APP_IDENTITY_MISMATCH");
      const grantedScopes = await candidate.listGrantedTenantScopes();
      if (input.requestedScopes.some((scope) => !grantedScopes.includes(scope))) {
        throw new Error("FEISHU_SCOPE_REAUTH_REQUIRED");
      }
      if (!(await this.#runtimeReady(input.agentId))) throw new Error("FEISHU_RUNTIME_TOOL_UNAVAILABLE");
      const verified: VerifiedFeishuBinding = {
        agentId: input.agentId,
        appId: input.appId,
        tenantKey: null,
        botOpenId: identity.externalBotId,
        tenantBrand: input.tenantBrand,
        appSecret: input.appSecret,
        grantedScopes,
      };
      const committed = await this.#database.transaction(async (transaction) => {
        const [attempt] = await transaction
          .select({ id: feishuSetupAttempts.id })
          .from(feishuSetupAttempts)
          .where(
            and(
              eq(feishuSetupAttempts.id, input.attemptId),
              eq(feishuSetupAttempts.agentId, input.agentId),
              eq(feishuSetupAttempts.ownerInstanceId, input.ownerInstanceId),
              eq(feishuSetupAttempts.state, "validating"),
            ),
          )
          .limit(1)
          .for("update");
        if (!attempt) throw new Error("FEISHU_SETUP_FENCE_STALE");
        const integrationId = await this.#integrations.activateFeishu(verified, transaction);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.#leaseMs);
        const [lease] = await transaction
          .insert(feishuConnectionLeases)
          .values({
            integrationId,
            holderInstanceId: this.#instanceId,
            fencingEpoch: 1,
            expiresAt,
            observedConnectedAt: now,
            observedAt: now,
          })
          .onConflictDoUpdate({
            target: feishuConnectionLeases.integrationId,
            set: {
              holderInstanceId: this.#instanceId,
              fencingEpoch: sql`${feishuConnectionLeases.fencingEpoch} + 1`,
              expiresAt,
              observedConnectedAt: now,
              observedAt: now,
            },
          })
          .returning({ epoch: feishuConnectionLeases.fencingEpoch });
        if (!lease) throw new Error("FEISHU_CONNECTION_LEASE_UNAVAILABLE");
        const [completed] = await transaction
          .update(feishuSetupAttempts)
          .set({ state: "succeeded", errorCode: null, completedAt: now })
          .where(
            and(
              eq(feishuSetupAttempts.id, input.attemptId),
              eq(feishuSetupAttempts.ownerInstanceId, input.ownerInstanceId),
              eq(feishuSetupAttempts.state, "validating"),
            ),
          )
          .returning({ id: feishuSetupAttempts.id });
        if (!completed) throw new Error("FEISHU_SETUP_FENCE_STALE");
        const material = await this.#integrations.getFeishuConnectionMaterial(integrationId, transaction);
        if (!material) throw new Error("FEISHU_BINDING_NOT_ACTIVE");
        handoff = {
          integrationId,
          epoch: lease.epoch,
          generation: material.generation,
          appId: material.appId,
        };
        return { integrationId, epoch: lease.epoch, material };
      });
      const next = {
        adapter: candidate,
        epoch: committed.epoch,
        generation: committed.material.generation,
        appId: committed.material.appId,
      };
      const previous = this.#owned.get(committed.integrationId);
      this.#owned.set(committed.integrationId, next);
      if (previous && previous.adapter !== candidate) {
        await previous.adapter.channel.disconnect().catch(() => undefined);
      }
      return verified;
    } catch (error) {
      detachHandlers?.();
      await candidate.channel.disconnect().catch(() => undefined);
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
    for (const [integrationId, owned] of [...this.#owned]) {
      const material = await this.#integrations.getFeishuConnectionMaterial(integrationId);
      if (!material || material.generation !== owned.generation || material.appId !== owned.appId) {
        this.#owned.delete(integrationId);
        await owned.adapter.channel.disconnect().catch(() => undefined);
        await this.#release(integrationId, owned.epoch);
        continue;
      }
      const [renewed] = await this.#database
        .update(feishuConnectionLeases)
        .set({ expiresAt, observedAt: now })
        .where(
          and(
            eq(feishuConnectionLeases.integrationId, integrationId),
            eq(feishuConnectionLeases.holderInstanceId, this.#instanceId),
            eq(feishuConnectionLeases.fencingEpoch, owned.epoch),
          ),
        )
        .returning({ integrationId: feishuConnectionLeases.integrationId });
      if (renewed) continue;
      this.#owned.delete(integrationId);
      await owned.adapter.channel.disconnect().catch(() => undefined);
    }

    const candidates = await this.#integrations.listFeishuConnectionIds();
    for (const integrationId of candidates) {
      if (this.#owned.has(integrationId)) continue;
      const epoch = await this.#claim(integrationId, false);
      if (epoch === undefined) continue;
      await this.#connectClaimed(integrationId, epoch).catch(async (error) => {
        await this.#integrations.recordDiagnosticError(integrationId, diagnosticCode(error));
        await this.#release(integrationId, epoch);
      });
    }
  }

  async resolveAdapter(integrationId: string, generation: number): Promise<ImProviderAdapter<unknown>> {
    const owned = this.#owned.get(integrationId);
    if (!owned || owned.generation !== generation) throw new Error("FEISHU_CONNECTION_NOT_OWNED");
    await this.#assertLease(integrationId, owned.epoch);
    return owned.adapter as ImProviderAdapter<unknown>;
  }

  async #claim(integrationId: string, forceTakeover: boolean): Promise<number | undefined> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.#leaseMs);
    const [claimed] = await this.#database
      .insert(feishuConnectionLeases)
      .values({
        integrationId,
        holderInstanceId: this.#instanceId,
        fencingEpoch: 1,
        expiresAt,
        observedConnectedAt: null,
        observedAt: now,
      })
      .onConflictDoUpdate({
        target: feishuConnectionLeases.integrationId,
        set: {
          holderInstanceId: this.#instanceId,
          fencingEpoch: sql`${feishuConnectionLeases.fencingEpoch} + 1`,
          expiresAt,
          observedConnectedAt: null,
          observedAt: now,
        },
        setWhere: forceTakeover ? undefined : lt(feishuConnectionLeases.expiresAt, now),
      })
      .returning({ epoch: feishuConnectionLeases.fencingEpoch });
    return claimed?.epoch;
  }

  async #connectClaimed(integrationId: string, epoch: number): Promise<void> {
    const material = await this.#integrations.getFeishuConnectionMaterial(integrationId);
    if (!material) throw new Error("FEISHU_BINDING_NOT_ACTIVE");
    const adapter = this.#createAdapter({
      appId: material.appId,
      appSecret: material.appSecret,
      tenantKey: material.tenantKey,
      tenantBrand: material.tenantBrand,
    });
    const identity = await adapter.validateBinding();
    if (identity.externalBotId !== material.botOpenId) throw new Error("FEISHU_BOT_IDENTITY_MISMATCH");
    await this.#replaceOwned(integrationId, {
      adapter,
      epoch,
      generation: material.generation,
      appId: material.appId,
    });
  }

  async #replaceOwned(integrationId: string, next: OwnedChannel): Promise<void> {
    this.#attachHandlers(next.adapter, () => ({
      integrationId,
      epoch: next.epoch,
      generation: next.generation,
      appId: next.appId,
    }));
    const previous = this.#owned.get(integrationId);
    const now = new Date();
    const [observed] = await this.#database
      .update(feishuConnectionLeases)
      .set({ observedConnectedAt: now, observedAt: now })
      .where(
        and(
          eq(feishuConnectionLeases.integrationId, integrationId),
          eq(feishuConnectionLeases.holderInstanceId, this.#instanceId),
          eq(feishuConnectionLeases.fencingEpoch, next.epoch),
        ),
      )
      .returning({ integrationId: feishuConnectionLeases.integrationId });
    if (!observed) throw new Error("FEISHU_CONNECTION_LEASE_STALE");
    this.#owned.set(integrationId, next);
    if (previous && previous.adapter !== next.adapter) {
      await previous.adapter.channel.disconnect().catch(() => undefined);
    }
  }

  #attachHandlers(
    adapter: FeishuAdapter,
    resolveHandoff: () => { integrationId: string; epoch: number; generation: number; appId: string } | undefined,
  ): (() => void) | undefined {
    return adapter.channel.on({
      message: async (message: NormalizedMessage) => {
        const handoff = resolveHandoff();
        if (!handoff) throw new Error("FEISHU_ADMISSION_NOT_READY");
        const events = adapter.normalizeInbound({ appId: handoff.appId, tenantKey: null, message });
        for (const event of events) {
          await this.#inbox.ingest(handoff.integrationId, handoff.generation, event, {
            provider: "feishu",
            holderInstanceId: this.#instanceId,
            fencingEpoch: handoff.epoch,
          });
        }
      },
      reconnecting: () => {
        const handoff = resolveHandoff();
        if (handoff) void this.#observeDisconnected(handoff.integrationId, handoff.epoch);
      },
      reconnected: () => {
        const handoff = resolveHandoff();
        if (handoff) void this.#observeConnected(handoff.integrationId, handoff.epoch);
      },
      error: (error: unknown) => {
        const handoff = resolveHandoff();
        if (handoff) void this.#integrations.recordDiagnosticError(handoff.integrationId, diagnosticCode(error));
      },
    });
  }

  async #assertLease(integrationId: string, epoch: number): Promise<void> {
    const [lease] = await this.#database
      .select({ integrationId: feishuConnectionLeases.integrationId })
      .from(feishuConnectionLeases)
      .where(
        and(
          eq(feishuConnectionLeases.integrationId, integrationId),
          eq(feishuConnectionLeases.holderInstanceId, this.#instanceId),
          eq(feishuConnectionLeases.fencingEpoch, epoch),
          sql`${feishuConnectionLeases.expiresAt} > now()`,
        ),
      )
      .limit(1);
    if (!lease) throw new Error("FEISHU_CONNECTION_LEASE_STALE");
  }

  async #observeConnected(integrationId: string, epoch: number): Promise<void> {
    const now = new Date();
    await this.#database
      .update(feishuConnectionLeases)
      .set({ observedConnectedAt: now, observedAt: now })
      .where(
        and(
          eq(feishuConnectionLeases.integrationId, integrationId),
          eq(feishuConnectionLeases.holderInstanceId, this.#instanceId),
          eq(feishuConnectionLeases.fencingEpoch, epoch),
        ),
      );
  }

  async #observeDisconnected(integrationId: string, epoch: number): Promise<void> {
    await this.#database
      .update(feishuConnectionLeases)
      .set({ observedConnectedAt: null, observedAt: new Date() })
      .where(
        and(
          eq(feishuConnectionLeases.integrationId, integrationId),
          eq(feishuConnectionLeases.holderInstanceId, this.#instanceId),
          eq(feishuConnectionLeases.fencingEpoch, epoch),
        ),
      );
  }

  async #release(integrationId: string, epoch: number): Promise<void> {
    await this.#database
      .delete(feishuConnectionLeases)
      .where(
        and(
          eq(feishuConnectionLeases.integrationId, integrationId),
          eq(feishuConnectionLeases.holderInstanceId, this.#instanceId),
          eq(feishuConnectionLeases.fencingEpoch, epoch),
        ),
      );
  }
}
