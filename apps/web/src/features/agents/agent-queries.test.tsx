import type {
  AccountComputerSummary,
  AgentDetail,
  ImBindingHandoffStatus,
  ImBindingSummary,
} from "@opentag/shared/browser";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { ApiError, browserApi } from "../../api.js";
import { queryKeys } from "../../query/keys.js";
import { LIVE_REFETCH_INTERVAL_MS } from "../../query/live.js";
import type { AgentDetailView } from "./agent-model.js";
import { projectAgentAvailability } from "./agent-model.js";
import {
  HANDOFF_CHECKING_POLL_WINDOW_MS,
  HANDOFF_CHECKING_REFETCH_INTERVAL_MS,
  useAgentDetailView,
  useAgentIdentityList,
  useAgentListView,
  useImBindingHandoffQuery,
} from "./agent-queries.js";

const accountId = "0b9c8d7e-6f50-4a1b-8c2d-3e4f50617283";
const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const computerId = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";

const computer: AccountComputerSummary = {
  computerId,
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
  connectedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:01:00.000Z",
  observedAt: "2026-08-20T00:01:00.000Z",
  createdAt: "2026-08-19T00:00:00.000Z",
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

const agentListItem = {
  ...agentDetail,
  usage: { windowDays: 30 as const, tasks: 32, failed: 0, tokens: 428_000 },
};

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

function IdentityProbe() {
  const state = useAgentIdentityList(accountId);
  return <span data-testid="identity">{state.kind}</span>;
}

function DetailWithAccountProbe() {
  const state = useAgentDetailView(agentId, { watched: true, accountId });
  return (
    <div>
      <span data-testid="kind">{state.kind}</span>
      <span data-testid="value">
        {state.kind === "ready" ? state.value.displayName : state.kind === "error" ? state.error.message : ""}
      </span>
    </div>
  );
}

let capturedClient: ReturnType<typeof useQueryClient>;
function CaptureClient() {
  capturedClient = useQueryClient();
  return null;
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

  it.each([401, 403, 404, 410])(
    "does not let a transient failure after a terminal one bring the Agent back (%d)",
    async (status) => {
      stubEvidence();
      const read = vi
        .spyOn(browserApi, "agent")
        .mockRejectedValueOnce(new ApiError(status, `Agent refused (${status})`))
        .mockRejectedValue(new ApiError(503, "Agent temporarily unavailable"));

      await renderInRouter(<DetailProbe initialAgent={routeAgent} />);
      await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("error"));

      // Losing contact is not news about the Agent: the Server already said it is gone or
      // forbidden, and a dropped connection afterwards does not withdraw that.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

      expect(screen.getByTestId("kind").textContent).toBe("error");
      expect(screen.getByTestId("value").textContent).toBe(`Agent refused (${status})`);
      expect(document.body.textContent).not.toContain("Reviewer");
    },
  );

  it("takes the Server's newer terminal answer over the one it recorded before", async () => {
    stubEvidence();
    const read = vi
      .spyOn(browserApi, "agent")
      .mockRejectedValueOnce(new ApiError(403, "Agent forbidden"))
      .mockRejectedValue(new ApiError(404, "Agent not found"));

    await renderInRouter(<DetailProbe initialAgent={routeAgent} />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("Agent forbidden"));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("Agent not found"));
  });

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

  it("lets the name-only switcher read the Agent list without Computer or messaging evidence", async () => {
    const list = vi.spyOn(browserApi, "agents").mockResolvedValue({
      agents: [
        agentListItem,
        { ...agentListItem, id: "22222222-2222-4222-8222-222222222222" },
        { ...agentListItem, id: "33333333-3333-4333-8333-333333333333" },
      ],
    });
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const binding = vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    const handoff = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);

    await renderInRouter(<IdentityProbe />);
    await waitFor(() => expect(screen.getByTestId("identity").textContent).toBe("ready"));
    expect(list).toHaveBeenCalledTimes(1);
    expect(computers).not.toHaveBeenCalled();
    expect(binding).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });

  it("reuses a successful list row for the selected Agent instead of GET /agents/:id", async () => {
    stubEvidence();
    const list = vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentListItem] });
    const detail = vi.spyOn(browserApi, "agent");

    await renderInRouter(<DetailWithAccountProbe />);
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("ready"));
    expect(screen.getByTestId("value").textContent).toBe("Reviewer");
    expect(list).toHaveBeenCalledTimes(1);
    expect(detail).not.toHaveBeenCalled();
  });

  it("does not treat a list refusal as this Agent's authorization and recovers by id", async () => {
    stubEvidence();
    vi.spyOn(browserApi, "agents").mockRejectedValue(new ApiError(403, "Agents refused"));
    const detail = vi.spyOn(browserApi, "agent").mockResolvedValue(agentDetail);

    await renderInRouter(<DetailWithAccountProbe />);
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("ready"));
    expect(screen.getByTestId("value").textContent).toBe("Reviewer");
    expect(detail).toHaveBeenCalledWith(agentId);
  });

  it("does not let an older list row overrule a newer per-Agent refusal", async () => {
    stubEvidence();
    const listResult = { agents: [agentListItem] };
    vi.spyOn(browserApi, "agents").mockResolvedValue(listResult);
    vi.spyOn(browserApi, "agent").mockRejectedValue(new ApiError(403, "Agent access removed"));
    const view = await renderInRouter(<CaptureClient />);
    capturedClient.setQueryData(queryKeys.agents.list(accountId), listResult, { updatedAt: Date.now() - 1_000 });
    await capturedClient
      .fetchQuery({ queryKey: queryKeys.agents.detail(agentId), queryFn: () => browserApi.agent(agentId) })
      .catch(() => undefined);
    view.rerender(
      <>
        <CaptureClient />
        <DetailWithAccountProbe />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("error"));
    expect(screen.getByTestId("value").textContent).toBe("Agent access removed");
  });

  it("keeps a newer per-Agent refusal across a transient failure and remount until authorized recovery", async () => {
    stubEvidence();
    const listResult = { agents: [agentListItem] };
    vi.spyOn(browserApi, "agents").mockResolvedValue(listResult);
    const detail = vi
      .spyOn(browserApi, "agent")
      .mockRejectedValueOnce(new ApiError(403, "Agent access removed"))
      .mockRejectedValueOnce(new ApiError(503, "Temporary outage"))
      .mockResolvedValue(agentDetail);
    const view = await renderInRouter(<CaptureClient />);
    capturedClient.setQueryData(queryKeys.agents.list(accountId), listResult, { updatedAt: Date.now() - 1_000 });
    await capturedClient
      .fetchQuery({ queryKey: queryKeys.agents.detail(agentId), queryFn: () => browserApi.agent(agentId) })
      .catch(() => undefined);
    await capturedClient
      .fetchQuery({ queryKey: queryKeys.agents.detail(agentId), queryFn: () => browserApi.agent(agentId) })
      .catch(() => undefined);
    view.rerender(
      <>
        <CaptureClient />
        <DetailWithAccountProbe />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("error"));
    expect(screen.getByTestId("value").textContent).toBe("Agent access removed");
    await act(async () => {
      await capturedClient.refetchQueries({ queryKey: queryKeys.agents.detail(agentId) });
    });
    await waitFor(() => expect(screen.getByTestId("kind").textContent).toBe("ready"));
    expect(screen.getByTestId("value").textContent).toBe("Reviewer");
    expect(detail).toHaveBeenCalled();
  });
});

