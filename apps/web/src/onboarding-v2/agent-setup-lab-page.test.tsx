import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "../query/client.js";
import { AgentSetupLabPage } from "./agent-setup-lab-page.js";

function renderLab() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AgentSetupLabPage />
    </QueryClientProvider>,
  );
}

async function openControls(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "New Agent Lab" }));
}

async function choose(label: string, option: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  selectOption(await screen.findByRole("option", { name: option }));
}

function selectOption(option: HTMLElement): void {
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

describe("AgentSetupLabPage", () => {
  it("keeps the focused New Agent controls in the lower-right corner", async () => {
    renderLab();

    const controls = await screen.findByRole("button", { name: "New Agent Lab" });
    const lab = controls.closest('[data-ui="onboarding-v2-lab"]');
    const page = controls.closest('[data-ui="onboarding-v2-lab-page"]');
    expect(lab?.className).toContain("fixed");
    expect(lab?.className).toContain("right-3");
    expect(lab?.className).toContain("bottom-3");
    expect(page?.className).not.toContain("lg:pr-[27rem]");

    await openControls();
    expect(page?.className).toContain("lg:pr-[27rem]");
    expect(screen.getByRole("button", { name: "First Agent" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Additional Agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Scenario" }));
    expect(screen.getByRole("option", { name: "Full journey · New computer" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Full journey · Existing computer" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Agent creation" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Computer connection" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Runtime setup" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Messaging setup" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Everything ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manual" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Auto" })).toBeTruthy();
  });

  it("shows the real creation choice and only exposes Back to agents for an additional Agent", async () => {
    renderLab();
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to agents" })).toBeNull();

    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Additional Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to agents" }));
    expect(
      await screen.findByText(
        "The real product would open the Agents list here. The Lab keeps this in-memory run isolated.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to Lab" }));
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });

  it("carries the runtime selected in the real creation form into First Agent setup", async () => {
    renderLab();
    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    expect(await screen.findByText("Opening app access for this agent…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete account admission" }));
    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();

    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Overrides" }));
    expect(screen.getByRole("combobox", { name: "Agent runtime" }).textContent).toContain("Claude Code");

    fireEvent.click(screen.getByRole("button", { name: "Additional Agent" }));
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });

  it("drives Feishu and Slack without leaving the Lab", async () => {
    renderLab();
    await openControls();
    await choose("Scenario", "Messaging setup");

    fireEvent.click(await screen.findByRole("button", { name: /Feishu|Lark/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Scan (Feishu|Lark) code/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Observe messaging handoff" }));
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open agent" }));
    expect(
      await screen.findByText("The real product would open Reviewer here. The Lab keeps this in-memory run isolated."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to Lab" }));

    await choose("Scenario", "Messaging setup");
    fireEvent.click(await screen.findByRole("button", { name: /Slack/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish Slack install" }));
    fireEvent.click(await screen.findByRole("button", { name: "Observe messaging handoff" }));
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
    expect(window.location.pathname).not.toContain("slack");
  });

  it("only offers the connected messaging override when that preset uses it", async () => {
    renderLab();
    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Overrides" }));
    expect(screen.queryByRole("combobox", { name: "Connected messaging app" })).toBeNull();

    await choose("Scenario", "Everything ready");
    await choose("Connected messaging app", "Slack");
    expect(await screen.findByText("Tag @reviewer in Slack to put it to work.")).toBeTruthy();
  });
});
