import {
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackAppConfiguration,
} from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { SlackConfiguration } from "./slack-configuration.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const bindingId = "2a63a21e-f6c7-4474-91ea-4dabf0566a24";
const manifest = {
  display_information: { name: "Assistant - OpenTag" },
  oauth_config: { scopes: { bot: [...SLACK_REQUIRED_BOT_SCOPES] } },
  settings: { event_subscriptions: { bot_events: [...SLACK_SUBSCRIBED_BOT_EVENTS] } },
};

function configuration(currentBinding: SlackAppConfiguration["currentBinding"] = null): SlackAppConfiguration {
  return {
    agentId,
    manifest,
    manifestUrl: "https://api.slack.com/apps?new_app=1&manifest_json=example",
    eventsUrl: `https://opentag.example.com/api/v1/agents/${agentId}/im-binding/slack/events`,
    requiredBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    subscribedBotEvents: [...SLACK_SUBSCRIBED_BOT_EVENTS],
    currentBinding,
  };
}

function Harness({ onSuccess = () => undefined }: { onSuccess?: () => void }) {
  return (
    <SlackConfiguration agentId={agentId} onSuccess={onSuccess}>
      {(control) => (
        <>
          <button type="button" onClick={() => void control.open("create")}>
            Create
          </button>
          <button type="button" onClick={() => void control.open("reauthorize")}>
            Reauthorize
          </button>
          <button type="button" onClick={() => void control.open("replace")}>
            Replace
          </button>
          {control.feedback}
        </>
      )}
    </SlackConfiguration>
  );
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Slack App ID"), { target: { value: "A123" } });
  fireEvent.change(screen.getByLabelText("Bot User OAuth Token"), { target: { value: "xoxb-token" } });
  fireEvent.change(screen.getByLabelText("Signing Secret"), { target: { value: "signing-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Slack configuration" }));
}

afterEach(() => vi.restoreAllMocks());

describe("SlackConfiguration", () => {
  it("opens a stateless guide with the fixed full scopes and events", async () => {
    const get = vi.spyOn(browserApi, "slackAppConfiguration").mockResolvedValue(configuration());
    render(<Harness />);

    const open = screen.getByRole("button", { name: "Create" });
    fireEvent.click(open);
    fireEvent.click(open);

    expect(await screen.findByText(`Required bot scopes: ${SLACK_REQUIRED_BOT_SCOPES.join(", ")}.`)).toBeTruthy();
    expect(screen.getByText(`Subscribed bot events: ${SLACK_SUBSCRIBED_BOT_EVENTS.join(", ")}.`)).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(agentId);
    expect(JSON.parse((screen.getByLabelText("Slack App manifest JSON") as HTMLTextAreaElement).value)).toEqual(
      manifest,
    );
  });

  it("atomically submits App ID, token, secret, and the current generation", async () => {
    const currentBinding = { id: bindingId, appId: "A123", credentialGeneration: 4 };
    vi.spyOn(browserApi, "slackAppConfiguration").mockResolvedValue(configuration(currentBinding));
    const configure = vi.spyOn(browserApi, "configureSlackApp").mockResolvedValue({} as never);
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    expect(await screen.findByLabelText("Slack App ID")).toMatchObject({ value: "A123", readOnly: true });
    fillAndSubmit();

    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    expect(configure).toHaveBeenCalledWith(agentId, {
      intent: "reauthorize",
      expectedBinding: { id: bindingId, credentialGeneration: 4 },
      appId: "A123",
      botAccessToken: "xoxb-token",
      signingSecret: "signing-secret",
    });
    expect(await screen.findByText(/no test message is required to save this generation/)).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("xoxb-token");
    expect(document.body.textContent).not.toContain("signing-secret");
  });

  it.each([
    ["Create", "create", null],
    ["Replace", "replace", { id: bindingId, appId: "A_CURRENT", credentialGeneration: 4 }],
  ] as const)("sends the explicit %s intent", async (button, intent, currentBinding) => {
    vi.spyOn(browserApi, "slackAppConfiguration").mockResolvedValue(configuration(currentBinding));
    const configure = vi.spyOn(browserApi, "configureSlackApp").mockResolvedValue({} as never);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: button }));
    await screen.findByLabelText("Slack App ID");
    fillAndSubmit();

    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    expect(configure).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        intent,
        expectedBinding: currentBinding
          ? { id: currentBinding.id, credentialGeneration: currentBinding.credentialGeneration }
          : null,
      }),
    );
  });

  it("labels App ID as configured evidence and maps validation errors", async () => {
    vi.spyOn(browserApi, "slackAppConfiguration").mockResolvedValue(configuration());
    vi.spyOn(browserApi, "configureSlackApp").mockRejectedValue(
      new ApiError(422, "missing scopes", "SLACK_SCOPE_REAUTH_REQUIRED", "validation"),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/not presented as Slack API-attested identity/)).toBeTruthy();
    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The installed App is missing required bot scopes. Apply the complete manifest, reinstall the App, and retry.",
    );
  });

  it("cancels locally without writing or creating server setup state", async () => {
    vi.spyOn(browserApi, "slackAppConfiguration").mockResolvedValue(configuration());
    const configure = vi.spyOn(browserApi, "configureSlackApp");
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Slack App ID")).toBeNull();
    expect(configure).not.toHaveBeenCalled();
  });
});
