import type { AgentAdminConfig, AgentRuntimeOptions } from "@opentag/shared/browser";
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, render as testingRender, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { createQueryClient } from "../../../query/client.js";
import { queryKeys } from "../../../query/keys.js";
import { LIVE_REFETCH_INTERVAL_MS } from "../../../query/live.js";
import { RuntimeConfigurationForm, runtimeConfigurationFromForm } from "./runtime-configuration.js";

const queryClients: QueryClient[] = [];
function render(element: ReactElement) {
  const client = createQueryClient();
  queryClients.push(client);
  return testingRender(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
beforeEach(() => {
  vi.spyOn(browserApi, "agentRuntimeOptions").mockRejectedValue(new ApiError(501, "Older client"));
});
afterEach(() => {
  for (const client of queryClients.splice(0)) client.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

async function returnToPage() {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const config: AgentAdminConfig = {
  id: agentId,
  createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  selfConfigurationEnabled: false,
  status: "active",
  revision: 4,
  runtimeConfig: {
    permissions: { approvalPolicy: "on-request", allowCommands: [] },
    contextTrees: [],
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
  const optionName =
    value === "" ? "Inherit local configuration" : value === "__custom_model__" ? "Custom model ID…" : value;
  const option = await screen.findByRole("option", { name: optionName });
  if (!option) throw new Error(`Missing ${label} option ${value}`);
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(trigger.textContent?.trim()).toContain(optionName));
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

describe("RuntimeConfigurationForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits approval controls and permission updates for local Pi", async () => {
    const piConfig = { ...config, runtimeProvider: "pi" as const };
    const save = vi.fn(async () => piConfig);
    render(<RuntimeConfigurationForm initialConfig={piConfig} save={save} section="execution" />);
    expect(screen.queryByRole("switch", { name: "Ask for approval" })).toBeNull();
    expect(screen.queryByText("Additional allowed commands")).toBeNull();
    await chooseOption("Model", "__custom_model__");
    fireEvent.change(screen.getByRole("textbox", { name: "Custom model ID" }), { target: { value: "pi-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "pi-model", reasoningEffort: null },
    });
  });

  it("saves permissions independently of an unsupported saved reasoning value", async () => {
    vi.mocked(browserApi.agentRuntimeOptions).mockResolvedValue({
      modelSuggestions: [],
      reasoningEffortAllowedValues: ["high"],
    });
    const configured = { ...config, runtimeConfig: { ...config.runtimeConfig, reasoningEffort: "historical-effort" } };
    const save = vi.fn(async () => configured);
    render(<RuntimeConfigurationForm initialConfig={configured} save={save} section="execution" />);
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "historical-effort (saved value)",
      "High",
    ]);
    fireEvent.click(screen.getByRole("switch", { name: "Ask for approval" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: {
        model: null,
        reasoningEffort: "historical-effort",
        permissions: { approvalPolicy: "never", allowCommands: [] },
      },
    });
  });

  it("turns off approvals while preserving allowed commands", async () => {
    const permissions = {
      approvalPolicy: "on-request" as const,
      allowCommands: ["docker ps"],
    };
    const configured = { ...config, runtimeConfig: { ...config.runtimeConfig, permissions } };
    const save = vi.fn(async () => ({
      ...configured,
      revision: 5,
      runtimeConfig: { ...configured.runtimeConfig, permissions: { ...permissions, approvalPolicy: "never" as const } },
    }));
    render(<RuntimeConfigurationForm initialConfig={configured} save={save} section="execution" />);

    expect(
      (screen.getByRole("switch", { name: "Ask for approval" }) as HTMLButtonElement).dataset.checked,
    ).toBeDefined();
    fireEvent.click(screen.getByRole("switch", { name: "Ask for approval" }));
    expect(screen.queryByText("Additional allowed commands")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: {
        model: null,
        reasoningEffort: null,
        permissions: { ...permissions, approvalPolicy: "never" },
      },
    });
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("adds and removes only additional commands, then saves the allowlist", async () => {
    const permissions = { approvalPolicy: "on-request" as const, allowCommands: [] };
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: {
        ...config.runtimeConfig,
        permissions: { ...permissions, allowCommands: ["docker ps"] },
      },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} section="execution" />);

    expect(screen.queryByRole("list", { name: "Additional allowed commands" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add git status" }));
    expect(screen.getByRole("button", { name: "Remove git status" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove git status" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Command to allow" }), {
      target: { value: "docker ps" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: {
        model: null,
        reasoningEffort: null,
        permissions: { ...permissions, allowCommands: ["docker ps"] },
      },
    });
  });

  it("rejects shell syntax and duplicate commands in the simple editor", () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} section="execution" />);
    const input = screen.getByRole("textbox", { name: "Command to allow" });
    fireEvent.change(input, { target: { value: "git status && rm -rf /" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(screen.getByRole("alert").textContent).toContain("without shell operators or wildcards");
    fireEvent.click(screen.getByRole("button", { name: "Add git status" }));
    fireEvent.change(input, { target: { value: "git status" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(screen.getByRole("alert").textContent).toBe("This command is already added.");
  });

  it.each([
    {
      provider: "codex" as const,
      model: "gpt-6.1-sol",
      discovered: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      expected: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"],
    },
    {
      provider: "claude-code" as const,
      model: "claude-fable-5-1",
      discovered: ["sonnet"],
      expected: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    },
    {
      provider: "pi" as const,
      model: "openai/gpt-6.1-sol",
      discovered: ["google/gemini-3.8-flash"],
      expected: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"],
    },
  ])("replaces $provider presets with the native catalog and preserves an unlisted saved model", async (entry) => {
    let resolveInitial!: (options: AgentRuntimeOptions) => void;
    vi.mocked(browserApi.agentRuntimeOptions)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValue({
        modelSuggestions: [...entry.discovered.slice(0, 1), "live/added"],
        reasoningEffortAllowedValues: ["high"],
      });
    const configured = {
      ...config,
      runtimeProvider: entry.provider,
      runtimeConfig: { ...config.runtimeConfig, model: entry.model },
    };
    const save = vi.fn();
    render(<RuntimeConfigurationForm initialConfig={configured} save={save} />);
    await waitFor(() => expect(resolveInitial).toBeTypeOf("function"));
    expect(await optionLabels("Model")).toEqual(expect.arrayContaining(entry.expected));

    resolveInitial({ modelSuggestions: entry.discovered, reasoningEffortAllowedValues: ["high"] });
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    const initial = await optionLabels("Model");
    expect(initial).toEqual(["Inherit local configuration", ...entry.discovered, "Custom model ID…"]);
    expect(screen.getByRole("textbox", { name: "Custom model ID" })).toHaveProperty("value", entry.model);
    expect(await optionLabels("Reasoning effort")).toEqual(["Inherit local configuration", "High"]);

    expect(screen.queryByRole("button", { name: "Refresh models and effort" })).toBeNull();
    await returnToPage();
    await waitFor(() => expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    const refreshed = await optionLabels("Model");
    expect(refreshed).toEqual(["Inherit local configuration", entry.discovered[0], "live/added", "Custom model ID…"]);
    expect(screen.getByRole("textbox", { name: "Custom model ID" })).toHaveProperty("value", entry.model);
    expect(save).not.toHaveBeenCalled();
  });

  it.each(
    (["codex", "claude-code", "pi"] as const).flatMap((provider) =>
      [null, "private/saved"].map((model) => ({ provider, model })),
    ),
  )("keeps an empty $provider native catalog empty with saved model $model", async ({ provider, model }) => {
    vi.mocked(browserApi.agentRuntimeOptions).mockResolvedValue({
      modelSuggestions: [],
      reasoningEffortAllowedValues: [],
    });
    const save = vi.fn();
    render(
      <RuntimeConfigurationForm
        initialConfig={{ ...config, runtimeProvider: provider, runtimeConfig: { ...config.runtimeConfig, model } }}
        save={save}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    expect(await optionLabels("Model")).toEqual(["Inherit local configuration", "Custom model ID…"]);
    expect(await optionLabels("Reasoning effort")).toEqual(["Inherit local configuration"]);
    if (model) expect(screen.getByRole("textbox", { name: "Custom model ID" })).toHaveProperty("value", model);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "codex" as const, preset: "gpt-6.1-sol" },
    { provider: "claude-code" as const, preset: "claude-fable-5-1" },
    { provider: "pi" as const, preset: "openai/gpt-6.1-sol" },
  ])("uses $provider presets only until the unavailable native directory recovers", async ({ provider, preset }) => {
    vi.mocked(browserApi.agentRuntimeOptions)
      .mockRejectedValueOnce(new ApiError(503, "Provider unavailable"))
      .mockResolvedValue({ modelSuggestions: ["native/only"], reasoningEffortAllowedValues: null });
    const save = vi.fn();
    render(<RuntimeConfigurationForm initialConfig={{ ...config, runtimeProvider: provider }} save={save} />);
    await screen.findByText(
      "Local model options are unavailable. Showing suggestions; custom model IDs remain available.",
    );
    expect(await optionLabels("Model")).toContain(preset);
    await returnToPage();
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Local model options are unavailable. Showing suggestions; custom model IDs remain available.",
        ),
      ).toBeNull(),
    );
    expect(await optionLabels("Model")).toEqual(["Inherit local configuration", "native/only", "Custom model ID…"]);
    expect(screen.getByText("The reasoning effort options for this model have not been confirmed.")).toBeTruthy();
    expect((await optionLabels("Reasoning effort")).length).toBeGreaterThan(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("updates only while the model page is visible and online, and refreshes on return or reconnect", async () => {
    vi.mocked(browserApi.agentRuntimeOptions).mockResolvedValue({
      modelSuggestions: ["live/model"],
      reasoningEffortAllowedValues: ["high"],
    });
    vi.useFakeTimers();
    const client = createQueryClient();
    queryClients.push(client);
    const save = vi.fn();
    const view = testingRender(
      <QueryClientProvider client={client}>
        <RuntimeConfigurationForm initialConfig={config} save={save} />
      </QueryClientProvider>,
    );
    try {
      await advance(0);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(1);
      await advance(LIVE_REFETCH_INTERVAL_MS - 1);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(2);

      focusManager.setFocused(false);
      await advance(LIVE_REFETCH_INTERVAL_MS * 3);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(2);
      focusManager.setFocused(true);
      await advance(0);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(3);

      onlineManager.setOnline(false);
      await advance(LIVE_REFETCH_INTERVAL_MS);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(3);
      onlineManager.setOnline(true);
      await advance(0);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(4);

      view.rerender(
        <QueryClientProvider client={client}>
          <RuntimeConfigurationForm computerOnline={false} initialConfig={config} save={save} />
        </QueryClientProvider>,
      );
      await advance(LIVE_REFETCH_INTERVAL_MS * 2);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(4);
      view.rerender(
        <QueryClientProvider client={client}>
          <RuntimeConfigurationForm initialConfig={config} save={save} />
        </QueryClientProvider>,
      );
      await advance(0);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(5);
      view.unmount();
      await advance(LIVE_REFETCH_INTERVAL_MS * 2);
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(5);
      expect(save).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it("quietly refreshes confirmed options without changing unsaved model or effort selections", async () => {
    let resolveRefresh!: (options: AgentRuntimeOptions) => void;
    const options = { modelSuggestions: ["gpt-6-sol"], reasoningEffortAllowedValues: ["high", "max"] };
    vi.mocked(browserApi.agentRuntimeOptions)
      .mockResolvedValueOnce(options)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const configured = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, model: "gpt-6-sol", reasoningEffort: "high" },
    };
    const save = vi.fn();
    render(<RuntimeConfigurationForm initialConfig={configured} save={save} />);
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    await chooseOption("Reasoning effort", "Max");
    await returnToPage();
    expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Reading local models…")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("gpt-6-sol");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("Max");
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(false);
    resolveRefresh({ ...options, modelSuggestions: [...options.modelSuggestions, "live/new"] });
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    expect(await optionLabels("Model")).toContain("live/new");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("Max");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps separate Computer caches when the same Agent moves between Computers", async () => {
    const first = { modelSuggestions: ["computer-a/model"], reasoningEffortAllowedValues: ["high"] };
    const second = { modelSuggestions: ["computer-b/model"], reasoningEffortAllowedValues: ["max"] };
    vi.mocked(browserApi.agentRuntimeOptions).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClients.push(client);
    const view = testingRender(
      <QueryClientProvider client={client}>
        <RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    expect(await optionLabels("Model")).toContain("computer-a/model");
    const moved = { ...config, computerId: "b35db6ac-90fe-4a92-831d-0b698127d948" };
    view.rerender(
      <QueryClientProvider client={client}>
        <RuntimeConfigurationForm initialConfig={moved} save={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(browserApi.agentRuntimeOptions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    const labels = await optionLabels("Model");
    expect(labels).toContain("computer-b/model");
    expect(labels).not.toContain("computer-a/model");
    expect(client.getQueryData(queryKeys.agents.runtimeOptions(config.id, config.computerId, "codex", ""))).toEqual(
      first,
    );
    expect(client.getQueryData(queryKeys.agents.runtimeOptions(config.id, moved.computerId, "codex", ""))).toEqual(
      second,
    );
  });

  it("uses per-model efforts, preserves historical values, and requires an explicit supported selection", async () => {
    vi.mocked(browserApi.agentRuntimeOptions).mockImplementation(async (_id, model) => ({
      modelSuggestions: ["gpt-6-sol", "gpt-6-luna"],
      reasoningEffortAllowedValues: model === "gpt-6-luna" ? ["high", "max"] : ["high", "max", "ultra"],
    }));
    const configured = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, model: "gpt-6-sol", reasoningEffort: "ultra" },
    };
    const save = vi.fn().mockResolvedValue(configured);
    render(<RuntimeConfigurationForm initialConfig={configured} save={save} />);
    await waitFor(() =>
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledWith(config.id, "gpt-6-sol", expect.any(AbortSignal)),
    );
    expect(await optionLabels("Reasoning effort")).toContain("Ultra");
    await chooseOption("Model", "gpt-6-luna");
    await screen.findByText(
      "Choose a supported effort or inherit local configuration before saving this model change.",
    );
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "ultra (saved value)",
      "High",
      "Max",
    ]);
    await chooseOption("Reasoning effort", "");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        expectedRevision: 4,
        runtimeConfig: { model: "gpt-6-luna", reasoningEffort: null },
      }),
    );
  });

  it("shows no explicit efforts for a confirmed empty list and refreshes custom model capabilities", async () => {
    vi.mocked(browserApi.agentRuntimeOptions).mockResolvedValue({
      modelSuggestions: ["custom/model"],
      reasoningEffortAllowedValues: [],
    });
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    expect(await optionLabels("Reasoning effort")).toEqual(["Inherit local configuration"]);
    await chooseOption("Model", "__custom_model__");
    fireEvent.change(screen.getByRole("textbox", { name: "Custom model ID" }), { target: { value: "other/private" } });
    await waitFor(() =>
      expect(browserApi.agentRuntimeOptions).toHaveBeenCalledWith(config.id, "other/private", expect.any(AbortSignal)),
    );
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    await returnToPage();
    await waitFor(() =>
      expect(
        vi.mocked(browserApi.agentRuntimeOptions).mock.calls.filter((call) => call[1] === "other/private").length,
      ).toBe(2),
    );
  });

  it("shows authorization failures instead of presenting a failed directory as confirmed", async () => {
    vi.mocked(browserApi.agentRuntimeOptions).mockRejectedValue(new ApiError(403, "Forbidden"));
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "You do not have access to this Agent’s local model options.",
    );
    expect(await optionLabels("Model")).toContain("Custom model ID…");
  });

  it("ignores a late response for a previous model and keeps drafts while refreshing", async () => {
    let resolveOld!: (value: { modelSuggestions: string[]; reasoningEffortAllowedValues: string[] }) => void;
    vi.mocked(browserApi.agentRuntimeOptions).mockImplementation((_id, model) =>
      model === "gpt-6-sol"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ modelSuggestions: ["gpt-6-sol", "gpt-6-luna"], reasoningEffortAllowedValues: ["high"] }),
    );
    const configured = { ...config, runtimeConfig: { ...config.runtimeConfig, model: "gpt-6-sol" } };
    render(<RuntimeConfigurationForm initialConfig={configured} save={vi.fn()} />);
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    await chooseOption("Model", "gpt-6-luna");
    await waitFor(() => expect(screen.queryByText("Reading local models…")).toBeNull());
    resolveOld({ modelSuggestions: ["gpt-6-sol"], reasoningEffortAllowedValues: ["ultra"] });
    expect(await optionLabels("Reasoning effort")).toEqual(["Inherit local configuration", "High"]);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("gpt-6-luna");
    await returnToPage();
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("gpt-6-luna");
  });

  it("presents model suggestions and the complete Codex reasoning list", async () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Model" })).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Fixed when this Agent is created.")).toBeTruthy();
    expect(await optionLabels("Model")).toEqual([
      "Inherit local configuration",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "Custom model ID…",
    ]);
    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
      "Ultra",
    ]);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain(
      "Inherit local configuration",
    );
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent?.trim()).toContain(
      "Inherit local configuration",
    );
    expect(screen.getByRole("heading", { name: "Soul" })).toBeTruthy();
    expect(screen.getByText("Tell Reviewer how you’d like it to respond and work.")).toBeTruthy();
    expect(screen.queryByText("Choose a common model or enter a custom model ID.")).toBeNull();
    expect(screen.queryByText("Provider default lets the runtime choose.")).toBeNull();
    expect(screen.queryByText(/^OpenTag omits model and effort overrides/)).toBeNull();
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

    await chooseOption("Reasoning effort", "High");
    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
      "Ultra",
    ]);
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent?.trim()).toContain("High");
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
    expect(await screen.findByText("Model settings saved.")).toBeTruthy();
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
      runtimeConfig: { ...config.runtimeConfig, model: "claude-sonnet-5-5", reasoningEffort: "max" },
    };
    render(<RuntimeConfigurationForm initialConfig={claudeConfig} save={vi.fn()} />);

    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(await optionLabels("Model")).toEqual([
      "Inherit local configuration",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "Custom model ID…",
    ]);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain("claude-sonnet-5-5");
    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]);
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent?.trim()).toContain("Max");
  });

  it("shows Pi model suggestions and the complete Pi reasoning list", async () => {
    const piConfig: AgentAdminConfig = {
      ...config,
      runtimeProvider: "pi",
      runtimeConfig: { ...config.runtimeConfig, model: "anthropic/claude-sonnet-5-5", reasoningEffort: "off" },
    };
    render(<RuntimeConfigurationForm initialConfig={piConfig} save={vi.fn()} />);

    expect(screen.getByText("Pi")).toBeTruthy();
    expect(await optionLabels("Model")).toEqual([
      "Inherit local configuration",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
      "openai/gpt-6.1-sol",
      "Custom model ID…",
    ]);
    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain(
      "anthropic/claude-sonnet-5-5",
    );
    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]);
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent?.trim()).toContain("Off");
  });

  it("maps Provider default to null while preserving expectedRevision", async () => {
    const configured: AgentAdminConfig = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, model: "gpt-6.1-sol", reasoningEffort: "high" },
    };
    const save = vi.fn(async () => ({
      ...configured,
      revision: 5,
      runtimeConfig: { ...configured.runtimeConfig, revision: 8, model: null, reasoningEffort: null },
    }));
    render(<RuntimeConfigurationForm initialConfig={configured} save={save} section="execution" />);

    await chooseOption("Model", "");
    await chooseOption("Reasoning effort", "");
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
      runtimeConfig: { ...historicalConfig.runtimeConfig, revision: 8, model: "gpt-6.1-sol" },
    }));
    render(<RuntimeConfigurationForm initialConfig={historicalConfig} save={save} section="execution" />);

    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "historical-effort (saved value)",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
      "Ultra",
    ]);
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent?.trim()).toContain(
      "historical-effort",
    );

    await chooseOption("Model", "gpt-6.1-sol");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "gpt-6.1-sol", reasoningEffort: "historical-effort" },
    });
  });

  it("saves Agent instructions independently", async () => {
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, instructions: "Updated instructions." },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Soul" }), {
      target: { value: "Updated instructions." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { instructions: "Updated instructions." },
    });
  });

  it("disables Soul controls while applying and clears feedback on the next edit", async () => {
    let resolveSave!: (updated: AgentAdminConfig) => void;
    const save = vi.fn(
      () =>
        new Promise<AgentAdminConfig>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<RuntimeConfigurationForm initialConfig={config} save={save} section="instructions" />);
    const editor = screen.getByRole("textbox", { name: "Soul" }) as HTMLTextAreaElement;
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
    fireEvent.change(editor, { target: { value: "Be direct." } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(editor.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Applying…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Discard changes" })).toHaveProperty("disabled", true);
    resolveSave({ ...config, revision: 5, runtimeConfig: { ...config.runtimeConfig, instructions: "Be direct." } });
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Changes applied.");
    expect(editor.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
    fireEvent.change(editor, { target: { value: "Be direct and concise." } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeTruthy();
  });

  it("keeps the example on focus, hides it on input, and restores it on clear or discard", () => {
    const emptyConfig: AgentAdminConfig = {
      ...config,
      runtimeConfig: { ...config.runtimeConfig, instructions: "" },
    };
    render(<RuntimeConfigurationForm initialConfig={emptyConfig} save={vi.fn()} section="instructions" />);

    expect(screen.getAllByText("Soul")).toHaveLength(1);
    const instructions = screen.getByRole("textbox", { name: "Soul" }) as HTMLTextAreaElement;
    expect(instructions.value).toBe("");
    expect(screen.getByText("Example")).toBeTruthy();
    expect(screen.getByText("For longer writing tasks, start with an outline before drafting.")).toBeTruthy();
    expect(instructions.getAttribute("aria-describedby")).toContain("-example");
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();

    fireEvent.focus(instructions);
    expect(screen.getByText("Example")).toBeTruthy();
    fireEvent.change(instructions, { target: { value: "My own workflow." } });
    expect(screen.queryByText("Example")).toBeNull();
    expect(screen.queryByText("Unapplied changes")).toBeNull();
    expect(screen.getByText("Changes take effect with the next response.")).toBeTruthy();
    fireEvent.change(instructions, { target: { value: "" } });
    expect(screen.getByText("Example")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();

    fireEvent.change(instructions, { target: { value: "Another draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(instructions.value).toBe("");
    expect(screen.getByText("Example")).toBeTruthy();
  });

  it("applies an empty Soul without saving the example and restores it after an error", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        ...config,
        revision: 5,
        runtimeConfig: { ...config.runtimeConfig, revision: 8, instructions: "" },
      });
    render(<RuntimeConfigurationForm initialConfig={config} save={save} section="instructions" />);
    const editor = screen.getByRole("textbox", { name: "Soul" }) as HTMLTextAreaElement;
    expect(screen.queryByText("Example")).toBeNull();

    fireEvent.change(editor, { target: { value: "" } });
    expect(screen.getByText("Example")).toBeTruthy();
    expect(screen.getByText("Apply to clear Soul.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn’t confirm the update. Try again.");
    expect(editor.value).toBe("");
    expect(screen.getByText("Example")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByText("Changes applied.")).toBeTruthy();
    expect(screen.queryByText("Apply to clear Soul.")).toBeNull();
    expect(save).toHaveBeenLastCalledWith({ expectedRevision: 4, runtimeConfig: { instructions: "" } });
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
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

    await chooseOption("Model", "gpt-6.1-sol");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t save the model settings. Try again.");
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { model: "gpt-6.1-sol", reasoningEffort: "historical-effort" },
    });
    expect(screen.getByRole("combobox", { name: "Model" }).textContent?.trim()).toContain("gpt-6.1-sol");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent?.trim()).toContain(
      "historical-effort",
    );
    expect(await optionLabels("Reasoning effort")).toContain("historical-effort (saved value)");
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
    await chooseOption("Reasoning effort", "High");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect((screen.getByLabelText("Custom model ID") as HTMLInputElement).value).toBe("gpt-historical-private");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent?.trim()).toContain(
      "historical-effort",
    );
    expect(await optionLabels("Reasoning effort")).toEqual([
      "Inherit local configuration",
      "historical-effort (saved value)",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
      "Ultra",
    ]);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows model connection troubleshooting on Model and not on Instructions", () => {
    const execution = render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} section="execution" />);
    expect(screen.getByRole("heading", { name: "Troubleshooting" })).toBeTruthy();
    const testRow = screen.getByText("Test model connection").closest('[data-ui="settings-row"]') as HTMLElement;
    expect(testRow).toBeTruthy();
    expect(within(testRow).getByRole("button", { name: "Run test" })).toBeTruthy();
    expect(screen.getByText(/saved model settings/)).toBeTruthy();
    execution.unmount();

    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} section="instructions" />);
    expect(screen.queryByRole("button", { name: "Run test" })).toBeNull();
    expect(screen.queryByText(/saved model settings/)).toBeNull();
  });

  it("disables the connection test until model drafts are saved", async () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} section="execution" />);

    await chooseOption("Reasoning effort", "High");
    expect(screen.getByText("Save changes before testing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run test" }).hasAttribute("disabled")).toBe(true);
  });

  it("disables the connection test while the Agent Computer is offline", () => {
    render(
      <RuntimeConfigurationForm computerOnline={false} initialConfig={config} save={vi.fn()} section="execution" />,
    );

    expect(screen.getByText("The Agent’s Computer must be online to run this test.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run test" }).hasAttribute("disabled")).toBe(true);
  });

  it("clears a runtime test result after a successful saved configuration change", async () => {
    vi.spyOn(browserApi, "testAgentRuntime").mockResolvedValue({ status: "passed" });
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, model: "gpt-6.1-sol" },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} section="execution" />);

    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByText(/^Connection succeeded\./)).toBeTruthy();

    await chooseOption("Model", "gpt-6.1-sol");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(await screen.findByText("Model settings saved.")).toBeTruthy();
    expect(screen.queryByText(/Connection succeeded/)).toBeNull();
  });
});
