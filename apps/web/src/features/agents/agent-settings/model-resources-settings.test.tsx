import type { AgentAdminConfig } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../../api.js";
import type { AgentDetailView } from "../agent-model.js";
import { AgentModelSettings } from "./model-settings.js";
import { AgentResourcesSettings } from "./resources-settings.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const agent: AgentDetailView = {
  id: agentId,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", displayName: "Ada" },
  computer: {
    computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
    displayName: "Ada's Mac",
    platform: "darwin",
  },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  activity: { state: "idle" },
  availability: {
    state: "ready",
    reason: null,
    lastConfirmedAt: "2026-08-20T00:01:00.000Z",
    dependencies: {
      computer: { state: "ready", lastConfirmedAt: "2026-08-20T00:01:00.000Z" },
      runtime: { provider: "codex", status: "ready" },
      handoff: { state: "ready", lastConfirmedAt: "2026-08-20T00:01:00.000Z" },
      channel: { state: "connected", provider: "slack", botDisplayName: "Reviewer" },
    },
  },
  messaging: { kind: "ready", value: undefined },
};

const config: AgentAdminConfig = {
  id: agentId,
  createdByUserId: agent.createdBy.userId,
  computerId: agent.computer.computerId,
  name: agent.name,
  displayName: agent.displayName,
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  revision: 4,
  runtimeConfig: {
    revision: 7,
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    instructions: "Review carefully.",
    maxDurationMs: 45_500,
  },
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
};

async function optionLabels(dialog: HTMLElement, label: string): Promise<string[]> {
  const trigger = within(dialog).getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const options = await screen.findAllByRole("option");
  const labels = options.map((option) => option.textContent?.trim() ?? "");
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
  return labels;
}

async function chooseOption(dialog: HTMLElement, label: string, optionName: string): Promise<void> {
  const trigger = within(dialog).getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(trigger.textContent?.trim()).toContain(optionName));
}

afterEach(() => vi.restoreAllMocks());

