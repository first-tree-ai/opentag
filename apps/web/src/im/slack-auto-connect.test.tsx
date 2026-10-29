import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { SlackAutoConnect } from "./slack-auto-connect.js";

afterEach(() => vi.restoreAllMocks());
it("links to the right workspace after confirmed submission and continues without another ticket", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "approval_pending", appId: "A1", teamId: "T1" })
    .mockResolvedValueOnce({ status: "connected" });
  const connected = vi.fn(async () => {});
  render(<SlackAutoConnect agentId="agent" resume onBusy={vi.fn()} onConnected={connected} />);
  expect(await screen.findByText(/Request submitted/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "View approval" })).toHaveProperty(
    "href",
    "https://app.slack.com/apps-manage/T1",
  );
  fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
  expect(screen.getByText("App: A1 · Workspace: T1")).toBeTruthy();
  expect(screen.getByText(/Requests to install.*Workspace Owners/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(api.mock.calls.map(([, input]) => input)).toEqual([{ action: "connect" }, { action: "connect" }]);
});
it("shows the actual safe error code without treating an ordinary install failure as approval", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({
    status: "failed",
    code: "install_failed",
    appId: "A1",
    teamId: "T1",
    errorCode: "http_request_failed",
  });
  render(<SlackAutoConnect agentId="agent" resume onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Check the network, then retry with the same App.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
  expect(screen.getByText("Slack error: http_request_failed")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "View approval" })).toBeNull();
});
it("provides app management for a denied request without encouraging another authorization", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({
    status: "failed",
    code: "approval_denied",
    appId: "A1",
    teamId: "T1",
  });
  render(<SlackAutoConnect agentId="agent" resume onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Installation denied. Contact an app manager.",
  );
  expect(screen.getByRole("link", { name: "View approval" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
});
it("shows one ticket under StrictMode and submits only the challenge before completing", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "authorization_required", ticket: "test-ticket" })
    .mockResolvedValueOnce({ status: "connected" });
  const connected = vi.fn(async () => {});
  render(
    <StrictMode>
      <SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={connected} />
    </StrictMode>,
  );
  expect(await screen.findByLabelText("Paste into Slack")).toHaveProperty("value", "/slackauthticket test-ticket");
  const submit = screen.getByRole("button", { name: "Connect" });
  expect(submit).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: " code " } });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(api.mock.calls).toEqual([
    ["agent", { action: "authorize" }],
    ["agent", { action: "connect", challenge: "code" }],
  ]);
  expect(screen.queryByLabelText("Code")).toBeNull();
});
it("continues callback recovery without another ticket or another challenge", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "authorized", teamName: "local-team" })
    .mockResolvedValueOnce({ status: "failed", code: "callbacks_failed" })
    .mockResolvedValueOnce({ status: "connected" });
  const connected = vi.fn(async () => {});
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={connected} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(api.mock.calls.map(([, input]) => input)).toEqual([
    { action: "authorize" },
    { action: "connect" },
    { action: "connect" },
  ]);
});
it("blocks creation retry when Slack may already have created the App", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "failed", code: "create_uncertain" });
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
});
it("retries installation without replacing management authorization", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "failed", code: "install_failed" })
    .mockResolvedValueOnce({ status: "connected" });
  render(<SlackAutoConnect agentId="agent" resume onBusy={vi.fn()} onConnected={vi.fn(async () => {})} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api.mock.calls.map(([, input]) => input)).toEqual([{ action: "connect" }, { action: "connect" }]);
  expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
});

