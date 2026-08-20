import { type SlackBindingActivation, SlackBindingActivationSchema } from "@opentag/shared";
import type { IntegrationService } from "../integration-service.js";
import type { SlackApiClient } from "./adapter.js";

export class SlackBindingActivator {
  readonly #api: SlackApiClient;
  readonly #integrations: IntegrationService;

  constructor(integrations: IntegrationService, api: SlackApiClient) {
    this.#integrations = integrations;
    this.#api = api;
  }

  async activate(rawInput: SlackBindingActivation): Promise<string> {
    const input = SlackBindingActivationSchema.parse(rawInput);
    const verified = await this.#api.authTest(input.botAccessToken);
    if (verified.appId !== input.appId || verified.teamId !== input.teamId || verified.botUserId !== input.botUserId) {
      throw new Error("SLACK_BINDING_IDENTITY_MISMATCH");
    }
    return this.#integrations.activateSlack(input);
  }
}
