import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerConnectAdapter } from "./computer-connect.js";
import { ComputerRecovery } from "./computer-recovery.js";

const computer = { computerId: "review-mac", displayName: "Ada's Mac", platform: "darwin" } as const;
const repairCommand = "opentag computer connect --server https://opentag.example.com -- repair-code";

function createAdapter() {
  return {
    issue: vi.fn<ComputerConnectAdapter["issue"]>().mockResolvedValue({
      bootstrapCommand: repairCommand,
      connectCodeId: "repair-code",
      issuedAt: new Date().toISOString(),
      expiresIn: 900,
    }),
    status: vi.fn<ComputerConnectAdapter["status"]>().mockResolvedValue({
      connectCodeId: "repair-code",
      state: "pending",
      computerId: null,
      redeemedAt: null,
    }),
    computers: vi.fn<ComputerConnectAdapter["computers"]>().mockResolvedValue({ computers: [] }),
  };
}

describe("shared Computer recovery", () => {
  afterEach(() => Reflect.deleteProperty(navigator, "clipboard"));

  it("shows the first action before exposing commands or repair", () => {
    const adapter = createAdapter();
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={vi.fn()} />);

    expect(screen.getByText("Turn on or wake this computer and check its internet connection.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Get connection help" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(adapter.issue).not.toHaveBeenCalled();
    expect(adapter.status).not.toHaveBeenCalled();
  });

  it("copies one diagnostic task for the correct Computer without issuing a code or claiming recovery", async () => {
    const adapter = createAdapter();
    const onConnected = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);

    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    expect(await screen.findByText("Paste this into your coding assistant on Ada's Mac.")).toBeTruthy();
    const instructions = screen.getByRole("region", { name: "Restore connection" });
    expect(instructions.textContent).toContain("opentag doctor --json");
    expect(screen.queryByRole("button", { name: "View instructions" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy instructions" })));

    const payload = writeText.mock.calls[0]?.[0] as string;
    expect(payload).toContain("Ada's Mac (Computer ID: review-mac)");
    expect(payload).toContain("opentag doctor --json");
    expect(payload).toContain("opentag daemon status --json");
    expect(payload).toContain("only if the installed service is stopped");
    expect(payload).toContain("Preserve the Computer and Agent bindings");
    expect(payload).toContain("a running service alone is not proof");
    expect(payload).toBe(instructions.textContent);
    expect(payload).not.toContain(": '");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(screen.queryByText(/Terminal/)).toBeNull();
    expect(screen.queryByText(/Expires in/)).toBeNull();
    expect(adapter.issue).not.toHaveBeenCalled();
    expect(adapter.status).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("only issues a targeted repair on request, replaces the task, and retains it across closing help", async () => {
    const adapter = createAdapter();
    render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    fireEvent.click(await screen.findByRole("button", { name: "Assistant requested a repair?" }));
    expect(adapter.issue).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Repair connection" }));
    expect(await screen.findByText("Expires in 15:00")).toBeTruthy();
    expect(adapter.issue).toHaveBeenCalledExactlyOnceWith({ mode: "repair", target: computer });
    expect(document.querySelector("code")?.textContent).toContain(repairCommand);
    expect(screen.queryByRole("button", { name: "Copy instructions" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(document.querySelector("code")?.textContent).toContain(repairCommand);
    expect(adapter.issue).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnosis available on other platforms without presenting a standalone service command", async () => {
    render(
      <ComputerRecovery
        computer={{ ...computer, platform: "win32" }}
        adapter={createAdapter()}
        onConnected={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    expect(await screen.findByRole("button", { name: "Copy instructions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy command" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
  });

  it("selects the visible instructions for manual copying when clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ComputerRecovery computer={computer} adapter={createAdapter()} onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy instructions" })));

    expect(await screen.findByText("Copy failed. Select and copy the instructions.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    const instructions = screen.getByRole("region", { name: "Restore connection" });
    expect(instructions?.textContent).toBe(writeText.mock.calls[0]?.[0]);
    expect(window.getSelection()?.toString()).toBe(instructions?.textContent);

    writeText.mockResolvedValue(undefined);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy instructions" })));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByText("Copy failed. Select and copy the instructions.")).toBeNull();
  });

  it("does not carry copied feedback or instructions to a different Computer", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const adapter = createAdapter();
    const onConnected = vi.fn();
    const { rerender } = render(<ComputerRecovery computer={computer} adapter={adapter} onConnected={onConnected} />);
    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy instructions" })));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    rerender(
      <ComputerRecovery
        computer={{ ...computer, computerId: "other-mac", displayName: "Other Mac" }}
        adapter={adapter}
        onConnected={onConnected}
      />,
    );
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get connection help" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy instructions" })));
    expect(writeText.mock.calls[1]?.[0]).toContain("Other Mac (Computer ID: other-mac)");
    expect(writeText.mock.calls[1]?.[0]).not.toContain("Ada's Mac");
  });
});
