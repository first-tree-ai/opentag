import type { AgentAdminConfig } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLocale } from "../../../__tests__/support/with-locale.js";
import { browserApi } from "../../../api.js";
import { GeneralConfigForm } from "./general-config-form.js";

const config: AgentAdminConfig = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
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

describe("GeneralConfigForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "saves and discards a name without changing self-configuration=%s",
    async (selfConfigurationEnabled) => {
      const initialConfig = { ...config, selfConfigurationEnabled };
      const updated = { ...initialConfig, displayName: "Reviewer Bot", revision: 5 };
      const updateAgent = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
      const onAgentChanged = vi.fn();
      render(<GeneralConfigForm initialConfig={initialConfig} onAgentChanged={onAgentChanged} />);

      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByText("Self-configuration")).toBeNull();
      expect(screen.getByRole("heading", { name: "Name" }).closest("form")).toBeNull();
      const displayName = screen.getByLabelText("Display name");
      expect(displayName.parentElement?.className).toContain("[&>input]:w-full");
      const form = displayName.closest("form") as HTMLFormElement;
      fireEvent.submit(form);
      expect(updateAgent).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Reviewer Bot" } });
      expect(screen.getByText("Unsaved changes")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Reviewer");

      fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Reviewer Bot" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(updateAgent).toHaveBeenCalledOnce());
      expect(updateAgent).toHaveBeenCalledWith(config.id, { expectedRevision: 4, displayName: "Reviewer Bot" });
      expect((await screen.findByRole("status")).textContent).toBe("Name saved.");
      expect(onAgentChanged).toHaveBeenCalledOnce();
    },
  );

  it("shows a provider error and fallback for failed saves", async () => {
    const updateAgent = vi
      .spyOn(browserApi, "updateAgent")
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockRejectedValueOnce("unknown failure");
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Conflict" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("status")).textContent).toBe("revision conflict");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Conflict again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("status")).textContent).toBe("Unable to save name");
    expect(updateAgent).toHaveBeenCalledTimes(2);
  });

  it("blocks duplicate name updates while saving", async () => {
    let release: ((value: AgentAdminConfig) => void) | undefined;
    const pending = new Promise<AgentAdminConfig>((resolve) => {
      release = resolve;
    });
    const updateAgent = vi.spyOn(browserApi, "updateAgent").mockReturnValue(pending);
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
    const displayName = screen.getByLabelText("Display name");
    const form = displayName.closest("form") as HTMLFormElement;
    fireEvent.change(displayName, { target: { value: "Draft name" } });
    fireEvent.submit(form);

    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(updateAgent).toHaveBeenCalledOnce();

    release?.({ ...config, displayName: "Draft name", revision: 5 });
    expect((await screen.findByRole("status")).textContent).toBe("Name saved.");
  });

  it("shows the name settings without self-configuration in Chinese", () => {
    withLocale("zh", () => {
      render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
      expect(screen.getByRole("textbox")).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByText("自助配置")).toBeNull();
      expect(
        screen.queryByText("允许此 Agent 通过 Session CLI 修改自己的指令、模型、推理强度和 MCP 挂载。"),
      ).toBeNull();
    });
  });
});
