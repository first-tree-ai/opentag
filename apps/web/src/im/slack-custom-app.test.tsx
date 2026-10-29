import type { SlackConfigurationView } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { SlackCustomApp } from "./slack-custom-app.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const bindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
const clients: QueryClient[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function unbound(): SlackConfigurationView {
  return {
    agentDisplayName: "QA Agent",
    eventsUrl: `https://qa.example/api/v1/agents/${agentId}/im-binding/slack/events`,
    allowedIntent: "create",
    blockedReason: null,
    expectedMessaging: { kind: "unbound" },
    preferredRecovery: "credentials",
    binding: null,
    identityClosure: null,
    handoff: null,
  };
}

function bound(): SlackConfigurationView {
  return {
    ...unbound(),
    allowedIntent: "reauthorize",
    expectedMessaging: { kind: "bound", provider: "slack", bindingId, credentialGeneration: 1 },
    binding: {
      id: bindingId,
      agentId,
      provider: "slack",
      bindingState: "active",
      bot: { displayName: "QA Bot", avatarUrl: null },
      receiveMode: "all_message",
      lastInboundAt: null,
      lastValidatedAt: "2026-10-12T00:00:00.000Z",
      lastRuntimeObservationAt: null,
      identity: {
        provider: "slack",
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        enterpriseId: null,
        appIdEvidence: "configured",
      },
      credentialGeneration: 1,
      grantedCapabilities: [],
      reauthorizationRequired: false,
      lastErrorCode: null,
    },
    identityClosure: { status: "pending", verifiedAt: null },
    handoff: { bindingState: "active", handoffReady: false },
  };
}

function fixture(view: SlackConfigurationView = unbound(), options: { manualOnly?: boolean } = {}) {
  const read = vi.spyOn(browserApi, "slackConfiguration").mockResolvedValue(view);
  const save = vi.spyOn(browserApi, "saveSlackConfiguration").mockResolvedValue({
    agentId,
    imBindingId: bindingId,
    appId: "A1",
    teamId: "T1",
    botUserId: "U1",
    credentialGeneration: 1,
    bindingState: "active",
    identityClosure: { status: "pending", verifiedAt: null },
  });
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "failed", code: "computer_unavailable" });
  const onSaved = vi.fn();
  const onOAuth = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const content = (id: string) => (
    <RouterContextProvider router={router}>
      <QueryClientProvider client={client}>
        <SlackCustomApp agentId={id} onSaved={onSaved} onOAuth={onOAuth} {...options} />
      </QueryClientProvider>
    </RouterContextProvider>
  );
  const result = render(content(agentId));
  return {
    ...result,
    client,
    read,
    save,
    onSaved,
    onOAuth,
    changeAgent: () => result.rerender(content("b163a21e-f6c7-4474-91ea-4dabf0566a24")),
  };
}

async function openCreate() {
  await screen.findByRole("button", { name: "Connect Slack" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Slack" })).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Manual setup" })).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Manual setup" }));
  await waitFor(() => expect(screen.getByLabelText("Signing Secret")).not.toHaveProperty("disabled", true));
}
function enterCredentials() {
  fireEvent.change(screen.getByLabelText("Bot Token"), { target: { value: "private-token" } });
  fireEvent.change(screen.getByLabelText("Signing Secret"), { target: { value: "private-secret" } });
}

