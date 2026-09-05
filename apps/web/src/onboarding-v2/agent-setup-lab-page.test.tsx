/** The complete New Agent lab over the same compact setup surface users see. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { AgentSetupLabPage } from "./agent-setup-lab-page.js";
import { deferred } from "./agent-setup-test-fixtures.js";

function mockBrowserApi(): void {
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
  vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(() => deferred<never>().promise);
}

function renderLabPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSetupLabPage />
    </QueryClientProvider>,
  );
}

function readinessRow(component: string): HTMLElement {
  const element = document.querySelector(`[data-ui="readiness-list"] [data-component="${component}"]`);
  if (!element) throw new Error(`Missing readiness row for ${component}`);
  return element as HTMLElement;
}

function stateSummaryRow(label: string): HTMLElement {
  const summary = screen.getByRole("region", { name: "Current state" });
  const term = within(summary).getByText(label, { selector: "dt" });
  if (!term.parentElement) throw new Error(`Missing state summary row for ${label}`);
  return term.parentElement;
}

async function openControls(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('[data-ui="onboarding-v2-lab"] button[aria-controls]');
  if (!trigger) throw new Error("Missing New Agent Lab trigger");
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

async function chooseOption(label: string, optionName: string): Promise<void> {
  if (label === "Start from") await openControls();
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(screen.getByRole("combobox", { name: label }).textContent?.trim()).toContain(optionName));
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

beforeEach(() => mockBrowserApi());
afterEach(() => vi.restoreAllMocks());

describe("agent setup lab page", () => {
  it("keeps the complete journey controls in the lower-right beside the production preview", async () => {
    renderLabPage();

    const controls = document.querySelector<HTMLButtonElement>('[data-ui="onboarding-v2-lab"] button[aria-controls]');
    expect(controls).not.toBeNull();
    if (!controls) throw new Error("Missing New Agent Lab trigger");
    const lab = controls.closest('[data-ui="onboarding-v2-lab"]');
    const page = controls.closest('[data-ui="onboarding-v2-lab-page"]');
    expect(lab?.className).toContain("fixed");
    expect(lab?.className).toContain("right-3");
    expect(lab?.className).toContain("bottom-3");
    expect(page?.className).not.toContain("lg:pr-[27rem]");
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(document.querySelector('[data-ui="readiness-lab"]')).toBeNull();

    await openControls();
    expect(screen.getByRole("button", { name: "Close" })).toBe(controls);
    expect(screen.getByRole("button", { name: "First Agent" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Additional Agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manual" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Auto" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Flow progress" }).textContent).toContain("No pending event.");
    expect(screen.getByText("Run the complete Agent journey and connect a new Computer.")).toBeTruthy();
    expect(stateSummaryRow("Computer").textContent).toContain("Waiting");
    expect(stateSummaryRow("Runtime · Codex").textContent).toContain("Waiting");
    expect(stateSummaryRow("Messaging support").textContent).toContain("Waiting");
    expect(stateSummaryRow("Messaging connection").textContent).toContain("Not started");
    expect(screen.queryByText("Lark CLI", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Slack CLI", { selector: "dt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Visual edge cases" })).toBeNull();

    const trigger = screen.getByRole("combobox", { name: "Start from" });
    fireEvent.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent?.trim() ?? "")).toEqual([
      "Journey · New computer",
      "Journey · Existing computer",
      "Checkpoint · Agent creation",
      "Checkpoint · Connect computer",
      "Checkpoint · Reconnect computer",
      "Checkpoint · Replace computer",
      "Preparation · Runtime report missing",
      "Preparation · Runtime checking",
      "Preparation · Install Runtime",
      "Preparation · Sign in to Runtime",
      "Preparation · Fix messaging support",
      "Preparation ready · Connect messaging",
      "Messaging · Waiting for handoff",
      "Messaging · Needs recovery",
      "Complete · Everything ready",
    ]);
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));

    await chooseOption("Start from", "Complete · Everything ready");
    await waitFor(() => expect(document.querySelector('[data-ui="agent-setup-ready"]')).not.toBeNull());
    expect(screen.getByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
  });

  it("makes the blocked-messaging and all-preparation-ready combinations explicit", async () => {
    renderLabPage();

    await chooseOption("Start from", "Preparation · Fix messaging support");
    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Journey" })).toBeNull();
    expect(stateSummaryRow("Computer").textContent).toContain("Ready");
    expect(stateSummaryRow("Runtime · Codex").textContent).toContain("Ready");
    expect(stateSummaryRow("Messaging support").textContent).toContain("Needs attention");
    expect(stateSummaryRow("Messaging connection").textContent).toContain("Not started");
    expect(readinessRow("messaging-support").getAttribute("data-status")).toBe("needs-attention");
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();

    await chooseOption("Start from", "Preparation ready · Connect messaging");
    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(stateSummaryRow("Computer").textContent).toContain("Ready");
    expect(stateSummaryRow("Runtime · Codex").textContent).toContain("Ready");
    expect(stateSummaryRow("Messaging support").textContent).toContain("Ready");
    expect(stateSummaryRow("Messaging connection").textContent).toContain("Not started");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
  });

  it("separates messaging support from the messaging connection lifecycle", async () => {
    renderLabPage();

    await chooseOption("Start from", "Messaging · Waiting for handoff");
    expect(stateSummaryRow("Messaging support").textContent).toContain("Ready");
    expect(stateSummaryRow("Messaging connection · Lark").textContent).toContain("Waiting for handoff");

    await chooseOption("Start from", "Messaging · Needs recovery");
    expect(stateSummaryRow("Messaging support").textContent).toContain("Ready");
    expect(stateSummaryRow("Messaging connection · Lark").textContent).toContain("Needs attention");

    await chooseOption("Start from", "Complete · Everything ready");
    expect(stateSummaryRow("Messaging connection · Lark").textContent).toContain("Ready");
  });

  it("shows the real creation choice and only exposes Back to agents for an additional Agent", async () => {
    renderLabPage();
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

  it("carries the creation Runtime into setup without allowing the created Agent to change it", async () => {
    renderLabPage();
    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    expect(await screen.findByText("Opening app access for this agent…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete account admission" }));
    expect(await screen.findByRole("heading", { name: "Connect your computer" })).toBeTruthy();

    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune state" }));
    expect(screen.queryByRole("combobox", { name: "Agent runtime" })).toBeNull();
    expect(stateSummaryRow("Runtime · Claude Code").textContent).toContain("Waiting");
    expect(screen.queryByText("1 changed")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Additional Agent" }));
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });

  it("marks a forced Computer outage as custom until the recovery event restores it", async () => {
    renderLabPage();
    await chooseOption("Start from", "Complete · Everything ready");
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune state" }));

    fireEvent.click(screen.getByRole("button", { name: "Take computer offline" }));
    expect(screen.getByText("1 changed")).toBeTruthy();
    expect(stateSummaryRow("Computer").textContent).toContain("Needs attention");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect computer" }));
    expect(screen.queryByText("1 changed")).toBeNull();
    expect(stateSummaryRow("Computer").textContent).toContain("Ready");
  });

  it("drops an ephemeral Computer override when another control rebuilds the scenario", async () => {
    renderLabPage();
    await chooseOption("Start from", "Complete · Everything ready");
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune state" }));
    fireEvent.click(screen.getByRole("button", { name: "Take computer offline" }));

    await chooseOption("Agent runtime", "Claude Code");

    expect(screen.getByText("1 changed")).toBeTruthy();
    expect(stateSummaryRow("Computer").textContent).toContain("Ready");
    expect(stateSummaryRow("Runtime · Claude Code").textContent).toContain("Ready");
  });

  it("drives Feishu and Slack without leaving the Lab", async () => {
    renderLabPage();
    await chooseOption("Start from", "Preparation ready · Connect messaging");

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Feishu|Lark/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Scan (Feishu|Lark) code/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Observe messaging handoff" }));
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open agent" }));
    expect(
      await screen.findByText("The real product would open Reviewer here. The Lab keeps this in-memory run isolated."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to Lab" }));

    await chooseOption("Start from", "Preparation ready · Connect messaging");
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Slack/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish Slack install" }));
    fireEvent.click(await screen.findByRole("button", { name: "Observe messaging handoff" }));
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
    expect(window.location.pathname).not.toContain("slack");
  });

  it("only offers the connected messaging override when that preset uses it", async () => {
    renderLabPage();
    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune state" }));
    expect(screen.queryByRole("combobox", { name: "Connected messaging app" })).toBeNull();

    await chooseOption("Start from", "Complete · Everything ready");
    await chooseOption("Connected messaging app", "Slack");
    expect(await screen.findByText("Tag @reviewer in Slack to put it to work.")).toBeTruthy();
    expect(screen.getByText("1 changed")).toBeTruthy();
    expect(stateSummaryRow("Messaging connection · Slack").textContent).toContain("Ready");
  });
});
