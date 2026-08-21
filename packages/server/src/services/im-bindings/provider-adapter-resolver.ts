import { FeishuAdapter } from "./feishu/adapter.js";
import type { ImBindingService } from "./im-binding-service.js";
import type { ImProviderAdapter } from "./provider-adapter.js";
import { SlackAdapter, type SlackApiClient } from "./slack/adapter.js";

export class ProviderAdapterResolutionError extends Error {
  constructor(readonly code: "IM_BINDING_ADAPTER_UNAVAILABLE" | "IM_BINDING_GENERATION_STALE") {
    super(code);
    this.name = "ProviderAdapterResolutionError";
  }
}

export function createImProviderAdapterResolver(input: {
  imBindings: ImBindingService;
  slackApi: SlackApiClient;
  createFeishuAdapter?: (options: {
    appId: string;
    appSecret: string;
    teamId: string | null;
    teamBrand: "feishu" | "lark" | null;
  }) => ImProviderAdapter<unknown>;
}): (imBindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>> {
  const createFeishuAdapter =
    input.createFeishuAdapter ??
    ((options) => new FeishuAdapter({ ...options, channel: null }) as ImProviderAdapter<unknown>);
  return async (imBindingId, generation) => {
    const slack = await input.imBindings.getSlackConnectionMaterial(imBindingId);
    if (slack) {
      if (slack.generation !== generation) {
        throw new ProviderAdapterResolutionError("IM_BINDING_GENERATION_STALE");
      }
      return new SlackAdapter({
        api: input.slackApi,
        token: slack.botAccessToken,
        appId: slack.appId,
        teamId: slack.teamId,
        botUserId: slack.botUserId,
        botId: slack.botId,
      });
    }
    const feishu = await input.imBindings.getFeishuConnectionMaterial(imBindingId);
    if (!feishu) throw new ProviderAdapterResolutionError("IM_BINDING_ADAPTER_UNAVAILABLE");
    if (feishu.generation !== generation) {
      throw new ProviderAdapterResolutionError("IM_BINDING_GENERATION_STALE");
    }
    return createFeishuAdapter({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      teamId: feishu.teamId,
      teamBrand: feishu.teamBrand,
    });
  };
}
