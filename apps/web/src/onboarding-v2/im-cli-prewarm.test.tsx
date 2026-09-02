import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnownComputer } from "./backend.js";
import type { AgentDraft, ReadinessFacts } from "./flow.js";
import { ComputerStep, MessagingStep } from "./steps.js";

const draft: AgentDraft = {
  cloudRuntime: undefined,
  destination: "local",
  name: "ada",
  runtime: "codex",
  tokenSource: undefined,
};

const computer: KnownComputer = { id: "mac", availability: "online", displayName: "Ada's Mac" };

const readiness: ReadinessFacts = {
  runtime: "ready",
  runtimeProvider: "codex",
  messagingCli: { feishu: "install", slack: "unavailable" },
};

describe("onboarding IM CLI prewarm presentation", () => {
  it("shows both official CLI statuses on the computer step without changing Continue", () => {
    render(
      <ComputerStep
        computer={computer}
        draft={draft}
        onComputerConnected={() => undefined}
        onContinue={() => undefined}
        readiness={readiness}
      />,
    );

    const statuses = document.querySelector('[data-ui="onboarding-v2-im-cli-readiness"]');
    expect(statuses?.textContent).toContain("Lark CLI");
    expect(statuses?.textContent).toContain("Preparing");
    expect(statuses?.textContent).toContain("Slack CLI");
    expect(statuses?.textContent).toContain("Unavailable");
    expect(document.querySelectorAll(".ots-check")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps messaging provider cards selectable regardless of local CLI state", () => {
    const onChoose = vi.fn();
    const onStart = vi.fn();
    render(
      <MessagingStep
        computerOnline
        messaging={{ kind: "idle" }}
        onChoose={onChoose}
        onSlackInstall={() => undefined}
        onStart={onStart}
        provider={undefined}
        readiness={readiness}
      />,
    );

    const lark = screen.getByRole("button", { name: /Lark/ }) as HTMLButtonElement;
    const slack = screen.getByRole("button", { name: /Slack/ }) as HTMLButtonElement;
    expect(lark.disabled).toBe(false);
    expect(slack.disabled).toBe(false);
    expect(lark.textContent).toContain("Preparing");
    expect(slack.textContent).toContain("Unavailable");
    fireEvent.click(lark);
    fireEvent.click(slack);
    expect(onChoose).toHaveBeenCalledWith("feishu");
    expect(onChoose).toHaveBeenCalledWith("slack");
  });

  it("treats a successful binding with a pending or failed CLI as waiting, not authorization failure", () => {
    render(
      <MessagingStep
        computerOnline
        messaging={{ kind: "waiting-handoff" }}
        onChoose={() => undefined}
        onSlackInstall={() => undefined}
        onStart={() => undefined}
        provider="feishu"
        readiness={readiness}
      />,
    );

    expect(screen.queryByText("That didn't work. Try again to get a new code.")).toBeNull();
    expect(screen.getByRole("status").textContent).not.toMatch(/didn't work/i);
  });
});
