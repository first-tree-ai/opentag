import type { AgentAdminConfig } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { browserApi } from "../../../api.js";
import type { AgentDetailView } from "../agent-model.js";
import { AgentManageSettings } from "./agent-manage-settings.js";

const config: AgentAdminConfig = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  revision: 4,
  runtimeConfig: { revision: 7, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const agent = {
  ...config,
  activity: { state: "working" },
  computer: { computerId: config.computerId, displayName: "Ada's Mac", platform: "darwin" },
  availability: {
    state: "ready",
    reason: null,
    dependencies: {
      computer: { state: "ready", lastConfirmedAt: config.updatedAt },
      runtime: { provider: "codex", status: "ready" },
      channel: { state: "ready", provider: null },
      handoff: { state: "ready" },
    },
  },
  messaging: { kind: "ready", value: undefined },
} as unknown as AgentDetailView;

describe("AgentManageSettings", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a failed pause and lets the viewer close its confirmation", async () => {
    vi.spyOn(browserApi, "suspendAgent").mockRejectedValue(new Error("pause conflict"));
    await renderInRouter(<AgentManageSettings agent={agent} initialConfig={config} onAgentChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause Agent" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("pause conflict");
    fireEvent.click(screen.getByRole("button", { name: "Keep active" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows lifecycle errors inline when no confirmation is needed", async () => {
    vi.spyOn(browserApi, "suspendAgent").mockRejectedValue(new Error("status update failed"));
    const idleAgent = { ...agent, activity: { state: "idle" } } as AgentDetailView;
    await renderInRouter(<AgentManageSettings agent={idleAgent} initialConfig={config} onAgentChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect((await screen.findByRole("status")).textContent).toBe("status update failed");
  });
});
