import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { SlackAutoConnect } from "./slack-auto-connect.js";

afterEach(() => vi.restoreAllMocks());
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
  expect(await screen.findByLabelText("Slack authorization command")).toHaveProperty(
    "value",
    "/slackauthticket test-ticket",
  );
  const submit = screen.getByRole("button", { name: "Create and connect" });
  expect(submit).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Slack challenge code"), { target: { value: " code " } });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(api.mock.calls).toEqual([
    ["agent", { action: "authorize" }],
    ["agent", { action: "connect", challenge: "code" }],
  ]);
  expect(screen.queryByLabelText("Slack challenge code")).toBeNull();
});
it("continues callback recovery without another ticket or another challenge", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "authorized", teamName: "local-team" })
    .mockResolvedValueOnce({ status: "failed", code: "callbacks_failed" })
    .mockResolvedValueOnce({ status: "connected" });
  const connected = vi.fn(async () => {});
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={connected} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create and connect" }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue connecting" }));
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
  expect(screen.queryByRole("button", { name: "Continue connecting" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create and connect" })).toBeNull();
});
it("allows explicit reauthorization after an installation failure", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockResolvedValueOnce({ status: "failed", code: "install_failed" })
    .mockResolvedValueOnce({ status: "authorization_required", ticket: "replacement" });
  render(<SlackAutoConnect agentId="agent" resume onBusy={vi.fn()} onConnected={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Get authorization command" }));
  expect(await screen.findByLabelText("Slack authorization command")).toHaveProperty(
    "value",
    "/slackauthticket replacement",
  );
  expect(api).toHaveBeenLastCalledWith("agent", { action: "authorize", force: true });
});
it("offers manual setup without futile deploy or authorization retries when local credentials were removed", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "failed", code: "manual_required" });
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "This Computer has no reusable setup credentials for this App. Connect or configure the existing App manually below; another authorization command will not recover them.",
  );
  expect(screen.queryByRole("button", { name: "Continue connecting" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create and connect" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Get authorization command" })).toBeNull();
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
    "Slack rejected App creation. Check your workspace permissions or App limit, or wait before trying again.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Create and connect" }));
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenLastCalledWith("agent", { action: "connect" });
});
it("explains that busy setup is still running without offering another authorization", async () => {
  vi.spyOn(browserApi, "autoSetupSlack").mockResolvedValue({ status: "failed", code: "busy" });
  render(<SlackAutoConnect agentId="agent" onBusy={vi.fn()} onConnected={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Setup is still running on your Computer. Wait, then continue connecting the same App.",
  );
  expect(screen.getByRole("button", { name: "Continue connecting" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Get authorization command" })).toBeNull();
});
it("keeps same-App retry after a gateway timeout and a busy response", async () => {
  const api = vi
    .spyOn(browserApi, "autoSetupSlack")
    .mockRejectedValueOnce(new ApiError(504, "gateway timeout"))
    .mockResolvedValueOnce({ status: "failed", code: "busy" })
    .mockResolvedValueOnce({ status: "connected" });
  const connected = vi.fn(async () => {});
  render(<SlackAutoConnect agentId="agent" resume onBusy={vi.fn()} onConnected={connected} />);
  fireEvent.click(await screen.findByRole("button", { name: "Continue connecting" }));
  await screen.findByText("Setup is still running on your Computer. Wait, then continue connecting the same App.");
  fireEvent.click(screen.getByRole("button", { name: "Continue connecting" }));
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
  expect(screen.queryByRole("button", { name: "Continue connecting" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create and connect" })).toBeNull();
  expect(screen.queryByText("private diagnostic")).toBeNull();
  expect(Boolean(screen.queryByText("Reopen setup to refresh the connection, or use manual setup below."))).toBe(
    manual,
  );
});
