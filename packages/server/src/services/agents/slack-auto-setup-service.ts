import {
  SLACK_INTERACTIONS_PATH,
  type SlackAutoSetupCommand,
  type SlackAutoSetupRequest,
  type SlackAutoSetupResponse,
  type SlackAutoSetupRuntimeResult,
  type SlackConfigurationView,
  type SlackProvisionCredentials,
} from "@opentag/shared";
import type { SlackAutoSetupOwner } from "../../runtime/slack-auto-setup-owner.js";
import { type SlackConfigurationService, SlackConfigurationServiceError } from "../im-bindings/slack/index.js";
import type { AgentService } from "./agent-service.js";
import { AgentServiceError } from "./errors.js";

export class SlackAutoSetupService {
  constructor(
    readonly options: {
      agents: Pick<AgentService, "getConfigById">;
      slack: Pick<SlackConfigurationService, "view" | "configureToken">;
      owner: Pick<SlackAutoSetupOwner, "start">;
      publicOrigin: string;
      officialSigningSecret?: string;
    },
  ) {}
  async run(accountId: string, agentId: string, input: SlackAutoSetupRequest): Promise<SlackAutoSetupResponse> {
    const config = await this.options.agents.getConfigById(accountId, agentId);
    if (!config.computerId)
      throw new AgentServiceError("AGENT_COMPUTER_NOT_BOUND", "deterministic", "Connect a Computer first", 409);
    const view = await this.options.slack.view(
      accountId,
      agentId,
      this.options.publicOrigin,
      this.options.officialSigningSecret,
    );
    if (view.blockedReason)
      throw new SlackConfigurationServiceError(view.blockedReason, 409, "Slack configuration is unavailable");
    if (view.binding && view.binding.identity.provider !== "slack")
      throw new SlackConfigurationServiceError(
        "SLACK_CONFIGURATION_CONFLICT",
        409,
        "Another messaging App is already bound",
      );
    this.#checkRecovery(view);
    const computerId = config.computerId;
    if (input.action === "authorize")
      return publicResult(
        await this.#dispatch(computerId, agentId, { action: "authorize", ...(input.force ? { force: true } : {}) }),
      );
    if (view.binding) return this.#callbacks(computerId, agentId, view, input.challenge);
    const installed = await this.#dispatch(computerId, agentId, {
      action: "install",
      displayName: config.name,
      ...(input.challenge ? { challenge: input.challenge } : {}),
    });
    if (installed.status !== "installed") return installed;
    await this.#checkPlacement(accountId, agentId, computerId);
    await this.#bind(accountId, agentId, installed.credentials);
    await this.#checkPlacement(accountId, agentId, computerId);
    return this.#callbacks(
      computerId,
      agentId,
      await this.options.slack.view(accountId, agentId, this.options.publicOrigin, this.options.officialSigningSecret),
    );
  }
  #dispatch(computerId: string, agentId: string, input: SlackAutoSetupCommand) {
    return this.options.owner.start({ computerId, agentId, input });
  }
  #checkRecovery(view: SlackConfigurationView) {
    if (view.binding && view.preferredRecovery === "oauth")
      throw new SlackConfigurationServiceError(
        "SLACK_CONFIGURATION_CONFLICT",
        409,
        "Use OAuth to reconnect the official Slack App",
      );
  }
  async #checkPlacement(accountId: string, agentId: string, computerId: string) {
    const latest = await this.options.agents.getConfigById(accountId, agentId);
    if (latest.computerId !== computerId)
      throw new SlackConfigurationServiceError(
        "SLACK_CONFIGURATION_CONFLICT",
        409,
        "The Agent moved to another Computer",
      );
  }
  async #bind(accountId: string, agentId: string, credentials: SlackProvisionCredentials) {
    const current = await this.options.slack.view(
      accountId,
      agentId,
      this.options.publicOrigin,
      this.options.officialSigningSecret,
    );
    if (current.binding) {
      const identity = current.binding.identity;
      if (
        identity.provider !== "slack" ||
        identity.appId !== credentials.appId ||
        identity.teamId !== credentials.teamId ||
        identity.botUserId !== credentials.botUserId
      )
        throw new SlackConfigurationServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          "The Agent already has a different binding",
        );
      return;
    }
    await this.options.slack.configureToken(
      accountId,
      agentId,
      {
        intent: "create",
        expectedMessaging: { kind: "unbound" },
        botAccessToken: credentials.botAccessToken,
        signingSecret: credentials.signingSecret,
      },
      credentials,
    );
  }
  async #callbacks(
    computerId: string,
    agentId: string,
    view: SlackConfigurationView,
    challenge?: string,
  ): Promise<SlackAutoSetupResponse> {
    this.#checkRecovery(view);
    if (view.binding?.identity.provider !== "slack" || view.binding.reauthorizationRequired)
      throw new SlackConfigurationServiceError(
        "SLACK_CREDENTIALS_UNAVAILABLE",
        409,
        "Update Slack credentials manually",
      );
    const identity = view.binding.identity;
    return publicResult(
      await this.#dispatch(computerId, agentId, {
        action: "callbacks",
        ...(challenge ? { challenge } : {}),
        appId: identity.appId,
        teamId: identity.teamId,
        botUserId: identity.botUserId,
        enterpriseId: identity.enterpriseId,
        eventsUrl: view.eventsUrl,
        interactionsUrl: new URL(SLACK_INTERACTIONS_PATH, this.options.publicOrigin).toString(),
      }),
    );
  }
}
function publicResult(result: SlackAutoSetupRuntimeResult["result"]): SlackAutoSetupResponse {
  return result.status === "installed" ? { status: "failed", code: "failed" } : result;
}
