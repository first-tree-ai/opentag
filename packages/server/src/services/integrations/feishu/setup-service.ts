import type { FeishuSetupAttempt, FeishuSetupIntent } from "@opentag/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { agents, feishuIntegrationIdentities, feishuSetupAttempts, integrations } from "../../../db/schema/index.js";
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
    tenantBrand?: "feishu" | "lark";
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
  }) {
    this.#database = input.database;
    this.#cipher = input.cipher;
    this.#instanceId = input.instanceId;
    this.#integrations = input.integrations;
    this.#registrations = input.registrations;
    this.#activation = input.activation;
  }

  start(): void {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => void this.#heartbeat().catch(() => undefined), OWNER_HEARTBEAT_MS);
    this.#heartbeatTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    await this.#database
      .update(feishuSetupAttempts)
      .set({ state: "failed", errorCode: "FEISHU_SETUP_OWNER_RESTARTED", completedAt: new Date() })
      .where(
        and(
          eq(feishuSetupAttempts.ownerInstanceId, this.#instanceId),
          inArray(feishuSetupAttempts.state, ["awaiting_user", "validating"]),
        ),
      );
    for (const registration of this.#running.values()) registration.abort();
    this.#running.clear();
  }

  async createOrReuse(callerUserId: string, agentId: string, intent: FeishuSetupIntent): Promise<FeishuSetupAttempt> {
    await this.#integrations.assertCanManage(callerUserId, agentId);
    const [active] = await this.#database
      .select()
      .from(feishuSetupAttempts)
      .where(
        and(
          eq(feishuSetupAttempts.agentId, agentId),
          inArray(feishuSetupAttempts.state, ["awaiting_user", "validating"]),
        ),
      )
      .limit(1);
    if (active) {
      if (
        (active.ownerInstanceId === this.#instanceId && !this.#running.has(active.id)) ||
        active.ownerHeartbeatAt.getTime() < Date.now() - OWNER_STALE_MS
      ) {
        await this.#database
          .update(feishuSetupAttempts)
          .set({ state: "failed", errorCode: "FEISHU_SETUP_OWNER_RESTARTED", completedAt: new Date() })
          .where(
            and(
              eq(feishuSetupAttempts.id, active.id),
              eq(feishuSetupAttempts.ownerInstanceId, active.ownerInstanceId),
              inArray(feishuSetupAttempts.state, ["awaiting_user", "validating"]),
            ),
          );
      } else {
        return this.#toAttempt(active);
      }
    }

    const [agent] = await this.#database
      .select({ displayName: agents.displayName, receiveMode: agents.receiveMode })
      .from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    const [existingBinding] = await this.#database
      .select({ provider: integrations.provider, appId: feishuIntegrationIdentities.appId })
      .from(integrations)
      .leftJoin(feishuIntegrationIdentities, eq(feishuIntegrationIdentities.integrationId, integrations.id))
      .where(eq(integrations.agentId, agentId))
      .limit(1);
    if (intent === "create" && existingBinding) throw new Error("FEISHU_INTEGRATION_ALREADY_EXISTS");
    if (intent === "reauthorize" && (existingBinding?.provider !== "feishu" || !existingBinding.appId)) {
      throw new Error("FEISHU_REAUTHORIZATION_REQUIRES_BINDING");
    }
    if (intent === "replace" && existingBinding?.provider !== "feishu") {
      throw new Error("FEISHU_REPLACEMENT_REQUIRES_BINDING");
    }
    const existingAppId = intent === "reauthorize" ? (existingBinding?.appId ?? undefined) : undefined;
    const profile: FeishuAppProfile = {
      name: agent.displayName,
      description: `OpenTag Agent: ${agent.displayName}`,
    };
    const registration = this.#registrations.start({ profile, intent, existingAppId, receiveMode: agent.receiveMode });
    let qr: Awaited<FeishuRegistration["qrReady"]>;
    try {
      qr = await registration.qrReady;
    } catch (error) {
      void registration.result.catch(() => undefined);
      registration.abort();
      throw error;
    }
    let created: typeof feishuSetupAttempts.$inferSelect | undefined;
    try {
      [created] = await this.#database
        .insert(feishuSetupAttempts)
        .values({
          agentId,
          intent,
          state: "awaiting_user",
          ownerInstanceId: this.#instanceId,
          ownerHeartbeatAt: new Date(),
          encryptedQrContext: this.#cipher.encrypt(JSON.stringify({ qrUrl: qr.url } satisfies AttemptSecret)),
          expiresAt: qr.expiresAt,
        })
        .returning();
    } catch (error) {
      void registration.result.catch(() => undefined);
      registration.abort();
      const [concurrent] = await this.#database
        .select()
        .from(feishuSetupAttempts)
        .where(
          and(
            eq(feishuSetupAttempts.agentId, agentId),
            inArray(feishuSetupAttempts.state, ["awaiting_user", "validating"]),
          ),
        )
        .limit(1);
      if (concurrent) return this.#toAttempt(concurrent);
      throw error;
    }
    if (!created) throw new Error("Feishu setup attempt insert did not return a row");
    this.#running.set(created.id, registration);
    void this.#complete(created.id, agentId, registration);
    return this.#toAttempt(created);
  }

  async get(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const [attempt] = await this.#database
      .select()
      .from(feishuSetupAttempts)
      .where(eq(feishuSetupAttempts.id, attemptId))
      .limit(1);
    if (!attempt) throw new Error("FEISHU_SETUP_NOT_FOUND");
    await this.#integrations.assertCanManage(callerUserId, attempt.agentId);
    let current = attempt;
    if (
      (["awaiting_user", "validating"].includes(attempt.state) &&
        attempt.ownerInstanceId === this.#instanceId &&
        !this.#running.has(attempt.id)) ||
      (["awaiting_user", "validating"].includes(attempt.state) &&
        attempt.ownerHeartbeatAt.getTime() < Date.now() - OWNER_STALE_MS)
    ) {
      const [failed] = await this.#database
        .update(feishuSetupAttempts)
        .set({ state: "failed", errorCode: "FEISHU_SETUP_OWNER_RESTARTED", completedAt: new Date() })
        .where(
          and(
            eq(feishuSetupAttempts.id, attempt.id),
            eq(feishuSetupAttempts.ownerInstanceId, attempt.ownerInstanceId),
            inArray(feishuSetupAttempts.state, ["awaiting_user", "validating"]),
          ),
        )
        .returning();
      if (failed) return this.#toAttempt(failed);
      current = (await this.#load(attempt.id)) ?? attempt;
    }
    if (current.state === "awaiting_user" && current.expiresAt <= new Date()) {
      const [expired] = await this.#database
        .update(feishuSetupAttempts)
        .set({ state: "expired", errorCode: "FEISHU_SETUP_EXPIRED", completedAt: new Date() })
        .where(
          and(
            eq(feishuSetupAttempts.id, current.id),
            eq(feishuSetupAttempts.ownerInstanceId, current.ownerInstanceId),
            eq(feishuSetupAttempts.state, "awaiting_user"),
          ),
        )
        .returning();
      if (expired) return this.#toAttempt(expired);
      current = (await this.#load(attempt.id)) ?? current;
    }
    return this.#toAttempt(current);
  }

  async cancel(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const attempt = await this.get(callerUserId, attemptId);
    const [canceled] = await this.#database
      .update(feishuSetupAttempts)
      .set({ state: "canceled", errorCode: "FEISHU_SETUP_CANCELED", completedAt: new Date() })
      .where(and(eq(feishuSetupAttempts.id, attemptId), eq(feishuSetupAttempts.state, "awaiting_user")))
      .returning();
    if (canceled) this.#running.get(attemptId)?.abort();
    return canceled ? this.#toAttempt(canceled) : attempt;
  }

  async #complete(attemptId: string, agentId: string, registration: FeishuRegistration): Promise<void> {
    try {
      const result = await registration.result;
      const [claimed] = await this.#database
        .update(feishuSetupAttempts)
        .set({ state: "validating" })
        .where(
          and(
            eq(feishuSetupAttempts.id, attemptId),
            eq(feishuSetupAttempts.state, "awaiting_user"),
            eq(feishuSetupAttempts.ownerInstanceId, this.#instanceId),
          ),
        )
        .returning({ id: feishuSetupAttempts.id });
      if (!claimed) return;
      const activationInput = {
        attemptId,
        ownerInstanceId: this.#instanceId,
        agentId,
        appId: result.appId,
        appSecret: result.appSecret,
        tenantBrand: result.tenantBrand,
        requestedScopes: result.requestedScopes,
      };
      await this.#activation.activateAtomicAttempt(activationInput);
    } catch (error) {
      const code = errorCode(error);
      await this.#database
        .update(feishuSetupAttempts)
        .set({
          state: code === "FEISHU_SETUP_EXPIRED" ? "expired" : code === "FEISHU_SETUP_CANCELED" ? "canceled" : "failed",
          errorCode: code,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(feishuSetupAttempts.id, attemptId),
            inArray(feishuSetupAttempts.state, ["awaiting_user", "validating"]),
          ),
        );
    } finally {
      this.#running.delete(attemptId);
    }
  }

  async #heartbeat(): Promise<void> {
    if (this.#running.size === 0) return;
    await this.#database
      .update(feishuSetupAttempts)
      .set({ ownerHeartbeatAt: new Date() })
      .where(
        and(
          eq(feishuSetupAttempts.ownerInstanceId, this.#instanceId),
          inArray(feishuSetupAttempts.state, ["awaiting_user", "validating"]),
        ),
      );
  }

  async #load(attemptId: string): Promise<typeof feishuSetupAttempts.$inferSelect | undefined> {
    const [attempt] = await this.#database
      .select()
      .from(feishuSetupAttempts)
      .where(eq(feishuSetupAttempts.id, attemptId))
      .limit(1);
    return attempt;
  }

  #toAttempt(row: typeof feishuSetupAttempts.$inferSelect): FeishuSetupAttempt {
    const secret = JSON.parse(this.#cipher.decrypt(row.encryptedQrContext)) as AttemptSecret;
    return {
      id: row.id,
      agentId: row.agentId,
      intent: row.intent,
      state: row.state,
      qrUrl: ["awaiting_user", "validating"].includes(row.state) ? secret.qrUrl : null,
      expiresAt: row.expiresAt.toISOString(),
      errorCode: row.errorCode,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
