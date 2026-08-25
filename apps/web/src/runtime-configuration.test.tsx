import type { AgentAdminConfig } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuntimeConfigurationForm, runtimeConfigurationFromForm } from "./runtime-configuration.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const config: AgentAdminConfig = {
  id: agentId,
  teamId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
  managerUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
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

function optionValues(label: string): string[] {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  return Array.from(select.options, (option) => option.value);
}

describe("RuntimeConfigurationForm", () => {
  it("presents model suggestions and the complete Codex reasoning list", () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Execution" })).toBeTruthy();
    expect(screen.getByText("Provider: Codex")).toBeTruthy();
    expect(optionValues("Model")).toEqual([
      "",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.3-codex",
      "__custom_model__",
    ]);
    expect(optionValues("Reasoning level")).toEqual(["", "minimal", "low", "medium", "high", "xhigh"]);
    expect((screen.getByLabelText("Model") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "Provider default",
    );
    expect((screen.getByLabelText("Reasoning level") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "Provider default",
    );
    expect(screen.getByRole("heading", { name: "Agent instructions" })).toBeTruthy();
    expect(screen.queryByText(/timeout/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("keeps the complete reasoning list after a selection", () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "high" } });
    expect(optionValues("Reasoning level")).toEqual(["", "minimal", "low", "medium", "high", "xhigh"]);
    expect((screen.getByLabelText("Reasoning level") as HTMLSelectElement).value).toBe("high");
  });

  it("accepts and saves a non-empty custom model ID", async () => {
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, model: "team/fine-tuned-model" },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "__custom_model__" } });
    const customModel = screen.getByLabelText("Custom model ID") as HTMLInputElement;
    expect(customModel.required).toBe(true);
    fireEvent.change(customModel, { target: { value: "  team/fine-tuned-model  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "team/fine-tuned-model", reasoningEffort: null },
    });
    expect((await screen.findByRole("status")).textContent).toBe("Execution settings saved.");
    expect((screen.getByLabelText("Custom model ID") as HTMLInputElement).value).toBe("team/fine-tuned-model");
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

    expect((screen.getByLabelText("Model") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "Custom model ID…",
    );
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

  it("shows Claude Code model suggestions and the complete strict reasoning list", () => {
    const claudeConfig: AgentAdminConfig = {
      ...config,
      runtimeProvider: "claude-code",
      runtimeConfig: { ...config.runtimeConfig, model: "claude-sonnet-5", reasoningEffort: "max" },
    };
    render(<RuntimeConfigurationForm initialConfig={claudeConfig} save={vi.fn()} />);

    expect(screen.getByText("Provider: Claude Code")).toBeTruthy();
    expect(optionValues("Model")).toEqual([
      "",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "__custom_model__",
    ]);
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("claude-sonnet-5");
    expect(optionValues("Reasoning level")).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    expect((screen.getByLabelText("Reasoning level") as HTMLSelectElement).value).toBe("max");
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

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "" } });
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

    expect(optionValues("Reasoning level")).toEqual([
      "",
      "historical-effort",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect((screen.getByLabelText("Reasoning level") as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "historical-effort (saved value)",
    );

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
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

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Revision changed");
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "gpt-5.6-sol", reasoningEffort: "historical-effort" },
    });
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.6-sol");
    expect((screen.getByLabelText("Reasoning level") as HTMLSelectElement).value).toBe("historical-effort");
    expect(optionValues("Reasoning level")).toContain("historical-effort");
  });

  it("discards model and reasoning drafts without saving", () => {
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
    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "high" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect((screen.getByLabelText("Custom model ID") as HTMLInputElement).value).toBe("gpt-historical-private");
    expect((screen.getByLabelText("Reasoning level") as HTMLSelectElement).value).toBe("historical-effort");
    expect(optionValues("Reasoning level")).toEqual([
      "",
      "historical-effort",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
