import type { SlackSetupAttempt, SlackSetupIntent } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { SlackSetup } from "./slack-setup.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const firstAttemptId = "2a63a21e-f6c7-4474-91ea-4dabf0566a24";
const secondAttemptId = "3a63a21e-f6c7-4474-91ea-4dabf0566a24";
const manifest = {
  display_information: { name: "Assistant - OpenTag" },
  oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write", "files:read", "im:history"] } },
};

function attempt(
  overrides: Partial<SlackSetupAttempt> & Pick<SlackSetupAttempt, "id" | "intent" | "state">,
): SlackSetupAttempt {
  return {
    agentId,
    manifest,
    manifestUrl: "https://api.slack.com/apps?new_app=1&manifest_json=example",
    eventsUrl: `https://opentag.example.com/api/v1/agents/${agentId}/im-binding/slack/events`,
    requiredBotScopes: ["app_mentions:read", "chat:write", "files:read", "im:history"],
    currentAppId: null,
    identity: null,
    challengeVerified: false,
    lastVerificationErrorCode: null,
    lastVerificationAt: null,
    expiresAt: "2026-08-20T00:30:00.000Z",
    errorCode: null,
    completedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const validated = {
  state: "awaiting_verification" as const,
  identity: { appId: "A1", teamId: "T1", enterpriseId: null, botUserId: "U1" },
};

function Harness({ onSuccess = () => undefined }: { onSuccess?: () => void }) {
  return (
    <SlackSetup agentId={agentId} onSuccess={onSuccess}>
      {(setup) => (
        <>
          <button type="button" onClick={() => void setup.start("create")}>
            Create
          </button>
          <button type="button" onClick={() => void setup.start("reauthorize")}>
            Reauthorize
          </button>
          <button type="button" onClick={() => void setup.start("replace")}>
            Replace
          </button>
          {setup.feedback}
        </>
      )}
    </SlackSetup>
  );
}

function fillCredentials(botAccessToken: string, signingSecret: string) {
  fireEvent.change(screen.getByLabelText("Bot User OAuth Token"), { target: { value: botAccessToken } });
  fireEvent.change(screen.getByLabelText("Signing Secret"), { target: { value: signingSecret } });
  fireEvent.click(screen.getByRole("button", { name: "Validate Slack installation" }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SlackSetup", () => {
  it("starts one create attempt with the new-App link and a copyable manifest", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const create = vi
      .spyOn(browserApi, "createSlackSetupAttempt")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "create", state: "awaiting_credentials" }));
    render(<Harness />);

    const button = screen.getByRole("button", { name: "Create" });
    fireEvent.click(button);
    fireEvent.click(button);

    const link = (await screen.findByRole("link", {
      name: "Create a dedicated Slack App from the generated manifest",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://api.slack.com/apps?new_app=1&manifest_json=example");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(agentId, "create");
    const json = screen.getByLabelText("Slack App manifest JSON") as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual(manifest);
    expect(screen.getByLabelText("Bot User OAuth Token")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel setup" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy manifest JSON" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Copied");
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(manifest, null, 2));
  });

  it("guides reauthorization through the existing App manifest instead of a new App", async () => {
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "reauthorize", state: "awaiting_credentials", currentAppId: "A1" }),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));

    const link = (await screen.findByRole("link", {
      name: "Open the current Slack App's manifest",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://api.slack.com/apps/A1/app-manifest");
    expect(screen.getByText(/Reinstall to Workspace/)).toBeTruthy();
    expect(screen.getByText(/it may have changed/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Create a .*Slack App from the generated manifest/ })).toBeNull();
    expect(screen.getByLabelText("Slack App manifest JSON")).toBeTruthy();
  });

  it("offers a new dedicated App for replacement", async () => {
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "replace", state: "awaiting_credentials", currentAppId: "A1" }),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const link = (await screen.findByRole("link", {
      name: "Create a new dedicated Slack App from the generated manifest",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://api.slack.com/apps?new_app=1&manifest_json=example");
    expect(screen.queryByRole("link", { name: "Open the current Slack App's manifest" })).toBeNull();
  });

  it("polls a pending attempt to success once and invokes the narrow success callback", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "reauthorize", ...validated }),
    );
    const poll = vi
      .spyOn(browserApi, "slackSetupAttempt")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "reauthorize", state: "succeeded" }));
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(screen.getByText(/State: succeeded/)).toBeTruthy();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith(firstAttemptId);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("submits credentials, clears the secrets, and explains what is verified", async () => {
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "create", state: "awaiting_credentials" }),
    );
    const submit = vi
      .spyOn(browserApi, "submitSlackSetupCredentials")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "create", ...validated }));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByLabelText("Bot User OAuth Token");
    fillCredentials("xoxb-token", "signing-secret");

    expect(await screen.findByText(/Bot Token validated/)).toBeTruthy();
    expect(submit).toHaveBeenCalledWith(firstAttemptId, {
      botAccessToken: "xoxb-token",
      signingSecret: "signing-secret",
    });
    expect(screen.getByText(/for App A1 in workspace T1 \(bot user U1\)/)).toBeTruthy();
    expect(screen.getByText(/Signing Secret not yet verified/)).toBeTruthy();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit credentials" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("xoxb-token");
    expect(document.body.textContent).not.toContain("signing-secret");
  });

  it("lets the admin edit pending credentials and surfaces a wrong Signing Secret", async () => {
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({
        id: firstAttemptId,
        intent: "create",
        ...validated,
        lastVerificationErrorCode: "SLACK_SIGNING_SECRET_INVALID",
        lastVerificationAt: "2026-08-20T00:05:00.000Z",
      }),
    );
    const submit = vi
      .spyOn(browserApi, "submitSlackSetupCredentials")
      .mockResolvedValue(attempt({ id: firstAttemptId, intent: "create", ...validated }));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("status")).textContent).toContain("could not verify the submitted Signing Secret");

    fireEvent.click(screen.getByRole("button", { name: "Edit credentials" }));
    const token = screen.getByLabelText("Bot User OAuth Token") as HTMLInputElement;
    expect(token.value).toBe("");
    expect(screen.getByRole("button", { name: "Keep current credentials" })).toBeTruthy();
    fillCredentials("xoxb-again", "corrected-secret");

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(firstAttemptId, {
      botAccessToken: "xoxb-again",
      signingSecret: "corrected-secret",
    });
    expect(await screen.findByText(/Signing Secret not yet verified/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
  });

  it("reports a verified Request URL and the remaining activation step", async () => {
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "create", ...validated, challengeVerified: true }),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/Signing Secret verified/)).toBeTruthy();
    expect(screen.getByText(/first matching event completes activation/)).toBeTruthy();
  });

  it("cancels an active attempt and retries it with its original intent", async () => {
    const create = vi
      .spyOn(browserApi, "createSlackSetupAttempt")
      .mockResolvedValueOnce(attempt({ id: firstAttemptId, intent: "replace", state: "awaiting_credentials" }))
      .mockResolvedValueOnce(attempt({ id: secondAttemptId, intent: "replace", state: "awaiting_credentials" }));
    const cancel = vi
      .spyOn(browserApi, "cancelSlackSetupAttempt")
      .mockResolvedValue(
        attempt({ id: firstAttemptId, intent: "replace", state: "canceled", errorCode: "SLACK_SETUP_CANCELED" }),
      );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel setup" }));

    expect(await screen.findByText(/State: canceled/)).toBeTruthy();
    expect(cancel).toHaveBeenCalledWith(firstAttemptId);
    expect(screen.getByText(/Slack setup was canceled/)).toBeTruthy();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry Slack setup" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls.map(([, intent]) => intent)).toEqual(["replace", "replace"]);
    expect(await screen.findByText(/State: awaiting_credentials/)).toBeTruthy();
  });

  it("backs off on transient poll failures and clears the error on the next success", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "create", ...validated }),
    );
    const poll = vi
      .spyOn(browserApi, "slackSetupAttempt")
      .mockRejectedValueOnce("network unavailable")
      .mockRejectedValueOnce(new ApiError(503, "Slack setup unavailable", "SERVICE_UNAVAILABLE", "transient"))
      .mockResolvedValueOnce(attempt({ id: firstAttemptId, intent: "create", state: "succeeded" }));
    const onSuccess = vi.fn();
    render(<Harness onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(poll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("Unable to refresh Slack setup");

    // The second poll waits for the doubled interval instead of the base one.
    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(poll).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toBe("Slack setup unavailable");

    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(poll).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/State: succeeded/)).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("stops polling on a deterministic failure and resumes only on an explicit refresh", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "create", ...validated }),
    );
    const poll = vi
      .spyOn(browserApi, "slackSetupAttempt")
      .mockRejectedValueOnce(new ApiError(404, "Not found", "SLACK_SETUP_NOT_FOUND", "deterministic"))
      .mockResolvedValueOnce(attempt({ id: firstAttemptId, intent: "create", state: "succeeded" }));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(poll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("no longer exists");

    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(poll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(poll).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/State: succeeded/)).toBeTruthy();
  });

  it("gives up after repeated transient poll failures with an actionable message", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockResolvedValue(
      attempt({ id: firstAttemptId, intent: "create", ...validated }),
    );
    const poll = vi.spyOn(browserApi, "slackSetupAttempt").mockRejectedValue(new Error("upstream down"));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));

    expect(poll).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("alert").textContent).toContain("Polling stopped");
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
    expect(screen.getByText(/State: awaiting_verification/)).toBeTruthy();
  });

  it("replaces the active polling lifecycle and cleans it up on unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockImplementation(
      async (_agentId: string, intent: SlackSetupIntent = "create") =>
        attempt({
          id: intent === "replace" ? secondAttemptId : firstAttemptId,
          intent,
          state: "awaiting_credentials",
        }),
    );
    const poll = vi
      .spyOn(browserApi, "slackSetupAttempt")
      .mockImplementation(async (attemptId) => attempt({ id: attemptId, intent: "replace", ...validated }));
    const view = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith(secondAttemptId);

    view.unmount();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("normalizes non-Error failures into a stable error state", async () => {
    vi.spyOn(browserApi, "createSlackSetupAttempt").mockRejectedValue("network unavailable");
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Unable to start Slack setup");
  });

  it("explains a Server-reported failure the same way whether or not an attempt exists", async () => {
    const conflict =
      "Another Slack setup is already in progress for this Agent. Cancel it before starting a different one.";
    const start = vi
      .spyOn(browserApi, "createSlackSetupAttempt")
      .mockRejectedValueOnce(
        new ApiError(
          409,
          "A Slack reauthorize setup is already active",
          "SLACK_SETUP_INTENT_CONFLICT",
          "deterministic",
        ),
      )
      .mockResolvedValueOnce(
        attempt({
          id: firstAttemptId,
          intent: "replace",
          state: "failed",
          errorCode: "SLACK_APP_TEAM_ALREADY_BOUND",
        }),
      );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect((await screen.findByRole("alert")).textContent).toBe(conflict);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/already connected to another Agent/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry Slack setup" })).toBeTruthy();
  });
});
