import type { WorkspaceComputerSummary as Computer, ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { AgentComputerSettings } from "./agent-settings/agent-computer-settings.js";
import { ComputerSetup } from "./computer-setup.js";
import { ComputerList } from "./computers-page.js";

const bootstrapCommand = "opentag computer connect --server https://opentag.example.com -- connect-code";
const connectedAt = "2026-08-20T00:00:00.000Z";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REPLACEMENT_CODE_ID = "8b2d0f63-0b9c-4d8e-9f2a-3b4c5d6e7f8a";
/** The Server's redemption time for a verdict; every connected fixture connects at or after it. */
const REDEEMED_AT = "2026-08-19T23:59:59.000Z";
const existingComputer: Computer = {
  computerId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  connectedAt,
  lastSeenAt: "2026-08-20T00:00:01.000Z",
  observedAt: connectedAt,
  enrolledAt: connectedAt,
  agentIds: [],
};
const newComputer: Computer = {
  ...existingComputer,
  computerId: "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  displayName: "Ada's Linux Computer",
  platform: "linux",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The Server's verdict on the issued code; pending until a test says otherwise. */
function verdict(
  overrides: { connectCodeId?: string; state?: "pending" | "expired" | "revoked" } = {},
): ComputerConnectCodeStatus {
  return {
    connectCodeId: overrides.connectCodeId ?? CONNECT_CODE_ID,
    state: overrides.state ?? "pending",
    computerId: null,
    redeemedAt: null,
  };
}

function redeemedVerdict(computerId: string): ComputerConnectCodeStatus {
  return { connectCodeId: CONNECT_CODE_ID, state: "redeemed", computerId, redeemedAt: REDEEMED_AT };
}

/** An open wait polls the issued code's status; a code the test says nothing about stays pending. */
function verdictsReturning(...pages: readonly ComputerConnectCodeStatus[]) {
  let call = 0;
  return vi.spyOn(browserApi, "computerConnectCodeStatus").mockImplementation(async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? verdict();
    call += 1;
    return page;
  });
}

async function clickGenerate(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Generate connection command" }));
  });
}

