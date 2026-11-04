import type { AccountComputerSummary, ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerConnectAdapter } from "./computer-connect.js";
import { ComputerRecovery } from "./computer-recovery.js";

const computer: AccountComputerSummary = {
  computerId: "review-mac",
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "offline",
  connectedAt: null,
  lastSeenAt: null,
  observedAt: "2026-10-10T00:00:00.000Z",
  createdAt: "2026-10-10T00:00:00.000Z",
  agentIds: [],
};
const command = "opentag connect --server https://opentag.example.com -- repair-code";
const pending: ComputerConnectCodeStatus = {
  connectCodeId: "repair-code",
  state: "pending",
  computerId: null,
  redeemedAt: null,
};
function createAdapter() {
  return {
    issue: vi.fn<ComputerConnectAdapter["issue"]>().mockResolvedValue({
      bootstrapCommand: command,
      connectCodeId: "repair-code",
      issuedAt: new Date().toISOString(),
      expiresIn: 900,
    }),
    status: vi.fn<ComputerConnectAdapter["status"]>().mockResolvedValue(pending),
    computers: vi.fn<ComputerConnectAdapter["computers"]>().mockResolvedValue({ computers: [computer] }),
  };
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_500);
  });
}
function clipboard(fails = false) {
  const writeText = fails
    ? vi.fn().mockRejectedValue(new Error("NotAllowedError"))
    : vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("shared Computer recovery", () => {
  it("automatically prepares exactly one targeted task under Strict Mode, without repair disclosures", async () => {
    const adapter = createAdapter();
    render(
      <StrictMode>
        <ComputerRecovery computer={computer} adapter={adapter} onConnected={vi.fn()} />
      </StrictMode>,
    );
    await settle();
    expect(adapter.issue).toHaveBeenCalledExactlyOnceWith({ mode: "repair", target: computer });
    expect(screen.getByText("Run this in a terminal on Ada's Mac, or send it to your Agent there.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Get connection help" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assistant requested a repair?" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.queryByText(/Turn on or wake/)).toBeNull();
    // The shared command window: expiry beside the command and one connection status.
    expect(screen.getByText(/^Expires in /)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Waiting for Ada's Mac to reconnect…");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows and copies the repair command itself, without claiming reconnection", async () => {
    const adapter = createAdapter(),
      onConnected = vi.fn(),
      writeText = clipboard();
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);
    await settle();
    const region = screen.getByRole("region", { name: "Restore connection" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    const payload = writeText.mock.calls[0]?.[0] as string;
    const [agentLine, commandLine, extra] = payload.split("\n");
    expect(agentLine).toMatch(/^: 'openTag: restore the connection of Ada'\\''s Mac\. Run the next line as-is/);
    expect(commandLine).toBe(command);
    expect(extra).toBeUndefined();
    expect(onConnected).not.toHaveBeenCalled();
    expect(region.textContent).toBe(payload);
    expect(screen.queryByRole("button", { name: "Show full instructions" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copied" })));
    expect(writeText.mock.calls[1]?.[0]).toBe(payload);
    expect(adapter.issue).toHaveBeenCalledOnce();
  });

  it("selects the complete command when clipboard access fails", async () => {
    const writeText = clipboard(true);
    render(<ComputerRecovery computer={computer} adapter={createAdapter()} onConnected={vi.fn()} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(window.getSelection()?.toString()).toBe(writeText.mock.calls[0]?.[0]);
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("withholds new authorization during uncertainty and retains the exact issued task afterward", async () => {
    const adapter = createAdapter(),
      onConnected = vi.fn();
    const view = render(
      <ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} available={false} />,
    );
    expect(adapter.issue).not.toHaveBeenCalled();
    view.rerender(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);
    await settle();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    view.rerender(
      <ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} available={false} />,
    );
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    await poll();
    view.rerender(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(adapter.issue).toHaveBeenCalledOnce();
  });

  it("retires expired instructions and only prepares a replacement when requested", async () => {
    const adapter = createAdapter();
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={vi.fn()} />);
    await settle();
    screen.getByRole("button", { name: "Copy" }).focus();
    adapter.status.mockResolvedValue({
      connectCodeId: "repair-code",
      state: "expired",
      computerId: null,
      redeemedAt: null,
    });
    await poll();
    // The masked copy control is disabled, so focus moves to the single Refresh action.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh" }));
    expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
    await poll();
    expect(adapter.issue).toHaveBeenCalledOnce();
    adapter.status.mockResolvedValue(pending);
    adapter.issue.mockResolvedValue({
      bootstrapCommand: "replacement-command",
      connectCodeId: "replacement",
      issuedAt: new Date().toISOString(),
      expiresIn: 900,
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    expect(screen.getByRole("region", { name: "Restore connection" }).textContent).toContain("replacement-command");
    expect(screen.getByRole("region", { name: "Restore connection" }).textContent).not.toContain(command);
    expect(adapter.issue).toHaveBeenCalledTimes(2);
  });

  it("does not let an unrelated online Computer finish recovery, but observes restoration without redemption", async () => {
    const adapter = createAdapter(),
      onConnected = vi.fn();
    adapter.computers.mockResolvedValue({
      computers: [{ ...computer, computerId: "other", connectionStatus: "online" }, computer],
    });
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    adapter.computers.mockResolvedValue({ computers: [{ ...computer, connectionStatus: "online" }] });
    await poll();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(screen.getByText("Ada's Mac is connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    await poll();
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it("shows progress only after redemption and waits for the exact newly connected Computer", async () => {
    const adapter = createAdapter(),
      onConnected = vi.fn(),
      redeemedAt = new Date().toISOString();
    adapter.status.mockResolvedValue({
      connectCodeId: "repair-code",
      state: "redeemed",
      computerId: computer.computerId,
      redeemedAt,
    });
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);
    await settle();
    // Whether the command was used is not shown: only the connection status.
    expect(screen.getByRole("status").textContent).toContain("Waiting for Ada's Mac to reconnect…");
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    adapter.computers.mockResolvedValue({
      computers: [{ ...computer, connectionStatus: "online", connectedAt: redeemedAt }],
    });
    await poll();
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it("observes actual restoration even if the optional authorization status is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = createAdapter();
    const onConnected = vi.fn();
    adapter.status.mockRejectedValue(new Error("Authorization status unavailable"));
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    adapter.computers.mockResolvedValue({ computers: [{ ...computer, connectionStatus: "online" }] });
    await poll();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(screen.getByText("Ada's Mac is connected")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("withholds expired authorization during a status outage without issuing a duplicate attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = createAdapter();
    adapter.issue.mockResolvedValue({
      bootstrapCommand: command,
      connectCodeId: "repair-code",
      issuedAt: new Date().toISOString(),
      expiresIn: 2,
    });
    adapter.status.mockRejectedValue(new Error("Authorization status unavailable"));
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={vi.fn()} />);
    await settle();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_001);
    });
    // Past the deadline the command is masked at once, with nothing new issued until the verdict.
    expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(adapter.issue).toHaveBeenCalledOnce();
    adapter.status.mockResolvedValue({ ...pending, state: "expired" });
    await poll();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("recovers from issuance failure without exposing an incomplete task", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = createAdapter();
    adapter.issue.mockRejectedValueOnce(new Error("failure"));
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={vi.fn()} />);
    await settle();
    expect(screen.getByText("Couldn’t prepare the connection command.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});