it("offers manual setup without futile deploy or authorization retries when local credentials were removed", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "failed", code: "manual_required" });
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Use manual setup for this App.");
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
});
it("offers creation retry after a definite rejection", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "failed", code: "create_failed" })
    .mockResolvedValueOnce({ status: "connected" });
  const connected = vi.fn(async () => {});
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={connected} />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Creation failed. Check permissions or try later.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenLastCalledWith("agent", { action: "connect" });
});
it("explains that busy setup is still running without offering another authorization", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "failed", code: "busy" });
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Setup is still running. Wait, then continue.",
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
});
it("keeps same-App retry after a gateway timeout and a busy response", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockRejectedValueOnce(new ApiError(504, "gateway timeout"))
    .mockResolvedValueOnce({ status: "failed", code: "busy" })
    .mockResolvedValueOnce({ status: "connected" });
  const connected = vi.fn(async () => {});
  render(<SlackAutoConnect agentId="agent" resume onBusy={vi.fn()} onConnected={connected} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByText("Setup is still running. Wait, then continue.");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(api.mock.calls.map(([, input]) => input)).toEqual([
    { action: "connect" },
    { action: "connect" },
    { action: "connect" },
  ]);
});
it.each([
  ["AGENT_COMPUTER_NOT_BOUND", "Connect a Computer to this Agent before connecting Slack.", false],
  ["SLACK_CONFIGURATION_CONFLICT", "The connection changed. Reopen setup to use its latest state.", true],
  [
    "SLACK_CREDENTIALS_UNAVAILABLE",
    "The saved credentials cannot be recovered. Disconnect and reconnect this App; history is retained.",
    true,
  ],
] as const)("preserves actionable API errors instead of looping on %s", async (code, message, manual) => {
  vi.spyOn(browserApi, "autoSetupSlack").mockRejectedValue(new ApiError(409, "private diagnostic", code));
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(screen.queryByText("private diagnostic")).toBeNull();
  expect(Boolean(screen.queryByText("Refresh the connection or use manual setup."))).toBe(manual);
});

it("selects the full command after a failed copy and preserves the challenge", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "authorization_required", ticket: "copy-ticket" });
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
    const command = (await screen.findByLabelText("Paste into Slack")) as HTMLTextAreaElement;
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "keep-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText("Copy manually.")).toBeTruthy();
    expect(command.selectionStart).toBe(0);
    expect(command.selectionEnd).toBe(command.value.length);
    expect(screen.getByLabelText("Code")).toHaveProperty("value", "keep-code");
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("reauthorizes only after an explicit authorization failure", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "failed", code: "authorization_failed" })
    .mockResolvedValueOnce({ status: "authorization_required", ticket: "renewed" });
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Reauthorize" }));
  expect(await screen.findByLabelText("Paste into Slack")).toHaveProperty("value", "/slackauthticket renewed");
  expect(api.mock.calls.map(([, input]) => input)).toEqual([
    { action: "authorize" },
    { action: "authorize", force: true },
  ]);
});

it.each(["computer_unavailable", "capability_missing"] as const)("does not loop authorization for %s", async (code) => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "failed", code });
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
});

it("ignores late setup results after the Agent form unmounts", async () => {
  let resolve!: (result: { status: "connected" }) => void;
  vi.spyOn(browserApi, "autoSetupSlack").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const connected = vi.fn();
  const view = render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={connected} />);
  view.unmount();
  resolve({ status: "connected" });
  await Promise.resolve();
  expect(connected).not.toHaveBeenCalled();
});

it("recovers an unverified code with a new authorization ticket, never silently resubmitting it", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "authorization_required", ticket: "first" })
    .mockResolvedValueOnce({ status: "failed", code: "authorization_failed" })
    .mockResolvedValueOnce({ status: "authorization_required", ticket: "replacement" });
  const connected = vi.fn();
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={connected} />);
  fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "invalid-demo-code" } });
  const form = screen.getByLabelText("Code").closest("form");
  if (!form) throw new Error("Missing authorization form");
  fireEvent.submit(form);
  expect((await screen.findByRole("alert")).textContent).toContain("incorrect or expired");
  expect(screen.queryByLabelText("Code")).toBeNull();
  expect(connected).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Reauthorize" }));
  expect(await screen.findByLabelText("Paste into Slack")).toHaveProperty("value", "/slackauthticket replacement");
  expect(screen.getByLabelText("Code")).toHaveProperty("value", "");
  expect(api.mock.calls[2]?.[1]).toEqual({ action: "authorize", force: true });
});

it.each([new Error("network lost"), new ApiError(503, "upstream detail")])(
  "treats a lost response as uncertain without offering an automatic setup replay",
  async (failure) => {
    const api = vi.spyOn(browserApi, "autoSetupSlack").mockRejectedValue(failure);
    render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("No request will be repeated automatically");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reauthorize" })).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(failure.message);
  },
);

it("explains a slow request without inventing a timeout or dispatching a second operation", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: { status: "authorization_required"; ticket: string }) => void;
    const api = vi.spyOn(browserApi, "autoSetupSlack").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Getting the authorization command");
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByRole("status").textContent).toContain("Still waiting for the computer");
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ status: "authorization_required", ticket: "late-but-valid" }));
    expect(screen.getByLabelText("Code")).toHaveProperty("disabled", false);
    expect(screen.queryByText(/Still waiting for the computer/)).toBeNull();
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});
