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

  it("saves and discards a changed display name", async () => {
    const updated = { ...config, displayName: "Reviewer Bot", revision: 5 };
    const updateAgent = vi.spyOn(browserApi, "updateAgent").mockResolvedValue(updated);
    const onAgentChanged = vi.fn();
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />);

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
  });

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

  it("lets the owner toggle Agent self-configuration", async () => {
    const updated = { ...config, selfConfigurationEnabled: true, revision: 5 };
    const updateAgent = vi
      .spyOn(browserApi, "updateAgent")
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce({ ...updated, selfConfigurationEnabled: false, revision: 6 });
    const onAgentChanged = vi.fn();
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />);

    const toggle = screen.getByRole("switch", { name: "Self-configuration" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    await waitFor(() => expect(updateAgent).toHaveBeenCalledOnce());
    expect(updateAgent).toHaveBeenCalledWith(config.id, {
      expectedRevision: config.revision,
      selfConfigurationEnabled: true,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((await screen.findByRole("status")).textContent).toBe("Self-configuration setting saved.");
    expect(onAgentChanged).toHaveBeenCalledOnce();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(updateAgent).toHaveBeenLastCalledWith(config.id, {
      expectedRevision: updated.revision,
      selfConfigurationEnabled: false,
    });
    expect(onAgentChanged).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("revision conflict"), "unknown failure"])(
    "preserves the disabled setting when saving fails with %s",
    async (cause) => {
      vi.spyOn(browserApi, "updateAgent").mockRejectedValue(cause);
      const onAgentChanged = vi.fn();
      render(<GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />);
      const toggle = screen.getByRole("switch", { name: "Self-configuration" });

      fireEvent.click(toggle);

      expect((await screen.findByRole("status")).textContent).toBe(
        cause instanceof Error ? cause.message : "Unable to save self-configuration setting",
      );
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
      expect(onAgentChanged).not.toHaveBeenCalled();
    },
  );

  it.each(["name", "self-configuration"])("blocks concurrent updates while saving %s", async (field) => {
    let release: ((value: AgentAdminConfig) => void) | undefined;
    const pending = new Promise<AgentAdminConfig>((resolve) => {
      release = resolve;
    });
    const updateAgent = vi.spyOn(browserApi, "updateAgent").mockReturnValue(pending);
    render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
    const displayName = screen.getByLabelText("Display name");
    const form = displayName.closest("form") as HTMLFormElement;
    const toggle = screen.getByRole("switch", { name: "Self-configuration" });
    fireEvent.change(displayName, { target: { value: "Draft name" } });

    if (field === "name") fireEvent.submit(form);
    else fireEvent.click(toggle);

    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    fireEvent.submit(form);
    expect(updateAgent).toHaveBeenCalledOnce();

    release?.({ ...config, displayName: "Draft name", selfConfigurationEnabled: field !== "name", revision: 5 });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows the disabled owner switch with Chinese copy", () => {
    withLocale("zh", () => {
      render(<GeneralConfigForm initialConfig={config} onAgentChanged={vi.fn()} />);
      expect(screen.getByRole("switch", { name: "自助配置" }).getAttribute("aria-checked")).toBe("false");
      expect(
        screen.getByText("允许此 Agent 通过 Session CLI 修改自己的指令、模型、推理强度和 MCP 挂载。"),
      ).toBeTruthy();
    });
  });
});
