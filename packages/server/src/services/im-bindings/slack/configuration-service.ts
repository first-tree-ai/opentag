import {
  type ErrorCategory,
  SLACK_REQUIRED_BOT_SCOPES,
  type SlackBindingActivation,
  type SlackConfigurationIntent,
  type SlackConfigurationResult,
} from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../../db/client.js";
import { agents, imBindings } from "../../../db/schema/index.js";
import type { ImBindingService } from "../im-binding-service.js";
import type { SlackApiClient, SlackInstallationInspection } from "./adapter.js";

type QueryExecutor = DatabaseClient | DatabaseTransaction;

export interface SlackOAuthExpectedBinding {
  id: string;
  credentialGeneration: number;
}

export interface SlackOAuthActivationInput {
  intent: SlackConfigurationIntent;
  expectedBinding: SlackOAuthExpectedBinding | null;
  appId: string;
  botAccessToken: string;
  signingSecret: string;
}

export class SlackConfigurationServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly category: ErrorCategory = "deterministic",
  ) {
    super(message);
  }
}

export class SlackConfigurationService {
  readonly #api: SlackApiClient;
  readonly #afterConfigurationTransaction?: () => Promise<void>;
  readonly #beforeConfigurationTransaction?: () => Promise<void>;
  readonly #database: DatabaseClient;
  readonly #imBindings: ImBindingService;
  readonly #now: () => Date;

  constructor(input: {
    api: SlackApiClient;
    database: DatabaseClient;
    imBindings: ImBindingService;
    now?: () => Date;
    afterConfigurationTransaction?: () => Promise<void>;
    beforeConfigurationTransaction?: () => Promise<void>;
  }) {
    this.#api = input.api;
    this.#afterConfigurationTransaction = input.afterConfigurationTransaction;
    this.#beforeConfigurationTransaction = input.beforeConfigurationTransaction;
    this.#database = input.database;
    this.#imBindings = input.imBindings;
    this.#now = input.now ?? (() => new Date());
  }

