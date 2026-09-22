import type { AccountComputerSummary, AgentDetail, CloudAvailability } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { useAgentDetailView, useAgentListView } from "./agent-queries.js";

const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const accountId = "0b9c8d7e-6f50-4a1b-8c2d-3e4f50617283";
const computerId = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
const time = "2026-09-20T00:00:00.000Z";
const computer: AccountComputerSummary = {
  computerId,
  displayName: "Cloud",
  platform: "linux",
  kind: "cloud",
  connectionStatus: "online",
  providerReadiness: [],
  connectedAt: time,
  lastSeenAt: time,
  observedAt: time,
  createdAt: time,
  agentIds: [agentId],
};
const agent: AgentDetail = {
  id: agentId,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId: accountId, displayName: "Ada" },
  computer: { computerId, displayName: "Cloud", platform: "linux" },
  runtimeProvider: "pi",
  receiveMode: "mention_only",
  status: "active",
  createdAt: time,
  updatedAt: time,
  activity: { state: "idle" },
};
function Probe() {
  const list = useAgentListView(accountId);
  const detail = useAgentDetailView(agentId, { accountId, watched: true });
  const client = useQueryClient();
  return (
    <>
      <span data-testid="list">{list.kind === "ready" ? list.value.agents[0]?.availability.reason : list.kind}</span>
      <span data-testid="detail">{detail.kind === "ready" ? detail.value.availability.reason : detail.kind}</span>
      <button type="button" onClick={() => void client.invalidateQueries({ queryKey: queryKeys.cloudAvailability() })}>
        Refresh
      </button>
    </>
  );
}
function stub(kind: "cloud" | "local" = "cloud") {
  vi.spyOn(browserApi, "agents").mockResolvedValue({
    agents: [{ ...agent, usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 } }],
  });
  vi.spyOn(browserApi, "agent").mockResolvedValue(agent);
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [{ ...computer, kind }] });
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
}
async function expectReason(reason: string) {
  await waitFor(() => {
    expect(screen.getByTestId("list").textContent).toBe(reason);
    expect(screen.getByTestId("detail").textContent).toBe(reason);
  });
}
afterEach(() => vi.restoreAllMocks());
describe("Cloud readiness evidence reaches Agent surfaces", () => {
  it("shares availability evidence and stops claiming readiness after a failed refresh", async () => {
    stub();
    const availability: CloudAvailability = { enabled: true, available: true, reason: null, observedAt: time };
    const read = vi.spyOn(browserApi, "cloudAvailability").mockResolvedValue(availability);
    await renderInRouter(<Probe />);
    await expectReason("im_not_connected");
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue({ ...availability, available: false, reason: "model_unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await expectReason("runtime_unavailable");
    read.mockRejectedValue(new Error("unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await expectReason("runtime_unconfirmed");
  });
  it("does not query Cloud availability for Local Computers", async () => {
    stub("local");
    const read = vi.spyOn(browserApi, "cloudAvailability");
    await renderInRouter(<Probe />);
    await expectReason("runtime_unconfirmed");
    expect(read).not.toHaveBeenCalled();
  });
});
