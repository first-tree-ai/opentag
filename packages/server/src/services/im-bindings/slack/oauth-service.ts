import {
  SLACK_REQUIRED_BOT_SCOPES,
  type SlackConfigurationIntent,
  type SlackConfigurationResult,
  type StartSlackOAuthResponse,
} from "@opentag/shared";
import { and, eq, isNull, lte } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { slackOAuthNonces } from "../../../db/schema/index.js";
import { AuthServiceError } from "../../auth/errors.js";
import { hashSecret } from "../../auth/security.js";
import { ImBindingServiceError } from "../im-binding-service.js";
import type { SlackApiClient } from "./adapter.js";
import { type SlackConfigurationService, SlackConfigurationServiceError } from "./configuration-service.js";
import type { SlackOAuthStateService } from "./oauth-state.js";

export interface SlackOAuthAppConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  redirectUrl: string;
}

export interface SlackOAuthStartResult extends StartSlackOAuthResponse {
  sessionBinding: string;
}

export interface SlackOAuthCallbackInput {
  accessToken?: string;
  code?: string;
  error?: string;
  sessionBinding?: string;
  state: string;
}

export interface SlackOAuthCallbackSuccess {
  agentId: string;
  result: SlackConfigurationResult;
}

function oauthFailed(message = "The Slack authorization flow is invalid or expired"): never {
  throw new SlackConfigurationServiceError("SLACK_OAUTH_FAILED", 401, message, "credential");
}

export class SlackOAuthService {
  readonly #api: SlackApiClient;
  readonly #app: SlackOAuthAppConfig;
  readonly #authenticateUser: (accessToken: string) => Promise<{ userId: string }>;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #slack: SlackConfigurationService;
  readonly #state: SlackOAuthStateService;

  constructor(input: {
    api: SlackApiClient;
    app: SlackOAuthAppConfig;
    authenticateUser: (accessToken: string) => Promise<{ userId: string }>;
    database: DatabaseClient;
    slack: SlackConfigurationService;
    state: SlackOAuthStateService;
    now?: () => Date;
  }) {
    this.#api = input.api;
    this.#app = input.app;
    this.#authenticateUser = input.authenticateUser;
    this.#database = input.database;
    this.#now = input.now ?? (() => new Date());
    this.#slack = input.slack;
    this.#state = input.state;
  }

