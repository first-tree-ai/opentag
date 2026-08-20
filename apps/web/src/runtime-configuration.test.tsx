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
    allowedTools: ["opentag_message_reply"],
    maxDurationMs: null,
  },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("RuntimeConfigurationForm", () => {
  it("presents provider-managed choices and the shared Turn-duration default", () => {
    render(<RuntimeConfigurationForm initialConfig={config} save={vi.fn()} />);

    expect((screen.getByLabelText("Model") as HTMLInputElement).placeholder).toBe("Managed by provider");
    const effort = screen.getByLabelText("Reasoning effort") as HTMLInputElement;
    expect(effort.placeholder).toBe("Managed by provider");
    const suggestions = document.getElementById(effort.getAttribute("list") ?? "");
    expect(Array.from(suggestions?.querySelectorAll("option") ?? []).map((option) => option.value)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect((screen.getByLabelText("Maximum Turn duration") as HTMLInputElement).placeholder).toBe("1800");
    expect(screen.getByText(/OpenTag's 30-minute default/)).toBeTruthy();
  });

  it("saves exact Provider values and converts seconds to API milliseconds", async () => {
    const save = vi.fn(async () => ({
      ...config,
      revision: 5,
      runtimeConfig: {
        ...config.runtimeConfig,
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
        maxDurationMs: 45_500,
      },
    }));
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "  gpt-5.6-codex  " } });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Maximum Turn duration"), { target: { value: "45.5" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Updated instructions." } });
    fireEvent.click(screen.getByRole("button", { name: "Save Runtime settings" }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith({
      expectedRevision: 4,
      runtimeConfig: {
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
        instructions: "Updated instructions.",
        maxDurationMs: 45_500,
      },
    });
    expect((await screen.findByRole("status")).textContent).toBe("Runtime configuration saved.");
  });

  it("restores provider-managed choices and the OpenTag duration default with blank values", () => {
    const data = new FormData();
    data.set("model", " ");
    data.set("reasoningEffort", "");
    data.set("instructions", "Keep this.");
    data.set("maxDurationSeconds", "");

    expect(runtimeConfigurationFromForm(data)).toEqual({
      model: null,
      reasoningEffort: null,
      instructions: "Keep this.",
      maxDurationMs: null,
    });
  });

  it.each(["0", "-1", "0.0001", "86400.001"])("rejects an invalid duration of %s before saving", async (duration) => {
    const save = vi.fn();
    render(<RuntimeConfigurationForm initialConfig={config} save={save} />);
    fireEvent.change(screen.getByLabelText("Maximum Turn duration"), { target: { value: duration } });
    fireEvent.submit(screen.getByRole("button", { name: "Save Runtime settings" }).closest("form") as HTMLFormElement);

    expect((await screen.findByRole("alert")).textContent).toContain("between 0.001 and 86400 seconds");
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects non-numeric duration input at the form-contract boundary", () => {
    const data = new FormData();
    data.set("maxDurationSeconds", "not-a-number");
    expect(() => runtimeConfigurationFromForm(data)).toThrow("between 0.001 and 86400 seconds");
  });
});
