import type { AgentDetail, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { ApiError, browserApi } from "../../api.js";
import type { AgentDetailView } from "./agent-model.js";
import { projectAgentAvailability } from "./agent-model.js";
import { useAgentDetailView, useAgentListView } from "./agent-queries.js";

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
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  activity: { state: "idle" },
};

/** The Agent a link carries in history state, as `AgentDetailPage` hands it to the next page. */
const routeAgent: AgentDetailView = {
  ...agentDetail,
  availability: projectAgentAvailability(agentDetail, computer, undefined, undefined, true, true),
  messaging: { kind: "ready", value: undefined },
};

/** A read that stays in flight, so a test can assert what a page shows *while* it is re-reading. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function stubEvidence() {
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
}

function DetailProbe({ initialAgent }: { initialAgent?: AgentDetailView }) {
  const state = useAgentDetailView(agentId, { watched: true, initialAgent });
  return (
    <div>
      <span data-testid="kind">{state.kind}</span>
      <span data-testid="value">
        {state.kind === "error"
          ? state.error.message
          : state.kind === "ready"
            ? `${state.value.displayName}/${state.value.availability.state}/${state.value.availability.dependencies.computer.state}`
            : ""}
      </span>
    </div>
  );
}

function ListProbe() {
  const state = useAgentListView(accountId);
  return (
    <div>
      <span data-testid="kind">{state.kind}</span>
      <span data-testid="value">
        {state.kind === "error"
          ? state.error.message
          : state.kind === "ready"
            ? state.value.agents.map((agent) => agent.displayName).join(",")
            : ""}
      </span>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Agent views read from the cache", () => {
  it.each([401, 403, 404, 410])(
    "keeps a terminal Agent response ahead of route state while the next read is in flight (%d)",
    async (status) => {
      stubEvidence();
      const read = vi
        .spyOn(browserApi, "agent")
        .mockRejectedValueOnce(new ApiError(status, `Agent refused (${status})`))
        .mockReturnValue(neverSettles<AgentDetail>());

      await renderInRouter(<DetailProbe initialAgent={routeAgent} />);
      await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("error"));

      /*
       * This page re-reads on focus and on a 30-second interval. The cache clears `error` for the
       * whole of a read it starts on a query that has never held data, so a verdict taken from
       * `isError` alone would be forgotten here and route state would put the Agent back.
       */
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

      expect(screen.getByTestId("kind").textContent).toBe("error");
      expect(screen.getByTestId("value").textContent).toBe(`Agent refused (${status})`);
      expect(document.body.textContent).not.toContain("Reviewer");
    },
  );

  it("still degrades to the Agent carried in route state when the failure is not terminal", async () => {
    stubEvidence();
    const read = vi
      .spyOn(browserApi, "agent")
      .mockRejectedValueOnce(new ApiError(503, "Agent temporarily unavailable"))
      .mockReturnValue(neverSettles<AgentDetail>());

    await renderInRouter(<DetailProbe initialAgent={routeAgent} />);
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("ready"));

    // The control for the case above: this branch is live, and only a terminal status diverts it.
    expect(screen.getByTestId("value").textContent).toContain("Reviewer");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("kind").textContent).toBe("ready");
    expect(screen.getByTestId("value").textContent).toContain("Reviewer");
  });

  it("stops counting a Computer as evidence once its read has failed", async () => {
    vi.spyOn(browserApi, "agent").mockResolvedValue(agentDetail);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const computers = vi
      .spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [computer] })
      .mockRejectedValue(new ApiError(503, "Computers unavailable"));

    await renderInRouter(<DetailProbe />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toContain("/ready"));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(computers).toHaveBeenCalledTimes(2));

    // A Computer the cache still holds after a failed re-read is not evidence, exactly as on the
    // list, where the Computer read gates the per-Agent evidence rather than being read through it.
    await waitFor(() => expect(screen.getByTestId("value").textContent).toContain("/unconfirmed"));
  });

  it.each([401, 403, 404, 410])(
    "surfaces a terminal Agent list response while the Computer read is still settling (%d)",
    async (status) => {
      vi.spyOn(browserApi, "agents").mockRejectedValue(new ApiError(status, `Agents refused (${status})`));
      vi.spyOn(browserApi, "computers").mockReturnValue(neverSettles());
      vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
      vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);

      await renderInRouter(<ListProbe />);

      // The Computer read gates the evidence, not the answer about the list itself.
      await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("error"));
      expect(screen.getByTestId("value").textContent).toBe(`Agents refused (${status})`);
    },
  );
});
