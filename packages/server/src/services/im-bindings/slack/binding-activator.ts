import { type SlackBindingActivation, SlackBindingActivationSchema } from "@opentag/shared";
import type { ImBindingService } from "../im-binding-service.js";
import type { SlackApiClient } from "./adapter.js";

export class SlackBindingActivator {
  readonly #api: SlackApiClient;
  readonly #imBindings: ImBindingService;

  constructor(imBindings: ImBindingService, api: SlackApiClient) {
    this.#imBindings = imBindings;
    this.#api = api;
  }

  async activate(rawInput: SlackBindingActivation): Promise<string> {
    const input = SlackBindingActivationSchema.parse(rawInput);
    const verified = await this.#api.inspectInstallation(input.botAccessToken);
    if (
      verified.appId === null ||
      verified.appId !== input.appId ||
      verified.teamId !== input.teamId ||
      verified.botUserId !== input.botUserId
    ) {
      throw new Error("SLACK_BINDING_IDENTITY_MISMATCH");
    }
    return this.#imBindings.activateSlack(
      {
        ...input,
        enterpriseId: verified.enterpriseId ?? undefined,
        grantedBotScopes: verified.grantedBotScopes,
      },
      verified.botId,
    );
  }
}
