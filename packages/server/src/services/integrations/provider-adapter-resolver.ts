import { FeishuAdapter } from "./feishu/adapter.js";
import type { IntegrationService } from "./integration-service.js";
import type { ImProviderAdapter } from "./provider-adapter.js";
import { SlackAdapter, type SlackApiClient } from "./slack/adapter.js";

export class ProviderAdapterResolutionError extends Error {
  constructor(readonly code: "INTEGRATION_ADAPTER_UNAVAILABLE" | "INTEGRATION_GENERATION_STALE") {
    super(code);
    this.name = "ProviderAdapterResolutionError";
  }
}

export function createImProviderAdapterResolver(input: {
  integrations: IntegrationService;
  slackApi: SlackApiClient;
  createFeishuAdapter?: (options: {
    appId: string;
    appSecret: string;
    teamId: string | null;
    teamBrand: "feishu" | "lark" | null;
  }) => ImProviderAdapter<unknown>;
}): (integrationId: string, generation: number) => Promise<ImProviderAdapter<unknown>> {
  const createFeishuAdapter =
    input.createFeishuAdapter ??
    ((options) => new FeishuAdapter({ ...options, channel: null }) as ImProviderAdapter<unknown>);
  return async (integrationId, generation) => {
    const slack = await input.integrations.getSlackConnectionMaterial(integrationId);
    if (slack) {
      if (slack.generation !== generation) {
        throw new ProviderAdapterResolutionError("INTEGRATION_GENERATION_STALE");
      }
      return new SlackAdapter({
        api: input.slackApi,
        token: slack.botAccessToken,
        appId: slack.appId,
        teamId: slack.teamId,
        botUserId: slack.botUserId,
      });
    }
    const feishu = await input.integrations.getFeishuConnectionMaterial(integrationId);
    if (!feishu) throw new ProviderAdapterResolutionError("INTEGRATION_ADAPTER_UNAVAILABLE");
    if (feishu.generation !== generation) {
      throw new ProviderAdapterResolutionError("INTEGRATION_GENERATION_STALE");
    }
    return createFeishuAdapter({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      teamId: feishu.teamId,
      teamBrand: feishu.teamBrand,
    });
  };
}
