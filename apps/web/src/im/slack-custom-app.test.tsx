import type { SlackConfigurationView } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function fixture(view: SlackConfigurationView = unbound()) {
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
  const onSaved = vi.fn();
  const onOAuth = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const content = (id: string) => (
    <QueryClientProvider client={client}>
      <SlackCustomApp agentId={id} onSaved={onSaved} onOAuth={onOAuth} />
    </QueryClientProvider>
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
  fireEvent.click(await screen.findByRole("button", { name: "Use your own Slack App" }));
}
function enterCredentials() {
  fireEvent.change(screen.getByLabelText("Bot User OAuth Token"), { target: { value: "private-token" } });
  fireEvent.change(screen.getByLabelText("Signing Secret"), { target: { value: "private-secret" } });
}

describe("custom Slack App flow", () => {
  it("shows one prefilled creation link and exactly two credential fields without OAuth", async () => {
    fixture();
    await openCreate();
    const link = screen.getByRole("link", { name: "Create App in Slack" }) as HTMLAnchorElement;
    expect(link.closest("details")).toBeNull();
    const manifest = JSON.parse(new URL(link.href).searchParams.get("manifest_json") ?? "{}");
    expect(manifest.settings.event_subscriptions.request_url).toBe(unbound().eventsUrl);
    expect(screen.getByLabelText("Bot User OAuth Token")).toBeTruthy();
    expect(screen.getByLabelText("Signing Secret")).toBeTruthy();
    expect(screen.queryByLabelText("Slack App ID")).toBeNull();
    expect(screen.queryByText("Bot message policy")).toBeNull();
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
    const submit = screen.getByRole("button", { name: "Save and verify in Slack" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(test.save).toHaveBeenCalledTimes(1);
    test.read.mockResolvedValue(bound());
    complete();
    expect(
      await screen.findByText(/Configuration saved.*Event Subscriptions.*Request URL is Verified.*Save Changes/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    expect(screen.queryByText("Slack connected. The Agent can receive messages.")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openCreate();
    expect(screen.getByLabelText("Signing Secret")).toHaveProperty("value", "");
    enterCredentials();
    test.changeAgent();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    await openCreate();
    expect(screen.getByLabelText("Bot User OAuth Token")).toHaveProperty("value", "");
    expect(test.save).not.toHaveBeenCalled();
  });

  it("recovers a committed request through GET without resubmitting", async () => {
    const test = fixture();
    await openCreate();
    enterCredentials();
    test.save.mockRejectedValue(new TypeError("lost response"));
    test.read.mockResolvedValue(bound());
    fireEvent.click(screen.getByRole("button", { name: "Save and verify in Slack" }));
    await waitFor(() => expect(test.onSaved).toHaveBeenCalledTimes(1));
    expect(test.save).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
  });

  it("keeps input after a deterministic credential rejection", async () => {
    const test = fixture();
    await openCreate();
    enterCredentials();
    test.save.mockRejectedValue(new ApiError(400, "invalid", "SLACK_AUTH_INVALID"));
    fireEvent.click(screen.getByRole("button", { name: "Save and verify in Slack" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Slack could not verify"),
    );
    expect(screen.getByLabelText("Signing Secret")).toHaveProperty("value", "private-secret");
    expect(test.read).toHaveBeenCalledTimes(1);
  });

  it.each(["token", "secret"])("updates only the changed %s with the exact current generation", async (field) => {
    const view = bound();
    const test = fixture(view);
    fireEvent.click(await screen.findByRole("button", { name: "Continue Slack setup" }));
    fireEvent.click(screen.getByText("Existing App or connection help"));
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    fireEvent.change(screen.getByLabelText(field === "token" ? "Bot User OAuth Token" : "Signing Secret"), {
      target: { value: "new-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    await waitFor(() =>
      expect(test.save).toHaveBeenCalledWith(agentId, {
        intent: "reauthorize",
        expectedMessaging: view.expectedMessaging,
        [field === "token" ? "botAccessToken" : "signingSecret"]: "new-value",
      }),
    );
  });

  it("does not call a URL challenge ready; requires identity closure and runtime handoff", async () => {
    const view = bound();
    if (!view.binding) throw new Error("missing fixture");
    view.binding.lastRuntimeObservationAt = "2026-10-12T00:01:00.000Z";
    const test = fixture(view);
    fireEvent.click(await screen.findByRole("button", { name: "Continue Slack setup" }));
    expect(
      await screen.findByText(
        "Slack callback received. Confirm Save Changes in Event Subscriptions, then send the Bot a direct message to verify its identity.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Slack App settings" })).toBeTruthy();
    const verified = {
      ...view,
      identityClosure: { status: "verified" as const, verifiedAt: "2026-10-12T00:02:00.000Z" },
    };
    test.read.mockResolvedValue(verified);
    await test.client.invalidateQueries();
    expect(await screen.findByText(/Slack identity verified. Preparing/)).toBeTruthy();
    test.read.mockResolvedValue({ ...verified, handoff: { bindingState: "active", handoffReady: true } });
    await test.client.invalidateQueries();
    expect(await screen.findByText("Slack connected. The Agent can receive messages.")).toBeTruthy();
  });

  it("preserves existing OAuth recovery on an older server", async () => {
    const test = fixture();
    test.read.mockRejectedValue(new ApiError(404, "old server"));
    test.rerender(
      <QueryClientProvider client={test.client}>
        <SlackCustomApp agentId={agentId} bindingId={bindingId} onSaved={test.onSaved} onOAuth={test.onOAuth} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Update permissions" }));
    expect(test.onOAuth).toHaveBeenCalledTimes(1);
  });

  it("polls pending setup until ready, then stops requesting unchanged configuration", async () => {
    const test = fixture(bound());
    const entry = await screen.findByRole("button", { name: "Continue Slack setup" });
    vi.useFakeTimers();
    fireEvent.click(entry);
    test.read.mockResolvedValue({
      ...bound(),
      identityClosure: { status: "verified", verifiedAt: "2026-10-12T00:02:00.000Z" },
      handoff: { bindingState: "active", handoffReady: true },
    });
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    expect(screen.getByText("Slack connected. The Agent can receive messages.")).toBeTruthy();
    const requests = test.read.mock.calls.length;
    expect(requests).toBeGreaterThan(1);
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(test.read).toHaveBeenCalledTimes(requests);
  });
});
