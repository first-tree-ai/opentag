import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
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
