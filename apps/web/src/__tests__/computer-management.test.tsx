import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  agentId,
  computerId,
  installApi,
  resetWebAppState,
  secondComputerId,
  twoReadyComputers,
} from "./support/app-fixtures.js";

function openComputer(search = "") {
  window.history.replaceState({}, "", `/agents/computers${search}`);
  render(<App />);
}
function repairRequests() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === "/api/v1/computer-connect-codes" && init?.method === "POST");
}

describe("Account Computer management", () => {
  beforeEach(resetWebAppState);

  it("keeps a disconnected computer assigned and exposes the same recovery instructions", async () => {
    installApi({ bound: true, computers: [{ ...twoReadyComputers[0], connectionStatus: "disconnected" }] });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);
    expect(await screen.findByText("Disconnected")).toBeTruthy();
    const restore = screen.getByRole("link", { name: "Restore connection" });
    expect(restore.getAttribute("href")).toContain(`computerId=${computerId}`);
    fireEvent.click(restore);
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore connection" })).toBeNull();
    expect(JSON.parse(String(repairRequests()[0]?.[1]?.body))).toEqual({
      mode: "repair",
      targetComputerId: computerId,
    });
  });

  it("keeps a healthy card quiet, with only removal in its menu", async () => {
    installApi({ bound: true });
    openComputer();
    expect(await screen.findByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
    expect(document.querySelector('[data-ui="computer-recovery"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Computer actions" }));
    expect(await screen.findByRole("menuitem", { name: "Remove computer…" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Disconnect" })).toBeNull();
    expect(repairRequests()).toHaveLength(0);
  });

  it("only issues the first connection command after an explicit action", async () => {
    installApi({ computers: [] });
    openComputer();
    const connect = await screen.findByRole("button", { name: "Connect computer" });
    expect(repairRequests()).toHaveLength(0);
    fireEvent.click(connect);
    await waitFor(() => expect(repairRequests()).toHaveLength(1));
    expect(JSON.parse(String(repairRequests()[0]?.[1]?.body))).toEqual({ mode: "create" });
  });

  it.each([
    { name: "one local computer", computers: [{ ...twoReadyComputers[0] }] },
    { name: "multiple computers", computers: twoReadyComputers },
  ])("connects another computer alongside $name only after an explicit action", async ({ computers }) => {
    installApi({ computers });
    openComputer(`?computerId=${computerId}&fromAgent=${agentId}`);
    const connect = await screen.findByRole("button", { name: "Connect a new computer" });
    expect(repairRequests()).toHaveLength(0);
    fireEvent.click(connect);
    await waitFor(() => expect(repairRequests()).toHaveLength(1));
    expect(JSON.parse(String(repairRequests()[0]?.[1]?.body))).toEqual({ mode: "create" });
    expect(screen.getByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect a new computer" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("starts the connection requested from Agent settings once, then drops the request from the URL", async () => {
    installApi({ bound: true, agentUnbound: true, computers: [{ ...twoReadyComputers[0] }] });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Connect a new computer" }));
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to/ })).toBeTruthy();
    await waitFor(() => expect(window.location.search).not.toContain("connect="));
    expect(window.location.search).toContain(`fromAgent=${agentId}`);
    expect(repairRequests()).toHaveLength(1);
    expect(JSON.parse(String(repairRequests()[0]?.[1]?.body))).toEqual({ mode: "create" });
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith("/computer/rebind"))).toBe(false);
  });

  it("offers the first Local connection while preserving an existing Cloud card", async () => {
    installApi({ computers: [{ ...twoReadyComputers[0], kind: "cloud", displayName: "Cloud" }] });
    openComputer();
    const connect = await screen.findByRole("button", { name: "Connect computer" });
    expect(screen.getByRole("heading", { name: "Cloud" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect a new computer" })).toBeNull();
    expect(repairRequests()).toHaveLength(0);
    fireEvent.click(connect);
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByText("Run this in a terminal on this computer, or send it to your Agent there.")).toBeTruthy();
    expect(repairRequests()).toHaveLength(1);
    expect(JSON.parse(String(repairRequests()[0]?.[1]?.body))).toEqual({ mode: "create" });
  });

  it("keeps an additional connection pending until the exact new computer comes online", async () => {
    let online = false;
    const connectedAt = new Date().toISOString();
    installApi({
      computers: (issued) => [
        { ...twoReadyComputers[0] },
        ...(issued ? [{ ...twoReadyComputers[1], connectedAt, connectionStatus: online ? "online" : "offline" }] : []),
      ],
    });
    const api = vi.mocked(fetch).getMockImplementation();
    if (!api) throw new Error("API fixture is missing");
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/v1/computer-connect-codes/"))
        return new Response(
          JSON.stringify({
            connectCodeId: String(path).split("/").at(-1),
            state: "redeemed",
            computerId: secondComputerId,
            redeemedAt: connectedAt,
          }),
          { headers: { "content-type": "application/json" } },
        );
      return api(path, init);
    });
    openComputer();
    fireEvent.click(await screen.findByRole("button", { name: "Connect a new computer" }));
    expect(await screen.findByText("Waiting for your computer…")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Zulu Tower" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect a new computer" })).toBeNull();
    expect(repairRequests()).toHaveLength(1);

    online = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("button", { name: "Connect a new computer" }, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Zulu Tower" })).toBeTruthy();
    expect(screen.getAllByText("Online")).toHaveLength(2);
    expect(repairRequests()).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith("/computer/rebind"))).toBe(false);
  });

  it("withdraws the additional connection entry when a cached inventory can no longer be confirmed", async () => {
    let failed = false;
    installApi({ bound: true, computerReadStatus: () => (failed ? 503 : undefined) });
    openComputer();
    expect(await screen.findByRole("button", { name: "Connect a new computer" })).toBeTruthy();
    failed = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect a new computer" })).toBeNull();
    expect(repairRequests()).toHaveLength(0);
  });

  it("shows every computer on one page even through an existing targeted link", async () => {
    installApi({ computers: twoReadyComputers });
    openComputer(`?computerId=${secondComputerId}`);
    expect(await screen.findByRole("heading", { name: "Zulu Tower" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
    expect(document.querySelectorAll('[data-ui="computer-management"]')).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /Manage (Ada|Zulu)/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "View account computers" })).toBeNull();
  });

  it("keeps the first connection attempt mounted between redemption and coming online", async () => {
    let online = false;
    const connectedAt = new Date().toISOString();
    installApi({
      computers: (issued) =>
        issued ? [{ ...twoReadyComputers[0], connectedAt, connectionStatus: online ? "online" : "offline" }] : [],
    });
    const api = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/v1/computer-connect-codes/"))
        return new Response(
          JSON.stringify({
            connectCodeId: String(path).split("/").at(-1),
            state: "redeemed",
            computerId,
            redeemedAt: connectedAt,
          }),
          { headers: { "content-type": "application/json" } },
        );
      if (!api) throw new Error("API fixture is missing");
      return api(path, init);
    });
    openComputer();
    fireEvent.click(await screen.findByRole("button", { name: "Connect computer" }));
    // After redemption the used command is gone and only the connection status remains.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Copy" })).toBeNull(), {
      timeout: 3_000,
    });
    expect(screen.getByText("Waiting for your computer…")).toBeTruthy();
    online = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Online", {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect your computer" })).toBeNull();
    expect(repairRequests()).toHaveLength(1);
  });

  it.each(["pending", "redeemed"] as const)("retains a %s attempt through inventory uncertainty", async (codeState) => {
    let failed = false,
      online = false;
    const issuedAt = new Date().toISOString();
    installApi({
      computers: () => [
        { ...twoReadyComputers[0], connectedAt: issuedAt, connectionStatus: online ? "online" : "offline" },
      ],
      computerReadStatus: () => (failed ? 503 : undefined),
    });
    const api = vi.mocked(fetch).getMockImplementation();
    if (!api) throw new Error("API fixture is missing");
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/v1/computer-connect-codes/"))
        return new Response(
          JSON.stringify({
            connectCodeId: String(path).split("/").at(-1),
            state: codeState,
            computerId: codeState === "redeemed" ? computerId : null,
            redeemedAt: codeState === "redeemed" ? issuedAt : null,
          }),
          { headers: { "content-type": "application/json" } },
        );
      return api(path, init);
    });
    openComputer();
    fireEvent.click(await screen.findByRole("button", { name: "Restore connection" }));
    const expectAttempt = async () => {
      if (codeState === "pending") expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
      else expect(await screen.findByText("Waiting for Ada's Mac to reconnect…", {}, { timeout: 3_000 })).toBeTruthy();
    };
    await expectAttempt();
    failed = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByText("Offline")).toBeNull();
    failed = false;
    fireEvent(window, new Event("focus"));
    await expectAttempt();
    expect(repairRequests()).toHaveLength(1);
    online = true;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Online", {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(document.querySelector('[data-ui="computer-recovery"]')).toBeNull();
  });

  it("presents cloud computers without local recovery or removal", async () => {
    installApi({ computers: [{ ...twoReadyComputers[0], kind: "cloud", connectionStatus: "offline" }] });
    openComputer();
    expect((await screen.findByText("Online")).closest('[data-state="success"]')).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Computer actions" })).toBeNull();
    expect(repairRequests()).toHaveLength(0);
  });

  it("reports a missing explicit target while retaining the inventory", async () => {
    installApi();
    openComputer("?computerId=missing");
    expect(await screen.findByText("This computer is no longer on your account.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ada's Mac" })).toBeTruthy();
  });

  it("does not offer a new connection when the inventory read fails", async () => {
    installApi({ computerEvidenceFails: true });
    openComputer();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect computer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(repairRequests()).toHaveLength(0);
  });

  it("opens recovery for an offline computer only when asked", async () => {
    installApi({ computers: [{ ...twoReadyComputers[0], agentIds: [], connectionStatus: "offline" }] });
    openComputer();
    const restore = await screen.findByRole("button", { name: "Restore connection" });
    // Several offline computers would otherwise each issue a command and lengthen the page.
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(repairRequests()).toHaveLength(0);

    fireEvent.click(restore);
    expect(await screen.findByRole("button", { name: "Copy" })).toBeTruthy();
    expect(repairRequests()).toHaveLength(1);
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore connection" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get connection help" })).toBeNull();
    const region = screen.getByRole("region", { name: "Restore connection" });
    expect(region.closest('[data-ui="computer-management"]')).toBeTruthy();
    expect(within(region).queryByText("Assistant requested a repair?")).toBeNull();
  });
});
