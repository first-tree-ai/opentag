/**
 * The Agent Setup lab page: the four production stage scenarios stay available, and the
 * readiness scenarios render one persistent presentational list whose fixture copy is explicit.
 */

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

/** Opens the labelled combobox and picks the option by its visible label. */
async function chooseOption(label: string, optionName: string): Promise<void> {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(trigger.textContent?.trim()).toContain(optionName));
  // Kumo keeps the closing popup mounted during its exit transition. Wait for it to leave the
  // accessible tree before another selector opens, or a slow runner can read both option sets.
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

beforeEach(() => mockBrowserApi());
afterEach(() => vi.restoreAllMocks());

describe("agent setup lab page", () => {
  it("keeps the four production stage scenarios selectable beside the readiness fixtures", async () => {
    renderLabPage();

    // The default scenario still mounts the production surface.
    expect(document.querySelector('[data-ui="agent-setup"]')).not.toBeNull();
    expect(document.querySelector('[data-ui="readiness-lab"]')).toBeNull();

    const trigger = screen.getByRole("combobox", { name: "Scenario" });
    fireEvent.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent?.trim() ?? "")).toEqual([
      "Needs computer",
      "Needs runtime",
      "Needs messaging",
      "Ready",
      ...READINESS_SCENARIOS.map((scenario) => READINESS_SCENARIO_LABELS[scenario]),
    ]);

    // A production stage choice keeps the production surface and never opens the readiness lab.
    fireEvent.pointerMove(screen.getByRole("option", { name: "Ready" }), { pointerType: "mouse" });
    fireEvent.pointerDown(screen.getByRole("option", { name: "Ready" }), { pointerType: "mouse" });
    fireEvent.pointerUp(screen.getByRole("option", { name: "Ready" }), { pointerType: "mouse" });
    fireEvent.click(screen.getByRole("option", { name: "Ready" }));
    await waitFor(() => expect(document.querySelector('[data-ui="agent-setup-ready"]')).not.toBeNull());
    expect(document.querySelector('[data-ui="readiness-lab"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
  });

  it("renders the ready checklist with four rows and the exact ready copy", async () => {
    renderLabPage();
    await chooseOption("Scenario", "Checklist: ready");

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
    await chooseOption("Scenario", "Checklist: ready");
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
    await chooseOption("Scenario", "Checklist: waiting");

    const firstRows = new Map(COMPONENTS.map((component) => [component, readinessRow(component)]));
    const firstList = readinessList();
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("waiting");
    expect(readinessRow("runtime").getAttribute("data-state")).toBe("blocked");

    for (const scenario of READINESS_SCENARIOS) {
      await chooseOption("Scenario", READINESS_SCENARIO_LABELS[scenario]);
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

    await chooseOption("Scenario", "Long English");
    const runtimeDetail = slot(readinessRow("runtime"), "readiness-detail").textContent ?? "";
    expect(runtimeDetail).toContain("Wait for a fresh reading");
    expect(runtimeDetail).toContain("OpenTag does not install Runtime CLIs");
    expect(runtimeDetail).toContain("example_runtime_diagnostic_");
    expect(runtimeDetail).toContain("\n");
    const feishuDetail = slot(readinessRow("im-cli:feishu"), "readiness-detail").textContent ?? "";
    expect(feishuDetail).toContain("opentag provider-cli inspect --provider feishu");

    await chooseOption("Scenario", "中文长文案");
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

    await chooseOption("Scenario", "Passed with warning");
    const warningRow = readinessRow("runtime");
    expect(warningRow.getAttribute("data-state")).toBe("passed");
    expect(warningRow.getAttribute("data-status")).toBe("ready");
    expect(slot(warningRow, "readiness-title").textContent).toBe("CodexCodex ready");
    expect(slot(warningRow, "readiness-detail").textContent).toContain("Non-blocking warning");
    expect(readinessRow("computer").getAttribute("data-state")).toBe("passed");
    expect(readinessRow("im-cli:slack").getAttribute("data-state")).toBe("passed");

    await chooseOption("Scenario", "Blank details");
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
    await chooseOption("Scenario", "Checklist: stale");
    for (const component of COMPONENTS) {
      expect(readinessRow(component).getAttribute("data-state")).toBe("blocked");
      expect(readinessRow(component).getAttribute("data-status")).toBe("stale");
    }
    for (const scenario of READINESS_SCENARIOS) {
      await chooseOption("Scenario", READINESS_SCENARIO_LABELS[scenario]);
      expect(readinessList().textContent).not.toMatch(
        /workspace authoriz|workspace token|credentials expire|opentag-runtime-(install|upgrade)|review\.invalid/i,
      );
    }
  });
});
