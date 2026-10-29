import type { SlackConfigurationView } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SETUP_READ_TIMEOUT_MS, ApiError, BrowserApi, browserApi } from "../api.js";
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

function fixture(
  view: SlackConfigurationView = unbound(),
  options: { manualOnly?: boolean; presentation?: "dialog" | "inline"; api?: BrowserApi } = {},
) {
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
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    if (field === "secret") fireEvent.click(screen.getByRole("button", { name: "Update Signing Secret" }));
    fireEvent.change(screen.getByLabelText(field === "token" ? "Bot Token" : "Signing Secret"), {
      target: { value: "new-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    fireEvent.change(screen.getByLabelText("Bot Token"), { target: { value: "private-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "Authorization saved. Open the Bot’s chat and send “Hello”. Confirm its reply to verify actual message delivery.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open chat" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open settings" })).toBeNull();
    expect(screen.queryByText("Slack connected.")).toBeNull();
    expect(test.save).toHaveBeenCalledWith(agentId, {
      intent: "reauthorize",
      expectedMessaging: view.expectedMessaging,
      botAccessToken: "private-token",
    });
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("link", { name: "Open settings" })).toBeTruthy();
  });

  it("does not call a URL challenge ready; requires identity closure and runtime handoff", async () => {
    const view = bound();
    if (!view.binding) throw new Error("missing fixture");
    view.binding.lastRuntimeObservationAt = "2026-10-12T00:01:00.000Z";
    const test = fixture(view);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(
        "Authorization saved. Open the Bot’s chat and send “Hello”. Confirm its reply to verify actual message delivery.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open chat" })).toBeTruthy();
    const verified = {
      ...view,
      identityClosure: { status: "verified" as const, verifiedAt: "2026-10-12T00:02:00.000Z" },
    };
    test.read.mockResolvedValue(verified);
    await test.client.invalidateQueries();
    expect(await screen.findByText("Check Agent status to finish setup.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View status" })).toBeTruthy();
    expect(screen.queryByText("Slack connected.")).toBeNull();
    expect(screen.getByText("App identity verified. Waiting for the Agent to be ready.")).toBeTruthy();
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
it("resumes saved binding callbacks after closing and reopening without a new ticket or manual credentials", async () => {
  const f = fixture(bound());
  const api = vi.mocked(browserApi.autoSetupSlack).mockResolvedValue({ status: "connected" });
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Close Connect Slack" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(f.onSaved).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenCalledExactlyOnceWith(agentId, { action: "connect" });
  expect(f.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  fireEvent.click(screen.getByRole("button", { name: "Update credentials" }));
  expect(screen.getByLabelText("Bot Token")).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(1);
});
it("does not offer automatic callback setup for a pending official OAuth binding", async () => {
  fixture({ ...bound(), preferredRecovery: "oauth" });
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(browserApi.autoSetupSlack).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Open chat" })).toBeTruthy();
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

it("continues observing when handoff is ready but the App identity is still pending", async () => {
  const test = fixture({ ...bound(), handoff: { bindingState: "active", handoffReady: true } });
  const entry = await screen.findByRole("button", { name: "Continue" });
  vi.useFakeTimers();
  fireEvent.click(entry);
  expect(screen.queryByText("Slack connected.")).toBeNull();
  const calls = test.read.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(2_100));
  expect(test.read.mock.calls.length).toBeGreaterThan(calls);
  expect(screen.queryByText("Slack connected.")).toBeNull();
});

it("surfaces a hung configuration read and offers a fresh read without writing credentials", async () => {
  const test = fixture();
  await screen.findByRole("button", { name: "Connect Slack" });
  vi.useFakeTimers();
  test.read.mockImplementation(() => new Promise(() => {}));
  void test.client.invalidateQueries();
  await act(() => vi.advanceTimersByTimeAsync(10_001));
  expect(screen.getByText("Couldn’t read connection status. Try again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(test.save).not.toHaveBeenCalled();
});

it("names the inline editing exit Cancel in both automatic and manual setup and restores focus", async () => {
  const test = fixture(unbound(), { presentation: "inline" });
  vi.mocked(browserApi.autoSetupSlack).mockResolvedValue({ status: "authorization_required", ticket: "test-ticket" });
  await screen.findByRole("button", { name: "Connect Slack" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Slack" })).not.toHaveProperty("disabled", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
  await screen.findByLabelText("Code");
  expect(screen.getByRole("button", { name: "Cancel" }).textContent).toBe("Cancel");
  expect(screen.queryByRole("button", { name: "Close Connect Slack" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Manual setup" }));
  enterCredentials();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("region", { name: "Connect Slack" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect Slack" }));
  expect(test.save).not.toHaveBeenCalled();
});

it("keeps a contextual Close name for the non-editing inline state", async () => {
  fixture(bound(), { presentation: "inline" });
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  const close = screen.getByRole("button", { name: "Close Connect Slack" });
  expect(close.textContent).toBe("Close");
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(close);
  expect(screen.queryByRole("region", { name: "Connect Slack" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
});

/** A real API transport that can stall, but releases a request when fetch is aborted. */
function cancellableConfigurationTransport(initial?: SlackConfigurationView) {
  const pending = new Set<{ signal: AbortSignal | null | undefined }>();
  const signals: (AbortSignal | null | undefined)[] = [];
  let peakPending = 0;
  let recovered: SlackConfigurationView | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (initial && fetchImpl.mock.calls.length === 1) return Response.json(initial);
    if (recovered) return Response.json(recovered);
    const signal = init?.signal;
    signals.push(signal);
    const request = { signal };
    pending.add(request);
    peakPending = Math.max(peakPending, pending.size);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        pending.delete(request);
        reject(signal?.reason ?? new DOMException("Request aborted", "AbortError"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  });
  return {
    api: new BrowserApi(fetchImpl),
    fetchImpl,
    signals,
    pending,
    peakPending: () => peakPending,
    recover: (view: SlackConfigurationView) => {
      recovered = view;
    },
  };
}

describe("configuration reads without AbortSignal.any", () => {
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  beforeEach(() => {
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  });
  afterEach(() => {
    if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor);
    else Reflect.deleteProperty(AbortSignal, "any");
  });

  it("aborts expired configuration GETs without overlapping polls, retains the view, and recovers without writes", async () => {
    const transport = cancellableConfigurationTransport(bound());
    fixture(bound(), { api: transport.api, presentation: "inline" });
    const entry = await screen.findByRole("button", { name: "Continue" });
    vi.useFakeTimers();
    fireEvent.click(entry);
    await act(() => vi.advanceTimersByTimeAsync(2_001));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(transport.signals).toHaveLength(attempt + 1);
      expect(transport.pending.size).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(AGENT_SETUP_READ_TIMEOUT_MS));
      expect(transport.signals[attempt]?.aborted).toBe(true);
      expect(transport.pending.size).toBe(0);
      expect(screen.getByText("Authorization saved · verification pending")).toBeTruthy();
      expect(screen.getByText("Couldn’t read connection status. Try again.")).toBeTruthy();
      if (attempt < 2) await act(() => vi.advanceTimersByTimeAsync(2_001));
    }
    transport.recover({
      ...bound(),
      identityClosure: { status: "verified", verifiedAt: "2026-10-12T00:02:00.000Z" },
      handoff: { bindingState: "active", handoffReady: true },
    });
    await act(() => vi.advanceTimersByTimeAsync(2_001));
    expect(screen.getByText("Slack connected.")).toBeTruthy();
    expect(screen.queryByText("Couldn’t read connection status. Try again.")).toBeNull();
    expect(transport.peakPending()).toBe(1);
    const reads = transport.fetchImpl.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(transport.fetchImpl).toHaveBeenCalledTimes(reads);
    for (const [url, init] of transport.fetchImpl.mock.calls) {
      expect(String(url)).toBe(`/api/v1/agents/${agentId}/im-binding/slack/configuration`);
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("aborts an in-flight configuration GET on unmount before its deadline", async () => {
    vi.useFakeTimers();
    const transport = cancellableConfigurationTransport();
    const test = fixture(unbound(), { api: transport.api, presentation: "inline" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(transport.signals).toHaveLength(1);
    expect(transport.pending.size).toBe(1);
    test.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(transport.signals[0]?.aborted).toBe(true);
    expect(transport.pending.size).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(AGENT_SETUP_READ_TIMEOUT_MS + 2_001));
    expect(transport.fetchImpl).toHaveBeenCalledOnce();
  });
});
