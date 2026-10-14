import {
  type AgentRuntimeProvider,
  type ProvisionSlackAgentRequest,
  type ProvisionSlackAgentResponse,
  SLACK_INTERACTIONS_PATH,
} from "@opentag/shared";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents } from "../../db/schema/index.js";
import { consumeAccountConnectCode } from "../auth/connect-code-service.js";
import { type SlackConfigurationService, SlackConfigurationServiceError } from "../im-bindings/slack/index.js";
import type { SessionCliProofService } from "../sessions/session-cli-proof-service.js";
import type { AgentService } from "./agent-service.js";
import { AgentServiceError, resourceNotFound } from "./errors.js";

export interface AgentSlackProvisionServiceOptions {
  database: DatabaseClient;
  proofs: Pick<SessionCliProofService, "authenticate">;
  agents: Pick<AgentService, "createForAccount">;
  slack: Pick<SlackConfigurationService, "view" | "configureToken">;
  publicOrigin: string;
}

/** One Account confirmation, one new creation intent; never delegates general Account authority. */
export class AgentSlackProvisionService {
  constructor(private readonly options: AgentSlackProvisionServiceOptions) {}

  async authenticate(proof: string): Promise<{
    accountId: string;
    computerId: string;
    runtimeProvider: AgentRuntimeProvider;
  }> {
    const source = await this.options.proofs.authenticate(proof);
    const [agent] = await this.options.database
      .select({ accountId: agents.createdByUserId, runtimeProvider: agents.runtimeProvider })
      .from(agents)
      .where(and(eq(agents.id, source.agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw resourceNotFound();
    // This operation has its own Account confirmation. The self-configuration switch keeps its existing meaning.
    return {
      ...agent,
      computerId: source.computerId,
    };
  }

  async provision(
    scope: { accountId: string; computerId: string; runtimeProvider: AgentRuntimeProvider },
    input: ProvisionSlackAgentRequest,
  ): Promise<ProvisionSlackAgentResponse> {
    const { accountId } = scope;
    if (input.agent.runtimeProvider !== scope.runtimeProvider) {
      throw new AgentServiceError(
        "AGENT_FORBIDDEN",
        "deterministic",
        "Slack provisioning must use the source Agent's Runtime Provider",
        403,
      );
    }
    await consumeAccountConnectCode(this.options.database, input.code, "slack-agent-provision", accountId);
    const agent = await this.options.agents.createForAccount(accountId, {
      ...input.agent,
      computerId: scope.computerId,
      runtimeProvider: scope.runtimeProvider,
    });
    const interactionsUrl = new URL(SLACK_INTERACTIONS_PATH, this.options.publicOrigin).toString();
    const current = await this.options.slack.view(accountId, agent.id, this.options.publicOrigin);
    if (current.binding) {
      const identity = current.binding.identity;
      if (
        identity.provider !== "slack" ||
        identity.appId !== input.slack.appId ||
        identity.teamId !== input.slack.teamId ||
        identity.botUserId !== input.slack.botUserId
      ) {
        throw new SlackConfigurationServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          "This creation intent already has a different messaging binding",
        );
      }
      // Return live state, including any recovery requirement. A replay never rotates or replaces credentials.
      return { agent, slack: current, interactionsUrl };
    }
    if (current.blockedReason) {
      throw new SlackConfigurationServiceError(current.blockedReason, 409, "The new Agent cannot connect Slack yet");
    }
    await this.options.slack.configureToken(
      accountId,
      agent.id,
      {
        intent: "create",
        expectedMessaging: { kind: "unbound" },
        botAccessToken: input.slack.botAccessToken,
        signingSecret: input.slack.signingSecret,
      },
      input.slack,
    );
    return {
      agent,
      slack: await this.options.slack.view(accountId, agent.id, this.options.publicOrigin),
      interactionsUrl,
    };
  }
}