  async currentBinding(callerUserId: string, agentId: string): Promise<SlackOAuthExpectedBinding | null> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    await this.#agent(agentId, this.#database);
    const current = await this.#current(agentId, this.#database, false);
    if (current && current.provider !== "slack") {
      throw new SlackConfigurationServiceError(
        "IM_BINDING_PROVIDER_IMMUTABLE",
        409,
        "Disable the current IM binding before configuring Slack",
      );
    }
    return this.#expectedBinding(current);
  }

  async configure(
    callerUserId: string,
    agentId: string,
    input: SlackOAuthActivationInput,
  ): Promise<SlackConfigurationResult> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const installation = await this.#inspect(input.botAccessToken);
    this.#validateInstallation(input.appId, installation);
    await this.#beforeConfigurationTransaction?.();

    const configured = await this.#database.transaction(async (transaction) => {
      // Token inspection is external. Reacquire live Workspace authority and serialize the Agent's
      // binding immediately before committing the inspected credential snapshot.
      await this.#imBindings.assertCanManageForMutation(callerUserId, agentId, transaction);
      await this.#agent(agentId, transaction);
      const current = await this.#current(agentId, transaction, true);
      if (current && current.provider !== "slack") {
        throw new SlackConfigurationServiceError(
          "IM_BINDING_PROVIDER_IMMUTABLE",
          409,
          "Disable the current IM binding before configuring Slack",
        );
      }
      const configuredCurrent = this.#configuredCurrent(current);
      const expected = input.expectedBinding;
      if (
        (expected === null && configuredCurrent) ||
        (expected !== null &&
          (!configuredCurrent ||
            configuredCurrent.id !== expected.id ||
            configuredCurrent.credentialGeneration !== expected.credentialGeneration))
      ) {
        throw new SlackConfigurationServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          "The Slack binding changed since authorization started",
        );
      }
      this.#validateIntent(input, installation, configuredCurrent);

      const activation: SlackBindingActivation = {
        intent: input.intent,
        agentId,
        appId: input.appId,
        teamId: installation.teamId,
        enterpriseId: installation.enterpriseId ?? undefined,
        botUserId: installation.botUserId,
        grantedBotScopes: installation.grantedBotScopes,
        botAccessToken: input.botAccessToken,
        signingSecret: input.signingSecret,
        installedAt: this.#now(),
      };
      return this.#imBindings.activateSlack(activation, installation.botId, transaction);
    });
    await this.#afterConfigurationTransaction?.();
    return configured;
  }

  async #inspect(token: string): Promise<SlackInstallationInspection> {
    try {
      return await this.#api.inspectInstallation(token);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "SLACK_AUTH_INVALID" || code === "SLACK_AUTH_REJECTED") {
        throw new SlackConfigurationServiceError(
          "SLACK_AUTH_INVALID",
          400,
          "Slack rejected the Bot User OAuth Token",
          "credential",
        );
      }
      if (code === "SLACK_AUTH_IDENTITY_INCOMPLETE") {
        throw new SlackConfigurationServiceError(
          "SLACK_AUTH_IDENTITY_INCOMPLETE",
          400,
          "Slack did not identify this token as an installed Bot User OAuth Token",
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

  #validateIntent(
    input: SlackOAuthActivationInput,
    installation: SlackInstallationInspection,
    current: typeof imBindings.$inferSelect | undefined,
  ): void {
    if (input.intent === "create") {
      if (current) {
        throw new SlackConfigurationServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          "Create cannot replace an existing Slack binding",
        );
      }
      return;
    }
    if (!current?.externalAppId || !current.externalTeamId || !current.externalBotId) {
      throw new SlackConfigurationServiceError(
        "SLACK_CONFIGURATION_CONFLICT",
        409,
        "Slack reauthorize requires a current configured binding",
      );
    }
    if (
      input.appId !== current.externalAppId ||
      installation.teamId !== current.externalTeamId ||
      installation.botUserId !== current.externalBotId
    ) {
      throw new SlackConfigurationServiceError(
        "SLACK_BINDING_IDENTITY_MISMATCH",
        409,
        "Reauthorization must preserve the current Slack App, Team, and Bot identity",
        "credential",
      );
    }
  }

  #validateInstallation(appId: string, installation: SlackInstallationInspection): void {
    if (installation.appId !== null && installation.appId !== appId) {
      throw new SlackConfigurationServiceError(
        "SLACK_BINDING_IDENTITY_MISMATCH",
        409,
        "The configured Slack App ID does not match the Bot Token",
        "credential",
      );
    }
    const granted = new Set(installation.grantedBotScopes);
    const missing = SLACK_REQUIRED_BOT_SCOPES.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new SlackConfigurationServiceError(
        "SLACK_SCOPE_REAUTH_REQUIRED",
        409,
        `The Slack installation is missing required scopes: ${missing.join(", ")}`,
        "credential",
      );
    }
  }

  async #agent(agentId: string, executor: QueryExecutor): Promise<{ displayName: string }> {
    const [agent] = await executor
      .select({ displayName: agents.displayName })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw new SlackConfigurationServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    return agent;
  }

  async #current(
    agentId: string,
    executor: QueryExecutor,
    forUpdate: boolean,
  ): Promise<typeof imBindings.$inferSelect | undefined> {
    const query = executor
      .select()
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (forUpdate) {
      const [row] = await query.for("update");
      return row;
    }
    const [row] = await query;
    return row;
  }

  #configuredCurrent(current: typeof imBindings.$inferSelect | undefined): typeof imBindings.$inferSelect | undefined {
    return current?.provider === "slack" &&
      current.slackInstallationId &&
      current.credentialGeneration >= 1 &&
      current.externalAppId
      ? current
      : undefined;
  }

  #expectedBinding(current: typeof imBindings.$inferSelect | undefined): SlackOAuthExpectedBinding | null {
    const configuredCurrent = this.#configuredCurrent(current);
    return configuredCurrent
      ? {
          id: configuredCurrent.id,
          credentialGeneration: configuredCurrent.credentialGeneration,
        }
      : null;
  }
}
