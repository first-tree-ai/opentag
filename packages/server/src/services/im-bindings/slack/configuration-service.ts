import { timingSafeEqual } from "node:crypto";
import {
  agentSlackEventsPath,
  type ErrorCategory,
  type SaveSlackConfigurationRequest,
  SLACK_REQUIRED_BOT_SCOPES,
  type SlackBindingActivation,
  type SlackConfigurationIntent,
  type SlackConfigurationResult,
  type SlackConfigurationView,
  type SlackProvisionCredentials,
} from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../../db/client.js";
import { agents, imBindings } from "../../../db/schema/index.js";
import type { ApplicationCipher } from "../../crypto.js";
import {
  type ImBindingService,
  ImBindingUnbindRequiredError,
  type SlackInstallationIngress,
} from "../im-binding-service.js";
import type { SlackApiClient, SlackInstallationInspection } from "./adapter.js";
import { readSlackConfigurationMaterial } from "./configuration-material.js";

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
  readonly #cipher: ApplicationCipher | undefined;
  readonly #api: SlackApiClient;
  readonly #onDiagnostic: (code: string) => void;
  readonly #afterConfigurationTransaction?: () => Promise<void>;
  readonly #beforeConfigurationTransaction?: () => Promise<void>;
  readonly #database: DatabaseClient;
  readonly #imBindings: ImBindingService;
  readonly #now: () => Date;

  constructor(input: {
    cipher?: ApplicationCipher;
    api: SlackApiClient;
    onDiagnostic?: (code: string) => void;
    database: DatabaseClient;
    imBindings: ImBindingService;
    now?: () => Date;
    afterConfigurationTransaction?: () => Promise<void>;
    beforeConfigurationTransaction?: () => Promise<void>;
  }) {
    this.#cipher = input.cipher;
    this.#api = input.api;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
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
      throw new ImBindingUnbindRequiredError({
        currentProvider: current.provider,
        currentBindingId: current.id,
        requestedProvider: "slack",
      });
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
    this.#validateScopes(installation);
    return this.#activate(callerUserId, agentId, input, installation);
  }

  async view(
    callerUserId: string,
    agentId: string,
    publicOrigin: string,
    officialSigningSecret?: string,
  ): Promise<SlackConfigurationView> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const agent = await this.#agent(agentId, this.#database, false);
    const current = await this.#current(agentId, this.#database, false);
    const binding = (await this.#imBindings.getConfigForAgent(callerUserId, agentId)) ?? null;
    const result: SlackConfigurationView = {
      agentDisplayName: agent.displayName,
      eventsUrl: new URL(agentSlackEventsPath(agentId), publicOrigin).toString(),
      allowedIntent: null,
      blockedReason: null,
      expectedMessaging: null,
      preferredRecovery: "credentials",
      binding,
      identityClosure: null,
      handoff: null,
    };
    if (agent.computerId === null) return { ...result, blockedReason: "AGENT_COMPUTER_NOT_BOUND" };
    if (!current) return { ...result, allowedIntent: "create", expectedMessaging: { kind: "unbound" } };
    if (current.provider !== "slack") return { ...result, blockedReason: "IM_BINDING_UNBIND_REQUIRED" };
    const material = await readSlackConfigurationMaterial(this.#database, this.#cipher, agentId);
    if (!material) return { ...result, blockedReason: "SLACK_CREDENTIALS_UNAVAILABLE" };
    if (
      material.generation !== current.credentialGeneration ||
      binding?.id !== current.id ||
      binding.credentialGeneration !== current.credentialGeneration
    ) {
      return { ...result, blockedReason: "SLACK_CONFIGURATION_CONFLICT" };
    }
    const setup = await this.#imBindings.getSetupBindingForAgent(callerUserId, agentId);
    if (setup?.bindingId === current.id && setup.credentialGeneration === current.credentialGeneration)
      result.handoff = setup.handoff;
    result.allowedIntent = "reauthorize";
    result.expectedMessaging = {
      kind: "bound",
      provider: "slack",
      bindingId: current.id,
      credentialGeneration: current.credentialGeneration,
    };
    if (officialSigningSecret && sameSecret(material.signingSecret, officialSigningSecret))
      result.preferredRecovery = "oauth";
    result.identityClosure = {
      status: material.observedConnectedAt ? "verified" : "pending",
      verifiedAt: material.observedConnectedAt?.toISOString() ?? null,
    };
    return result;
  }

  async configureToken(
    callerUserId: string,
    agentId: string,
    input: SaveSlackConfigurationRequest,
    expectedIdentity?: Pick<SlackProvisionCredentials, "appId" | "teamId" | "botUserId">,
  ): Promise<SlackConfigurationResult> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    await this.#agent(agentId, this.#database);
    const current = await this.#current(agentId, this.#database, false);
    const expected = input.expectedMessaging;
    if (current?.provider === "feishu") {
      throw new ImBindingUnbindRequiredError({
        currentProvider: "feishu",
        currentBindingId: current.id,
        requestedProvider: "slack",
      });
    }
    if (
      (expected.kind === "unbound" && current) ||
      (expected.kind === "bound" &&
        (!current ||
          current.id !== expected.bindingId ||
          current.credentialGeneration !== expected.credentialGeneration))
    ) {
      throw new SlackConfigurationServiceError("SLACK_CONFIGURATION_CONFLICT", 409, "The messaging binding changed");
    }
    const previous =
      input.intent === "reauthorize"
        ? await readSlackConfigurationMaterial(this.#database, this.#cipher, agentId)
        : undefined;
    if (
      input.intent === "reauthorize" &&
      (!previous || previous.generation !== input.expectedMessaging.credentialGeneration)
    ) {
      throw new SlackConfigurationServiceError(
        "SLACK_CREDENTIALS_UNAVAILABLE",
        409,
        "Disconnect and reconnect this installation to recover its credentials",
      );
    }
    const botAccessToken = input.botAccessToken || previous?.botAccessToken;
    const signingSecret = input.signingSecret || previous?.signingSecret;
    if (!botAccessToken || !signingSecret)
      throw new SlackConfigurationServiceError(
        "SLACK_CREDENTIALS_REQUIRED",
        400,
        "Both credentials are required for a new installation",
      );
    const installation = await this.#inspect(botAccessToken);
    this.#validateScopes(installation);
    const appId = await this.#inspectApp(botAccessToken, installation);
    this.#validateInstallation(appId, installation);
    assertExpectedSlackIdentity(expectedIdentity, appId, installation);
    assertSameSlackIdentity(previous, appId, installation);
    return this.#activate(
      callerUserId,
      agentId,
      {
        intent: input.intent,
        expectedBinding:
          expected.kind === "bound"
            ? { id: expected.bindingId, credentialGeneration: expected.credentialGeneration }
            : null,
        appId,
        botAccessToken,
        signingSecret,
      },
      installation,
    );
  }

  async #inspectApp(token: string, installation: SlackInstallationInspection): Promise<string> {
    try {
      const bot = await this.#api.botInfo?.(token, installation.botId);
      if (!bot || bot.deleted || bot.id !== installation.botId || bot.userId !== installation.botUserId || !bot.appId) {
        throw new Error("SLACK_AUTH_IDENTITY_INCOMPLETE");
      }
      return bot.appId;
    } catch (error) {
      const incomplete = error instanceof Error && error.message === "SLACK_AUTH_IDENTITY_INCOMPLETE";
      throw new SlackConfigurationServiceError(
        incomplete ? "SLACK_AUTH_IDENTITY_INCOMPLETE" : "SLACK_UPSTREAM_UNAVAILABLE",
        incomplete ? 400 : 502,
        "Slack could not verify this Bot's App identity",
        incomplete ? "credential" : "transient",
      );
    }
  }

  async #activate(
    callerUserId: string,
    agentId: string,
    input: SlackOAuthActivationInput,
    installation: SlackInstallationInspection,
  ): Promise<SlackConfigurationResult> {
    // Profile enrichment must never prevent a valid installation from connecting.
    let profile: SlackBindingActivation["profile"];
    try {
      profile = await this.#api.botProfile?.(input.botAccessToken, installation.botUserId);
    } catch {
      this.#onDiagnostic("SLACK_BOT_PROFILE_UNAVAILABLE");
      profile = undefined;
    }
    await this.#beforeConfigurationTransaction?.();

    const configured = await this.#database.transaction(async (transaction) => {
      // Token inspection is external. Reacquire live Account authority and serialize the Agent's
      // binding immediately before committing the inspected credential snapshot.
      await this.#imBindings.assertCanManageForMutation(callerUserId, agentId, transaction);
      await this.#agent(agentId, transaction);
      const current = await this.#current(agentId, transaction, true);
      if (current && current.provider !== "slack") {
        throw new ImBindingUnbindRequiredError({
          currentProvider: current.provider,
          currentBindingId: current.id,
          requestedProvider: "slack",
        });
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
      this.#validateIntent(input, configuredCurrent);

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
        profile,
      };
      return this.#imBindings.activateSlack(activation, installation.botId, transaction);
    });
    await this.#afterConfigurationTransaction?.();
    await this.#imBindings.notifyProviderCliRequirementChanged(agentId).catch(() => undefined);
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

  #validateIntent(input: SlackOAuthActivationInput, current: typeof imBindings.$inferSelect | undefined): void {
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
  }

  #validateScopes(installation: SlackInstallationInspection): void {
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

  /**
   * Reads the Agent every Slack configuration path needs, and refuses one that has no Computer.
   * The check lives here rather than at the start of the flow because both ends need it: an Account
   * that installs the Slack App first and only then learns the Agent has nowhere to run has been
   * asked for work that could not have succeeded, and an Agent unbound between start and callback
   * would otherwise commit a route to a Computer that no longer exists.
   */
  async #agent(
    agentId: string,
    executor: QueryExecutor,
    requireComputer = true,
  ): Promise<{ displayName: string; computerId: string | null }> {
    const [agent] = await executor
      .select({ computerId: agents.computerId, displayName: agents.displayName })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw new SlackConfigurationServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    if (requireComputer && agent.computerId === null) {
      throw new SlackConfigurationServiceError(
        "AGENT_COMPUTER_NOT_BOUND",
        409,
        "Connect a Computer to this Agent before connecting Slack",
      );
    }
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

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertSameSlackIdentity(
  previous: SlackInstallationIngress | undefined,
  appId: string,
  installation: SlackInstallationInspection,
): void {
  if (!previous) return;
  if (
    previous.appId === appId &&
    previous.teamId === installation.teamId &&
    previous.botUserId === installation.botUserId &&
    previous.botId === installation.botId
  )
    return;
  throw new SlackConfigurationServiceError(
    "SLACK_BINDING_IDENTITY_MISMATCH",
    409,
    "Credential updates must keep the same App, Team and Bot",
    "credential",
  );
}

function assertExpectedSlackIdentity(
  expectedIdentity: Pick<SlackProvisionCredentials, "appId" | "teamId" | "botUserId"> | undefined,
  appId: string,
  installation: SlackInstallationInspection,
): void {
  if (
    expectedIdentity &&
    (appId !== expectedIdentity.appId ||
      installation.teamId !== expectedIdentity.teamId ||
      installation.botUserId !== expectedIdentity.botUserId)
  ) {
    throw new SlackConfigurationServiceError(
      "SLACK_BINDING_IDENTITY_MISMATCH",
      409,
      "The Bot Token does not match the App, Team and Bot being provisioned",
      "credential",
    );
  }
}
