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

describe("RuntimeConfigurationForm", () => {
  it("presents a concise Runtime summary without exposing the Turn timeout", () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Runtime" })).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getAllByText("Provider default")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Agent instructions" })).toBeTruthy();
    expect(screen.queryByText(/timeout/i)).toBeNull();
    expect(screen.queryByText("Execution choices")).toBeNull();
  });

  it("edits only the understandable Runtime choices", () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit settings" }));
    expect((screen.getByLabelText("Model") as HTMLInputElement).placeholder).toBe("Provider default");
    const effort = screen.getByLabelText("Reasoning level") as HTMLInputElement;
    expect(effort.placeholder).toBe("Provider default");
    const suggestions = document.getElementById(effort.getAttribute("list") ?? "");
    expect(Array.from(suggestions?.querySelectorAll("option") ?? []).map((option) => option.value)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(screen.queryByLabelText(/duration/i)).toBeNull();
  });

  it("uses plain provider-managed copy for Claude Code", () => {
    render(<RuntimeConfigurationForm initialConfig={{ ...config, runtimeProvider: "claude-code" }} save={vi.fn()} />);

    expect(screen.getByText("Runtime settings are managed by Claude Code.")).toBeTruthy();
    expect(screen.getByText("Agent instructions are not editable for this provider.")).toBeTruthy();
    expect(screen.queryByText(/Effective Runtime Snapshot/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();
  });

  it("saves Runtime choices without rewriting hidden configuration", async () => {
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: {
        ...config.runtimeConfig,
        revision: 8,
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
      },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit settings" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "  gpt-5.6-codex  " } });
    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: {
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
      },
    });
    expect((await screen.findByRole("status")).textContent).toBe("Runtime settings saved.");
    expect(screen.getByText("gpt-5.6-codex")).toBeTruthy();
  });

  it("saves Agent instructions independently", async () => {
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: { ...config.runtimeConfig, revision: 8, instructions: "Updated instructions." },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Updated instructions." } });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: { instructions: "Updated instructions." },
    });
    expect((await screen.findByRole("status")).textContent).toBe("Agent instructions saved.");
  });

  it("restores provider defaults with blank Runtime values", () => {
    const data = new FormData();
    data.set("model", " ");
    data.set("reasoningEffort", "");

    expect(runtimeConfigurationFromForm(data)).toEqual({
      model: null,
      reasoningEffort: null,
    });
  });

  it("reports save failures without closing the editor", async () => {
    const save = vi.fn(async () => {
      throw new Error("Revision changed");
    });
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Revision changed");
    expect(screen.getByLabelText("Model")).toBeTruthy();
  });
});
