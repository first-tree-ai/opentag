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

const SlackSetupContextSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("awaiting_credentials") }).strict(),
  z
    .object({
      stage: z.literal("awaiting_verification"),
      botAccessToken: z.string().min(1),
      signingSecret: z.string().min(1),
      installation: z
        .object({
          appId: z.string().min(1),
          teamId: z.string().min(1),
          enterpriseId: z.string().nullable(),
          botUserId: z.string().min(1),
          botId: z.string().min(1),
          grantedBotScopes: z.array(z.string().min(1)),
        })
        .strict(),
      challengeVerified: z.boolean(),
    })
    .strict(),
]);

type SlackSetupContext = z.infer<typeof SlackSetupContextSchema>;
type AgentSetupFacts = { displayName: string; receiveMode: "mention_only" | "all_message" };

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

export class SlackSetupService {
  readonly #api: SlackApiClient;
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #imBindings: ImBindingService;
  readonly #instanceId: string;
  readonly #now: () => Date;
  readonly #publicOrigin: string;
  readonly #beforeActivationTransaction?: () => Promise<void>;

  constructor(input: {
    api: SlackApiClient;
    cipher: ApplicationCipher;
    database: DatabaseClient;
    imBindings: ImBindingService;
    instanceId: string;
    publicOrigin: string;
    now?: () => Date;
    beforeActivationTransaction?: () => Promise<void>;
  }) {
    this.#api = input.api;
    this.#cipher = input.cipher;
    this.#database = input.database;
    this.#imBindings = input.imBindings;
    this.#instanceId = input.instanceId;
    this.#publicOrigin = input.publicOrigin;
    this.#now = input.now ?? (() => new Date());
    this.#beforeActivationTransaction = input.beforeActivationTransaction;
  }