describe("AgentModelSettings", () => {
  it("shows the fixed runtime and edits model and reasoning together", async () => {
    const onAgentChanged = vi.fn();
    const updated: AgentAdminConfig = {
      ...config,
      revision: 5,
      runtimeConfig: {
        ...config.runtimeConfig,
        revision: 8,
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    };
    const save = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    render(<AgentModelSettings agent={agent} config={config} onAgentChanged={onAgentChanged} />);

    expect(screen.getByRole("heading", { name: "Model" })).toBeTruthy();
    expect(screen.queryByText("Model & reasoning")).toBeNull();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Fixed after creation.")).toBeTruthy();
    expect(screen.getByText("gpt-5.6-terra")).toBeTruthy();
    expect(screen.getByText("High")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Change model" });
    expect(await optionLabels(dialog, "Model")).toEqual([
      "Provider default",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.3-codex",
      "Custom model ID…",
    ]);
    await chooseOption(dialog, "Model", "gpt-5.6-sol");
    await chooseOption(dialog, "Reasoning level", "xhigh");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(agentId, {
      expectedRevision: 4,
      runtimeConfig: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change model" })).toBeNull());
    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.getByText("XHigh")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Model settings saved.");
    expect(onAgentChanged).toHaveBeenCalledOnce();
  });

  it("preserves custom models and unknown saved reasoning values", async () => {
    const historicalConfig: AgentAdminConfig = {
      ...config,
      runtimeConfig: {
        ...config.runtimeConfig,
        model: "workspace/private-model",
        reasoningEffort: "historical-effort",
      },
    };
    const updated: AgentAdminConfig = {
      ...historicalConfig,
      revision: 5,
      runtimeConfig: {
        ...historicalConfig.runtimeConfig,
        revision: 8,
        model: "workspace/private-model-v2",
      },
    };
    const save = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    render(<AgentModelSettings agent={agent} config={historicalConfig} onAgentChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Change model" });
    expect((within(dialog).getByLabelText("Custom model ID") as HTMLInputElement).value).toBe(
      "workspace/private-model",
    );
    expect(await optionLabels(dialog, "Reasoning level")).toContain("historical-effort (saved value)");
    expect(within(dialog).getByRole("combobox", { name: "Reasoning level" }).textContent).toContain(
      "historical-effort",
    );
    fireEvent.change(within(dialog).getByLabelText("Custom model ID"), {
      target: { value: "  workspace/private-model-v2  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(agentId, {
      expectedRevision: 4,
      runtimeConfig: { model: "workspace/private-model-v2", reasoningEffort: "historical-effort" },
    });
  });

  it("keeps the dialog draft when saving fails", async () => {
    vi.spyOn(browserApi, "updateAgent").mockRejectedValue(new Error("Revision changed"));
    render(<AgentModelSettings agent={agent} config={config} onAgentChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Change model" });
    await chooseOption(dialog, "Reasoning level", "medium");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Revision changed");
    expect(within(dialog).getByRole("combobox", { name: "Reasoning level" }).textContent).toContain("medium");
  });

  it("uses a newer config revision supplied by the settings shell", async () => {
    const refreshedConfig: AgentAdminConfig = { ...config, revision: 9 };
    const updated: AgentAdminConfig = {
      ...refreshedConfig,
      revision: 10,
      runtimeConfig: { ...refreshedConfig.runtimeConfig, revision: 8, reasoningEffort: "medium" },
    };
    const save = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    const view = render(<AgentModelSettings agent={agent} config={config} onAgentChanged={vi.fn()} />);

    view.rerender(<AgentModelSettings agent={agent} config={refreshedConfig} onAgentChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Change model" });
    await chooseOption(dialog, "Reasoning level", "medium");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(agentId, {
      expectedRevision: 9,
      runtimeConfig: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    });
  });
});

describe("AgentResourcesSettings", () => {
  it("summarizes and saves instructions while keeping future resources honest", async () => {
    const onAgentChanged = vi.fn();
    const updatedInstructions = "Be concise and cite evidence.";
    const updated: AgentAdminConfig = {
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, instructions: updatedInstructions },
    };
    const save = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    render(<AgentResourcesSettings agent={agent} config={config} onAgentChanged={onAgentChanged} />);

    expect(screen.getByRole("heading", { name: "Resources" })).toBeTruthy();
    expect(screen.getByText("Custom · 17 characters")).toBeTruthy();
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);
    expect(
      screen.getByText("Coming soon. For now, chat with your agent to set up skills and integrations."),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit instructions" });
    const instructions = within(dialog).getByLabelText("Instructions") as HTMLTextAreaElement;
    expect(instructions.rows).toBe(8);
    expect(instructions.value).toBe("Review carefully.");
    fireEvent.change(instructions, { target: { value: updatedInstructions } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(agentId, {
      expectedRevision: 4,
      runtimeConfig: { instructions: updatedInstructions },
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit instructions" })).toBeNull());
    expect(screen.getByText("Custom · 29 characters")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Instructions saved.");
    expect(onAgentChanged).toHaveBeenCalledOnce();
  });

  it("describes empty instructions without exposing fake resource links", () => {
    const emptyConfig: AgentAdminConfig = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, instructions: "" },
    };
    render(<AgentResourcesSettings agent={agent} config={emptyConfig} onAgentChanged={vi.fn()} />);

    expect(screen.getByText("Not customized · 0 characters")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("uses the latest shell revision when saving instructions", async () => {
    const refreshedConfig: AgentAdminConfig = { ...config, revision: 9 };
    const updated: AgentAdminConfig = {
      ...refreshedConfig,
      revision: 10,
      runtimeConfig: { ...refreshedConfig.runtimeConfig, revision: 8, instructions: "Updated." },
    };
    const save = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    const view = render(<AgentResourcesSettings agent={agent} config={config} onAgentChanged={vi.fn()} />);

    view.rerender(<AgentResourcesSettings agent={agent} config={refreshedConfig} onAgentChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit instructions" });
    fireEvent.change(within(dialog).getByLabelText("Instructions"), { target: { value: "Updated." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(agentId, {
      expectedRevision: 9,
      runtimeConfig: { instructions: "Updated." },
    });
  });
});