describe("custom Slack App flow", () => {
  it("shows one prefilled creation link and exactly two credential fields without OAuth", async () => {
    fixture();
    await openCreate();
    const link = screen.getByRole("link", { name: "Create App" }) as HTMLAnchorElement;
    expect(link.closest("details")).toBeNull();
    const manifest = JSON.parse(new URL(link.href).searchParams.get("manifest_json") ?? "{}");
    expect(manifest.settings.event_subscriptions.request_url).toBe(unbound().eventsUrl);
    expect(manifest.features.bot_user.display_name).toBe("qa-agent");
    expect(screen.getByText("Slack Bot: @qa-agent")).toBeTruthy();
    expect(screen.getByLabelText("Bot Token")).toBeTruthy();
    expect(screen.getByLabelText("Signing Secret")).toBeTruthy();
    expect(screen.queryByLabelText("Slack App ID")).toBeNull();
    expect(screen.queryByText("Bot message policy")).toBeNull();
  });

  it("keeps creation recovery in collapsed help and links to existing Apps before retrying", async () => {
    fixture();
    await openCreate();
    expect(screen.queryByRole("link", { name: "View Apps" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("link", { name: "View Apps" })).toHaveProperty("href", "https://api.slack.com/apps");
    expect(
      screen.getByText(/check Your Apps first.*OAuth & Permissions.*retry later without creating another copy/),
    ).toBeTruthy();
  });

  it("commits once, clears credentials, and retains pending identity after saving", async () => {
    const test = fixture();
    await openCreate();
    enterCredentials();
    let complete!: () => void;
    test.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              agentId,
              imBindingId: bindingId,
              appId: "A1",
              teamId: "T1",
              botUserId: "U1",
              credentialGeneration: 1,
              bindingState: "active",
              identityClosure: { status: "pending", verifiedAt: null },
            });
        }),
    );
    const submit = screen.getByRole("button", { name: "Save" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(test.save).toHaveBeenCalledTimes(1);
    test.read.mockResolvedValue(bound());
    complete();
    expect(await screen.findByText(/In Event Subscriptions.*Verified.*Save Changes/)).toBeTruthy();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    expect(screen.queryByText("Slack connected.")).toBeNull();
    expect(
      JSON.stringify(
        test.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("private-");
    expect(test.onSaved).toHaveBeenCalledTimes(1);
  });

  it("destroys credential inputs on cancel and Agent changes", async () => {
    const test = fixture();
    await openCreate();
    enterCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Close Connect Slack" }));
    await openCreate();
    expect(screen.getByLabelText("Signing Secret")).toHaveProperty("value", "");
    enterCredentials();
    test.changeAgent();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    await openCreate();
    expect(screen.getByLabelText("Bot Token")).toHaveProperty("value", "");
    expect(test.save).not.toHaveBeenCalled();
  });

  it("recovers a committed request through GET without resubmitting", async () => {
    const test = fixture();
    await openCreate();
    enterCredentials();
    test.save.mockRejectedValue(new TypeError("lost response"));
    test.read.mockResolvedValue(bound());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(test.onSaved).toHaveBeenCalledTimes(1));
    expect(test.save).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
  });

  it("keeps input after a deterministic credential rejection", async () => {
    const test = fixture();
    await openCreate();
    enterCredentials();
    test.save.mockRejectedValue(new ApiError(400, "invalid", "SLACK_AUTH_INVALID"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Slack could not verify/)).toBeTruthy();
    expect(screen.getByLabelText("Signing Secret")).toHaveProperty("value", "private-secret");
    expect(test.read).toHaveBeenCalledTimes(1);
  });

  it.each(["token", "secret"])("updates only the changed %s with the exact current generation", async (field) => {
    const view = bound();
    const test = fixture(view);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    if (field === "secret") fireEvent.click(screen.getByRole("button", { name: "Replace signing secret" }));
    fireEvent.change(screen.getByLabelText(field === "token" ? "New bot token" : "Signing Secret"), {
      target: { value: "new-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(test.save).toHaveBeenCalledWith(agentId, {
        intent: "reauthorize",
        expectedMessaging: view.expectedMessaging,
        [field === "token" ? "botAccessToken" : "signingSecret"]: "new-value",
      }),
    );
  });

  it("verifies updated credentials by DM without repeating saved Slack settings or reporting ready early", async () => {
    const view = bound();
    if (!view.binding) throw new Error("missing fixture");
    view.binding.lastInboundAt = "2026-10-12T00:01:00.000Z";
    const test = fixture(view);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    fireEvent.change(screen.getByLabelText("New bot token"), { target: { value: "private-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Send a message — try “Hi”.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open chat in Slack" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open event settings in Slack" })).toBeNull();
    expect(screen.queryByText("Slack connected.")).toBeNull();
    expect(test.save).toHaveBeenCalledWith(agentId, {
      intent: "reauthorize",
      expectedMessaging: view.expectedMessaging,
      botAccessToken: "private-token",
    });
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    expect(screen.getByRole("link", { name: "Open event settings in Slack" })).toBeTruthy();
  });

  it("does not call a URL challenge ready; requires identity closure and runtime handoff", async () => {
    const view = bound();
    if (!view.binding) throw new Error("missing fixture");
    view.binding.lastRuntimeObservationAt = "2026-10-12T00:01:00.000Z";
    const test = fixture(view);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Send a message — try “Hi”.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open chat in Slack" })).toBeTruthy();
    const verified = {
      ...view,
      identityClosure: { status: "verified" as const, verifiedAt: "2026-10-12T00:02:00.000Z" },
    };
    test.read.mockResolvedValue(verified);
    await test.client.invalidateQueries();
    expect(await screen.findByText("Check Agent status to finish setup.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View status" })).toBeTruthy();
    test.read.mockResolvedValue({ ...verified, handoff: { bindingState: "active", handoffReady: true } });
    await test.client.invalidateQueries();
    expect(await screen.findByText("Slack connected.")).toBeTruthy();
  });

  it("requires a server upgrade instead of replacing an unidentified binding through OAuth", async () => {
    const test = fixture();
    test.read.mockRejectedValue(new ApiError(404, "old server"));
    test.rerender(
      <QueryClientProvider client={test.client}>
        <SlackCustomApp agentId={agentId} bindingId={bindingId} onSaved={test.onSaved} onOAuth={test.onOAuth} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Update the server to connect Slack.")).toBeTruthy();
    expect(test.onOAuth).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Connect Slack" })).toBeNull();
  });

  it("polls pending setup until ready, then stops requesting unchanged configuration", async () => {
    const test = fixture(bound());
    const entry = await screen.findByRole("button", { name: "Continue" });
    vi.useFakeTimers();
    fireEvent.click(entry);
    test.read.mockResolvedValue({
      ...bound(),
      identityClosure: { status: "verified", verifiedAt: "2026-10-12T00:02:00.000Z" },
      handoff: { bindingState: "active", handoffReady: true },
    });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(screen.getByText("Slack connected.")).toBeTruthy();
    const requests = test.read.mock.calls.length;
    expect(requests).toBeGreaterThan(1);
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(test.read).toHaveBeenCalledTimes(requests);
  });
});
it("reopens pending setup at the message check with focused troubleshooting actions", async () => {
  const f = fixture(bound());
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Test your Slack connection" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect(screen.getByRole("link", { name: "Open chat in Slack" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
  expect(screen.queryByRole("button", { name: /Finish automatic setup/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Retry automatic setup" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open event settings in Slack" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connection details" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
  expect(screen.getByLabelText("New bot token")).toBeTruthy();
  expect(browserApi.autoSetupSlack).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.onSaved).not.toHaveBeenCalled();
});
it("does not offer automatic callback setup for a pending official OAuth binding", async () => {
  fixture({ ...bound(), preferredRecovery: "oauth" });
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
  expect(screen.queryByRole("button", { name: "Retry automatic setup" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(browserApi.autoSetupSlack).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Open chat in Slack" })).toBeTruthy();
});

it("opens Cloud manual setup without requesting a CLI ticket", async () => {
  fixture(unbound(), { manualOnly: true });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Slack" })).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  expect(screen.getByLabelText("Bot Token")).toBeTruthy();
  expect(screen.getByLabelText("Signing Secret")).toBeTruthy();
  expect(browserApi.autoSetupSlack).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
});

it("keeps one ticket across manual switching while clearing manual secrets", async () => {
  fixture();
  const api = vi
    .mocked(browserApi.autoSetupSlack)
    .mockResolvedValue({ status: "authorization_required", ticket: "one-ticket" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Slack" })).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  await screen.findByLabelText("Code");
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "keep-code" } });
  fireEvent.click(screen.getByRole("button", { name: "Manual setup" }));
  enterCredentials();
  expect(screen.getByLabelText("Code").closest("[hidden]")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByLabelText("Code")).toHaveProperty("value", "keep-code");
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Manual setup" }));
  expect(screen.getByLabelText("Bot Token")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Signing Secret")).toHaveProperty("value", "");
});

it("uses existing-App credentials after uncertain creation without offering another create", async () => {
  fixture();
  vi.mocked(browserApi.autoSetupSlack).mockResolvedValue({ status: "failed", code: "create_uncertain" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Slack" })).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Manual setup" }));
  expect(screen.getByLabelText("Bot Token")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View Apps" })).toHaveProperty("href", "https://api.slack.com/apps");
  expect(screen.queryByRole("link", { name: "Create App" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(browserApi.autoSetupSlack).toHaveBeenCalledTimes(1);
});

describe("Slack connection dialog navigation", () => {
  it("names the recipient once and opens the correct Slack app and workspace", async () => {
    fixture(bound());
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    const dialog = screen.getByRole("dialog", { name: "Test your Slack connection" });
    expect(within(dialog).getAllByText("QA Bot")).toHaveLength(1);
    expect(within(dialog).getByText("Send a message — try “Hi”.")).toBeTruthy();
    const link = within(dialog).getByRole("link", { name: "Open chat in Slack" }) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get("app")).toBe("A1");
    expect(new URL(link.href).searchParams.get("team")).toBe("T1");
    expect(within(dialog).getByRole("status").textContent).toContain("Waiting for your test message…");
  });

  it("navigates between help, details and the test without closing the dialog", async () => {
    const test = fixture(bound());
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    expect(screen.getByRole("dialog", { name: "Troubleshoot Slack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View required URL and events" }));
    const details = screen.getByRole("dialog", { name: "Connection details" });
    expect(within(details).getByText("A1")).toBeTruthy();
    expect(within(details).getByText("T1")).toBeTruthy();
    expect(within(details).getByText(bound().eventsUrl)).toBeTruthy();
    expect(within(details).getAllByRole("listitem")).toHaveLength(7);
    await waitFor(() => expect(details.contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Troubleshoot Slack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Test your Slack connection" })).toBeTruthy();
    expect(test.save).not.toHaveBeenCalled();
    expect(browserApi.autoSetupSlack).not.toHaveBeenCalled();
  });

  it.each(["Cancel", "Back"])("clears unsaved credentials when leaving with %s", async (action) => {
    const test = fixture(bound());
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Enter a new token or signing secret to save changes.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New bot token"), { target: { value: "unsaved-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Show bot token" }));
    expect(screen.getByLabelText("New bot token")).toHaveProperty("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Replace signing secret" }));
    fireEvent.change(screen.getByLabelText("Signing Secret"), { target: { value: "unsaved-secret" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
    expect(screen.queryByText("Enter a new token or signing secret to save changes.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.getByRole("dialog", { name: "Troubleshoot Slack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    expect(screen.getByLabelText("New bot token")).toHaveProperty("value", "");
    expect(screen.getByLabelText("New bot token")).toHaveProperty("type", "password");
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replace signing secret" }));
    expect(screen.getByLabelText("Signing Secret")).toHaveProperty("value", "");
    expect(test.save).not.toHaveBeenCalled();
  });

  it.each([false, true])("copies the complete request URL with failure fallback: %s", async (fail) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = fail
      ? vi.fn().mockRejectedValue(new Error("clipboard blocked"))
      : vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      fixture(bound());
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
      fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
      fireEvent.click(screen.getByRole("button", { name: "Connection details" }));
      fireEvent.click(screen.getByRole("button", { name: "Copy Request URL" }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(bound().eventsUrl);
      if (fail) {
        expect(await screen.findByText("Copy manually.")).toBeTruthy();
        expect(screen.getByLabelText("Copy Request URL manually")).toHaveProperty("value", bound().eventsUrl);
      } else {
        expect(await screen.findByText("Copied")).toBeTruthy();
        expect(screen.queryByLabelText("Copy Request URL manually")).toBeNull();
      }
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("saved Slack callback recovery", () => {
  it("retries after reopening without another ticket, installation or credential write", async () => {
    const test = fixture(bound());
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Test your Slack connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    let complete!: () => void;
    vi.mocked(browserApi.autoSetupSlack).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ status: "connected" });
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry automatic setup" }));
    expect(screen.getByRole("button", { name: "Close Retry automatic setup" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Back" })).toHaveProperty("disabled", true);
    expect(browserApi.autoSetupSlack).toHaveBeenCalledExactlyOnceWith(agentId, { action: "connect" });
    complete();
    await waitFor(() => expect(test.onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "Test your Slack connection" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open chat in Slack" })).toBeTruthy();
    expect(test.save).not.toHaveBeenCalled();
  });

  it("keeps callback failures retryable through Continue and can return to help", async () => {
    const test = fixture(bound());
    vi.mocked(browserApi.autoSetupSlack).mockResolvedValue({
      status: "failed",
      code: "callbacks_failed",
      appId: "A1",
      teamId: "T1",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry automatic setup" }));
    const retry = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(retry);
    await waitFor(() => expect(browserApi.autoSetupSlack).toHaveBeenCalledTimes(2));
    expect(vi.mocked(browserApi.autoSetupSlack).mock.calls.every(([, request]) => request.action === "connect")).toBe(
      true,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).not.toHaveProperty("disabled", true));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Troubleshoot Slack" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    expect(screen.getByLabelText("New bot token")).toBeTruthy();
    expect(test.save).not.toHaveBeenCalled();
  });

  it("keeps Cloud callback recovery manual", async () => {
    fixture(bound(), { manualOnly: true });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
    expect(screen.queryByRole("button", { name: "Retry automatic setup" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open event settings in Slack" })).toBeTruthy();
    expect(browserApi.autoSetupSlack).not.toHaveBeenCalled();
  });

  it("requires credential recovery for a revoked binding", async () => {
    const view = bound();
    if (!view.binding) throw new Error("missing fixture");
    view.binding.reauthorizationRequired = true;
    fixture(view);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("New bot token")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("button", { name: "Retry automatic setup" })).toBeNull();
    expect(browserApi.autoSetupSlack).not.toHaveBeenCalled();
  });
});

describe("verified Slack handoff headings", () => {
  it.each([undefined, "needs_attention", "preparing_cli", "checking_credentials"] as const)(
    "describes the actual handoff phase: %s",
    async (phase) => {
      const view = bound();
      const test = fixture(view);
      fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
      test.read.mockResolvedValue({
        ...view,
        identityClosure: { status: "verified", verifiedAt: "2026-10-12T00:02:00.000Z" },
        handoff: { bindingState: "active", handoffReady: false, ...(phase ? { providerCli: { phase } } : {}) },
      });
      await test.client.invalidateQueries();
      const checking = phase === "preparing_cli" || phase === "checking_credentials";
      expect(
        await screen.findByRole("dialog", { name: checking ? "Preparing the Agent…" : "Check your agent" }),
      ).toBeTruthy();
      expect(
        screen.getByText(
          checking
            ? "Slack connection verified. We’re checking your agent is ready."
            : "The connection is verified, but your agent needs attention.",
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Having trouble?" }));
      expect(screen.queryByRole("button", { name: "Retry automatic setup" })).toBeNull();
    },
  );
});
