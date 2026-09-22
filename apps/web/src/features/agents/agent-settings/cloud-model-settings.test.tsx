import type { AgentAdminConfig, CloudModelOptions } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import { RuntimeConfigurationForm } from "./runtime-configuration.js";

const config: AgentAdminConfig = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  name: "cloud-test",
  displayName: "Cloud test",
  runtimeProvider: "pi",
  receiveMode: "mention_only",
  status: "active",
  revision: 4,
  runtimeConfig: {
    contextTrees: [],
    revision: 7,
    model: null,
    reasoningEffort: null,
    instructions: "",
    maxDurationMs: null,
  },
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};
const options: CloudModelOptions = {
  available: true,
  models: ["router-model-a", "router-model-b"],
  defaultModel: "router-model-a",
};
const clients: QueryClient[] = [];

function mount(initialConfig = config, save = vi.fn().mockResolvedValue(config)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <RuntimeConfigurationForm
        computerKind="cloud"
        computerOnline={false}
        initialConfig={initialConfig}
        save={save}
        section="execution"
      />
    </QueryClientProvider>,
  );
  return { client, save };
}

async function selectModel(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe("Cloud model settings", () => {
  it("keeps instruction editing independent of Router availability", async () => {
    const read = vi.spyOn(browserApi, "cloudModelOptions").mockRejectedValue(new ApiError(503, "Unavailable"));
    const save = vi.fn().mockResolvedValue({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, instructions: "Be concise.", revision: 8 },
    });
    render(<RuntimeConfigurationForm computerKind="cloud" initialConfig={config} save={save} section="instructions" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Be concise." } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Instructions saved.")).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith({ expectedRevision: 4, runtimeConfig: { instructions: "Be concise." } });
  });

  it("uses Router models and saves an explicit selection without Local suggestions", async () => {
    vi.spyOn(browserApi, "cloudModelOptions").mockResolvedValue(options);
    const save = vi.fn().mockResolvedValue({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, model: "router-model-b", revision: 8 },
    });
    mount(config, save);
    await screen.findByText("Platform default (router-model-a)");
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent?.trim())).toEqual([
      "Platform default (router-model-a)",
      "router-model-a",
      "router-model-b",
    ]);
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    await selectModel("router-model-b");
    expect(screen.queryByLabelText("Custom model ID")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        expectedRevision: 4,
        runtimeConfig: { model: "router-model-b", reasoningEffort: null },
      }),
    );
    expect(await screen.findByText("Model settings saved.")).toBeTruthy();
  });

  it("fails closed on a model-list error and lets the user retry", async () => {
    const read = vi
      .spyOn(browserApi, "cloudModelOptions")
      .mockRejectedValueOnce(new ApiError(503, "Unavailable"))
      .mockResolvedValue(options);
    mount();
    await screen.findByRole("button", { name: "Retry model list" });
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Run test" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("claude-sonnet-4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry model list" }));
    await screen.findByText("Platform default (router-model-a)");
    expect(read).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("button", { name: "Run test" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a retired saved model and allows an explicit reset to the platform default", async () => {
    vi.spyOn(browserApi, "cloudModelOptions").mockResolvedValue(options);
    const saved = { ...config, runtimeConfig: { ...config.runtimeConfig, model: "retired-model" } };
    const { save } = mount(saved);
    await screen.findAllByText("This model is no longer available. Select the platform default or an available model.");
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("retired-model");
    expect((screen.getByRole("button", { name: "Run test" }) as HTMLButtonElement).disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
    await selectModel("Platform default (router-model-a)");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        expectedRevision: 4,
        runtimeConfig: { model: null, reasoningEffort: null },
      }),
    );
  });

  it("does not retain actionable stale models after a failed refresh", async () => {
    const read = vi.spyOn(browserApi, "cloudModelOptions").mockResolvedValue(options);
    const { client } = mount();
    await screen.findByText("Platform default (router-model-a)");
    read.mockRejectedValue(new ApiError(503, "Unavailable"));
    await client.refetchQueries({ queryKey: queryKeys.cloudModelOptions() });
    await screen.findByRole("button", { name: "Retry model list" });
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Run test" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tests hosted model connectivity without a Local connection and explains the limited scope", async () => {
    vi.spyOn(browserApi, "cloudModelOptions").mockResolvedValue(options);
    const test = vi.spyOn(browserApi, "testAgentRuntime").mockResolvedValue({ status: "passed" });
    mount();
    await screen.findByText("Platform default (router-model-a)");
    expect(screen.getByText("Test hosted model connection")).toBeTruthy();
    expect(screen.getByText(/it does not test the Sandbox, Pi, or messaging/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await screen.findByText(
      "The hosted model connection passed. Sandbox and task execution still need a real task check.",
    );
    expect(test).toHaveBeenCalledWith(
      config.id,
      {
        expectedRevision: config.revision,
        expectedRuntimeConfigRevision: config.runtimeConfig.revision,
      },
      expect.any(AbortSignal),
    );
  });
});