describe("ComputerSetup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(connectedAt);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("issues a repair code against the target Computer, without a Computers read", async () => {
    const calls: string[] = [];
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      calls.push("computers");
      return { computers: [existingComputer] };
    });
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => {
      calls.push("issue");
      return { connectCodeId: CONNECT_CODE_ID, bootstrapCommand, expiresIn: 900, issuedAt: connectedAt };
    });
    verdictsReturning();

    render(
      <ComputerSetup target={{ computerId: existingComputer.computerId, displayName: existingComputer.displayName }} />,
    );
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    await clickGenerate();

    // The recovery is a repair of that exact Computer, and no list read precedes or informs it.
    expect(calls).toEqual(["issue"]);
    expect(issue).toHaveBeenCalledWith({ mode: "repair", targetComputerId: existingComputer.computerId });
    expect(screen.getByText(bootstrapCommand)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for Ada's Mac to connect…");
  });

  it("takes no baseline for an open wait: the Server's verdict names the Computer", async () => {
    const calls: string[] = [];
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      calls.push("computers");
      return { computers: [existingComputer] };
    });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => {
      calls.push("issue");
      return { connectCodeId: CONNECT_CODE_ID, bootstrapCommand, expiresIn: 900, issuedAt: connectedAt };
    });
    const verdicts = verdictsReturning();

    render(<ComputerSetup />);
    await clickGenerate();

    expect(calls).toEqual(["issue"]);
    expect(screen.getByText(bootstrapCommand)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");

    // The wait polls the code's status, and a pending verdict never consults the Computers list.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(verdicts).toHaveBeenCalledWith(CONNECT_CODE_ID);
    expect(calls).toEqual(["issue"]);
  });

  it("adopts exactly the Computer the Server says redeemed the code, and cleans up polling", async () => {
    const onConnected = vi.fn();
    // An unrelated machine is online throughout; only the verdict's machine can settle the wait.
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer, newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning(redeemedVerdict(newComputer.computerId));

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("status").textContent).toBe("Computer connected.");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected.mock.calls[0]?.[0].computerId).toBe(newComputer.computerId);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps waiting while the verdict is pending, whatever the Computers list shows", async () => {
    const onConnected = vi.fn();
    // A new Computer enrolling and an existing one reconnecting are both just list movement: no
    // verdict, no arrival.
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [newComputer, { ...existingComputer, connectedAt: "2026-08-20T00:00:02.000Z" }],
    });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning();

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("keeps waiting when the redeemed Computer has not connected yet", async () => {
    const onConnected = vi.fn();
    // The verdict names the machine the moment the code is spent; the panel waits for that exact
    // machine to actually come online rather than reporting the redemption itself as a connection.
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [{ ...newComputer, connectionStatus: "offline" as const, connectedAt: null }],
    });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning(redeemedVerdict(newComputer.computerId));

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it.each(["expired", "revoked"] as const)(
    "ends the wait on the Server's %s verdict, ahead of the local clock",
    async (state) => {
      const onConnected = vi.fn();
      vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [newComputer] });
      vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand,
        expiresIn: 900,
        issuedAt: connectedAt,
      });
      verdictsReturning(verdict({ state }));

      render(<ComputerSetup onConnected={onConnected} />);
      await clickGenerate();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });

      // Fail closed: the wait ends with the same terminal the local expiry uses, and the machine
      // that happens to be enrolled nearby is not adopted.
      expect(screen.getByRole("alert").textContent).toBe(
        "This Computer connection command expired. Generate a new one to continue.",
      );
      expect(screen.queryByRole("status")).toBeNull();
      expect(onConnected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cleans up polling when unmounted", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning();

    const view = render(<ComputerSetup />);
    await clickGenerate();
    expect(vi.getTimerCount()).toBe(2);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops polling when the connect code expires", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 2,
      issuedAt: connectedAt,
    });
    verdictsReturning();

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByRole("alert").textContent).toBe(
      "This Computer connection command expired. Generate a new one to continue.",
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts expiry and polling when a replacement command is generated", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: "first command",
        expiresIn: 2,
        issuedAt: connectedAt,
      })
      .mockResolvedValueOnce({
        connectCodeId: REPLACEMENT_CODE_ID,
        bootstrapCommand: "replacement command",
        expiresIn: 5,
        issuedAt: "2026-08-20T00:00:01.000Z",
      });
    const verdicts = verdictsReturning();

    render(<ComputerSetup />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await clickGenerate();

    expect(screen.getByText("replacement command")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.getTimerCount()).toBe(2);
    // The replacement cycle polls its own code, never the expired one.
    expect(verdicts).toHaveBeenLastCalledWith(REPLACEMENT_CODE_ID);
  });

  it("clears an old-cycle error when replacement issuance succeeds", async () => {
    const replacementIssue = deferred<{
      connectCodeId: string;
      bootstrapCommand: string;
      expiresIn: number;
      issuedAt: string;
    }>();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: "first command",
        expiresIn: 2,
        issuedAt: connectedAt,
      })
      .mockImplementationOnce(() => replacementIssue.promise);
    verdictsReturning();

    render(<ComputerSetup />);
    await clickGenerate();
    await clickGenerate();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "This Computer connection command expired. Generate a new one to continue.",
    );

    await act(async () => {
      replacementIssue.resolve({
        connectCodeId: REPLACEMENT_CODE_ID,
        bootstrapCommand: "replacement command",
        expiresIn: 5,
        issuedAt: "2026-08-20T00:00:02.000Z",
      });
      await Promise.resolve();
    });

    expect(screen.getByText("replacement command")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("ignores an old in-flight poll after replacement issuance succeeds", async () => {
    const oldPoll = deferred<ComputerConnectCodeStatus>();
    const replacementIssue = deferred<{
      connectCodeId: string;
      bootstrapCommand: string;
      expiresIn: number;
      issuedAt: string;
    }>();
    const onConnected = vi.fn();
    let statusCall = 0;
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockImplementation(() => {
      statusCall += 1;
      // 1 = the poll left in flight across the replacement, 2+ = the replacement code's own polls.
      return statusCall === 1 ? oldPoll.promise : Promise.resolve(verdict({ connectCodeId: REPLACEMENT_CODE_ID }));
    });
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: "first command",
        expiresIn: 900,
        issuedAt: connectedAt,
      })
      .mockImplementationOnce(() => replacementIssue.promise);

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await clickGenerate();

    await act(async () => {
      replacementIssue.resolve({
        connectCodeId: REPLACEMENT_CODE_ID,
        bootstrapCommand: "replacement command",
        expiresIn: 900,
        issuedAt: "2026-08-20T00:00:01.500Z",
      });
      await Promise.resolve();
      // The stale verdict lands redeemed — for the superseded code, so it must not be adopted.
      oldPoll.resolve(redeemedVerdict(newComputer.computerId));
      await Promise.resolve();
    });

    expect(screen.getByText("replacement command")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("keeps the current polling cycle when replacement issuance fails", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer, newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand: "first command",
        expiresIn: 900,
        issuedAt: connectedAt,
      })
      .mockRejectedValueOnce(new Error("Replacement command failed"));
    verdictsReturning(redeemedVerdict(newComputer.computerId));

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    await clickGenerate();

    expect(screen.getByRole("alert").textContent).toBe("Replacement command failed");
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("status").textContent).toBe("Computer connected.");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("copies the command and counts down on the existing poll cycle", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning();

    render(<ComputerSetup />);
    await clickGenerate();

    expect(screen.getByText("Expires in 15:00")).toBeTruthy();
    // The command owns no timer of its own: the poll cycle and the expiry deadline stay the only two.
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByText("Expires in 14:59")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    });

    expect(writeText).toHaveBeenCalledWith(bootstrapCommand);
    expect(screen.getAllByText("Copied!", { exact: true }).length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
  });

  it("keeps the Kumo copy affordance when the browser denies clipboard access", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning();

    render(<ComputerSetup />);
    await clickGenerate();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    });

    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(
      screen.queryByText("Copying is unavailable here. The command is selected; press Ctrl or Cmd + C."),
    ).toBeNull();
  });

  it("stops showing the countdown once the Computer connects", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer, newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning(redeemedVerdict(newComputer.computerId));

    render(<ComputerSetup />);
    await clickGenerate();
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("status").textContent).toBe("Computer connected.");
    expect(screen.queryByText(/^Expires in/)).toBeNull();
  });

  it("normalizes connect-code issuance errors", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockRejectedValue("unavailable");

    render(<ComputerSetup />);
    await clickGenerate();

    expect(screen.getByRole("alert").textContent).toBe("Unable to create a Computer connection command");
    expect(screen.queryByRole("status")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes polling errors and keeps waiting", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    // The status read is the wait's only poll; a transient failure is reported and retired.
    let statusCall = 0;
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockImplementation(async () => {
      statusCall += 1;
      if (statusCall === 1) return Promise.reject("offline");
      return verdict();
    });

    render(<ComputerSetup />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("alert").textContent).toBe("Unable to refresh the connection command status");
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(vi.getTimerCount()).toBe(2);
  });

  it("reports a failed Computers read after redemption with its own wording, and keeps waiting", async () => {
    // The Computers read only happens once a verdict names a Computer, so its failure wording is
    // about the list, not the command status.
    vi.spyOn(browserApi, "computers").mockRejectedValue("offline");
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning(redeemedVerdict(newComputer.computerId));

    render(<ComputerSetup />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("alert").textContent).toBe("Unable to refresh Computers");
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(vi.getTimerCount()).toBe(2);
  });
  it("names the target Computer in its prompt and waiting status", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

    render(
      <ComputerSetup target={{ computerId: existingComputer.computerId, displayName: existingComputer.displayName }} />,
    );

    expect(screen.getByRole("heading", { name: "Reconnect Ada's Mac" })).toBeTruthy();
    await clickGenerate();

    expect(screen.getByRole("status").textContent).toBe("Waiting for Ada's Mac to connect…");
  });

  it("adopts the target Computer once the Server reports the repair code redeemed", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [{ ...existingComputer, connectedAt: "2026-08-20T00:00:02.000Z" }],
    });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning(redeemedVerdict(existingComputer.computerId));

    render(
      <ComputerSetup
        onConnected={onConnected}
        target={{ computerId: existingComputer.computerId, displayName: existingComputer.displayName }}
      />,
    );
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("status").textContent).toBe("Ada's Mac is connected.");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected.mock.calls[0]?.[0].computerId).toBe(existingComputer.computerId);
  });

  it("keeps waiting for the target while the repair code is pending, whatever else reconnects", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer, newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning();

    render(
      <ComputerSetup
        onConnected={onConnected}
        target={{ computerId: existingComputer.computerId, displayName: existingComputer.displayName }}
      />,
    );
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Waiting for Ada's Mac to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("refuses a redemption verdict that names a different Computer than the target", async () => {
    // A repair verdict can only ever name the target; anything else is not this command's answer,
    // and adopting it would drift the recovery onto a Computer it was never meant for.
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer, newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning(redeemedVerdict(newComputer.computerId));

    render(
      <ComputerSetup
        onConnected={onConnected}
        target={{ computerId: existingComputer.computerId, displayName: existingComputer.displayName }}
      />,
    );
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Waiting for Ada's Mac to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(browserApi.computers).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it.each([
    ["offline", { ...existingComputer, connectionStatus: "offline" as const, connectedAt: null }],
    ["on a connection predating redemption", { ...existingComputer, connectedAt: "2026-08-19T23:59:58.000Z" }],
  ])("keeps waiting for the repaired target while it is %s", async (_state, targetComputer) => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [targetComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });
    verdictsReturning(redeemedVerdict(existingComputer.computerId));

    render(
      <ComputerSetup
        onConnected={onConnected}
        target={{ computerId: existingComputer.computerId, displayName: existingComputer.displayName }}
      />,
    );
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Waiting for Ada's Mac to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it.each(["expired", "revoked"] as const)(
    "ends a targeted wait on the Server's %s verdict without adopting anything",
    async (state) => {
      const onConnected = vi.fn();
      vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer, newComputer] });
      vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
        connectCodeId: CONNECT_CODE_ID,
        bootstrapCommand,
        expiresIn: 900,
        issuedAt: connectedAt,
      });
      verdictsReturning(verdict({ state }));

      render(
        <ComputerSetup
          onConnected={onConnected}
          target={{ computerId: existingComputer.computerId, displayName: existingComputer.displayName }}
        />,
      );
      await clickGenerate();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });

      expect(screen.getByRole("alert").textContent).toBe(
        "This Computer connection command expired. Generate a new one to continue.",
      );
      expect(screen.queryByRole("status")).toBeNull();
      expect(onConnected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("answers the primary action in preview without issuing a code or polling", async () => {
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode");
    const computers = vi.spyOn(browserApi, "computers");
    render(<ComputerSetup preview />);

    await clickGenerate();

    // Review has to see the step this action opens, so the command, its copy affordance and a
    // running validity are all rendered — from a fixed command, with no Server reached.
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(screen.getByText(/^Expires in /)).toBeTruthy();
    expect(issue).not.toHaveBeenCalled();
    expect(computers).not.toHaveBeenCalled();

    // No poll cycle started, so nothing can expire the command out from under a reviewer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(computers).not.toHaveBeenCalled();
  });

  it("explains when the assigned Computer status cannot be confirmed", () => {
    const agent = {
      id: "agent-1",
      runtimeProvider: "codex",
      computer: {
        computerId: existingComputer.computerId,
        displayName: existingComputer.displayName,
        platform: "darwin",
      },
      availability: {
        state: "unconfirmed",
        reason: "computer_unconfirmed",
        dependencies: {
          computer: { state: "unconfirmed", lastConfirmedAt: null },
          runtime: { provider: "codex", status: "ready" },
        },
      },
    } as never;
    render(<AgentComputerSettings agent={agent} onAgentChanged={vi.fn()} />);
    expect(screen.getByText("Unable to confirm")).toBeTruthy();
    expect(screen.getByText(/could not confirm this Computer/i)).toBeTruthy();
  });
});

describe("ComputerList", () => {
  it("explains when no Computers are enrolled", () => {
    render(<ComputerList computers={[]} />);

    expect(screen.getByRole("heading", { name: "Enrolled Computers" })).toBeTruthy();
    expect(screen.getByText("No Computers are enrolled yet.")).toBeTruthy();
  });
});
