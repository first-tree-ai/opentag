import type { AccountComputerSummary as Computer, ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { ComputerConnect } from "./computer-connect.js";

const NOW = "2026-08-20T00:00:00.000Z";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REPLACEMENT_CODE_ID = "8b2d0f63-0b9c-4d8e-9f2a-3b4c5d6e7f8a";
const COMPUTER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const OTHER_COMPUTER_ID = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const COMMAND = "opentag computer connect --server https://opentag.example.com -- connect-code";
const REPLACEMENT_COMMAND = "opentag computer connect --server https://opentag.example.com -- replacement-connect-code";
const REDEEMED_AT = "2026-08-20T00:00:01.000Z";
// What the block both shows and copies for `Ada's Mac`: the POSIX null command, with the
// apostrophe closed and reopened so the sentence cannot escape its quotes.
const REPAIR_COMMENT = ": 'Run this command to reconnect OpenTag on Ada'\\''s Mac.'";

const computer: Computer = {
  computerId: COMPUTER_ID,
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  connectedAt: "2026-08-20T00:00:02.000Z",
  lastSeenAt: "2026-08-20T00:00:02.000Z",
  observedAt: "2026-08-20T00:00:02.000Z",
  createdAt: NOW,
  agentIds: [],
};

function pending(connectCodeId = CONNECT_CODE_ID): ComputerConnectCodeStatus {
  return { connectCodeId, state: "pending", computerId: null, redeemedAt: null };
}

function redeemed(computerId = COMPUTER_ID): ComputerConnectCodeStatus {
  return { connectCodeId: CONNECT_CODE_ID, state: "redeemed", computerId, redeemedAt: REDEEMED_AT };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function commandIsShown(command: string): boolean {
  return [...document.querySelectorAll("code")].some((node) => node.textContent?.includes(command));
}

describe("ComputerConnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue(pending());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("issues a create command as soon as the explicit flow mounts", async () => {
    const issued = deferred<Awaited<ReturnType<typeof browserApi.issueComputerConnectCode>>>();
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode").mockReturnValue(issued.promise);

    render(<ComputerConnect intent={{ mode: "create" }} />);

    expect(issue).toHaveBeenCalledOnce();
    expect(issue).toHaveBeenCalledWith({ mode: "create" });
    expect(screen.getByRole("status").textContent).toContain("Preparing connection command");
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
    const skeleton = document.querySelector('[data-ui="computer-connect-command-skeleton"]');
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
    expect(skeleton?.classList.contains("ots-command-pending")).toBe(true);
    expect(skeleton?.textContent).toContain("[connection command pending]");
    expect(skeleton?.textContent).not.toContain("opentag.example.com");
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(screen.queryByRole("code")).toBeNull();

    issued.resolve({ connectCodeId: CONNECT_CODE_ID, bootstrapCommand: COMMAND, expiresIn: 900, issuedAt: NOW });
    await flushAsync();
    expect(commandIsShown(COMMAND)).toBe(true);
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(
      screen.getByText("Paste this command into the coding agent on the computer you're connecting."),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Waiting for your computer");
    const remaining = screen.getByText("Expires in 15:00");
    expect(remaining.closest('[role="status"]')).toBeNull();
    expect(remaining.parentElement?.getAttribute("data-ui")).toBe("computer-connect-expiry");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("Expires in 14:59")).toBeTruthy();
  });

  it("keeps repair idle inside the command surface, then issues against the exact target", async () => {
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });

    render(
      <ComputerConnect
        intent={{ mode: "repair", target: { computerId: COMPUTER_ID, displayName: computer.displayName } }}
      />,
    );
    expect(issue).not.toHaveBeenCalled();
    const repairAction = screen.getByRole("button", { name: "Generate a repair command" });
    expect(repairAction.closest(".ots-command__body")).toBeTruthy();
    expect(screen.getByText("Need to reinstall?")).toBeTruthy();
    expect(screen.getByText(/Start OpenTag on Ada's Mac/)).toBeTruthy();
    fireEvent.click(repairAction);
    await flushAsync();

    expect(issue).toHaveBeenCalledWith({ mode: "repair", targetComputerId: COMPUTER_ID });
    expect(screen.getByText("Paste this command into the coding agent on Ada's Mac.")).toBeTruthy();
    expect(screen.getByText(REPAIR_COMMENT)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(`Waiting for ${computer.displayName} to reconnect`);
  });

  it("copies a comment the terminal ignores instead of one zsh tries to run", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(
      <ComputerConnect
        intent={{ mode: "repair", target: { computerId: COMPUTER_ID, displayName: computer.displayName } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate a repair command" }));
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await flushAsync();

    /*
     * A leading `#` is only a comment where `interactive_comments` is set, which zsh leaves off for
     * interactive use, so the pasted line answered `command not found: #` before the real command
     * ran. `Ada's Mac` also carries the apostrophe that would otherwise close the quoted sentence
     * and hand the rest of it to the shell as commands.
     */
    expect(writeText).toHaveBeenCalledWith(`${REPAIR_COMMENT}\n${COMMAND}`);
    expect(REPAIR_COMMENT.startsWith("#")).toBe(false);
  });

  it("adopts only the Computer named by this code's Server verdict", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed());
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });

    render(<ComputerConnect intent={{ mode: "create" }} onConnected={onConnected} />);
    await flushAsync();

    expect(computers).toHaveBeenCalledOnce();
    expect(onConnected).toHaveBeenCalledWith(computer);
    expect(screen.getByText("Ada's Mac is connected")).toBeTruthy();
  });

  it("does not let another Computer satisfy a repair attempt", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed(OTHER_COMPUTER_ID));
    const computers = vi.spyOn(browserApi, "computers");

    render(
      <ComputerConnect
        intent={{ mode: "repair", target: { computerId: COMPUTER_ID, displayName: computer.displayName } }}
        onConnected={onConnected}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate a repair command" }));
    await flushAsync();

    expect(computers).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(`Waiting for ${computer.displayName} to reconnect`);
  });

  it.each([
    { label: "offline", connectionStatus: "offline" as const, connectedAt: computer.connectedAt },
    { label: "connected before redemption", connectionStatus: "online" as const, connectedAt: NOW },
  ])("keeps waiting when the redeemed Computer is $label", async ({ connectedAt, connectionStatus }) => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed());
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [{ ...computer, connectedAt, connectionStatus }],
    });

    render(<ComputerConnect intent={{ mode: "create" }} onConnected={onConnected} />);
    await flushAsync();

    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Waiting for your computer");
  });

  it("keeps an issued command through a transient poll failure and clears the error on recovery", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus)
      .mockRejectedValueOnce(new Error("Temporary polling failure"))
      .mockResolvedValue(pending());

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();

    expect(commandIsShown(COMMAND)).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Temporary polling failure");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(commandIsShown(COMMAND)).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps polling the exact redeemed Computer after the command deadline", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 1,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed());
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });

    render(<ComputerConnect intent={{ mode: "create" }} onConnected={onConnected} />);
    await flushAsync();
    await vi.waitFor(() => {
      expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(document.querySelector('[data-ui="computer-connect-expiry"]')?.textContent).toBe("");
    computers.mockResolvedValue({ computers: [computer] });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(onConnected).toHaveBeenCalledWith(computer);
    expect(screen.queryByText("This command has expired.")).toBeNull();
    expect(browserApi.issueComputerConnectCode).toHaveBeenCalledOnce();
  });

  it.each(["expired", "revoked"] as const)("keeps a %s command in place and disables copying", async (state) => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state,
      computerId: null,
      redeemedAt: null,
    });

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();

    expect(commandIsShown(COMMAND)).toBe(true);
    expect(screen.getByText("This command has expired.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Connection command expired");
    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Get a new command" })).toBeTruthy();
  });

  it("reissues in place after local expiry", async () => {
    const issue = vi
      .spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: COMMAND,
        expiresIn: 1,
        issuedAt: NOW,
      })
      .mockResolvedValueOnce({
        connectCodeId: REPLACEMENT_CODE_ID,
        bootstrapCommand: REPLACEMENT_COMMAND,
        expiresIn: 900,
        issuedAt: "2026-08-20T00:00:01.000Z",
      });

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(commandIsShown(COMMAND)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    expect(screen.getByRole("status").textContent).toContain("Preparing connection command");
    await flushAsync();

    expect(issue).toHaveBeenCalledTimes(2);
    expect(commandIsShown(COMMAND)).toBe(false);
    expect(commandIsShown(REPLACEMENT_COMMAND)).toBe(true);
    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("waits for an in-flight deadline verdict before offering a replacement", async () => {
    const oldPoll = deferred<ComputerConnectCodeStatus>();
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: COMMAND,
        expiresIn: 1,
        issuedAt: NOW,
      })
      .mockResolvedValueOnce({
        connectCodeId: REPLACEMENT_CODE_ID,
        bootstrapCommand: REPLACEMENT_COMMAND,
        expiresIn: 900,
        issuedAt: "2026-08-20T00:00:01.000Z",
      });
    vi.mocked(browserApi.computerConnectCodeStatus)
      .mockReturnValueOnce(oldPoll.promise)
      .mockResolvedValue(pending(REPLACEMENT_CODE_ID));
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const onConnected = vi.fn();

    render(<ComputerConnect intent={{ mode: "create" }} onConnected={onConnected} />);
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByRole("button", { name: "Get a new command" })).toBeNull();
    oldPoll.resolve({
      connectCodeId: CONNECT_CODE_ID,
      state: "expired",
      computerId: null,
      redeemedAt: null,
    });
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await flushAsync();

    expect(computers).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(commandIsShown(REPLACEMENT_COMMAND)).toBe(true);
  });

  it("restores an expired command when replacement issuance fails", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: COMMAND,
        expiresIn: 1,
        issuedAt: NOW,
      })
      .mockRejectedValueOnce(new Error("Issuance unavailable"));

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await flushAsync();

    expect(commandIsShown(COMMAND)).toBe(true);
    expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Issuance unavailable");
    expect(alert.closest(".ots-command__body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("retries an initial issuance failure", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockRejectedValueOnce(new Error("Issuance unavailable"))
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: COMMAND,
        expiresIn: 900,
        issuedAt: NOW,
      });

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();
    expect(screen.getByRole("alert").textContent).toContain("Issuance unavailable");
    expect(screen.getByRole("alert").closest(".ots-command__body")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(screen.queryByText("opentag.example.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flushAsync();
    expect(commandIsShown(COMMAND)).toBe(true);
  });

  it("issues only once when Strict Mode replays its mount effect", async () => {
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });

    render(
      <StrictMode>
        <ComputerConnect intent={{ mode: "create" }} />
      </StrictMode>,
    );
    await flushAsync();

    expect(issue).toHaveBeenCalledOnce();
    expect(commandIsShown(COMMAND)).toBe(true);
  });

  it("cleans up timers and ignores a late poll after unmount", async () => {
    const poll = deferred<ComputerConnectCodeStatus>();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockReturnValue(poll.promise);
    const computers = vi.spyOn(browserApi, "computers");

    const view = render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();
    view.unmount();
    poll.resolve(redeemed());
    await flushAsync();

    expect(computers).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late issuance response after unmount", async () => {
    const issued = deferred<Awaited<ReturnType<typeof browserApi.issueComputerConnectCode>>>();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockReturnValue(issued.promise);

    const view = render(<ComputerConnect intent={{ mode: "create" }} />);
    view.unmount();
    issued.resolve({ connectCodeId: CONNECT_CODE_ID, bootstrapCommand: COMMAND, expiresIn: 900, issuedAt: NOW });
    await flushAsync();

    expect(browserApi.computerConnectCodeStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