  async start(callerUserId: string, agentId: string, intent: SlackConfigurationIntent): Promise<SlackOAuthStartResult> {
    const expectedBinding = await this.#slack.currentBinding(callerUserId, agentId);
    if (intent === "create" && expectedBinding) {
      throw new SlackConfigurationServiceError(
        "SLACK_CONFIGURATION_CONFLICT",
        409,
        "Create cannot replace an existing Slack binding",
      );
    }
    if (intent === "reauthorize" && !expectedBinding) {
      throw new SlackConfigurationServiceError(
        "SLACK_CONFIGURATION_CONFLICT",
        409,
        "Slack reauthorize requires a current configured binding",
      );
    }

    const issued = await this.#state.issue({
      userId: callerUserId,
      agentId,
      intent,
      expectedBinding,
    });
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      await transaction.delete(slackOAuthNonces).where(lte(slackOAuthNonces.expiresAt, now));
      await transaction
        .update(slackOAuthNonces)
        .set({ consumedAt: now })
        .where(
          and(
            eq(slackOAuthNonces.userId, callerUserId),
            eq(slackOAuthNonces.agentId, agentId),
            isNull(slackOAuthNonces.consumedAt),
          ),
        );
      await transaction.insert(slackOAuthNonces).values({
        nonceHash: issued.nonceHash,
        userId: callerUserId,
        agentId,
        intent,
        expectedBindingId: expectedBinding?.id,
        expectedCredentialGeneration: expectedBinding?.credentialGeneration,
        sessionBindingHash: issued.payload.sessionBindingHash,
        expiresAt: issued.expiresAt,
        createdAt: now,
      });
    });

    const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizationUrl.searchParams.set("client_id", this.#app.clientId);
    authorizationUrl.searchParams.set("scope", SLACK_REQUIRED_BOT_SCOPES.join(","));
    authorizationUrl.searchParams.set("redirect_uri", this.#app.redirectUrl);
    authorizationUrl.searchParams.set("state", issued.state);
    return {
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: issued.expiresAt.toISOString(),
      sessionBinding: issued.sessionBinding,
    };
  }

  async callback(input: SlackOAuthCallbackInput): Promise<SlackOAuthCallbackSuccess> {
    const payload = await this.#state.verify(input.state, input.sessionBinding);
    try {
      return await this.#complete(payload, input);
    } catch (error) {
      if (
        error instanceof SlackConfigurationServiceError ||
        error instanceof AuthServiceError ||
        error instanceof ImBindingServiceError
      ) {
        Object.assign(error, { slackOAuthAgentId: payload.agentId });
      }
      throw error;
    }
  }

  async #complete(
    payload: Awaited<ReturnType<SlackOAuthStateService["verify"]>>,
    input: SlackOAuthCallbackInput,
  ): Promise<SlackOAuthCallbackSuccess> {
    if (!input.accessToken) {
      throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Authentication is required", 401);
    }
    const authenticated = await this.#authenticateUser(input.accessToken);
    if (authenticated.userId !== payload.userId) {
      throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Authentication is required", 401);
    }

    const now = this.#now();
    const consumed = await this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(slackOAuthNonces)
        .set({ consumedAt: now })
        .where(
          and(
            eq(slackOAuthNonces.nonceHash, hashSecret(payload.nonce)),
            eq(slackOAuthNonces.userId, payload.userId),
            eq(slackOAuthNonces.agentId, payload.agentId),
            isNull(slackOAuthNonces.consumedAt),
          ),
        )
        .returning();
      return row;
    });
    if (!consumed || consumed.expiresAt.getTime() <= now.getTime() || consumed.intent !== payload.intent) {
      oauthFailed();
    }
    if (consumed.sessionBindingHash !== payload.sessionBindingHash) oauthFailed();
    const storedExpected =
      consumed.expectedBindingId && consumed.expectedCredentialGeneration
        ? { id: consumed.expectedBindingId, credentialGeneration: consumed.expectedCredentialGeneration }
        : null;
    if (
      storedExpected?.id !== payload.expectedBinding?.id ||
      storedExpected?.credentialGeneration !== payload.expectedBinding?.credentialGeneration
    ) {
      oauthFailed();
    }

    if (input.error || !input.code) {
      oauthFailed(input.error === "access_denied" ? "Slack authorization was cancelled" : undefined);
    }

    const installation = await this.#exchange(input.code);
    const result = await this.#slack.configure(payload.userId, payload.agentId, {
      intent: payload.intent,
      expectedBinding: payload.expectedBinding,
      appId: installation.appId,
      botAccessToken: installation.botAccessToken,
      signingSecret: this.#app.signingSecret,
    });
    return { agentId: payload.agentId, result };
  }

  async #exchange(code: string): Promise<{ appId: string; botAccessToken: string }> {
    try {
      return await this.#api.oauthAccess({
        clientId: this.#app.clientId,
        clientSecret: this.#app.clientSecret,
        code,
        redirectUri: this.#app.redirectUrl,
      });
    } catch (error) {
      const codeName = error instanceof Error ? error.message : "";
      if (codeName === "SLACK_AUTH_INVALID" || codeName === "SLACK_AUTH_REJECTED") {
        const failure = new SlackConfigurationServiceError(
          "SLACK_OAUTH_FAILED",
          401,
          "The Slack authorization flow is invalid or expired",
          "credential",
        );
        if (error instanceof Error && typeof error.cause === "string") {
          Object.assign(failure, { upstreamSlackError: error.cause.slice(0, 128) });
        }
        throw failure;
      }
      if (codeName === "SLACK_AUTH_IDENTITY_INCOMPLETE") {
        throw new SlackConfigurationServiceError(
          "SLACK_AUTH_IDENTITY_INCOMPLETE",
          400,
          "Slack did not identify this authorization as an installed Bot User",
          "credential",
        );
      }
      throw new SlackConfigurationServiceError(
        "SLACK_UPSTREAM_UNAVAILABLE",
        502,
        "Slack did not return a usable installation identity",
        "transient",
      );
    }
  }
}
