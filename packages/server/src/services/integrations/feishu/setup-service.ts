import { randomUUID } from "node:crypto";
import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { agents, integrations } from "../../../db/schema/index.js";
import type { ApplicationCipher } from "../../crypto.js";
import type { IntegrationService, VerifiedFeishuBinding } from "../integration-service.js";
import type { FeishuAppProfile, FeishuRegistration, FeishuRegistrationGateway } from "./registration.js";

export interface FeishuBindingActivation {
  activateAtomicAttempt(input: {
    attemptId: string;
    ownerInstanceId: string;
    agentId: string;
    appId: string;
    appSecret: string;
    teamBrand?: "feishu" | "lark";
    requestedScopes: string[];
  }): Promise<VerifiedFeishuBinding>;
}

interface AttemptSecret {
  qrUrl: string;
}

const OWNER_HEARTBEAT_MS = 5_000;
const OWNER_STALE_MS = 15_000;

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    if (error.code === "access_denied") return "FEISHU_SETUP_DENIED";
    if (error.code === "expired_token") return "FEISHU_SETUP_EXPIRED";
    if (error.code === "abort") return "FEISHU_SETUP_CANCELED";
  }
  if (error instanceof Error && /^FEISHU_[A-Z0-9_]+$/.test(error.message)) return error.message.slice(0, 120);
  return "FEISHU_SETUP_FAILED";
}

