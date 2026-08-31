import type { WorkspaceComputerSummary as Computer } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { AgentComputerSettings } from "./agent-settings/agent-computer-settings.js";
import { ComputerSetup } from "./computer-setup.js";
import { ComputerList } from "./computers-page.js";

const bootstrapCommand = "opentag computer connect --server https://opentag.example.com -- connect-code";
const connectedAt = "2026-08-20T00:00:00.000Z";
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

  it("captures the owned-Computer baseline before issuing a connect code", async () => {
    const calls: string[] = [];
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      calls.push("baseline");
      return { computers: [existingComputer] };
    });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => {
      calls.push("issue");
      return { bootstrapCommand, expiresIn: 900, issuedAt: connectedAt };
    });

    render(<ComputerSetup />);
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    await clickGenerate();

    expect(calls).toEqual(["baseline", "issue"]);
    expect(screen.getByText(bootstrapCommand)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
  });

  it.each([
    ["new", [existingComputer, newComputer]],
    ["refreshed", [{ ...existingComputer, connectedAt: "2026-08-20T00:00:02.000Z" }]],
  ])("detects a %s Computer and cleans up polling on completion", async (_kind, polledComputers) => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [existingComputer] })
      .mockResolvedValue({ computers: polledComputers });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole("status").textContent).toBe("Computer connected.");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not report an existing Computer heartbeat as connected", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [existingComputer] })
      .mockResolvedValue({
        computers: [{ ...existingComputer, lastSeenAt: "2026-08-20T00:00:10.000Z" }],
      });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("cleans up polling when unmounted", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [existingComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

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
      bootstrapCommand,
      expiresIn: 2,
      issuedAt: connectedAt,
    });

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
        bootstrapCommand: "first command",
        expiresIn: 2,
        issuedAt: connectedAt,
      })
      .mockResolvedValueOnce({
        bootstrapCommand: "replacement command",
        expiresIn: 5,
        issuedAt: "2026-08-20T00:00:01.000Z",
      });

    render(<ComputerSetup />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await clickGenerate();

    expect(screen.getByText("replacement command")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });

    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("clears an old-cycle error when replacement issuance succeeds", async () => {
    const replacementIssue = deferred<{ bootstrapCommand: string; expiresIn: number; issuedAt: string }>();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({ bootstrapCommand: "first command", expiresIn: 2, issuedAt: connectedAt })
      .mockImplementationOnce(() => replacementIssue.promise);

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
    const oldPoll = deferred<{ computers: Computer[] }>();
    const replacementIssue = deferred<{ bootstrapCommand: string; expiresIn: number; issuedAt: string }>();
    const onConnected = vi.fn();
    let ownComputersCall = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(() => {
      ownComputersCall += 1;
      return ownComputersCall === 2 ? oldPoll.promise : Promise.resolve({ computers: [] });
    });
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({ bootstrapCommand: "first command", expiresIn: 900, issuedAt: connectedAt })
      .mockImplementationOnce(() => replacementIssue.promise);

    render(<ComputerSetup onConnected={onConnected} />);
    await clickGenerate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await clickGenerate();

    await act(async () => {
      replacementIssue.resolve({
        bootstrapCommand: "replacement command",
        expiresIn: 900,
        issuedAt: "2026-08-20T00:00:01.500Z",
      });
      await Promise.resolve();
      oldPoll.resolve({ computers: [newComputer] });
      await Promise.resolve();
    });

    expect(screen.getByText("replacement command")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    expect(onConnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
  });

  it("keeps the current polling cycle when replacement issuance fails", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [] })
      .mockResolvedValueOnce({ computers: [] })
      .mockResolvedValue({ computers: [newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode")
      .mockResolvedValueOnce({ bootstrapCommand: "first command", expiresIn: 900, issuedAt: connectedAt })
      .mockRejectedValueOnce(new Error("Replacement command failed"));

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
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

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
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

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
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [existingComputer] })
      .mockResolvedValue({ computers: [existingComputer, newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

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
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [] })
      .mockRejectedValueOnce("offline")
      .mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

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

  it("confirms the target Computer by name once it reconnects", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [existingComputer] })
      .mockResolvedValue({ computers: [{ ...existingComputer, connectedAt: "2026-08-20T00:00:02.000Z" }] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

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
  });

  it("keeps waiting for the target when an unrelated Computer reconnects", async () => {
    const onConnected = vi.fn();
    vi.spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [existingComputer] })
      .mockResolvedValue({ computers: [existingComputer, newComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand,
      expiresIn: 900,
      issuedAt: connectedAt,
    });

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
