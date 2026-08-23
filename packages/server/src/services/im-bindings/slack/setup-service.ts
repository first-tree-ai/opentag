import { randomUUID } from "node:crypto";
import {
  agentSlackEventsPath,
  type ErrorCategory,
  type SlackBindingActivation,
  type SlackSetupAttempt,
  type SlackSetupIntent,
  type SubmitSlackSetupCredentialsRequest,
} from "@opentag/shared";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../../db/client.js";
import { agents, imBindings } from "../../../db/schema/index.js";
import type { ApplicationCipher } from "../../crypto.js";
import type { ImBindingService, SlackIngressBinding } from "../im-binding-service.js";
import type { SlackApiClient, SlackInstallationInspection } from "./adapter.js";
import { verifySlackSignature } from "./signature.js";

const ATTEMPT_TTL_MS = 30 * 60 * 1000;
const ACTIVE_SETUP_STATES = ["awaiting_user", "validating"] as const;
type ActiveSetupState = (typeof ACTIVE_SETUP_STATES)[number];

const SlackSetupContextSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("awaiting_credentials") }).strict(),
  z
    .object({
      stage: z.literal("awaiting_verification"),
      botAccessToken: z.string().min(1),
      signingSecret: z.string().min(1),
      installation: z
        .object({
          appId: z.string().min(1).nullable(),
          teamId: z.string().min(1),
          enterpriseId: z.string().nullable(),
          botUserId: z.string().min(1),
          botId: z.string().min(1),
          grantedBotScopes: z.array(z.string().min(1)),
        })
        .strict(),
      challengeVerified: z.boolean(),
      // Non-secret diagnostics about the most recent signature verification routed to this attempt.
      lastVerificationErrorCode: z.string().min(1).max(120).nullable().default(null),
      lastVerificationAt: z.string().datetime().nullable().default(null),
    })
    .strict(),
]);

type SlackSetupContext = z.infer<typeof SlackSetupContextSchema>;
type SlackVerificationContext = Extract<SlackSetupContext, { stage: "awaiting_verification" }>;
type AgentSetupFacts = { displayName: string; receiveMode: "mention_only" | "all_message" };
type ImBindingRow = typeof imBindings.$inferSelect;
type QueryExecutor = DatabaseClient | DatabaseTransaction;

/**
 * Result of routing one signed Slack event through the pending setup attempt of an Agent.
 * `awaiting_challenge` means the event was signed by the submitted Signing Secret but the attempt
 * has not proven the Events Request URL yet; ingress must keep serving the current binding instead
 * of failing the request, because a reauthorization normally keeps the live secret unchanged.
 */
export type SlackSetupEventOutcome =
  | { status: "activated"; binding: SlackIngressBinding }
  | { status: "awaiting_challenge" }
  | { status: "unmatched" };

