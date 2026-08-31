import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { SlackConfiguration } from "./slack-configuration.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

function Harness({ onSuccess = () => undefined }: { onSuccess?: () => void }) {
  return (
    <SlackConfiguration agentId={agentId} onSuccess={onSuccess}>
      {(control) => (
        <>
          <button type="button" onClick={() => void control.startOAuth("create")}>
            Add OpenTag
          </button>
          <button type="button" onClick={() => void control.startOAuth("reauthorize")}>
            Reauthorize
          </button>
          {control.feedback}
        </>
      )}
    </SlackConfiguration>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("SlackConfiguration", () => {
  it("starts first-party OpenTag Slack OAuth without exposing the session binding", async () => {
    const start = vi.spyOn(browserApi, "startSlackOAuth").mockResolvedValue({
      authorizationUrl: "https://slack.com/oauth/v2/authorize?client_id=client&state=signed-state",
      expiresAt: "2026-08-19T00:10:00.000Z",
    });
    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "Add OpenTag" }));
      await waitFor(() => expect(start).toHaveBeenCalledWith(agentId, { intent: "create" }));
      expect(assign).toHaveBeenCalledWith("https://slack.com/oauth/v2/authorize?client_id=client&state=signed-state");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("starts reauthorization through the same OAuth entry", async () => {
    const start = vi.spyOn(browserApi, "startSlackOAuth").mockResolvedValue({
      authorizationUrl: "https://slack.com/oauth/v2/authorize?client_id=client&state=signed-state",
      expiresAt: "2026-08-19T00:10:00.000Z",
    });
    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
      await waitFor(() => expect(start).toHaveBeenCalledWith(agentId, { intent: "reauthorize" }));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("maps OAuth start failures without opening a credential form", async () => {
    vi.spyOn(browserApi, "startSlackOAuth").mockRejectedValue(
      new ApiError(403, "forbidden", "IM_BINDING_FORBIDDEN", "deterministic"),
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add OpenTag" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Only the Account owner can manage this Slack configuration.",
    );
    expect(screen.queryByLabelText("Slack App ID")).toBeNull();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
  });

  it("surfaces a completed OAuth callback without requiring a test message", async () => {
    const onSuccess = vi.fn();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging?slack_oauth=success`);
    render(<Harness onSuccess={onSuccess} />);
    expect(await screen.findByText(/no test message is required to save this generation/)).toBeTruthy();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(window.location.search).not.toContain("slack_oauth");
  });

  it("maps known and unknown OAuth callback errors to safe feedback", async () => {
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging?slack_oauth_error=SLACK_AUTH_INVALID`);
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Slack rejected this authorization. Start OpenTag Slack again from this Agent.",
    );

    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging?slack_oauth_error=other`);
    const { unmount } = render(<Harness />);
    expect(await screen.findAllByRole("alert")).toHaveLength(2);
    unmount();
  });
});
