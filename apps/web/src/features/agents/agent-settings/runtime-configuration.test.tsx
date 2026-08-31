import type { AgentAdminConfig } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import { RuntimeConfigurationForm, runtimeConfigurationFromForm } from "./runtime-configuration.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const config: AgentAdminConfig = {
  id: agentId,
  createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  revision: 4,
  runtimeConfig: {
    revision: 7,
    model: null,
    reasoningEffort: null,
    instructions: "Review carefully.",
    maxDurationMs: 45_500,
  },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

async function optionLabels(label: string): Promise<string[]> {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const options = await screen.findAllByRole("option");
  const values = options.map((option) => option.textContent?.trim() ?? "");
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
  return values;
}

async function chooseOption(label: string, value: string): Promise<void> {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const optionName = value === "" ? "Provider default" : value === "__custom_model__" ? "Custom model ID…" : value;
  const option = await screen.findByRole("option", { name: optionName });
  if (!option) throw new Error(`Missing ${label} option ${value}`);
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(trigger.textContent?.trim()).toContain(optionName));
}

describe("RuntimeConfigurationForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("presents model suggestions and the complete Codex reasoning list", async () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Execution" })).toBeTruthy();
    expect(screen.getByText("Provider: Codex")).toBeTruthy();
    expect(await optionLabels("Model")).toEqual([
      "Provider default",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.3-codex",
      "Custom model ID…",
    ]);
    expect(await optionLabels("Reasoning level")).toEqual([
      "Provider default",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain("Provider default");
    expect(screen.getByRole("combobox", { name: "Reasoning level" }).textContent?.trim()).toContain("Provider default");
    expect(screen.getByRole("heading", { name: "Agent instructions" })).toBeTruthy();
    expect(screen.queryByText("Choose a common model or enter a custom model ID.")).toBeNull();
    expect(screen.queryByText("Provider default lets the runtime choose.")).toBeNull();
    expect(
      screen.queryByText(
        "Be concise and specific. These instructions apply in addition to OpenTag's platform guidance.",
      ),
    ).toBeNull();
    expect(screen.queryByText(/timeout/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("keeps the complete reasoning list after a selection", async () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    await chooseOption("Reasoning level", "high");
    expect(await optionLabels("Reasoning level")).toEqual([
      "Provider default",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(screen.getByRole("combobox", { name: "Reasoning level" }).textContent?.trim()).toContain("high");
  });

  it("accepts and saves a non-empty custom model ID", async () => {
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, model: "workspace/fine-tuned-model" },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    await chooseOption("Model", "__custom_model__");
    const customModel = screen.getByLabelText("Custom model ID") as HTMLInputElement;
    expect(customModel.required).toBe(true);
    fireEvent.change(customModel, { target: { value: "  workspace/fine-tuned-model  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "workspace/fine-tuned-model", reasoningEffort: null },
    });
    expect((await screen.findByRole("status")).textContent).toBe("Execution settings saved.");
    expect((screen.getByLabelText("Custom model ID") as HTMLInputElement).value).toBe("workspace/fine-tuned-model");
  });

  it("shows, edits, and saves an unknown historical model as custom", async () => {
    const historicalConfig: AgentAdminConfig = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, model: "gpt-historical-private" },
    };
    const save = vi.fn(async () => ({
      ...historicalConfig,
      revision: 5,
      runtimeConfig: { ...historicalConfig.runtimeConfig, revision: 8, model: "gpt-historical-updated" },
    }));
    render(<RuntimeConfigurationForm initialConfig={historicalConfig} save={save} section="execution" />);

    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain("Custom model ID");
    expect((screen.getByLabelText("Custom model ID") as HTMLInputElement).value).toBe("gpt-historical-private");
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "gpt-historical-updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "gpt-historical-updated", reasoningEffort: null },
    });
  });

  it("shows Claude Code model suggestions and the complete strict reasoning list", async () => {
    const claudeConfig: AgentAdminConfig = {
      ...config,
      runtimeProvider: "claude-code",
      runtimeConfig: { ...config.runtimeConfig, model: "claude-sonnet-5", reasoningEffort: "max" },
    };
    render(<RuntimeConfigurationForm initialConfig={claudeConfig} save={vi.fn()} />);

    expect(screen.getByText("Provider: Claude Code")).toBeTruthy();
    expect(await optionLabels("Model")).toEqual([
      "Provider default",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "Custom model ID…",
    ]);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain("claude-sonnet-5");
    expect(await optionLabels("Reasoning level")).toEqual([
      "Provider default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(screen.getByRole("combobox", { name: "Reasoning level" }).textContent?.trim()).toContain("max");
  });

  it("maps Provider default to null while preserving expectedRevision", async () => {
    const configured: AgentAdminConfig = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, model: "gpt-5.6-sol", reasoningEffort: "high" },
    };
    const save = vi.fn(async () => ({
      ...configured,
      revision: 5,
      runtimeConfig: { ...configured.runtimeConfig, revision: 8, model: null, reasoningEffort: null },
    }));
    render(<RuntimeConfigurationForm initialConfig={configured} save={save} section="execution" />);

    await chooseOption("Model", "");
    await chooseOption("Reasoning level", "");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: null, reasoningEffort: null },
    });
  });

  it("preserves an unknown historical reasoning value during a model-only save", async () => {
    const historicalConfig: AgentAdminConfig = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, reasoningEffort: "historical-effort" },
    };
    const save = vi.fn(async () => ({
      ...historicalConfig,
      revision: 5,
      runtimeConfig: { ...historicalConfig.runtimeConfig, revision: 8, model: "gpt-5.6-sol" },
    }));
    render(<RuntimeConfigurationForm initialConfig={historicalConfig} save={save} section="execution" />);

    expect(await optionLabels("Reasoning level")).toEqual([
      "Provider default",
      "historical-effort (saved value)",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(screen.getByRole("combobox", { name: "Reasoning level" }).textContent?.trim()).toContain(
      "historical-effort",
    );

    await chooseOption("Model", "gpt-5.6-sol");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "gpt-5.6-sol", reasoningEffort: "historical-effort" },
    });
  });

  it("saves Agent instructions independently", async () => {
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, instructions: "Updated instructions." },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Updated instructions." } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { instructions: "Updated instructions." },
    });
  });

  it("normalizes blank form values to provider defaults", () => {
    const data = new FormData();
    data.set("model", " ");
    data.set("reasoningEffort", "");

    expect(runtimeConfigurationFromForm(data)).toEqual({ model: null, reasoningEffort: null });
  });

  it("reports save failures without losing drafts", async () => {
    const historicalConfig: AgentAdminConfig = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, reasoningEffort: "historical-effort" },
    };
    const save = vi.fn(async () => {
      throw new Error("Revision changed");
    });
    render(<RuntimeConfigurationForm initialConfig={historicalConfig} save={save} />);

    await chooseOption("Model", "gpt-5.6-sol");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Revision changed");
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "gpt-5.6-sol", reasoningEffort: "historical-effort" },
    });
    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain("gpt-5.6-sol");
    expect(screen.getByRole("combobox", { name: "Reasoning level" }).textContent?.trim()).toContain(
      "historical-effort",
    );
    expect(await optionLabels("Reasoning level")).toContain("historical-effort (saved value)");
  });

  it("discards model and reasoning drafts without saving", async () => {
    const initialConfig: AgentAdminConfig = {
      ...config,
      runtimeConfig: {
        ...config.runtimeConfig,
        model: "gpt-historical-private",
        reasoningEffort: "historical-effort",
      },
    };
    const save = vi.fn();
    render(<RuntimeConfigurationForm initialConfig={initialConfig} save={save} section="execution" />);

    fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "gpt-historical-updated" } });
    await chooseOption("Reasoning level", "high");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect((screen.getByLabelText("Custom model ID") as HTMLInputElement).value).toBe("gpt-historical-private");
    expect(screen.getByRole("combobox", { name: "Reasoning level" }).textContent?.trim()).toContain(
      "historical-effort",
    );
    expect(await optionLabels("Reasoning level")).toEqual([
      "Provider default",
      "historical-effort (saved value)",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("exposes Test runtime on the saved execution surface and not on instructions", () => {
    const execution = render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} section="execution" />);
    expect(screen.getByRole("button", { name: "Test runtime" })).toBeTruthy();
    expect(screen.getByText(/real Provider request/)).toBeTruthy();
    execution.unmount();

    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} section="instructions" />);
    expect(screen.queryByRole("button", { name: "Test runtime" })).toBeNull();
    expect(screen.queryByText(/real Provider request/)).toBeNull();
  });

  it("clears a runtime test result after a successful saved configuration change", async () => {
    vi.spyOn(browserApi, "testAgentRuntime").mockResolvedValue({ status: "passed" });
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, model: "gpt-5.6-sol" },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} section="execution" />);

    fireEvent.click(screen.getByRole("button", { name: "Test runtime" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/^Passed\./);

    await chooseOption("Model", "gpt-5.6-sol");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect((await screen.findByRole("status")).textContent).toBe("Execution settings saved.");
    expect(screen.queryByText(/exact invocation/)).toBeNull();
  });
});