const SlackActivationEnvelopeSchema = z
  .object({
    type: z.literal("event_callback"),
    api_app_id: z.string().min(1).max(255),
    team_id: z.string().min(1).max(255),
    authorizations: z
      .array(
        z
          .object({
            team_id: z.string().min(1).max(255),
            user_id: z.string().min(1).max(255),
            is_bot: z.boolean(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export class SlackSetupServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly category: ErrorCategory = "deterministic",
  ) {
    super(message);
  }
}

export function requiredSlackBotScopes(receiveMode: "mention_only" | "all_message"): string[] {
  const scopes = ["app_mentions:read", "chat:write", "files:read", "im:history"];
  if (receiveMode === "all_message") scopes.push("channels:history", "groups:history", "mpim:history");
  return scopes.sort();
}

function slackBotEvents(receiveMode: "mention_only" | "all_message"): string[] {
  const events = ["app_mention", "app_uninstalled", "message.im", "tokens_revoked"];
  if (receiveMode === "all_message") events.push("message.channels", "message.groups", "message.mpim");
  return events.sort();
}

function isActiveSetupState(state: string | null | undefined): state is ActiveSetupState {
  return ACTIVE_SETUP_STATES.includes(state as ActiveSetupState);
}

function notFound(): SlackSetupServiceError {
  return new SlackSetupServiceError("SLACK_SETUP_NOT_FOUND", 404, "The Slack setup attempt was not found");
}

export class SlackSetupService {
  readonly #api: SlackApiClient;
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #imBindings: ImBindingService;
  readonly #instanceId: string;
  readonly #now: () => Date;
  readonly #publicOrigin: string;
  readonly #beforeActivationTransaction?: () => Promise<void>;
  readonly #beforeSetupTransaction?: () => Promise<void>;

  constructor(input: {
    api: SlackApiClient;
    cipher: ApplicationCipher;
    database: DatabaseClient;
    imBindings: ImBindingService;
    instanceId: string;
    publicOrigin: string;
    now?: () => Date;
    beforeActivationTransaction?: () => Promise<void>;
    beforeSetupTransaction?: () => Promise<void>;
  }) {
    this.#api = input.api;
    this.#cipher = input.cipher;
    this.#database = input.database;
    this.#imBindings = input.imBindings;
    this.#instanceId = input.instanceId;
    this.#publicOrigin = input.publicOrigin;
    this.#now = input.now ?? (() => new Date());
    this.#beforeActivationTransaction = input.beforeActivationTransaction;
    this.#beforeSetupTransaction = input.beforeSetupTransaction;
  }

  async createOrReuse(callerUserId: string, agentId: string, intent: SlackSetupIntent): Promise<SlackSetupAttempt> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const agent = await this.#agent(agentId);
    const preflight = await this.#admit(agentId, await this.#currentForAgent(agentId), intent);
    if (preflight.kind === "reuse") return this.#toAttempt(preflight.row, agent);
    await this.#beforeSetupTransaction?.();

    const attemptId = randomUUID();
    const row = await this.#database.transaction(async (transaction) => {
      // The Agent row lock serializes concurrent setup starts; the re-read below decides under that lock.
      await this.#imBindings.assertCanManageForMutation(callerUserId, agentId, transaction);
      const admitted = await this.#admit(
        agentId,
        await this.#currentForAgent(agentId, transaction, true),
        intent,
        transaction,
      );
      if (admitted.kind === "reuse") return admitted.row;
      const now = this.#now();
      const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
      const encryptedSetupContext = this.#encrypt({ stage: "awaiting_credentials" });
      if (admitted.current) {
        const [updated] = await transaction
          .update(imBindings)
          .set({
            setupAttemptId: attemptId,
            setupIntent: intent,
            setupState: "awaiting_user",
            setupOwnerInstanceId: this.#instanceId,
            setupOwnerHeartbeatAt: now,
            encryptedSetupContext,
            setupExpiresAt: expiresAt,
            lastErrorCode: null,
            updatedAt: now,
          })
          .where(and(eq(imBindings.id, admitted.current.id), ne(imBindings.status, "disabled")))
          .returning();
        return updated;
      }
      const [created] = await transaction
        .insert(imBindings)
        .values({
          agentId,
          provider: "slack",
          status: "provisioning",
          setupAttemptId: attemptId,
          setupIntent: intent,
          setupState: "awaiting_user",
          setupOwnerInstanceId: this.#instanceId,
          setupOwnerHeartbeatAt: now,
          encryptedSetupContext,
          setupExpiresAt: expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return created;
    });
    if (!row) throw new SlackSetupServiceError("SLACK_SETUP_CONFLICT", 409, "Another Slack setup is already active");
    return this.#toAttempt(row, agent);
  }

  async submitCredentials(
    callerUserId: string,
    attemptId: string,
    input: SubmitSlackSetupCredentialsRequest,
  ): Promise<SlackSetupAttempt> {
    const row = await this.#load(attemptId);
    if (row?.provider !== "slack") throw notFound();
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    const agent = await this.#agent(row.agentId);
    if (!isActiveSetupState(row.setupState)) {
      throw new SlackSetupServiceError("SLACK_SETUP_NOT_ACTIVE", 409, "The Slack setup attempt is not active");
    }
    if (row.setupExpiresAt && row.setupExpiresAt <= this.#now()) {
      await this.#expire(attemptId);
      throw new SlackSetupServiceError("SLACK_SETUP_EXPIRED", 409, "The Slack setup attempt expired");
    }
    if (!this.#context(row)) {
      throw new SlackSetupServiceError("SLACK_SETUP_CONFLICT", 409, "Slack setup context is unavailable");
    }
    const installation = await this.#inspect(input.botAccessToken);
    const required = requiredSlackBotScopes(this.#targetReceiveMode(row, agent));
    const granted = new Set(installation.grantedBotScopes);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new SlackSetupServiceError(
        "SLACK_SCOPE_REAUTH_REQUIRED",
        409,
        `The Slack installation is missing required scopes: ${missing.join(", ")}`,
        "credential",
      );
    }
    if (
      row.setupIntent === "reauthorize" &&
      ((installation.appId !== null && row.externalAppId !== installation.appId) ||
        row.externalTeamId !== installation.teamId ||
        row.externalBotId !== installation.botUserId)
    ) {
      throw new SlackSetupServiceError(
        "SLACK_BINDING_IDENTITY_MISMATCH",
        409,
        "Reauthorization must use the current Slack App and bot installation",
      );
    }
    if (
      row.setupIntent === "replace" &&
      row.externalTeamId === installation.teamId &&
      row.externalBotId === installation.botUserId &&
      (installation.appId === null || row.externalAppId === installation.appId)
    ) {
      throw new SlackSetupServiceError(
        "SLACK_REPLACEMENT_REQUIRES_DIFFERENT_APP",
        409,
        "Use reauthorization when the Slack App identity is unchanged",
      );
    }
    // Re-submitting while validating atomically replaces both secrets and restarts URL verification.
    const context: SlackSetupContext = {
      stage: "awaiting_verification",
      botAccessToken: input.botAccessToken,
      signingSecret: input.signingSecret,
      installation,
      challengeVerified: false,
      lastVerificationErrorCode: null,
      lastVerificationAt: null,
    };
    const now = this.#now();
    const [updated] = await this.#database
      .update(imBindings)
      .set({ setupState: "validating", encryptedSetupContext: this.#encrypt(context), updatedAt: now })
      .where(
        and(
          eq(imBindings.setupAttemptId, attemptId),
          inArray(imBindings.setupState, ACTIVE_SETUP_STATES),
          gt(imBindings.setupExpiresAt, now),
          ne(imBindings.status, "disabled"),
        ),
      )
      .returning();
    if (!updated) throw await this.#staleAttemptError(attemptId);
    return this.#toAttempt(updated, agent);
  }

  async get(callerUserId: string, attemptId: string): Promise<SlackSetupAttempt> {
    const row = await this.#load(attemptId);
    if (row?.provider !== "slack") throw notFound();
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    if (row.setupExpiresAt && row.setupExpiresAt <= this.#now() && isActiveSetupState(row.setupState)) {
      await this.#expire(attemptId);
      return this.get(callerUserId, attemptId);
    }
    return this.#toAttempt(row, await this.#agent(row.agentId));
  }

  async cancel(callerUserId: string, attemptId: string): Promise<SlackSetupAttempt> {
    const attempt = await this.get(callerUserId, attemptId);
    if (!["awaiting_credentials", "awaiting_verification"].includes(attempt.state)) return attempt;
    const now = this.#now();
    const [updated] = await this.#database
      .update(imBindings)
      .set({
        setupState: "canceled",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        ...(attempt.intent === "reauthorize" ? { pendingReceiveMode: null } : {}),
        lastErrorCode: "SLACK_SETUP_CANCELED",
        updatedAt: now,
      })
      .where(and(eq(imBindings.setupAttemptId, attemptId), inArray(imBindings.setupState, ACTIVE_SETUP_STATES)))
      .returning();
    return updated ? this.#toAttempt(updated, await this.#agent(updated.agentId)) : attempt;
  }

  async verifyChallenge(input: {
    agentId: string;
    rawBody: Buffer;
    timestamp: string | undefined;
    signature: string | undefined;
  }): Promise<string> {
    const row = await this.#pendingForAgent(input.agentId);
    const context = row ? this.#context(row) : undefined;
    if (!row?.setupAttemptId || context?.stage !== "awaiting_verification") {
      throw new SlackSetupServiceError(
        "SLACK_SETUP_NOT_READY",
        409,
        "Submit Slack credentials before retrying URL verification",
      );
    }
    const pending = { ...row, setupAttemptId: row.setupAttemptId };
    if (!this.#signatureMatches(input, context.signingSecret)) {
      if (!context.challengeVerified) {
        await this.#recordVerification(pending, context, "SLACK_SIGNING_SECRET_INVALID");
      }
      throw new SlackSetupServiceError("SLACK_SIGNING_SECRET_INVALID", 401, "Slack request signature did not match");
    }
    const payload = z
      .object({ type: z.literal("url_verification"), challenge: z.string().min(1).max(4096) })
      .passthrough()
      .parse(JSON.parse(input.rawBody.toString("utf8")));
    if (!context.challengeVerified || context.lastVerificationErrorCode !== null) {
      const recorded = await this.#recordVerification(pending, { ...context, challengeVerified: true }, null);
      if (!recorded) throw await this.#staleChallengeError(pending.setupAttemptId);
    }
    return payload.challenge;
  }

  async tryActivateFromEvent(input: {
    agentId: string;
    appId: string;
    teamId: string;
    rawBody: Buffer;
    timestamp: string | undefined;
    signature: string | undefined;
  }): Promise<SlackSetupEventOutcome> {
    const row = await this.#pendingForAgent(input.agentId);
    const context = row ? this.#context(row) : undefined;
    if (!row?.setupAttemptId || context?.stage !== "awaiting_verification") return { status: "unmatched" };
    const pending = { ...row, setupAttemptId: row.setupAttemptId };
    if (!this.#signatureMatches(input, context.signingSecret)) {
      if (!context.challengeVerified && this.#intentMatchesApp(row, input.appId)) {
        await this.#recordVerification(pending, context, "SLACK_SIGNING_SECRET_INVALID");
      }
      return { status: "unmatched" };
    }
    if (!context.challengeVerified) {
      // The secret is proven but the Request URL is not; never fail live ingress for that.
      if (context.lastVerificationErrorCode !== null) await this.#recordVerification(pending, context, null);
      return { status: "awaiting_challenge" };
    }
    if (!this.#activationIdentityMatches(input, context.installation) || !this.#intentMatchesApp(row, input.appId)) {
      await this.#fail(row.setupAttemptId, "SLACK_BINDING_IDENTITY_MISMATCH");
      throw new SlackSetupServiceError(
        "SLACK_BINDING_IDENTITY_MISMATCH",
        409,
        "The signed Slack event did not match the token installation and setup intent",
      );
    }
    await this.#beforeActivationTransaction?.();
    const attemptId = row.setupAttemptId;
    try {
      const activated = await this.#database.transaction(async (transaction) =>
        this.#activateCurrentAttempt(transaction, input, row.id, attemptId),
      );
      if (!activated) return { status: "unmatched" };
    } catch (error) {
      await this.#fail(attemptId, this.#safeActivationCode(error));
      throw error;
    }
    const binding = await this.#imBindings.findSlackIngressBindingForAgent(row.agentId);
    if (!binding)
      throw new SlackSetupServiceError("SLACK_ACTIVATION_INCOMPLETE", 500, "Slack activation did not converge");
    return { status: "activated", binding };
  }

  async #activateCurrentAttempt(
    transaction: DatabaseTransaction,
    input: {
      agentId: string;
      appId: string;
      teamId: string;
      rawBody: Buffer;
      timestamp: string | undefined;
      signature: string | undefined;
    },
    imBindingId: string,
    attemptId: string,
  ): Promise<string | undefined> {
    const [agent] = await transaction
      .select({ receiveMode: agents.receiveMode })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), ne(agents.status, "deleted")))
      .limit(1)
      .for("update");
    if (!agent) return undefined;
    const [row] = await transaction
      .select()
      .from(imBindings)
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.agentId, input.agentId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.setupAttemptId, attemptId),
          eq(imBindings.setupState, "validating"),
          ne(imBindings.status, "disabled"),
        ),
      )
      .limit(1)
      .for("update");
    const context = row ? this.#context(row) : undefined;
    const now = this.#now();
    if (!row?.setupExpiresAt || row.setupExpiresAt <= now || context?.stage !== "awaiting_verification") {
      return undefined;
    }
    const targetReceiveMode = this.#targetReceiveMode(row, agent);
    if (!this.#signatureMatches(input, context.signingSecret)) return undefined;
    if (!context.challengeVerified) return undefined;
    if (!this.#activationIdentityMatches(input, context.installation) || !this.#intentMatchesApp(row, input.appId)) {
      return undefined;
    }
    if (targetReceiveMode !== agent.receiveMode) {
      const [updatedAgent] = await transaction
        .update(agents)
        .set({ receiveMode: targetReceiveMode, revision: sql`${agents.revision} + 1`, updatedAt: now })
        .where(and(eq(agents.id, input.agentId), ne(agents.status, "deleted")))
        .returning({ id: agents.id });
      if (!updatedAgent) return undefined;
    }
    const activation: SlackBindingActivation = {
      agentId: row.agentId,
      appId: input.appId,
      teamId: context.installation.teamId,
      enterpriseId: context.installation.enterpriseId ?? undefined,
      botUserId: context.installation.botUserId,
      grantedBotScopes: context.installation.grantedBotScopes,
      botAccessToken: context.botAccessToken,
      signingSecret: context.signingSecret,
      installedAt: now,
    };
    const activatedImBindingId = await this.#imBindings.activateSlack(
      activation,
      context.installation.botId,
      transaction,
    );
    const [finished] = await transaction
      .update(imBindings)
      .set({
        setupState: "succeeded",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        pendingReceiveMode: null,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.setupAttemptId, attemptId),
          eq(imBindings.setupState, "validating"),
        ),
      )
      .returning({ id: imBindings.id });
    if (!finished) {
      throw new SlackSetupServiceError("SLACK_SETUP_CONFLICT", 409, "Slack setup changed concurrently");
    }
    return activatedImBindingId;
  }

  /**
   * Decides whether a setup request reuses the active attempt or may start a new one. Runs once
   * before the transaction (cheap rejection) and again under the Agent lock (authoritative).
   */
  async #admit(
    agentId: string,
    current: ImBindingRow | undefined,
    intent: SlackSetupIntent,
    executor: QueryExecutor = this.#database,
  ): Promise<{ kind: "reuse"; row: ImBindingRow } | { kind: "start"; current: ImBindingRow | undefined }> {
    if (current?.provider === "slack" && current.setupAttemptId && isActiveSetupState(current.setupState)) {
      if (current.setupExpiresAt && current.setupExpiresAt > this.#now()) {
        if (current.setupIntent === intent) return { kind: "reuse", row: current };
        throw new SlackSetupServiceError(
          "SLACK_SETUP_INTENT_CONFLICT",
          409,
          `A Slack ${current.setupIntent} setup is already active; cancel it before starting a ${intent} setup`,
        );
      }
      await this.#expire(current.setupAttemptId, executor);
      current = await this.#currentForAgent(agentId, executor, executor !== this.#database);
    }
    if (current && current.provider !== "slack") {
      throw new SlackSetupServiceError(
        "IM_BINDING_PROVIDER_IMMUTABLE",
        409,
        "Disable the current IM binding before connecting Slack",
      );
    }
    if (intent === "create" && current && current.status !== "provisioning") {
      throw new SlackSetupServiceError(
        "SLACK_IM_BINDING_ALREADY_EXISTS",
        409,
        "This Agent already has a Slack binding",
      );
    }
    if (intent === "reauthorize" && (!current?.externalAppId || !current.externalTeamId || !current.externalBotId)) {
      throw new SlackSetupServiceError(
        "SLACK_REAUTHORIZATION_REQUIRES_BINDING",
        409,
        "Slack reauthorization requires an existing binding",
      );
    }
    if (intent === "replace" && (!current || current.status === "provisioning")) {
      throw new SlackSetupServiceError(
        "SLACK_REPLACEMENT_REQUIRES_BINDING",
        409,
        "Slack replacement requires an existing binding",
      );
    }
    return { kind: "start", current };
  }

  async #inspect(token: string): Promise<SlackInstallationInspection> {
    try {
      return await this.#api.inspectInstallation(token);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "SLACK_AUTH_INVALID" || code === "SLACK_AUTH_REJECTED") {
        throw new SlackSetupServiceError(
          "SLACK_AUTH_INVALID",
          400,
          "Slack rejected the Bot User OAuth Token",
          "credential",
        );
      }
      throw new SlackSetupServiceError(
        "SLACK_UPSTREAM_UNAVAILABLE",
        502,
        "Slack did not return a usable installation identity",
        "transient",
      );
    }
  }

  #signatureMatches(
    input: { rawBody: Buffer; timestamp: string | undefined; signature: string | undefined },
    signingSecret: string,
  ): boolean {
    return verifySlackSignature({ ...input, signingSecret, now: this.#now() });
  }

  #activationIdentityMatches(
    input: { appId: string; teamId: string; rawBody: Buffer },
    installation: SlackInstallationInspection,
  ): boolean {
    try {
      const envelope = SlackActivationEnvelopeSchema.safeParse(JSON.parse(input.rawBody.toString("utf8")));
      if (!envelope.success) return false;
      if (
        envelope.data.api_app_id !== input.appId ||
        envelope.data.team_id !== input.teamId ||
        installation.teamId !== input.teamId ||
        (installation.appId !== null && installation.appId !== input.appId)
      ) {
        return false;
      }
      return envelope.data.authorizations.some(
        (authorization) =>
          authorization.is_bot &&
          authorization.team_id === installation.teamId &&
          authorization.user_id === installation.botUserId,
      );
    } catch {
      return false;
    }
  }

  #intentMatchesApp(row: ImBindingRow, appId: string): boolean {
    if (row.setupIntent === "reauthorize") return row.externalAppId === appId;
    if (row.setupIntent === "replace") return row.externalAppId !== appId;
    return true;
  }

  /**
   * Stores a non-secret verification diagnostic inside the encrypted setup context, fenced to the
   * exact attempt, validating state, and unexpired deadline. Returns whether the attempt was still live.
   */
  async #recordVerification(
    row: ImBindingRow & { setupAttemptId: string },
    context: SlackVerificationContext,
    errorCode: string | null,
  ): Promise<boolean> {
    const now = this.#now();
    const next: SlackSetupContext = {
      ...context,
      lastVerificationErrorCode: errorCode,
      lastVerificationAt: now.toISOString(),
    };
    const [updated] = await this.#database
      .update(imBindings)
      .set({ encryptedSetupContext: this.#encrypt(next), updatedAt: now })
      .where(
        and(
          eq(imBindings.id, row.id),
          eq(imBindings.setupAttemptId, row.setupAttemptId),
          eq(imBindings.setupState, "validating"),
          gt(imBindings.setupExpiresAt, now),
          ne(imBindings.status, "disabled"),
        ),
      )
      .returning({ id: imBindings.id });
    return updated !== undefined;
  }

  async #staleAttemptError(attemptId: string): Promise<SlackSetupServiceError> {
    const row = await this.#load(attemptId);
    if (row?.provider !== "slack") return notFound();
    if (isActiveSetupState(row.setupState)) {
      if (row.setupExpiresAt && row.setupExpiresAt <= this.#now()) {
        await this.#expire(attemptId);
        return new SlackSetupServiceError("SLACK_SETUP_EXPIRED", 409, "The Slack setup attempt expired");
      }
      return new SlackSetupServiceError("SLACK_SETUP_CONFLICT", 409, "Slack setup changed concurrently");
    }
    return new SlackSetupServiceError("SLACK_SETUP_NOT_ACTIVE", 409, "The Slack setup attempt is not active");
  }

  async #staleChallengeError(attemptId: string): Promise<SlackSetupServiceError> {
    const row = await this.#load(attemptId);
    if (row?.provider === "slack" && isActiveSetupState(row.setupState)) {
      if (row.setupExpiresAt && row.setupExpiresAt <= this.#now()) {
        await this.#expire(attemptId);
        return new SlackSetupServiceError("SLACK_SETUP_EXPIRED", 409, "The Slack setup attempt expired");
      }
    }
    return new SlackSetupServiceError(
      "SLACK_SETUP_NOT_READY",
      409,
      "Submit Slack credentials before retrying URL verification",
    );
  }

  async #agent(agentId: string): Promise<AgentSetupFacts> {
    const [agent] = await this.#database
      .select({ displayName: agents.displayName, receiveMode: agents.receiveMode })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw new SlackSetupServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    return agent;
  }

  async #currentForAgent(
    agentId: string,
    executor: QueryExecutor = this.#database,
    forUpdate = false,
  ): Promise<ImBindingRow | undefined> {
    const query = executor
      .select()
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (forUpdate) {
      const [locked] = await query.for("update");
      return locked;
    }
    const [row] = await query;
    return row;
  }

  async #pendingForAgent(agentId: string): Promise<ImBindingRow | undefined> {
    const [row] = await this.#database
      .select()
      .from(imBindings)
      .where(
        and(
          eq(imBindings.agentId, agentId),
          eq(imBindings.provider, "slack"),
          inArray(imBindings.setupState, ACTIVE_SETUP_STATES),
          gt(imBindings.setupExpiresAt, this.#now()),
          ne(imBindings.status, "disabled"),
        ),
      )
      .limit(1);
    return row;
  }

  async #load(attemptId: string): Promise<ImBindingRow | undefined> {
    const [row] = await this.#database
      .select()
      .from(imBindings)
      .where(eq(imBindings.setupAttemptId, attemptId))
      .limit(1);
    return row;
  }

  #context(row: ImBindingRow): SlackSetupContext | undefined {
    if (!row.encryptedSetupContext) return undefined;
    return SlackSetupContextSchema.parse(JSON.parse(this.#cipher.decrypt(row.encryptedSetupContext)));
  }

  #encrypt(context: SlackSetupContext): string {
    return this.#cipher.encrypt(JSON.stringify(context));
  }

  #eventsUrl(agentId: string): string {
    return new URL(agentSlackEventsPath(agentId), this.#publicOrigin).toString();
  }

  #manifest(
    agentId: string,
    agent: AgentSetupFacts,
    targetReceiveMode: AgentSetupFacts["receiveMode"],
  ): Record<string, unknown> {
    const name = `${agent.displayName} - OpenTag`.slice(0, 35);
    return {
      _metadata: { major_version: 1 },
      display_information: { name },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: name, always_online: false },
      },
      oauth_config: { scopes: { bot: requiredSlackBotScopes(targetReceiveMode) } },
      settings: {
        event_subscriptions: {
          request_url: this.#eventsUrl(agentId),
          bot_events: slackBotEvents(targetReceiveMode),
        },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    };
  }

  #manifestUrl(manifest: Record<string, unknown>): string {
    const url = new URL("https://api.slack.com/apps");
    url.searchParams.set("new_app", "1");
    url.searchParams.set("manifest_json", JSON.stringify(manifest));
    return url.toString();
  }

  #toAttempt(row: ImBindingRow, agent: AgentSetupFacts): SlackSetupAttempt {
    if (!row.setupAttemptId || !row.setupIntent || !row.setupState) throw notFound();
    const context = this.#context(row);
    const verification = context?.stage === "awaiting_verification" ? context : undefined;
    const targetReceiveMode = this.#targetReceiveMode(row, agent);
    const terminal = !isActiveSetupState(row.setupState);
    const state =
      row.setupState === "awaiting_user"
        ? ("awaiting_credentials" as const)
        : row.setupState === "validating"
          ? ("awaiting_verification" as const)
          : row.setupState;
    const manifest = this.#manifest(row.agentId, agent, targetReceiveMode);
    return {
      id: row.setupAttemptId,
      agentId: row.agentId,
      intent: row.setupIntent,
      state,
      manifest,
      manifestUrl: this.#manifestUrl(manifest),
      eventsUrl: this.#eventsUrl(row.agentId),
      requiredBotScopes: requiredSlackBotScopes(targetReceiveMode),
      currentAppId: row.externalAppId,
      identity:
        verification && verification.installation.appId !== null
          ? {
              appId: verification.installation.appId,
              teamId: verification.installation.teamId,
              enterpriseId: verification.installation.enterpriseId,
              botUserId: verification.installation.botUserId,
            }
          : null,
      challengeVerified: verification?.challengeVerified ?? false,
      lastVerificationErrorCode: verification?.lastVerificationErrorCode ?? null,
      lastVerificationAt: verification?.lastVerificationAt ?? null,
      expiresAt: (row.setupExpiresAt ?? row.updatedAt).toISOString(),
      errorCode: row.lastErrorCode,
      completedAt: terminal ? row.updatedAt.toISOString() : null,
      createdAt: row.updatedAt.toISOString(),
    };
  }

  async #expire(attemptId: string, executor: QueryExecutor = this.#database): Promise<void> {
    await this.#finish(attemptId, "expired", "SLACK_SETUP_EXPIRED", executor);
  }

  #targetReceiveMode(row: ImBindingRow, agent: Pick<AgentSetupFacts, "receiveMode">): AgentSetupFacts["receiveMode"] {
    return row.pendingReceiveMode ?? agent.receiveMode;
  }

  async #fail(attemptId: string | null, code: string): Promise<void> {
    if (attemptId) await this.#finish(attemptId, "failed", code);
  }

  async #finish(
    attemptId: string,
    state: "failed" | "expired",
    lastErrorCode: string | null,
    executor: QueryExecutor = this.#database,
  ): Promise<void> {
    await executor
      .update(imBindings)
      .set({
        setupState: state,
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        lastErrorCode,
        updatedAt: this.#now(),
      })
      .where(and(eq(imBindings.setupAttemptId, attemptId), inArray(imBindings.setupState, ACTIVE_SETUP_STATES)));
  }

  #safeActivationCode(error: unknown): string {
    if (error instanceof Error && /^SLACK_[A-Z0-9_]+$/.test(error.message) && error.message.length <= 120) {
      return error.message;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^SLACK_[A-Z0-9_]+$/.test(error.code)
    ) {
      return error.code.slice(0, 120);
    }
    return "SLACK_ACTIVATION_FAILED";
  }
}
