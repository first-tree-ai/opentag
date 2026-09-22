import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { computerId, installApi, json, resetWebAppState, twoReadyComputers } from "./support/app-fixtures.js";

function installComputer(
  initial: "online" | "offline" | "disconnected" = "online",
  lostResponse = false,
  commits = true,
) {
  let connectionStatus = initial;
  let unavailable = false;
  let expired = false;
  let observed = 0;
  const writes: string[] = [];
  installApi({
    computers: () => [
      { ...twoReadyComputers[0], connectionStatus, observedAt: new Date(Date.now() + observed++).toISOString() },
    ],
    computerReadStatus: () => (unavailable ? 503 : undefined),
  });
  const base = vi.mocked(fetch).getMockImplementation();
  if (!base) throw new Error("Missing API fixture");
  const disconnectResponse = () => {
    writes.push(`/api/v1/computers/${computerId}/disconnect`);
    if (commits) connectionStatus = "disconnected";
    if (lostResponse) {
      unavailable = true;
      throw new TypeError("Network error");
    }
    return new Response(null, { status: 204 });
  };
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (path === `/api/v1/computers/${computerId}/disconnect`) return disconnectResponse();
    if (String(path).startsWith("/api/v1/computer-connect-codes/"))
      return json({
        connectCodeId: String(path).split("/").at(-1),
        state: expired ? "expired" : "pending",
        computerId: null,
        redeemedAt: null,
      });
    if (path === "/api/v1/computer-connect-codes" && init?.method === "POST") {
      writes.push(String(path));
      expired = false;
      const response = await base(path, init);
      return json({ ...(await response.json()), issuedAt: new Date().toISOString() }, 201);
    }
    return base(path, init);
  });
  window.history.replaceState({}, "", "/agents/computers");
  render(<App />);
  return {
    writes,
    restore: () => {
      unavailable = false;
    },
    expire: () => {
      expired = true;
    },
  };
}
async function confirmDisconnect() {
  fireEvent.click(await screen.findByRole("button", { name: "Computer actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  return screen.findByRole("alertdialog", { name: "Disconnect this computer?" });
}

function concurrentDisconnect() {
  let disconnected = false;
  let observed = 0;
  let holdRead = false;
  let releaseRead: (() => void) | undefined;
  let rejectDisconnect: ((cause: Error) => void) | undefined;
  installApi({
    computers: () => [
      {
        ...twoReadyComputers[0],
        connectionStatus: disconnected ? "disconnected" : "online",
        observedAt: new Date(1_700_000_000_000 + observed++).toISOString(),
      },
    ],
  });
  const base = vi.mocked(fetch).getMockImplementation();
  if (!base) throw new Error("Missing API fixture");
  vi.mocked(fetch).mockImplementation(async (path, init) => {
    if (path === `/api/v1/computers/${computerId}/disconnect`)
      return new Promise<Response>((_resolve, reject) => {
        rejectDisconnect = reject;
      });
    const response = await base(path, init);
    if (path === "/api/v1/computers" && holdRead) {
      holdRead = false;
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    }
    return response;
  });
  window.history.replaceState({}, "", "/agents/computers");
  render(<App />);
  return {
    refresh: async () => {
      await waitFor(() => expect(rejectDisconnect).toBeDefined());
      holdRead = true;
      fireEvent(window, new Event("focus"));
      await waitFor(() => expect(releaseRead).toBeDefined());
    },
    finishRead: () =>
      act(async () => {
        releaseRead?.();
      }),
    loseResponse: () =>
      act(async () => {
        disconnected = true;
        rejectDisconnect?.(new TypeError("Lost response"));
      }),
  };
}

describe("Computer connection controls", () => {
  beforeEach(resetWebAppState);
  it.each(["before", "after"])(
    "keeps uncertainty when an older inventory read finishes %s the lost response",
    async (order) => {
      const api = concurrentDisconnect();
      const dialog = await confirmDisconnect();
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
      await api.refresh();
      if (order === "before") await api.finishRead();
      await api.loseResponse();
      expect(await within(dialog).findByRole("alert")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      if (order === "after") await api.finishRead();
      expect(await screen.findByText("Status unavailable")).toBeTruthy();
      expect(screen.queryByText("Online")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Computer actions" }));
      expect(screen.getByRole("menuitem", { name: "Disconnect" }).getAttribute("aria-disabled")).toBe("true");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
      expect(await screen.findByText("Disconnected")).toBeTruthy();
    },
  );
  it("focuses the safe choice and cancels without revoking access", async () => {
    const api = installComputer();
    const dialog = await confirmDisconnect();
    const keep = within(dialog).getByRole("button", { name: "Keep connected" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.writes).toEqual([]);
    expect(screen.getByText("Online")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Computer actions" })));
  });
  it("disconnects without deleting, then reopens the same reconnect command after closing", async () => {
    const api = installComputer();
    const dialog = await confirmDisconnect();
    expect(within(dialog).getByText("Your Agents, settings, and local files will be kept.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    const command = document.querySelector("code")?.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Close Reconnect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.getByText("Run the connection command on this computer.")).toBeTruthy();
    const view = screen.getByRole("button", { name: "View instructions" });
    await waitFor(() => expect(document.activeElement).toBe(view));
    fireEvent.click(view);
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(document.querySelector("code")?.textContent).toBe(command);
    expect(api.writes).toEqual([`/api/v1/computers/${computerId}/disconnect`, "/api/v1/computer-connect-codes"]);
  });
  it("does not report disconnection after a lost response until a fresh read confirms it", async () => {
    const api = installComputer("online", true);
    const dialog = await confirmDisconnect();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByText("Disconnected")).toBeNull();
    api.restore();
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByText("Disconnected")).toBeTruthy();
    expect(api.writes).toHaveLength(1);
  });
  it("shows expiry after closing, and only replaces the command when requested", async () => {
    const api = installComputer("disconnected");
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Reconnect" }));
    api.expire();
    expect(await screen.findByText("This command is no longer valid.", {}, { timeout: 3_000 })).toBeTruthy();
    expect(api.writes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "View instructions" }));
    expect(await screen.findByRole("button", { name: "Get a new command" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(api.writes).toHaveLength(2);
  });
  it("keeps the repair command when a failed disconnect did not revoke it", async () => {
    const api = installComputer("offline", true, false);
    fireEvent.click(await screen.findByRole("button", { name: "Get connection help" }));
    fireEvent.click(screen.getByRole("button", { name: "Assistant requested a repair?" }));
    fireEvent.click(await screen.findByRole("button", { name: "Repair connection" }));
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    const command = document.querySelector("code")?.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Close Reconnect" }));
    const dialog = await confirmDisconnect();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    api.restore();
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
    fireEvent.click(await screen.findByRole("button", { name: "View instructions" }));
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(document.querySelector("code")?.textContent).toBe(command);
    expect(api.writes.filter((path) => path === "/api/v1/computer-connect-codes")).toHaveLength(1);
  });
});
