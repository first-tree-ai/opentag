import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { computerId, installApi, resetWebAppState, twoReadyComputers } from "./support/app-fixtures.js";

function openComputer(search = "") {
  window.history.replaceState({}, "", `/agents/computers${search}`);
  render(<App />);
}

describe("Account Computer management", () => {
  beforeEach(resetWebAppState);

  it("manages the sole computer directly and does not encourage adding another", async () => {
    installApi({ bound: true });
    openComputer();
    expect(await screen.findByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Reviewer Codex" })).toBeNull();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
    expect(document.querySelector('[data-ui="computer-connect"]')).toBeNull();
  });

  it("only issues the first connection command after an explicit action", async () => {
    installApi({ computers: [] });
    openComputer();
    const connect = await screen.findByRole("button", { name: "Connect computer" });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path, init]) => path === "/api/v1/computer-connect-codes" && init?.method === "POST"),
    ).toBe(false);
    fireEvent.click(connect);
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([path, init]) => path === "/api/v1/computer-connect-codes" && init?.method === "POST"),
      ).toBe(true),
    );
  });

  it("retains explicit selection for existing multi-computer accounts", async () => {
    installApi({ computers: twoReadyComputers });
    openComputer();
    fireEvent.click(await screen.findByRole("link", { name: "Manage Zulu Tower" }));
    expect(await screen.findByRole("heading", { name: "Zulu Tower" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ada's Mac" })).toBeNull();
    expect(screen.getByRole("link", { name: "View account computers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
  });

  it("keeps the first connection attempt visible between redemption and coming online", async () => {
    let online = false;
    const connectedAt = new Date().toISOString();
    installApi({
      computers: (issued) =>
        issued ? [{ ...twoReadyComputers[0], connectedAt, connectionStatus: online ? "online" : "offline" }] : [],
    });
    const api = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/v1/computer-connect-codes/")) {
        return new Response(
          JSON.stringify({
            connectCodeId: String(path).split("/").at(-1),
            state: "redeemed",
            computerId,
            redeemedAt: connectedAt,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (!api) throw new Error("API fixture is missing");
      return api(path, init);
    });
    openComputer();
    fireEvent.click(await screen.findByRole("button", { name: "Connect computer" }));
    expect(await screen.findByText("Command accepted. Waiting for OpenTag to come online…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(document.querySelector(".ots-command__body")).toBeNull();
    online = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Online", {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect your computer" })).toBeNull();
    const issued = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === "/api/v1/computer-connect-codes" && init?.method === "POST");
    expect(issued).toHaveLength(1);
  });

  it("withdraws recovery actions when a refresh can no longer confirm the computer", async () => {
    let failed = false;
    installApi({ computerStatus: () => "offline", computerReadStatus: () => (failed ? 503 : undefined) });
    openComputer();
    fireEvent.click(await screen.findByRole("button", { name: "Get connection help" }));
    fireEvent.click(await screen.findByRole("button", { name: "Assistant requested a repair?" }));
    expect(await screen.findByRole("button", { name: "Repair connection" })).toBeTruthy();
    failed = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Update failed. Showing last available data.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(screen.queryByText("Waiting for Computer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get connection help" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
  });

  it("presents managed cloud computers without local repair instructions", async () => {
    installApi({ computers: [{ ...twoReadyComputers[0], kind: "cloud", connectionStatus: "offline" }] });
    openComputer();
    expect((await screen.findAllByText("Managed")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Online")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get connection help" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
  });

  it("does not substitute the sole computer for a missing explicit target", async () => {
    installApi();
    openComputer("?computerId=missing");
    expect(await screen.findByText("This computer is no longer on your account.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ada's Mac" })).toBeNull();
  });

  it("does not offer a new connection when the computer read fails", async () => {
    installApi({ computerEvidenceFails: true });
    openComputer();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("makes an offline computer with no Agents recoverable", async () => {
    installApi({ computers: [{ ...twoReadyComputers[0], agentIds: [], connectionStatus: "offline" }] });
    openComputer(`?computerId=${computerId}`);
    const help = await screen.findByRole("button", { name: "Get connection help" });
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.getByText("Turn on or wake this computer and check its internet connection.")).toBeTruthy();
    fireEvent.click(help);
    expect(await screen.findByRole("button", { name: "Copy instructions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.getByRole("region", { name: "Restore connection" }).textContent).toContain("opentag doctor --json");
  });
});