export class FeishuSetupService {
  readonly #activation: FeishuBindingActivation;
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #instanceId: string;
  readonly #integrations: IntegrationService;
  readonly #onDiagnostic: (code: string) => void;
  readonly #registrations: FeishuRegistrationGateway;
  readonly #running = new Map<string, FeishuRegistration>();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(input: {
    database: DatabaseClient;
    cipher: ApplicationCipher;
    instanceId: string;
    integrations: IntegrationService;
    registrations: FeishuRegistrationGateway;
    activation: FeishuBindingActivation;
    onDiagnostic?: (code: string) => void;
  }) {
    this.#database = input.database;
    this.#cipher = input.cipher;
    this.#instanceId = input.instanceId;
    this.#integrations = input.integrations;
    this.#registrations = input.registrations;
    this.#activation = input.activation;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
  }

  start(): void {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat().catch(() => this.#onDiagnostic("FEISHU_SETUP_HEARTBEAT_FAILED"));
    }, OWNER_HEARTBEAT_MS);
    this.#heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    const now = new Date();
    await this.#database
      .update(integrations)
      .set({
        setupState: "failed",
        lastErrorCode: "FEISHU_SETUP_OWNER_RESTARTED",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(integrations.setupOwnerInstanceId, this.#instanceId),
          inArray(integrations.setupState, ["awaiting_user", "validating"]),
        ),
      );
    for (const registration of this.#running.values()) registration.abort();
    this.#running.clear();
  }

  async createOrReuse(callerUserId: string, agentId: string, intent: FeishuSetupIntent): Promise<FeishuSetupAttempt> {
    await this.#integrations.assertCanManage(callerUserId, agentId);
    const current = await this.#currentForAgent(agentId);
    if (current?.setupAttemptId && current.setupState && ["awaiting_user", "validating"].includes(current.setupState)) {
      if (
        (current.setupOwnerInstanceId === this.#instanceId && !this.#running.has(current.setupAttemptId)) ||
        !current.setupOwnerHeartbeatAt ||
        current.setupOwnerHeartbeatAt.getTime() < Date.now() - OWNER_STALE_MS
      ) {
        await this.#failOwnedSlot(
          current.id,
          current.setupAttemptId,
          current.setupOwnerInstanceId,
          "FEISHU_SETUP_OWNER_RESTARTED",
        );
      } else {
        return this.#toAttempt(current);
      }
    }

    const [agent] = await this.#database
      .select({ displayName: agents.displayName, receiveMode: agents.receiveMode })
      .from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const existing = await this.#currentForAgent(agentId);
    if (intent === "create" && existing && existing.status !== "provisioning") {
      throw new Error("FEISHU_INTEGRATION_ALREADY_EXISTS");
    }
    if (intent === "reauthorize" && (existing?.provider !== "feishu" || !existing.externalAppId)) {
      throw new Error("FEISHU_REAUTHORIZATION_REQUIRES_BINDING");
    }
    if (intent === "replace" && (existing?.provider !== "feishu" || existing.status === "provisioning")) {
      throw new Error("FEISHU_REPLACEMENT_REQUIRES_BINDING");
    }
    const profile: FeishuAppProfile = {
      name: agent.displayName,
      description: `OpenTag Agent: ${agent.displayName}`,
    };
    const registration = this.#registrations.start({
      profile,
      intent,
      existingAppId: intent === "reauthorize" ? (existing?.externalAppId ?? undefined) : undefined,
      receiveMode: agent.receiveMode,
    });
    let qr: Awaited<FeishuRegistration["qrReady"]>;
    try {
      qr = await registration.qrReady;
    } catch (error) {
      void registration.result.catch(() => undefined);
      registration.abort();
      throw error;
    }

    const attemptId = randomUUID();
    const now = new Date();
    let row: typeof integrations.$inferSelect | undefined;
    try {
      if (existing) {
        [row] = await this.#database
          .update(integrations)
          .set({
            setupAttemptId: attemptId,
            setupIntent: intent,
            setupState: "awaiting_user",
            setupOwnerInstanceId: this.#instanceId,
            setupOwnerHeartbeatAt: now,
            encryptedSetupContext: this.#cipher.encrypt(JSON.stringify({ qrUrl: qr.url } satisfies AttemptSecret)),
            setupExpiresAt: qr.expiresAt,
            lastErrorCode: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(integrations.id, existing.id),
              ne(integrations.status, "disabled"),
              isNull(integrations.setupOwnerInstanceId),
            ),
          )
          .returning();
      } else {
        [row] = await this.#database
          .insert(integrations)
          .values({
            agentId,
            provider: "feishu",
            status: "provisioning",
            setupAttemptId: attemptId,
            setupIntent: intent,
            setupState: "awaiting_user",
            setupOwnerInstanceId: this.#instanceId,
            setupOwnerHeartbeatAt: now,
            encryptedSetupContext: this.#cipher.encrypt(JSON.stringify({ qrUrl: qr.url } satisfies AttemptSecret)),
            setupExpiresAt: qr.expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
      }
    } catch (error) {
      void registration.result.catch(() => undefined);
      registration.abort();
      const concurrent = await this.#currentForAgent(agentId);
      if (concurrent?.setupAttemptId && ["awaiting_user", "validating"].includes(concurrent.setupState ?? "")) {
        return this.#toAttempt(concurrent);
      }
      throw error;
    }
    if (!row) {
      void registration.result.catch(() => undefined);
      registration.abort();
      const concurrent = await this.#currentForAgent(agentId);
      if (concurrent?.setupAttemptId && ["awaiting_user", "validating"].includes(concurrent.setupState ?? "")) {
        return this.#toAttempt(concurrent);
      }
      throw new Error("Feishu setup slot admission did not converge");
    }
    this.#running.set(attemptId, registration);
    void this.#complete(attemptId, agentId, registration).catch(() =>
      this.#onDiagnostic("FEISHU_SETUP_COMPLETION_FAILED"),
    );
    return this.#toAttempt(row);
  }

  async get(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const row = await this.#load(attemptId);
    if (!row) throw new Error("FEISHU_SETUP_NOT_FOUND");
    await this.#integrations.assertCanManage(callerUserId, row.agentId);
    let current = row;
    if (
      current.setupState &&
      ["awaiting_user", "validating"].includes(current.setupState) &&
      ((current.setupOwnerInstanceId === this.#instanceId && !this.#running.has(attemptId)) ||
        !current.setupOwnerHeartbeatAt ||
        current.setupOwnerHeartbeatAt.getTime() < Date.now() - OWNER_STALE_MS)
    ) {
      await this.#failOwnedSlot(current.id, attemptId, current.setupOwnerInstanceId, "FEISHU_SETUP_OWNER_RESTARTED");
      current = (await this.#load(attemptId)) ?? current;
    }
    if (current.setupState === "awaiting_user" && current.setupExpiresAt && current.setupExpiresAt <= new Date()) {
      const [expired] = await this.#database
        .update(integrations)
        .set({
          setupState: "expired",
          lastErrorCode: "FEISHU_SETUP_EXPIRED",
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          encryptedSetupContext: null,
          setupExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrations.id, current.id),
            eq(integrations.setupAttemptId, attemptId),
            eq(integrations.setupState, "awaiting_user"),
          ),
        )
        .returning();
      if (expired) current = expired;
    }
    return this.#toAttempt(current);
  }

  async cancel(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const attempt = await this.get(callerUserId, attemptId);
    const now = new Date();
    const [canceled] = await this.#database
      .update(integrations)
      .set({
        setupState: "canceled",
        lastErrorCode: "FEISHU_SETUP_CANCELED",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(integrations.setupAttemptId, attemptId), eq(integrations.setupState, "awaiting_user")))
      .returning();
    if (canceled) this.#running.get(attemptId)?.abort();
    return canceled ? this.#toAttempt(canceled) : attempt;
  }

  async #complete(attemptId: string, agentId: string, registration: FeishuRegistration): Promise<void> {
    try {
      const result = await registration.result;
      const [claimed] = await this.#database
        .update(integrations)
        .set({ setupState: "validating", updatedAt: new Date() })
        .where(
          and(
            eq(integrations.setupAttemptId, attemptId),
            eq(integrations.agentId, agentId),
            eq(integrations.setupState, "awaiting_user"),
            eq(integrations.setupOwnerInstanceId, this.#instanceId),
          ),
        )
        .returning({ id: integrations.id });
      if (!claimed) return;
      await this.#activation.activateAtomicAttempt({
        attemptId,
        ownerInstanceId: this.#instanceId,
        agentId,
        appId: result.appId,
        appSecret: result.appSecret,
        teamBrand: result.teamBrand,
        requestedScopes: result.requestedScopes,
      });
    } catch (error) {
      const code = errorCode(error);
      const state =
        code === "FEISHU_SETUP_EXPIRED" ? "expired" : code === "FEISHU_SETUP_CANCELED" ? "canceled" : "failed";
      try {
        await this.#database
          .update(integrations)
          .set({
            setupState: state,
            lastErrorCode: code,
            setupOwnerInstanceId: null,
            setupOwnerHeartbeatAt: null,
            encryptedSetupContext: null,
            setupExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(integrations.setupAttemptId, attemptId),
              inArray(integrations.setupState, ["awaiting_user", "validating"]),
            ),
          );
      } catch {
        this.#onDiagnostic("FEISHU_SETUP_FAILURE_STATE_WRITE_FAILED");
      }
    } finally {
      this.#running.delete(attemptId);
    }
  }

  async #heartbeat(): Promise<void> {
    if (this.#running.size === 0) return;
    await this.#database
      .update(integrations)
      .set({ setupOwnerHeartbeatAt: new Date() })
      .where(
        and(
          eq(integrations.setupOwnerInstanceId, this.#instanceId),
          inArray(integrations.setupState, ["awaiting_user", "validating"]),
        ),
      );
  }

  async #currentForAgent(agentId: string): Promise<typeof integrations.$inferSelect | undefined> {
    const [row] = await this.#database
      .select()
      .from(integrations)
      .where(and(eq(integrations.agentId, agentId), ne(integrations.status, "disabled")))
      .limit(1);
    return row;
  }

  async #load(attemptId: string): Promise<typeof integrations.$inferSelect | undefined> {
    const [row] = await this.#database
      .select()
      .from(integrations)
      .where(eq(integrations.setupAttemptId, attemptId))
      .limit(1);
    return row;
  }

  async #failOwnedSlot(
    integrationId: string,
    attemptId: string,
    ownerInstanceId: string | null,
    code: string,
  ): Promise<void> {
    if (!ownerInstanceId) return;
    await this.#database
      .update(integrations)
      .set({
        setupState: "failed",
        lastErrorCode: code,
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.setupAttemptId, attemptId),
          eq(integrations.setupOwnerInstanceId, ownerInstanceId),
          inArray(integrations.setupState, ["awaiting_user", "validating"]),
        ),
      );
  }

  #toAttempt(row: typeof integrations.$inferSelect): FeishuSetupAttempt {
    if (!row.setupAttemptId || !row.setupIntent || !row.setupState) throw new Error("FEISHU_SETUP_NOT_FOUND");
    const secret = row.encryptedSetupContext
      ? (JSON.parse(this.#cipher.decrypt(row.encryptedSetupContext)) as AttemptSecret)
      : undefined;
    const terminal = !["awaiting_user", "validating"].includes(row.setupState);
    return {
      id: row.setupAttemptId,
      agentId: row.agentId,
      intent: row.setupIntent,
      state: row.setupState,
      qrUrl: !terminal && secret ? secret.qrUrl : null,
      expiresAt: (row.setupExpiresAt ?? row.updatedAt).toISOString(),
      errorCode: row.lastErrorCode,
      completedAt: terminal ? row.updatedAt.toISOString() : null,
      createdAt: row.updatedAt.toISOString(),
    };
  }
}