const activeBinding: ImBindingSummary = {
  id: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  agentId,
  provider: "feishu",
  bindingState: "active",
  bot: { displayName: "Reviewer", avatarUrl: null },
  receiveMode: "mention_only",
  lastInboundAt: null,
  lastValidatedAt: "2026-08-20T00:00:30.000Z",
  lastRuntimeObservationAt: "2026-08-20T00:00:45.000Z",
};
const checkingHandoff: ImBindingHandoffStatus = {
  bindingState: "active",
  handoffReady: false,
  providerCli: { phase: "checking_credentials" },
};
const readyHandoff: ImBindingHandoffStatus = { bindingState: "active", handoffReady: true };

function HandoffProbe() {
  const query = useImBindingHandoffQuery(agentId);
  return <span data-testid="handoff">{query.data ? String(query.data.handoffReady) : "none"}</span>;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Handoff polling while the messaging check is in progress", () => {
  afterEach(() => vi.useRealTimers());

  /*
   * A check the Server reports as in progress settles within seconds, and the ordinary 30-second
   * cadence would leave the page saying "checking" long after it had. The fast cadence is only
   * for that state: a settled answer, ready or failed, returns to the shared live cadence.
   */
  it("re-reads every two seconds until the check settles, then returns to the live cadence", async () => {
    const read = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(checkingHandoff);
    vi.useFakeTimers();
    await renderInRouter(<HandoffProbe />);
    await advance(50);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(readyHandoff);
    await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("handoff").textContent).toBe("true");
    await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS * 2);
    expect(read).toHaveBeenCalledTimes(3);
    await advance(LIVE_REFETCH_INTERVAL_MS - HANDOFF_CHECKING_REFETCH_INTERVAL_MS * 2);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("falls back to the live cadence after ninety seconds of an unsettled check", async () => {
    const read = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(checkingHandoff);
    vi.useFakeTimers();
    await renderInRouter(<HandoffProbe />);
    await advance(50);
    await advance(HANDOFF_CHECKING_POLL_WINDOW_MS);
    const fastReads = read.mock.calls.length;
    expect(fastReads).toBe(1 + HANDOFF_CHECKING_POLL_WINDOW_MS / HANDOFF_CHECKING_REFETCH_INTERVAL_MS);
    await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(fastReads);
    await advance(LIVE_REFETCH_INTERVAL_MS - HANDOFF_CHECKING_REFETCH_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(fastReads + 1);
  });

  /*
   * The window is a budget of checking answers, not wall-clock time. A hidden tab neither polls nor
   * spends the budget, so a viewer who returns after minutes -- the very case this fix is for --
   * still gets the fast cadence for whatever budget is left.
   */
  it("does not spend the fast-polling budget while the tab is hidden", async () => {
    const read = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(checkingHandoff);
    vi.useFakeTimers();
    try {
      await renderInRouter(<HandoffProbe />);
      await advance(50);
      await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS * 2);
      expect(read).toHaveBeenCalledTimes(3);
      focusManager.setFocused(false);
      await advance(HANDOFF_CHECKING_POLL_WINDOW_MS * 2);
      expect(read).toHaveBeenCalledTimes(3);
      focusManager.setFocused(true);
      await advance(50);
      expect(read).toHaveBeenCalledTimes(4);
      await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS);
      expect(read).toHaveBeenCalledTimes(5);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it("keeps the live cadence when the Agent has no handoff at all", async () => {
    const read = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    vi.useFakeTimers();
    await renderInRouter(<HandoffProbe />);
    await advance(50);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(LIVE_REFETCH_INTERVAL_MS - HANDOFF_CHECKING_REFETCH_INTERVAL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("polls the list's handoff evidence at the same fast cadence", async () => {
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentListItem] });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(activeBinding);
    const read = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(checkingHandoff);
    vi.useFakeTimers();
    await renderInRouter(<ListProbe />);
    await advance(50);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(HANDOFF_CHECKING_REFETCH_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
