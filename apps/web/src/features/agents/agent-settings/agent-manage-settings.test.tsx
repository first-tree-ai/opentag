import type {
  AgentAdminConfig,
  AgentDetail,
  AgentListItem as AgentListApiItem,
  ListAgentsResponse,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { browserApi } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import type { AgentDetailView } from "../agent-model.js";
import { projectAgentAvailability } from "../agent-model.js";
import { useAgentDetailView, useAgentListView } from "../agent-queries.js";
import { AgentManageSettings } from "./agent-manage-settings.js";

const accountId = "0b9c8d7e-6f50-4a1b-8c2d-3e4f50617283";
const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const computerId = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";

const computer: WorkspaceComputerSummary = {
  computerId,
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
  connectedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:01:00.000Z",
  observedAt: "2026-08-20T00:01:00.000Z",
  enrolledAt: "2026-08-19T00:00:00.000Z",
  agentIds: [agentId],
};

const agentDetail: AgentDetail = {
  id: agentId,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
  computer: { computerId, displayName: "Ada's Mac", platform: "darwin" },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "suspended",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  activity: { state: "idle" },
};

const listItem: AgentListApiItem = {
  ...agentDetail,
  activity: { state: "idle" },
  usage: { windowDays: 30, tasks: 32, failed: 0, tokens: 428_000 },
};

const agentView: AgentDetailView = {
  ...agentDetail,
  availability: projectAgentAvailability(agentDetail, computer, undefined, undefined, true, true),
  messaging: { kind: "ready", value: undefined },
};

const config: AgentAdminConfig = {
  id: agentId,
  name: agentDetail.name,
  displayName: agentDetail.displayName,
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  // Deleting is only offered once the Agent is paused, so the fixture starts where that flow ends.
  status: "suspended",
  createdAt: agentDetail.createdAt,
  updatedAt: agentDetail.updatedAt,
  createdByUserId: agentDetail.createdBy.userId,
  computerId,
  revision: 2,
  runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
};

const activeConfig: AgentAdminConfig = { ...config, status: "active" };
const activeAgent = { ...agentView, status: "active", activity: { state: "working" } } as AgentDetailView;
const idleActiveAgent = { ...activeAgent, activity: { state: "idle" } } as AgentDetailView;

function AgentListProbe() {
  const state = useAgentListView(accountId);
  return (
    <span data-testid="agent-list">
      {state.kind === "ready" ? state.value.agents.map((agent) => agent.displayName).join(",") || "empty" : state.kind}
    </span>
  );
}

/**
 * What the Agent's own page shows on its first paint. Mounting it again after the delete is how a
 * viewer would come back to the Agent, so what the cache still holds for it is visible here.
 */
function AgentDetailProbe() {
  const state = useAgentDetailView(agentId);
  return <span data-testid="agent-detail">{state.kind === "ready" ? state.value.displayName : state.kind}</span>;
}

function RefreshAgentsButton() {
  const queryClient = useQueryClient();
  return (
    <button type="button" onClick={() => void queryClient.refetchQueries({ queryKey: queryKeys.agents.listRoot() })}>
      Refresh Agents
    </button>
  );
}

function stubEvidence() {
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
}

async function confirmDelete() {
  fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
  fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
}

afterEach(() => vi.restoreAllMocks());

describe("Deleting an Agent", () => {
  it("keeps the Agent evicted when a list read that outlived the delete answers", async () => {
    stubEvidence();
    let releaseList: (response: ListAgentsResponse) => void = () => undefined;
    vi.spyOn(browserApi, "agents")
      .mockResolvedValueOnce({ agents: [listItem] })
      .mockReturnValueOnce(
        new Promise<ListAgentsResponse>((resolve) => {
          releaseList = resolve;
        }),
      );
    const remove = vi.spyOn(browserApi, "deleteAgent").mockResolvedValue(undefined);

    await renderInRouter(
      <>
        <AgentListProbe />
        <RefreshAgentsButton />
        <AgentManageSettings agent={agentView} config={config} onAgentChanged={() => undefined} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("agent-list").textContent).toBe("Reviewer"));

    // A read that left before the delete. The list is watched on an interval and on focus, so
    // holding one here is the ordinary case, not a contrived one.
    fireEvent.click(screen.getByRole("button", { name: "Refresh Agents" }));
    await confirmDelete();
    await waitFor(() => expect(remove).toHaveBeenCalledWith(agentId));
    await waitFor(() => expect(screen.getByTestId("agent-list").textContent).toBe("empty"));

    // Only now does the held read answer, still naming the Agent because it left before the delete.
    await act(async () => {
      releaseList({ agents: [listItem] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A confirmed delete outranks a read the Server answered from before it happened.
    expect(screen.getByTestId("agent-list").textContent).toBe("empty");
  });

  it("drops the deleted Agent's own cache entries, not only the lists that named it", async () => {
    stubEvidence();
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [listItem] });
    vi.spyOn(browserApi, "agent")
      .mockResolvedValueOnce(agentDetail)
      .mockReturnValue(new Promise<AgentDetail>(() => undefined));
    const remove = vi.spyOn(browserApi, "deleteAgent").mockResolvedValue(undefined);
    const manage = <AgentManageSettings agent={agentView} config={config} onAgentChanged={() => undefined} />;

    const view = await renderInRouter(
      <>
        <AgentDetailProbe />
        {manage}
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("agent-detail").textContent).toBe("Reviewer"));

    view.rerender(manage);
    await confirmDelete();
    await waitFor(() => expect(remove).toHaveBeenCalledWith(agentId));
    await act(async () => undefined);
    view.rerender(
      <>
        <AgentDetailProbe />
        {manage}
      </>,
    );

    // The detail, config, binding and usage entries all sit under the Agent's own key prefix. With
    // them dropped, coming back to the Agent has nothing to show while it re-reads — rather than
    // painting the deleted Agent from the cache first.
    await waitFor(() => expect(screen.getByTestId("agent-detail").textContent).toBe("loading"));
  });
});

describe("Agent lifecycle actions", () => {
  it("reports a failed pause and lets the viewer close its confirmation", async () => {
    vi.spyOn(browserApi, "suspendAgent").mockRejectedValue(new Error("pause conflict"));
    await renderInRouter(<AgentManageSettings agent={activeAgent} config={activeConfig} onAgentChanged={vi.fn()} />);

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
    await renderInRouter(
      <AgentManageSettings agent={idleActiveAgent} config={activeConfig} onAgentChanged={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect((await screen.findByRole("status")).textContent).toBe("status update failed");
  });
});
