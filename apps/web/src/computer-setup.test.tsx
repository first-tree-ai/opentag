import type { Computer } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "./api.js";
import { ComputerSetup } from "./computer-setup.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const bootstrapCommand = "opentag login --server https://opentag.example.com -- connect-code";
const connectedAt = "2026-08-20T00:00:00.000Z";
const existingComputer: Computer = {
  id: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  ownerUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  displayName: "Ada's Mac",
  platform: "darwin",
  arch: "arm64",
  clientVersion: "0.0.1",
  connectionStatus: "online",
  connectedAt,
  lastSeenAt: "2026-08-20T00:00:01.000Z",
};
const newComputer: Computer = {
  ...existingComputer,
  id: "95fe9af3-d1c6-472b-b78c-8a7ccf512750",
  displayName: "Ada's Linux Computer",
  platform: "linux",
};

async function clickGenerate(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Generate connection command" }));
  });
}

describe("ComputerSetup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("captures the owned-Computer baseline before issuing a connect code", async () => {
    const calls: string[] = [];
    vi.spyOn(browserApi, "ownComputers").mockImplementation(async () => {
      calls.push("baseline");
      return { computers: [existingComputer] };
    });
    vi.spyOn(browserApi, "issueConnectCode").mockImplementation(async () => {
      calls.push("issue");
      return { bootstrapCommand, expiresIn: 900, issuedAt: connectedAt };
    });

    render(<ComputerSetup teamId={teamId} />);
    await clickGenerate();

    expect(calls).toEqual(["baseline", "issue"]);
    expect(screen.getByText(bootstrapCommand)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
  });

  it.each([
    ["new", [existingComputer, newComputer]],
    ["refreshed", [{ ...existingComputer, lastSeenAt: "2026-08-20T00:00:02.000Z" }]],
  ])("detects a %s Computer and cleans up polling on completion", async (_kind, polledComputers) => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "ownComputers")
      .mockResolvedValueOnce({ computers: [existingComputer] })
      .mockResolvedValue({ computers: polledComputers });
    vi.spyOn(browserApi, "issueConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

    render(<ComputerSetup teamId={teamId} onConnected={onConnected} />);
    await clickGenerate();
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("status").textContent).toBe("Computer connected.");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not report an unchanged Computer as connected", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "ownComputers").mockResolvedValue({ computers: [existingComputer] });
    vi.spyOn(browserApi, "issueConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

    render(<ComputerSetup teamId={teamId} onConnected={onConnected} />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("cleans up polling when unmounted", async () => {
    vi.spyOn(browserApi, "ownComputers").mockResolvedValue({ computers: [existingComputer] });
    vi.spyOn(browserApi, "issueConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

    const view = render(<ComputerSetup teamId={teamId} />);
    await clickGenerate();
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes connect-code issuance errors", async () => {
    vi.spyOn(browserApi, "ownComputers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueConnectCode").mockRejectedValue("unavailable");

    render(<ComputerSetup teamId={teamId} />);
    await clickGenerate();

    expect(screen.getByRole("alert").textContent).toBe("Unable to create a Computer connection command");
    expect(screen.queryByRole("status")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes polling errors and keeps waiting", async () => {
    vi.spyOn(browserApi, "ownComputers")
      .mockResolvedValueOnce({ computers: [] })
      .mockRejectedValueOnce("offline")
      .mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

    render(<ComputerSetup teamId={teamId} />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("alert").textContent).toBe("Unable to refresh Computers");
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(vi.getTimerCount()).toBe(1);
  });
});
