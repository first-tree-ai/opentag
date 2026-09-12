/**
 * The Lab's fine-tuning controls over the in-memory world: scenario labels that follow the
 * snapshot, injected observation failures, inventory overrides, automation, and Reset.
 */

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

async function openControls(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('[data-ui="onboarding-v2-lab"] button[aria-controls]');
  if (!trigger) throw new Error("Missing New Agent Lab trigger");
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}

function screenState(): string {
  return screen.getByRole("combobox", { name: "Screen state" }).textContent?.trim() ?? "";
}

function pageForState(
  optionName: string,
): "Choose location" | "Name & Runtime" | "Connect computer" | "Verify environment" | "Connect messaging" | "Ready" {
  if (["New computer", "Existing computer"].includes(optionName)) return "Choose location";
  if (optionName === "Agent creation") return "Name & Runtime";
  if (["Connect computer", "Reconnect computer", "Replace computer"].includes(optionName)) return "Connect computer";
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
  if (["Connect messaging", "Waiting for handoff", "Needs recovery"].includes(optionName)) return "Connect messaging";
  if (optionName === "Everything ready") return "Ready";
  throw new Error(`Unknown Screen state: ${optionName}`);
}

/** Opens the labelled Kumo select and picks the option by its visible label. */
async function chooseOption(label: string, optionName: string): Promise<void> {
  if (label === "Screen state") {
    await openControls();
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

async function openFineTuning(): Promise<void> {
  await openControls();
  const toggle = screen.getByRole("button", { name: /Fine-tune state/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  await screen.findByRole("combobox", { name: "Simulated status failure" });
}

beforeEach(() => mockBrowserApi());
afterEach(() => vi.restoreAllMocks());

describe("agent setup lab controls", () => {
  it("names the runtime state the preparation screen is actually showing", async () => {
    renderLabPage();

    await chooseOption("Screen state", "Runtime report missing");
    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screenState()).toBe("Runtime report missing");

    await chooseOption("Screen state", "Runtime checking");
    expect(screenState()).toBe("Runtime checking");

    await chooseOption("Screen state", "Sign in to Runtime");
    expect(screenState()).toBe("Sign in to Runtime");

    await chooseOption("Screen state", "Install Runtime");
    expect(screenState()).toBe("Install Runtime");
  });

  it("recognises a Computer that belongs to another Account as the replace checkpoint", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Replace computer");
    await openFineTuning();
    // With several owned Computers the choice stays open, so the rebind state is what is on screen.
    await chooseOption("Computers on the account", "Several");

    expect(
      await screen.findByText(
        "Previous Mac belongs to another Account. Choose a Computer owned by this Account for Reviewer.",
      ),
    ).toBeTruthy();
    expect(screenState()).toBe("Replace computer");
  });

  it("injects one observation failure at a time and clears it on Reset", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Install Runtime");
    await openFineTuning();

    await chooseOption("Simulated status failure", "Runtime status unavailable");
    expect(await screen.findByText("We couldn't read the latest state from the server. Check again.")).toBeTruthy();
    expect(screen.getByText("1 changed")).toBeTruthy();
    // The failing leg keeps the preparation screen, and the label keeps the configured scenario.
    expect(screenState()).toBe("Install Runtime");

    // Swapping the injected failure is still one override, not two.
    await chooseOption("Simulated status failure", "Messaging status unavailable");
    expect(screen.getByText("1 changed")).toBeTruthy();

    await chooseOption("Simulated status failure", "No injected failure");
    await waitFor(() =>
      expect(screen.queryByText("We couldn't read the latest state from the server. Check again.")).toBeNull(),
    );
    expect(screen.queryByText("1 changed")).toBeNull();

    await chooseOption("Simulated status failure", "Computer status unavailable");
    expect(await screen.findByText("We couldn't read the latest state from the server. Check again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(screen.queryByText("We couldn't read the latest state from the server. Check again.")).toBeNull(),
    );
    expect(screen.queryByText("1 changed")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screenState()).toBe("Install Runtime");
  });

  it("counts an inventory override only while it differs from the scenario default", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Connect computer");
    await openFineTuning();
    expect(screen.getByRole("combobox", { name: "Computers on the account" }).textContent?.trim()).toBe(
      "No computers yet",
    );

    await chooseOption("Computers on the account", "Several");
    expect(screen.getByText("1 changed")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Connect your computer" })).toBeTruthy();

    await chooseOption("Computers on the account", "No computers yet");
    expect(screen.queryByText("1 changed")).toBeNull();
  });

  it("runs the pending events on its own once automation is switched on", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Connect messaging");
    fireEvent.click(await screen.findByRole("button", { name: /Lark/ }));
    await openControls();
    expect(await screen.findByRole("button", { name: "Scan Lark code" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(screen.getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("true");

    // The scan lands after 1.5s and the handoff observation 1.2s later, with nothing else clicked.
    expect(await screen.findByText("reviewer is ready.", undefined, { timeout: 6_000 })).toBeTruthy();
  }, 15_000);

  it("simulates a refused authorization from the pending event controls", async () => {
    renderLabPage();
    await chooseOption("Screen state", "Connect messaging");
    fireEvent.click(await screen.findByRole("button", { name: /Lark/ }));
    await openControls();
    expect(await screen.findByRole("button", { name: "Scan Lark code" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Simulate authorization failure" }));

    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Lark authorization didn't complete. Disconnect Lark, then reconnect it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Simulate authorization failure" })).toBeNull();
    expect(screenState()).toBe("Needs recovery");
  });

  it("falls back to the new-computer journey when Back leaves a creation-only scenario", async () => {
    renderLabPage();
    await openControls();
    await chooseOption("Screen", "Name & Runtime");
    expect(await screen.findByRole("heading", { name: "Create your agent" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Screen" }).textContent?.trim()).toBe("Choose location"),
    );
    expect(screenState()).toBe("New computer");
  });

  it("skips account admission for an additional Agent created in the Lab", async () => {
    renderLabPage();
    await openControls();
    fireEvent.click(screen.getByRole("button", { name: "Additional Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    expect(await screen.findByRole("heading", { name: "Connect your computer" }, { timeout: 4_000 })).toBeTruthy();
    expect(screen.queryByText("Opening app access for this agent…")).toBeNull();
  });
});
