import { randomUUID } from "node:crypto";
import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { agents, imBindings } from "../../../db/schema/index.js";
import type { ApplicationCipher } from "../../crypto.js";
import type { ImBindingService, VerifiedFeishuBinding } from "../im-binding-service.js";
import { FeishuOperationError, safeFeishuSetupErrorCode } from "./errors.js";
import type { FeishuAppProfile, FeishuRegistration, FeishuRegistrationGateway } from "./registration.js";

export interface FeishuBindingActivation {
  activateAtomicAttempt(input: {
    attemptId: string;
    ownerInstanceId: string;
    agentId: string;
    appId: string;
    appSecret: string;
    teamBrand?: "feishu" | "lark";
  }): Promise<VerifiedFeishuBinding>;
}

interface AttemptSecret {
  qrUrl: string;
}

const OWNER_HEARTBEAT_MS = 5_000;
const OWNER_STALE_MS = 15_000;

export class FeishuSetupService {
  readonly #activation: FeishuBindingActivation;
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #instanceId: string;
  readonly #imBindings: ImBindingService;
  readonly #onDiagnostic: (code: string) => void;
  readonly #registrations: FeishuRegistrationGateway;
  readonly #running = new Map<string, FeishuRegistration>();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(input: {
    database: DatabaseClient;
    cipher: ApplicationCipher;
    instanceId: string;
    imBindings: ImBindingService;
    registrations: FeishuRegistrationGateway;
    activation: FeishuBindingActivation;
    onDiagnostic?: (code: string) => void;
  }) {
    this.#database = input.database;
    this.#cipher = input.cipher;
    this.#instanceId = input.instanceId;
    this.#imBindings = input.imBindings;
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
      .update(imBindings)
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
          eq(imBindings.setupOwnerInstanceId, this.#instanceId),
          inArray(imBindings.setupState, ["awaiting_user", "validating"]),
        ),
      );
    for (const registration of this.#running.values()) registration.abort();
    this.#running.clear();
  }

  async createOrReuse(callerUserId: string, agentId: string, intent: FeishuSetupIntent): Promise<FeishuSetupAttempt> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const current = await this.#currentForAgent(agentId);
    if (current?.setupAttemptId && current.setupState && ["awaiting_user", "validating"].includes(current.setupState)) {
      if (
        (current.setupOwnerInstanceId === this.#instanceId && !this.#running.has(current.setupAttemptId)) ||
        !current.setupOwnerHeartbeatAt ||
        current.setupOwnerHeartbeatAt.getTime() < Date.now() - OWNER_STALE_MS
      ) {
        await this.#failOwnedSlot(
          callerUserId,
          agentId,
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
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const existing = await this.#currentForAgent(agentId);
    if (intent === "create" && existing && existing.status !== "provisioning") {
      throw new Error("FEISHU_IM_BINDING_ALREADY_EXISTS");
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
    let registration: FeishuRegistration;
    try {
      registration = this.#registrations.start({
        profile,
        intent,
        existingAppId: intent === "reauthorize" ? (existing?.externalAppId ?? undefined) : undefined,
        receiveMode: agent.receiveMode,
      });
    } catch {
      throw new FeishuOperationError("FEISHU_SETUP_FAILED");
    }
    let qr: Awaited<FeishuRegistration["qrReady"]>;
    try {
      qr = await registration.qrReady;
    } catch {
      void registration.result.catch(() => undefined);
      registration.abort();
      throw new FeishuOperationError("FEISHU_SETUP_FAILED");
    }

    const attemptId = randomUUID();
    const now = new Date();
    let row: typeof imBindings.$inferSelect | undefined;
    try {
      row = await this.#database.transaction(async (transaction) => {
        await this.#imBindings.assertCanManageForMutation(callerUserId, agentId, transaction);
        if (existing) {
          const [updated] = await transaction
            .update(imBindings)
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
                eq(imBindings.id, existing.id),
                ne(imBindings.status, "disabled"),
                isNull(imBindings.setupOwnerInstanceId),
              ),
            )
            .returning();
          return updated;
        }
        const [created] = await transaction
          .insert(imBindings)
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
        return created;
      });
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
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    const attempt = this.#toAttempt(row);
    const now = new Date();
    if (row.setupState === "awaiting_user" && row.setupExpiresAt && row.setupExpiresAt <= now) {
      return {
        ...attempt,
        state: "expired",
        qrUrl: null,
        errorCode: "FEISHU_SETUP_EXPIRED",
        completedAt: row.setupExpiresAt.toISOString(),
      };
    }
    if (
      row.setupState &&
      ["awaiting_user", "validating"].includes(row.setupState) &&
      ((row.setupOwnerInstanceId === this.#instanceId && !this.#running.has(attemptId)) ||
        !row.setupOwnerHeartbeatAt ||
        row.setupOwnerHeartbeatAt.getTime() < now.getTime() - OWNER_STALE_MS)
    ) {
      return {
        ...attempt,
        state: "failed",
        qrUrl: null,
        errorCode: "FEISHU_SETUP_OWNER_RESTARTED",
        completedAt: now.toISOString(),
      };
    }
    return attempt;
  }

  async cancel(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const attempt = await this.get(callerUserId, attemptId);
    if (!["awaiting_user", "validating"].includes(attempt.state)) return attempt;
    const now = new Date();
    const canceled = await this.#database.transaction(async (transaction) => {
      await this.#imBindings.assertCanManageForMutation(callerUserId, attempt.agentId, transaction);
      const [row] = await transaction
        .update(imBindings)
        .set({
          setupState: "canceled",
          lastErrorCode: "FEISHU_SETUP_CANCELED",
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          encryptedSetupContext: null,
          setupExpiresAt: null,
          updatedAt: now,
        })
        .where(and(eq(imBindings.setupAttemptId, attemptId), eq(imBindings.setupState, "awaiting_user")))
        .returning();
      return row;
    });
    if (canceled) this.#running.get(attemptId)?.abort();
    return canceled ? this.#toAttempt(canceled) : attempt;
  }

  async #complete(attemptId: string, agentId: string, registration: FeishuRegistration): Promise<void> {
    try {
      const result = await registration.result;
      const [claimed] = await this.#database
        .update(imBindings)
        .set({ setupState: "validating", updatedAt: new Date() })
        .where(
          and(
            eq(imBindings.setupAttemptId, attemptId),
            eq(imBindings.agentId, agentId),
            eq(imBindings.setupState, "awaiting_user"),
            eq(imBindings.setupOwnerInstanceId, this.#instanceId),
          ),
        )
        .returning({ id: imBindings.id });
      if (!claimed) return;
      await this.#activation.activateAtomicAttempt({
        attemptId,
        ownerInstanceId: this.#instanceId,
        agentId,
        appId: result.appId,
        appSecret: result.appSecret,
        teamBrand: result.teamBrand,
      });
    } catch (error) {
      const code = safeFeishuSetupErrorCode(error);
      const state =
        code === "FEISHU_SETUP_EXPIRED" ? "expired" : code === "FEISHU_SETUP_CANCELED" ? "canceled" : "failed";
      try {
        await this.#database
          .update(imBindings)
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
              eq(imBindings.setupAttemptId, attemptId),
              inArray(imBindings.setupState, ["awaiting_user", "validating"]),
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
      .update(imBindings)
      .set({ setupOwnerHeartbeatAt: new Date() })
      .where(
        and(
          eq(imBindings.setupOwnerInstanceId, this.#instanceId),
          inArray(imBindings.setupState, ["awaiting_user", "validating"]),
        ),
      );
  }

  async #currentForAgent(agentId: string): Promise<typeof imBindings.$inferSelect | undefined> {
    const [row] = await this.#database
      .select()
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    return row;
  }

  async #load(attemptId: string): Promise<typeof imBindings.$inferSelect | undefined> {
    const [row] = await this.#database
      .select()
      .from(imBindings)
      .where(eq(imBindings.setupAttemptId, attemptId))
      .limit(1);
    return row;
  }

  async #failOwnedSlot(
    callerUserId: string,
    agentId: string,
    imBindingId: string,
    attemptId: string,
    ownerInstanceId: string | null,
    code: string,
  ): Promise<void> {
    if (!ownerInstanceId) return;
    await this.#database.transaction(async (transaction) => {
      await this.#imBindings.assertCanManageForMutation(callerUserId, agentId, transaction);
      await transaction
        .update(imBindings)
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
            eq(imBindings.id, imBindingId),
            eq(imBindings.agentId, agentId),
            eq(imBindings.setupAttemptId, attemptId),
            eq(imBindings.setupOwnerInstanceId, ownerInstanceId),
            inArray(imBindings.setupState, ["awaiting_user", "validating"]),
          ),
        );
    });
  }

  #toAttempt(row: typeof imBindings.$inferSelect): FeishuSetupAttempt {
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
