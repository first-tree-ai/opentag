import {
  agentSlackEventsPath,
  type ConfigureSlackAppRequest,
  type ErrorCategory,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackAppConfiguration,
  type SlackBindingActivation,
} from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../../db/client.js";
import { agents, imBindings } from "../../../db/schema/index.js";
import type { ImBindingService } from "../im-binding-service.js";
import type { SlackApiClient, SlackInstallationInspection } from "./adapter.js";

type QueryExecutor = DatabaseClient | DatabaseTransaction;

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
  readonly #beforeConfigurationTransaction?: () => Promise<void>;
  readonly #database: DatabaseClient;
  readonly #imBindings: ImBindingService;
  readonly #now: () => Date;
  readonly #publicOrigin: string;

  constructor(input: {
    api: SlackApiClient;
    database: DatabaseClient;
    imBindings: ImBindingService;
    publicOrigin: string;
    now?: () => Date;
    beforeConfigurationTransaction?: () => Promise<void>;
  }) {
    this.#api = input.api;
    this.#beforeConfigurationTransaction = input.beforeConfigurationTransaction;
    this.#database = input.database;
    this.#imBindings = input.imBindings;
    this.#now = input.now ?? (() => new Date());
    this.#publicOrigin = input.publicOrigin;
  }

  async get(callerUserId: string, agentId: string): Promise<SlackAppConfiguration> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const { agent, current } = await this.#facts(agentId);
    if (current && current.provider !== "slack") {
      throw new SlackConfigurationServiceError(
        "IM_BINDING_PROVIDER_IMMUTABLE",
        409,
        "Disable the current IM binding before configuring Slack",
      );
    }
    return this.#configuration(agentId, agent.displayName, current);
  }

  async configure(callerUserId: string, agentId: string, input: ConfigureSlackAppRequest): Promise<string> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const installation = await this.#inspect(input.botAccessToken);
    this.#validateInstallation(input.appId, installation);
    await this.#beforeConfigurationTransaction?.();

    return this.#database.transaction(async (transaction) => {
      // Token inspection is external. Reacquire live Team authority and serialize the Agent's
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
      const configuredCurrent =
        current?.encryptedCredential && current.credentialGeneration >= 1 && current.externalAppId
          ? current
          : undefined;
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
          "The Slack binding changed since the configuration was read",
        );
      }

      const activation: SlackBindingActivation = {
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
      throw new SlackConfigurationServiceError(
        "SLACK_UPSTREAM_UNAVAILABLE",
        502,
        "Slack did not return a usable installation identity",
        "transient",
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

  async #facts(agentId: string): Promise<{
    agent: { displayName: string };
    current: typeof imBindings.$inferSelect | undefined;
  }> {
    const agent = await this.#agent(agentId, this.#database);
    const current = await this.#current(agentId, this.#database, false);
    return { agent, current };
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

  #configuration(
    agentId: string,
    displayName: string,
    current: typeof imBindings.$inferSelect | undefined,
  ): SlackAppConfiguration {
    const eventsUrl = new URL(agentSlackEventsPath(agentId), this.#publicOrigin).toString();
    const name = `${displayName} - OpenTag`.slice(0, 35);
    const manifest: Record<string, unknown> = {
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
      oauth_config: { scopes: { bot: [...SLACK_REQUIRED_BOT_SCOPES] } },
      settings: {
        event_subscriptions: { request_url: eventsUrl, bot_events: [...SLACK_SUBSCRIBED_BOT_EVENTS] },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    };
    const manifestUrl = new URL("https://api.slack.com/apps");
    manifestUrl.searchParams.set("new_app", "1");
    manifestUrl.searchParams.set("manifest_json", JSON.stringify(manifest));
    const configuredCurrent =
      current?.provider === "slack" &&
      current.encryptedCredential &&
      current.credentialGeneration >= 1 &&
      current.externalAppId
        ? current
        : undefined;
    return {
      agentId,
      manifest,
      manifestUrl: manifestUrl.toString(),
      eventsUrl,
      requiredBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      subscribedBotEvents: [...SLACK_SUBSCRIBED_BOT_EVENTS],
      currentBinding: configuredCurrent
        ? {
            id: configuredCurrent.id,
            appId: configuredCurrent.externalAppId as string,
            credentialGeneration: configuredCurrent.credentialGeneration,
          }
        : null,
    };
  }
}
