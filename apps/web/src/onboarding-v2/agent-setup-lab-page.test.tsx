/** The complete New Agent lab over the same compact setup surface users see. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

async function openControls(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('[data-ui="onboarding-v2-lab"] button[aria-controls]');
  if (!trigger) throw new Error("Missing New Agent Lab trigger");
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

function pageForState(
  optionName: string,
): "Choose location" | "Name & Runtime" | "Connect computer" | "Verify environment" | "Connect messaging" | "Ready" {
  if (["New computer", "Existing computer"].includes(optionName)) return "Choose location";
  if (optionName === "Agent creation") return "Name & Runtime";
  if (["Connect computer", "Reconnect computer", "Replace computer"].includes(optionName)) {
    return "Connect computer";
  }
  if (
    [
      "Runtime report missing",
      "Runtime checking",
      "Install Runtime",
      "Sign in to Runtime",
      "Fix messaging support",
      "Ready to continue",
    ].includes(optionName)
  ) {
    return "Verify environment";
  }
  if (["Connect messaging", "Waiting for handoff", "Needs recovery"].includes(optionName)) {
    return "Connect messaging";
  }
  if (optionName === "Everything ready") return "Ready";
  throw new Error(`Unknown Screen state: ${optionName}`);
}

/** Opens the labelled combobox and picks the option by its visible label. */
async function chooseOption(label: string, optionName: string): Promise<void> {
  if (label === "Screen state") await openControls();
  if (label === "Screen state") {
    const pageName = pageForState(optionName);
    const pageTrigger = screen.getByRole("combobox", { name: "Screen" });
    if (pageTrigger.textContent?.trim() !== pageName) {
      fireEvent.click(pageTrigger);
      const pageOption = await screen.findByRole("option", { name: pageName });
      fireEvent.pointerMove(pageOption, { pointerType: "mouse" });
      fireEvent.pointerDown(pageOption, { pointerType: "mouse" });
      fireEvent.pointerUp(pageOption, { pointerType: "mouse" });
      fireEvent.click(pageOption);
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Screen" }).textContent?.trim()).toBe(pageName));
      await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    }
  }
  const trigger = screen.queryByRole("combobox", { name: label });
  if (!trigger) return;
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
    expect(screen.queryByRole("region", { name: "Simulated flow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manual" })).toBeNull();
    expect(screen.getByText("Run the complete Agent journey and connect a new Computer.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Current state" })).toBeNull();

    const trigger = screen.getByRole("combobox", { name: "Screen state" });
    fireEvent.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent?.trim() ?? "")).toEqual(["New computer", "Existing computer"]);
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));

    await chooseOption("Screen state", "Everything ready");
    await waitFor(() => expect(document.querySelector('[data-ui="agent-setup-ready"]')).not.toBeNull());
    expect(screen.getByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
  });

  it("switches the production preview directly from the Screen control", async () => {
    renderLabPage();
    await openControls();

    expect(screen.getByRole("combobox", { name: "Screen" }).textContent?.trim()).toBe("Choose location");

    await chooseOption("Screen", "Name & Runtime");
    expect(await screen.findByRole("heading", { name: "Create your agent" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Screen state" })).toBeNull();

    await chooseOption("Screen", "Connect computer");
    expect(await screen.findByRole("heading", { name: "Connect your computer" })).toBeTruthy();

    await chooseOption("Screen", "Verify environment");
    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();

    await chooseOption("Screen", "Connect messaging");
    expect(await screen.findByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();

    await chooseOption("Screen", "Ready");
    await waitFor(() => expect(document.querySelector('[data-ui="agent-setup-ready"]')).not.toBeNull());
    expect(screen.queryByRole("combobox", { name: "Screen state" })).toBeNull();
  });

  it("keeps Screen synchronized when the production creation page moves forward and back", async () => {
    renderLabPage();
    await openControls();

    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Create your agent" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Screen" }).textContent?.trim()).toBe("Name & Runtime"),
    );
    expect(screen.queryByRole("combobox", { name: "Screen state" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Screen" }).textContent?.trim()).toBe("Choose location"),
    );
    expect(screen.getByRole("combobox", { name: "Screen state" }).textContent?.trim()).toBe("New computer");
  });

  it("makes the blocked-messaging and all-preparation-ready combinations explicit", async () => {
    renderLabPage();

    await chooseOption("Screen state", "Fix messaging support");
    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Journey" })).toBeNull();
    expect(readinessRow("messaging-support").getAttribute("data-status")).toBe("needs-attention");
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();

    await chooseOption("Screen state", "Ready to continue");
    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Screen state" }).textContent?.trim()).toBe("Connect messaging");
  });

  it("separates messaging support from the messaging connection lifecycle", async () => {
    renderLabPage();

    await chooseOption("Screen state", "Waiting for handoff");
    expect(await screen.findByText("Connected. Checking your agent can be reached…")).toBeTruthy();

    await chooseOption("Screen state", "Needs recovery");
    expect(await screen.findByText("Lark needs updated permissions.")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();

    await chooseOption("Screen state", "Everything ready");
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
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
    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Complete account admission" }));
    expect(await screen.findByRole("heading", { name: "Connect your computer" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Screen" }).textContent?.trim()).toBe("Connect computer");
    expect(screen.getByRole("combobox", { name: "Screen state" }).textContent?.trim()).toBe("Connect computer");

    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune state" }));
    expect(screen.queryByRole("combobox", { name: "Agent runtime" })).toBeNull();
    expect(screen.queryByText("1 changed")).toBeNull();

    await chooseOption("Screen", "Choose location");
    fireEvent.click(screen.getByRole("button", { name: "Additional Agent" }));
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });

  it("marks a forced Computer outage as custom until the recovery event restores it", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Everything ready");
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune state" }));

    fireEvent.click(screen.getByRole("button", { name: "Take computer offline" }));
    expect(screen.getByText("1 changed")).toBeTruthy();
    expect(await screen.findByText("Offline")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect computer" }));
    expect(screen.queryByText("1 changed")).toBeNull();
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
  });

  it("drops an ephemeral Computer override when another control rebuilds the scenario", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Everything ready");
    fireEvent.click(screen.getByRole("button", { name: "Fine-tune state" }));
    fireEvent.click(screen.getByRole("button", { name: "Take computer offline" }));

    await chooseOption("Agent runtime", "Claude Code");

    expect(screen.getByText("1 changed")).toBeTruthy();
    expect(screen.queryByText("Offline")).toBeNull();
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
  });

  it("drives Feishu and Slack without leaving the Lab", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Connect messaging");

    fireEvent.click(await screen.findByRole("button", { name: /Feishu|Lark/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Scan (Feishu|Lark) code/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Observe messaging handoff" }));
    expect(await screen.findByText("reviewer is ready.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open agent" }));
    expect(
      await screen.findByText("The real product would open Reviewer here. The Lab keeps this in-memory run isolated."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Return to Lab" }));

    await chooseOption("Screen state", "Connect messaging");
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

    await chooseOption("Screen state", "Everything ready");
    await chooseOption("Connected messaging app", "Slack");
    expect(await screen.findByText("Tag @reviewer in Slack to put it to work.")).toBeTruthy();
    expect(screen.getByText("1 changed")).toBeTruthy();
  });
});
