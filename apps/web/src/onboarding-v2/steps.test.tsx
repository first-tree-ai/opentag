import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentDraft } from "./flow.js";
import { AgentStep, DestinationStep } from "./steps.js";

const baseDraft: AgentDraft = { destination: undefined, name: "opentag", runtime: undefined };

describe("creation step navigation", () => {
  it("shows only Continue on the first step and enables it after a destination is selected", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <DestinationStep cloudAvailable={false} draft={baseDraft} onChoose={() => undefined} onSubmit={onSubmit} />,
    );

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton.hasAttribute("disabled")).toBe(true);

    rerender(
      <DestinationStep
        cloudAvailable={false}
        draft={{ ...baseDraft, destination: "local" }}
        onChoose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    expect(continueButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(continueButton);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("enables Back on the second step, then locks both navigation actions while creating", () => {
    const onBack = vi.fn();
    const onSubmit = vi.fn();
    const readyDraft: AgentDraft = { destination: "local", name: "opentag", runtime: "codex" };
    const { rerender } = render(
      <AgentStep
        draft={readyDraft}
        onBack={onBack}
        onChange={() => undefined}
        onSubmit={onSubmit}
        submitLabel="Create Agent"
      />,
    );

    const back = screen.getByRole("button", { name: "Back" });
    const create = screen.getByRole("button", { name: "Create Agent" });
    expect(back.hasAttribute("disabled")).toBe(false);
    expect(create.hasAttribute("disabled")).toBe(false);

    rerender(
      <AgentStep
        draft={readyDraft}
        onBack={onBack}
        onChange={() => undefined}
        onSubmit={onSubmit}
        submitLabel="Creating agent…"
        submitting
      />,
    );
    expect(back.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Creating agent…" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps Create Agent disabled until a Runtime is selected", () => {
    render(
      <AgentStep
        draft={{ destination: "local", name: "opentag", runtime: undefined }}
        onBack={() => undefined}
        onChange={() => undefined}
        onSubmit={() => undefined}
        submitLabel="Create Agent"
      />,
    );

    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(true);
  });
});
