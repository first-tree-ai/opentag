import type { ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerConnectAdapter } from "../features/computer-connect/computer-connect.js";
import type { KnownComputer } from "./backend.js";
import type { AgentDraft } from "./flow.js";
import { ComputerStep } from "./steps.js";

const draft: AgentDraft = {
  cloudRuntime: undefined,
  destination: "local",
  name: "ada",
  runtime: "codex",
  tokenSource: undefined,
};

function computer(id: string, availability: KnownComputer["availability"]): KnownComputer {
  return { id, availability, displayName: id === "mac" ? "Ada's Mac" : "Work iMac" };
}

describe("ComputerStep repair disclosure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the pending onboarding command channel-neutral", () => {
    vi.useFakeTimers();
    const adapter: ComputerConnectAdapter = {
      issue: () => new Promise(() => undefined),
      status: () => new Promise<ComputerConnectCodeStatus>(() => undefined),
      computers: async () => ({ computers: [] }),
    };

    render(
      <ComputerStep
        adapter={adapter}
        computer={undefined}
        draft={draft}
        onComputerConnected={() => undefined}
        onContinue={() => undefined}
        readiness={undefined}
      />,
    );

    const panel = document.querySelector('[data-ui="onboarding-v2-computer-connect"]');
    expect(panel?.textContent).toContain("[connection command pending]");
    expect(panel?.textContent).not.toContain("opentag.example.com");
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("requires a fresh repair action after availability or target changes", async () => {
    vi.useFakeTimers();
    const issue = vi.fn().mockResolvedValue({
      bootstrapCommand: "opentag computer connect -- code",
      connectCodeId: "connect-code",
      expiresIn: 900,
      issuedAt: "2026-08-20T00:00:00.000Z",
    });
    const adapter: ComputerConnectAdapter = {
      issue,
      status: () => new Promise<ComputerConnectCodeStatus>(() => undefined),
      computers: async () => ({ computers: [] }),
    };
    const view = render(
      <ComputerStep
        adapter={adapter}
        computer={computer("mac", "offline")}
        draft={draft}
        onComputerConnected={() => undefined}
        onContinue={() => undefined}
        readiness={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." }));
    await act(async () => Promise.resolve());
    expect(issue).toHaveBeenCalledTimes(1);

    view.rerender(
      <ComputerStep
        adapter={adapter}
        computer={computer("mac", "unknown")}
        draft={draft}
        onComputerConnected={() => undefined}
        onContinue={() => undefined}
        readiness={undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." })).toBeTruthy();
    expect(issue).toHaveBeenCalledTimes(1);

    view.rerender(
      <ComputerStep
        adapter={adapter}
        computer={computer("imac", "offline")}
        draft={draft}
        onComputerConnected={() => undefined}
        onContinue={() => undefined}
        readiness={undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." })).toBeTruthy();
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("disables the onboarding command after redemption while the exact Computer is still arriving", async () => {
    vi.useFakeTimers();
    const adapter: ComputerConnectAdapter = {
      issue: vi.fn().mockResolvedValue({
        bootstrapCommand: "opentag computer connect -- code",
        connectCodeId: "connect-code",
        expiresIn: 900,
        issuedAt: "2026-08-20T00:00:00.000Z",
      }),
      status: vi.fn().mockResolvedValue({
        computerId: "mac",
        connectCodeId: "connect-code",
        redeemedAt: "2026-08-20T00:00:01.000Z",
        state: "redeemed",
      }),
      computers: vi.fn().mockResolvedValue({ computers: [] }),
    };

    render(
      <ComputerStep
        adapter={adapter}
        computer={undefined}
        draft={draft}
        onComputerConnected={() => undefined}
        onContinue={() => undefined}
        readiness={undefined}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
