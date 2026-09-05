/** The complete New Agent lab plus the focused readiness-review fixtures. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { AgentSetupLabPage } from "./agent-setup-lab-page.js";
import { deferred } from "./agent-setup-test-fixtures.js";
import {
  LONG_RUNTIME_LABEL_EN,
  LONG_RUNTIME_LABEL_ZH,
  READINESS_SCENARIO_LABELS,
  READINESS_SCENARIOS,
} from "./readiness-lab-fixtures.js";

const COMPONENTS = ["computer", "runtime", "im-cli:feishu", "im-cli:slack"] as const;

/** The production surface talks to browserApi; these endpoints are scripted like the page tests. */
function mockBrowserApi(): void {
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
  vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(() => deferred<never>().promise);
}

/** The production surface reads computers through react-query, exactly like the page tests. */
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

function readinessList(): HTMLElement {
  const element = document.querySelector('[data-ui="readiness-list"]');
  if (!element) throw new Error("Missing readiness list");
  return element as HTMLElement;
}

function slot(rowElement: HTMLElement, ui: string): HTMLElement {
  const element = rowElement.querySelector(`[data-ui="${ui}"]`);
  if (!element) throw new Error(`Missing ${ui} slot`);
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
  if (label === "Screen state" || label === "Visual edge cases") await openControls();
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
  if (label === "Visual edge cases") {
    const section = screen.getByRole("button", { name: label });
    if (section.getAttribute("aria-expanded") !== "true") fireEvent.click(section);
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
  // Kumo keeps the closing popup mounted during its exit transition. Wait for it to leave the
  // accessible tree before another selector opens, or a slow runner can read both option sets.
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

beforeEach(() => mockBrowserApi());
afterEach(() => vi.restoreAllMocks());

describe("agent setup lab page", () => {
  it("keeps the complete journey controls in the lower-right beside the readiness fixtures", async () => {
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
    expect(page?.className).not.toContain("lg:pr-[27rem]");
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
    expect(document.querySelector('[data-ui="readiness-lab"]')).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

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
    expect(readinessRow("im-cli:feishu").getAttribute("data-status")).toBe("needs-attention");
    expect(slot(readinessRow("im-cli:feishu"), "readiness-title").textContent).toContain("Lark CLI");
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();

    await chooseOption("Screen state", "Connect messaging");
    expect(await screen.findByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    expect(
      screen.getByText("Computer, Runtime, and messaging support are ready. Choose a messaging app."),
    ).toBeTruthy();
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

  it("renders the ready checklist with four rows and the exact ready copy", async () => {
    renderLabPage();
    await chooseOption("Visual edge cases", "Checklist: ready");

    expect(document.querySelector('[data-ui="agent-setup"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "Readiness checklist" })).toBeTruthy();
    const list = readinessList();
    expect(list.tagName).toBe("OL");
    expect(list.getAttribute("aria-label")).toBe("Readiness results");

    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(4);
    expect([...items].map((item) => item.getAttribute("data-component"))).toEqual([...COMPONENTS]);
    items.forEach((item, index) => {
      expect(item.getAttribute("data-state")).toBe("passed");
      expect(item.getAttribute("data-status")).toBe("ready");
      expect(item.querySelector(".otv2-readiness__marker")?.textContent).toBe(String(index + 1));
    });

    // The runtime row carries the default Codex label; every row shows the exact caller copy.
    const computer = readinessRow("computer");
    expect(slot(computer, "readiness-title").textContent).toBe("ComputerComputer ready");
    expect(slot(computer, "readiness-detail").textContent).toBe("Connected to Review Mac.");
    const runtime = readinessRow("runtime");
    expect(slot(runtime, "readiness-title").textContent).toBe("CodexCodex ready");
    expect(slot(runtime, "readiness-detail").textContent).toContain("operator-supplied CLI");
    const feishu = readinessRow("im-cli:feishu");
    expect(slot(feishu, "readiness-title").textContent).toBe("Lark CLILark CLI ready");
    expect(slot(feishu, "readiness-detail").textContent).toBe("Compatible Lark CLI artifact verified locally.");
    const slack = readinessRow("im-cli:slack");
    expect(slot(slack, "readiness-title").textContent).toBe("Slack CLISlack CLI ready");
    expect(slot(slack, "readiness-detail").textContent).toBe("Compatible Slack CLI artifact verified locally.");
  });

  it("relabels the runtime row when Preview Runtime moves to Claude Code", async () => {
    renderLabPage();
    await chooseOption("Visual edge cases", "Checklist: ready");
    const runtimeRow = readinessRow("runtime");
    const computerRow = readinessRow("computer");

    const runtimeTrigger = screen.getByRole("combobox", { name: "Preview Runtime" });
    expect(runtimeTrigger.textContent?.trim()).toBe("Codex");
    fireEvent.click(runtimeTrigger);
    const optionNames = await screen.findAllByRole("option");
    expect(optionNames.map((option) => option.textContent?.trim() ?? "")).toEqual([
      "Codex",
      "Claude Code",
      LONG_RUNTIME_LABEL_EN,
    ]);
    // Close the popover again before opening it fresh, or the selection lands on a closing option.
    fireEvent.click(runtimeTrigger);
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));

    await chooseOption("Preview Runtime", "Claude Code");
    expect(readinessRow("runtime")).toBe(runtimeRow);
    expect(readinessRow("computer")).toBe(computerRow);
    expect(slot(readinessRow("runtime"), "readiness-title").textContent).toBe("Claude CodeClaude Code ready");
    expect(slot(readinessRow("runtime"), "readiness-detail").textContent).toContain("operator-supplied CLI");
    expect(slot(readinessRow("computer"), "readiness-title").textContent).toBe("ComputerComputer ready");
  });

  it("keeps one persistent list with the same row elements across every fixture scenario", async () => {
    renderLabPage();
    await chooseOption("Visual edge cases", "Checklist: waiting");

    const firstRows = new Map(COMPONENTS.map((component) => [component, readinessRow(component)]));
    const firstList = readinessList();
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("waiting");
    expect(readinessRow("runtime").getAttribute("data-state")).toBe("blocked");

    for (const scenario of READINESS_SCENARIOS) {
      await chooseOption("Visual edge cases", READINESS_SCENARIO_LABELS[scenario]);
      expect(readinessList()).toBe(firstList);
      expect(screen.getByRole("heading", { name: "Readiness checklist" })).toBeTruthy();
      for (const component of COMPONENTS) {
        expect(readinessRow(component)).toBe(firstRows.get(component));
      }
      const items = readinessList().querySelectorAll("li");
      items.forEach((item, index) => {
        expect(item.querySelector(".otv2-readiness__marker")?.textContent).toBe(String(index + 1));
      });
    }

    // The last scenario really replaced the rows' content, not just the attributes.
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("ready");
    expect(readinessRow("runtime").getAttribute("data-state")).toBe("passed");
    expect(slot(readinessRow("runtime"), "readiness-title").textContent).toBe("CodexCodex ready");
  });

  it("exposes the long English and Chinese fixture copy", async () => {
    renderLabPage();

    await chooseOption("Visual edge cases", "Long English");
    const runtimeDetail = slot(readinessRow("runtime"), "readiness-detail").textContent ?? "";
    expect(runtimeDetail).toContain("Wait for a fresh reading");
    expect(runtimeDetail).toContain("OpenTag does not install Runtime CLIs");
    expect(runtimeDetail).toContain("example_runtime_diagnostic_");
    expect(runtimeDetail).toContain("\n");
    const feishuDetail = slot(readinessRow("im-cli:feishu"), "readiness-detail").textContent ?? "";
    expect(feishuDetail).toContain("opentag provider-cli inspect --provider feishu");

    await chooseOption("Visual edge cases", "Long Chinese copy");
    const runtimeRow = readinessRow("runtime");
    expect(slot(readinessRow("computer"), "readiness-title").textContent).toBe("电脑就绪");
    // The sample sentences are Chinese; brand names still follow the app locale via the naming helper.
    expect(slot(readinessRow("im-cli:feishu"), "readiness-title").textContent).toBe("Lark CLI需要安装");
    expect(slot(runtimeRow, "readiness-title").textContent).toBe("Codex需要关注");
    const zhRuntimeDetail = slot(runtimeRow, "readiness-detail").textContent ?? "";
    expect(zhRuntimeDetail).toContain("因此本项尚未就绪");
    expect(zhRuntimeDetail).toContain("OpenTag 不会自动安装 Runtime CLI");
    const zhFeishuDetail = slot(readinessRow("im-cli:feishu"), "readiness-detail").textContent ?? "";
    expect(zhFeishuDetail).toContain("opentag provider-cli inspect --provider feishu");
    expect(zhFeishuDetail).toContain("这不等于正在安装");

    // The deliberately long caller-supplied runtime label follows the fixture locale.
    await chooseOption("Preview Runtime", LONG_RUNTIME_LABEL_ZH);
    expect(readinessRow("runtime")).toBe(runtimeRow);
    expect(slot(readinessRow("runtime"), "readiness-title").textContent).toBe(`${LONG_RUNTIME_LABEL_ZH}需要关注`);
    expect(screen.getByRole("combobox", { name: "Preview Runtime" }).textContent?.trim()).toBe(LONG_RUNTIME_LABEL_ZH);
  });

  it("exposes the passed warning and the genuinely blank details", async () => {
    renderLabPage();

    await chooseOption("Visual edge cases", "Passed with warning");
    const warningRow = readinessRow("runtime");
    expect(warningRow.getAttribute("data-state")).toBe("passed");
    expect(warningRow.getAttribute("data-status")).toBe("ready");
    expect(slot(warningRow, "readiness-title").textContent).toBe("CodexCodex ready");
    expect(slot(warningRow, "readiness-detail").textContent).toContain("Non-blocking warning");
    expect(readinessRow("computer").getAttribute("data-state")).toBe("passed");
    expect(readinessRow("im-cli:slack").getAttribute("data-state")).toBe("passed");

    await chooseOption("Visual edge cases", "Blank details");
    for (const component of COMPONENTS) {
      const detail = slot(readinessRow(component), "readiness-detail");
      expect(detail.textContent).toBe("");
      expect(detail.getAttribute("aria-label")).not.toBe("");
      expect(detail.getAttribute("aria-label")).not.toBeNull();
      expect(readinessRow(component).querySelector('[data-ui="readiness-title"]')?.textContent).not.toBe("");
    }
    expect(readinessList().querySelectorAll('[data-ui="readiness-detail"]')).toHaveLength(4);
  });

  it("keeps stale reports blocked and messaging authorization out of preparation fixtures", async () => {
    renderLabPage();
    await chooseOption("Visual edge cases", "Checklist: stale");
    for (const component of COMPONENTS) {
      expect(readinessRow(component).getAttribute("data-state")).toBe("blocked");
      expect(readinessRow(component).getAttribute("data-status")).toBe("stale");
    }
    for (const scenario of READINESS_SCENARIOS) {
      await chooseOption("Visual edge cases", READINESS_SCENARIO_LABELS[scenario]);
      expect(readinessList().textContent).not.toMatch(
        /workspace authoriz|workspace token|credentials expire|opentag-runtime-(install|upgrade)|review\.invalid/i,
      );
    }
  });
});
