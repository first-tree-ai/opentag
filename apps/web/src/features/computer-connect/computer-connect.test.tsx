import type { AccountComputerSummary as Computer, ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as renderPlain, screen } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analytics } from "../../analytics/analytics.js";
import type { GtagCommand } from "../../analytics/gtag.js";
import { ApiError, browserApi } from "../../api.js";
import { createQueryClient } from "../../query/client.js";
import { ComputerConnect } from "./computer-connect.js";

function render(ui: ReactNode) {
  const client = createQueryClient();
  const view = renderPlain(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return Object.assign(view, { disposeQueryClient: () => client.clear() });
}

const NOW = "2026-08-20T00:00:00.000Z";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REPLACEMENT_CODE_ID = "8b2d0f63-0b9c-4d8e-9f2a-3b4c5d6e7f8a";
const COMPUTER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const OTHER_COMPUTER_ID = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const COMMAND = "opentag computer connect --server https://opentag.example.com -- connect-code";
const REPLACEMENT_COMMAND = "opentag computer connect --server https://opentag.example.com -- replacement-connect-code";
const REDEEMED_AT = "2026-08-20T00:00:01.000Z";

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

function expandedTaskIncludesCommand(command: string): boolean {
  const expand = screen.queryByRole("button", { name: "Show full instructions" });
  if (expand) fireEvent.click(expand);
  return [...document.querySelectorAll(".ots-command__code")].some((node) => node.textContent?.includes(command));
}

describe("ComputerConnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue(pending());
  });

  afterEach(() => {
    analytics.disarm();
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
    expect(screen.queryByRole("button", { name: "Copy for AI assistant" })).toBeNull();
    expect(screen.queryByRole("code")).toBeNull();

    issued.resolve({ connectCodeId: CONNECT_CODE_ID, bootstrapCommand: COMMAND, expiresIn: 900, issuedAt: NOW });
    await flushAsync();
    expect(expandedTaskIncludesCommand(COMMAND)).toBe(true);
    expect(screen.getByRole("button", { name: "Copy for AI assistant" })).toBeTruthy();
    expect(screen.getByText("Copy the task to your AI assistant on this computer.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Waiting for your computer");
    const remaining = screen.getByText("Expires in 15:00");
    expect(remaining.closest('[role="status"]')).toBeNull();
    expect(remaining.parentElement?.getAttribute("data-ui")).toBe("computer-connect-expiry");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("Expires in 14:59")).toBeTruthy();
  });

  it("shows server-authored issuance errors and logs structured diagnostics", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockRejectedValue(
      new ApiError(503, "The server refused this connection."),
    );

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();

    expect(screen.getByRole("alert").textContent).toContain("The server refused this connection.");
    expect(console.warn).toHaveBeenCalledWith(
      "[OpenTag] Computer connect failure",
      expect.objectContaining({
        source: "ui",
        operation: "issue",
        errorName: "ApiError",
        error: { name: "ApiError", message: "The server refused this connection." },
      }),
    );
  });

  it.each(["current", "another"] as const)(
    "copies the same complete connection task for the %s computer",
    async (executionLocation) => {
      const issue = vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: COMMAND,
        expiresIn: 900,
        issuedAt: NOW,
      });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      render(<ComputerConnect executionLocation={executionLocation} intent={{ mode: "create" }} />);
      await flushAsync();
      expect(
        screen.getByText(
          executionLocation === "current"
            ? "Copy the task to your AI assistant on this computer."
            : "Copy the task to your AI assistant on the target computer. Return here to continue setup when it connects.",
        ),
      ).toBeTruthy();
      const region = screen.getByRole("region", { name: "Connect computer" });
      expect(region.textContent).not.toContain(COMMAND);
      fireEvent.click(screen.getByRole("button", { name: "Copy for AI assistant" }));
      await flushAsync();
      const payload = writeText.mock.calls[0]?.[0] as string;
      expect(payload).toContain(COMMAND);
      expect(payload).toContain("Preserve a working connection");
      expect(payload).toContain("Do not redeem an already-used authorization");
      expect(payload).not.toContain("target computer");
      fireEvent.click(screen.getByRole("button", { name: "Show full instructions" }));
      expect(region.textContent).toBe(payload);
      expect(issue).toHaveBeenCalledExactlyOnceWith({ mode: "create" });
    },
  );

  it("uses the translated fallback for a transport issuance failure", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockRejectedValue(new TypeError("Failed to fetch"));

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn’t prepare the connection command.");
    expect(alert.textContent).not.toContain("Failed to fetch");
  });

  it("uses the translated fallback when an issuance error has no message", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockRejectedValue(new Error());

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn’t prepare the connection command.");
  });

  it("keeps repair idle compact without a command surface, then issues against the exact target", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [{ ...computer, connectionStatus: "offline" }] });
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
    const repairAction = screen.getByRole("button", { name: "Repair connection" });
    expect(repairAction.closest(".ots-command__body")).toBeNull();
    expect(screen.queryByText("Need to reinstall?")).toBeNull();
    // Idle is the one state with no command and no countdown, so it renders no lead row. The
    // failed and expired states still introduce a command that is not there to paste; that is
    // older than this change and left alone rather than half-fixed here.
    expect(screen.queryByText(/Start openTag on Ada's Mac/)).toBeNull();
    fireEvent.click(repairAction);
    await flushAsync();

    expect(issue).toHaveBeenCalledWith({ mode: "repair", targetComputerId: COMPUTER_ID });
    expect(screen.getByText("Copy the task to your AI assistant on Ada's Mac.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show full instructions" }));
    expect(screen.getByRole("region", { name: "Restore connection" }).textContent).toContain(COMPUTER_ID);
    expect(screen.getByRole("status").textContent).toContain(`Waiting for ${computer.displayName} to reconnect`);
  });

  it("copies the complete targeted recovery task before expansion", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Repair connection" }));
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: "Copy for AI assistant" }));
    await flushAsync();

    const payload = writeText.mock.calls[0]?.[0] as string;
    expect(payload).toContain(`Computer: ${computer.displayName}`);
    expect(payload).toContain(`Computer ID: ${COMPUTER_ID}`);
    expect(payload).toContain(COMMAND);
    expect(payload).toContain("Preserve the original Computer ID, Agent assignments, and user data");
    fireEvent.click(screen.getByRole("button", { name: "Show full instructions" }));
    expect(screen.getByRole("region", { name: "Restore connection" }).textContent).toBe(payload);
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

  it("reports the command being shown and the connection that follows it, once each", async () => {
    const sent: GtagCommand[] = [];
    analytics.arm((command) => sent.push(command));
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed());
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();
    // The poll keeps running after the latch; a second verdict must not be a second connection.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent.map((command) => command[1])).toEqual(["computer_connect_started", "computer_connected"]);
    expect(sent[1]?.[2]).toEqual({ mode: "create", funnel: "activation", funnel_step: 3 });
  });

  it("keeps a repair out of the activation funnel, while still reporting it", async () => {
    const sent: GtagCommand[] = [];
    analytics.arm((command) => sent.push(command));
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed());
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });

    render(
      <ComputerConnect
        intent={{ mode: "repair", target: { computerId: COMPUTER_ID, displayName: computer.displayName } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Repair connection" }));
    await flushAsync();

    // Reconnecting a Computer the Account already had is not somebody reaching step 3 again.
    expect(sent.map((command) => command[1])).toEqual(["computer_connect_started", "computer_connected"]);
    expect(sent[1]?.[2]).toEqual({ mode: "repair" });
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
    fireEvent.click(screen.getByRole("button", { name: "Repair connection" }));
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
    expect(screen.getByRole("status").textContent).toContain("Command accepted. Waiting for openTag to come online");
  });

  it("keeps an issued command through a transient poll failure and clears the error on recovery", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(pending());

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();

    expect(expandedTaskIncludesCommand(COMMAND)).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t check the connection status.");
    expect(screen.getByRole("alert").textContent).not.toContain("Failed to fetch");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(expandedTaskIncludesCommand(COMMAND)).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses the translated fallback when redeemed inventory polling fails", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed());
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [] })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ computers: [] });

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn’t check the connection status.");
    expect(alert.textContent).not.toContain("Failed to fetch");
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
      expect(screen.queryByRole("button", { name: "Copy for AI assistant" })).toBeNull();
    });
    expect(document.querySelector('[data-ui="computer-connect-expiry"]')).toBeNull();
    computers.mockResolvedValue({ computers: [computer] });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));

    expect(onConnected).toHaveBeenCalledWith(computer);
    expect(screen.queryByText("This command is no longer valid.")).toBeNull();
    expect(browserApi.issueComputerConnectCode).toHaveBeenCalledOnce();
  });

  it("retires a redeemed attempt if access is subsequently disconnected elsewhere", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemed());
    const inventory = vi
      .spyOn(browserApi, "computers")
      .mockResolvedValue({ computers: [{ ...computer, connectionStatus: "offline" }] });
    render(<ComputerConnect intent={{ mode: "repair", target: computer }} onConnected={onConnected} />);
    fireEvent.click(screen.getByRole("button", { name: "Repair connection" }));
    await flushAsync();
    inventory.mockResolvedValue({ computers: [{ ...computer, connectionStatus: "disconnected", connectedAt: null }] });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByRole("button", { name: "Get a new command" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy for AI assistant" })).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    expect(browserApi.issueComputerConnectCode).toHaveBeenCalledOnce();
  });

  it.each(["expired", "revoked"] as const)("retires a %s command and offers replacement", async (state) => {
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

    expect(expandedTaskIncludesCommand(COMMAND)).toBe(false);
    expect(screen.getByText("This command is no longer valid.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("This command is no longer valid.");
    expect(screen.queryByRole("button", { name: "Copy for AI assistant" })).toBeNull();
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
    expect(expandedTaskIncludesCommand(COMMAND)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    expect(screen.getByRole("status").textContent).toContain("Preparing connection command");
    await flushAsync();

    expect(issue).toHaveBeenCalledTimes(2);
    expect(expandedTaskIncludesCommand(COMMAND)).toBe(false);
    expect(expandedTaskIncludesCommand(REPLACEMENT_COMMAND)).toBe(true);
    expect((screen.getByRole("button", { name: "Copy for AI assistant" }) as HTMLButtonElement).disabled).toBe(false);
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
    expect(expandedTaskIncludesCommand(REPLACEMENT_COMMAND)).toBe(true);
  });

  it("keeps replacement failure retryable without showing an expired command", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: COMMAND,
        expiresIn: 1,
        issuedAt: NOW,
      })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await flushAsync();

    expect(expandedTaskIncludesCommand(COMMAND)).toBe(false);
    expect(screen.queryByRole("button", { name: "Copy for AI assistant" })).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn’t prepare the connection command.");
    expect(alert.textContent).not.toContain("Failed to fetch");
    expect(alert.closest(".ots-command__body")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("retries an initial issuance failure", async () => {
    vi.spyOn(browserApi, "issueComputerConnectCode").mockRejectedValueOnce(new Error()).mockResolvedValueOnce({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });

    render(<ComputerConnect intent={{ mode: "create" }} />);
    await flushAsync();
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t prepare the connection command.");
    expect(screen.getByRole("alert").closest(".ots-command__body")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy for AI assistant" })).toBeNull();
    expect(screen.queryByText("opentag.example.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flushAsync();
    expect(expandedTaskIncludesCommand(COMMAND)).toBe(true);
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
    expect(expandedTaskIncludesCommand(COMMAND)).toBe(true);
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
    const statusCalls = vi.mocked(browserApi.computerConnectCodeStatus).mock.calls.length;
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(vi.mocked(browserApi.computerConnectCodeStatus).mock.calls.length).toBe(statusCalls);
    poll.resolve(redeemed());
    await flushAsync();
    expect(computers).not.toHaveBeenCalled();
    view.disposeQueryClient();
  });

  it("ignores a late issuance response after unmount", async () => {
    const issued = deferred<Awaited<ReturnType<typeof browserApi.issueComputerConnectCode>>>();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockReturnValue(issued.promise);

    const view = render(<ComputerConnect intent={{ mode: "create" }} />);
    view.unmount();
    issued.resolve({ connectCodeId: CONNECT_CODE_ID, bootstrapCommand: COMMAND, expiresIn: 900, issuedAt: NOW });
    await flushAsync();
    expect(browserApi.computerConnectCodeStatus).not.toHaveBeenCalled();
    view.disposeQueryClient();
  });
});