  async createOrReuse(callerUserId: string, agentId: string, intent: SlackSetupIntent): Promise<SlackSetupAttempt> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const agent = await this.#agent(agentId);
    let current = await this.#currentForAgent(agentId);
    if (
      current?.provider === "slack" &&
      current.setupAttemptId &&
      current.setupState &&
      ACTIVE_SETUP_STATES.includes(current.setupState as (typeof ACTIVE_SETUP_STATES)[number])
    ) {
      if (current.setupExpiresAt && current.setupExpiresAt > this.#now()) return this.#toAttempt(current, agent);
      await this.#expire(current.setupAttemptId);
      current = await this.#currentForAgent(agentId);
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

    const attemptId = randomUUID();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
    const encryptedSetupContext = this.#encrypt({ stage: "awaiting_credentials" });
    const row = await this.#database.transaction(async (transaction) => {
      await this.#imBindings.assertCanManageForMutation(callerUserId, agentId, transaction);
      if (current) {
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
          .where(and(eq(imBindings.id, current.id), ne(imBindings.status, "disabled")))
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
    if (row?.provider !== "slack") {
      throw new SlackSetupServiceError("SLACK_SETUP_NOT_FOUND", 404, "The Slack setup attempt was not found");
    }
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    const agent = await this.#agent(row.agentId);
    if (row.setupExpiresAt && row.setupExpiresAt <= this.#now()) {
      await this.#expire(attemptId);
      throw new SlackSetupServiceError("SLACK_SETUP_EXPIRED", 409, "The Slack setup attempt expired");
    }
    if (row.setupState !== "awaiting_user") {
      if (row.setupState === "validating") return this.#toAttempt(row, agent);
      throw new SlackSetupServiceError("SLACK_SETUP_NOT_ACTIVE", 409, "The Slack setup attempt is not active");
    }
    const currentContext = this.#context(row);
    if (currentContext?.stage !== "awaiting_credentials") {
      throw new SlackSetupServiceError("SLACK_SETUP_CONFLICT", 409, "Slack setup context is not awaiting credentials");
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
      (row.externalAppId !== installation.appId ||
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
      row.externalAppId === installation.appId &&
      row.externalTeamId === installation.teamId &&
      row.externalBotId === installation.botUserId
    ) {
      throw new SlackSetupServiceError(
        "SLACK_REPLACEMENT_REQUIRES_DIFFERENT_APP",
        409,
        "Use reauthorization when the Slack App identity is unchanged",
      );
    }
    const context: SlackSetupContext = {
      stage: "awaiting_verification",
      botAccessToken: input.botAccessToken,
      signingSecret: input.signingSecret,
      installation,
      challengeVerified: false,
    };
    const now = this.#now();
    const [updated] = await this.#database
      .update(imBindings)
      .set({ setupState: "validating", encryptedSetupContext: this.#encrypt(context), updatedAt: now })
      .where(and(eq(imBindings.setupAttemptId, attemptId), eq(imBindings.setupState, "awaiting_user")))
      .returning();
    if (!updated) throw new SlackSetupServiceError("SLACK_SETUP_CONFLICT", 409, "Slack setup changed concurrently");
    return this.#toAttempt(updated, agent);
  }

  async get(callerUserId: string, attemptId: string): Promise<SlackSetupAttempt> {
    const row = await this.#load(attemptId);
    if (row?.provider !== "slack") {
      throw new SlackSetupServiceError("SLACK_SETUP_NOT_FOUND", 404, "The Slack setup attempt was not found");
    }
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    if (
      row.setupExpiresAt &&
      row.setupExpiresAt <= this.#now() &&
      row.setupState &&
      ACTIVE_SETUP_STATES.includes(row.setupState as (typeof ACTIVE_SETUP_STATES)[number])
    ) {
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
    if (!this.#signatureMatches(input, context.signingSecret)) {
      throw new SlackSetupServiceError("SLACK_SIGNING_SECRET_INVALID", 401, "Slack request signature did not match");
    }
    const payload = z
      .object({ type: z.literal("url_verification"), challenge: z.string().min(1).max(4096) })
      .passthrough()
      .parse(JSON.parse(input.rawBody.toString("utf8")));
    if (!context.challengeVerified) {
      const next = { ...context, challengeVerified: true } satisfies SlackSetupContext;
      await this.#database
        .update(imBindings)
        .set({ encryptedSetupContext: this.#encrypt(next), updatedAt: this.#now() })
        .where(
          and(
            eq(imBindings.id, row.id),
            eq(imBindings.setupAttemptId, row.setupAttemptId),
            eq(imBindings.setupState, "validating"),
            gt(imBindings.setupExpiresAt, this.#now()),
          ),
        );
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
  }): Promise<SlackIngressBinding | undefined> {
    const row = await this.#pendingForAgent(input.agentId);
    const context = row ? this.#context(row) : undefined;
    if (!row?.setupAttemptId || context?.stage !== "awaiting_verification") return undefined;
    if (!this.#signatureMatches(input, context.signingSecret)) return undefined;
    if (!context.challengeVerified) {
      throw new SlackSetupServiceError(
        "SLACK_SIGNING_CHALLENGE_REQUIRED",
        409,
        "Verify the Slack Events Request URL before activating the binding",
      );
    }
    if (context.installation.appId !== input.appId || context.installation.teamId !== input.teamId) {
      await this.#fail(row.setupAttemptId, "SLACK_BINDING_IDENTITY_MISMATCH");
      throw new SlackSetupServiceError(
        "SLACK_BINDING_IDENTITY_MISMATCH",
        409,
        "The signed Slack event did not match the token installation identity",
      );
    }
    await this.#beforeActivationTransaction?.();
    const attemptId = row.setupAttemptId;
    try {
      const activated = await this.#database.transaction(async (transaction) =>
        this.#activateCurrentAttempt(transaction, input, row.id, attemptId),
      );
      if (!activated) return undefined;
    } catch (error) {
      await this.#fail(attemptId, this.#safeActivationCode(error));
      throw error;
    }
    const binding = await this.#imBindings.findSlackIngressBindingForAgent(row.agentId);
    if (!binding)
      throw new SlackSetupServiceError("SLACK_ACTIVATION_INCOMPLETE", 500, "Slack activation did not converge");
    return binding;
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
    if (!context.challengeVerified) {
      throw new SlackSetupServiceError(
        "SLACK_SIGNING_CHALLENGE_REQUIRED",
        409,
        "Verify the Slack Events Request URL before activating the binding",
      );
    }
    if (context.installation.appId !== input.appId || context.installation.teamId !== input.teamId) return undefined;
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
      appId: context.installation.appId,
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

  async #agent(agentId: string): Promise<AgentSetupFacts> {
    const [agent] = await this.#database
      .select({ displayName: agents.displayName, receiveMode: agents.receiveMode })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw new SlackSetupServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    return agent;
  }

  async #currentForAgent(agentId: string): Promise<typeof imBindings.$inferSelect | undefined> {
    const [row] = await this.#database
      .select()
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    return row;
  }

  async #pendingForAgent(agentId: string): Promise<typeof imBindings.$inferSelect | undefined> {
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

  async #load(attemptId: string): Promise<typeof imBindings.$inferSelect | undefined> {
    const [row] = await this.#database
      .select()
      .from(imBindings)
      .where(eq(imBindings.setupAttemptId, attemptId))
      .limit(1);
    return row;
  }

  #context(row: typeof imBindings.$inferSelect): SlackSetupContext | undefined {
    if (!row.encryptedSetupContext) return undefined;
    return SlackSetupContextSchema.parse(JSON.parse(this.#cipher.decrypt(row.encryptedSetupContext)));
  }

  #encrypt(context: SlackSetupContext): string {
    return this.#cipher.encrypt(JSON.stringify(context));
  }

  #eventsUrl(agentId: string): string {
    return new URL(agentSlackEventsPath(agentId), this.#publicOrigin).toString();
  }

  #manifestUrl(agentId: string, agent: AgentSetupFacts, targetReceiveMode: AgentSetupFacts["receiveMode"]): string {
    const name = `${agent.displayName} - OpenTag`.slice(0, 35);
    const manifest = {
      _metadata: { major_version: 1 },
      display_information: { name },
      features: { bot_user: { display_name: name, always_online: false } },
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
    const url = new URL("https://api.slack.com/apps");
    url.searchParams.set("new_app", "1");
    url.searchParams.set("manifest_json", JSON.stringify(manifest));
    return url.toString();
  }

  #toAttempt(row: typeof imBindings.$inferSelect, agent: AgentSetupFacts): SlackSetupAttempt {
    if (!row.setupAttemptId || !row.setupIntent || !row.setupState) {
      throw new SlackSetupServiceError("SLACK_SETUP_NOT_FOUND", 404, "The Slack setup attempt was not found");
    }
    const context = this.#context(row);
    const targetReceiveMode = this.#targetReceiveMode(row, agent);
    const terminal = !ACTIVE_SETUP_STATES.includes(row.setupState as (typeof ACTIVE_SETUP_STATES)[number]);
    const state =
      row.setupState === "awaiting_user"
        ? ("awaiting_credentials" as const)
        : row.setupState === "validating"
          ? ("awaiting_verification" as const)
          : row.setupState;
    return {
      id: row.setupAttemptId,
      agentId: row.agentId,
      intent: row.setupIntent,
      state,
      manifestUrl: this.#manifestUrl(row.agentId, agent, targetReceiveMode),
      eventsUrl: this.#eventsUrl(row.agentId),
      requiredBotScopes: requiredSlackBotScopes(targetReceiveMode),
      identity:
        context?.stage === "awaiting_verification"
          ? {
              appId: context.installation.appId,
              teamId: context.installation.teamId,
              enterpriseId: context.installation.enterpriseId,
              botUserId: context.installation.botUserId,
            }
          : null,
      expiresAt: (row.setupExpiresAt ?? row.updatedAt).toISOString(),
      errorCode: row.lastErrorCode,
      completedAt: terminal ? row.updatedAt.toISOString() : null,
      createdAt: row.updatedAt.toISOString(),
    };
  }

  async #expire(attemptId: string): Promise<void> {
    await this.#finish(attemptId, "expired", "SLACK_SETUP_EXPIRED");
  }

  #targetReceiveMode(
    row: typeof imBindings.$inferSelect,
    agent: Pick<AgentSetupFacts, "receiveMode">,
  ): AgentSetupFacts["receiveMode"] {
    return row.pendingReceiveMode ?? agent.receiveMode;
  }

  async #fail(attemptId: string | null, code: string): Promise<void> {
    if (attemptId) await this.#finish(attemptId, "failed", code);
  }

  async #finish(attemptId: string, state: "failed" | "expired", lastErrorCode: string | null): Promise<void> {
    await this.#database
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
