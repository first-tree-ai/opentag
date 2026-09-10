import { useQueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { browserApi } from "../api.js";
import { useAgentDetailView } from "../features/agents/agent-queries.js";
import { queryKeys } from "../query/keys.js";
import { AgentSetupPage } from "./agent-setup-page.js";
import {
  SETUP_AGENT_ID,
  SETUP_COMPUTER_ID,
  SETUP_NOW,
  SETUP_USER_ID,
  setupAgent,
} from "./agent-setup-test-fixtures.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

let client: ReturnType<typeof useQueryClient>;
function Capture() {
  client = useQueryClient();
  return null;
}
function HomeComputerProbe() {
  const state = useAgentDetailView(SETUP_AGENT_ID, { accountId: SETUP_USER_ID });
  return <output>{state.kind === "ready" ? (state.value.computer?.computerId ?? "no computer") : state.kind}</output>;
}

afterEach(() => vi.restoreAllMocks());

it("binding a Computer in setup makes the next home view read the updated Agent binding", async () => {
  let bound = false;
  const waiting = createMemorySetupAdapter({ agent: setupAgent({ computer: null }) });
  const connected = createMemorySetupAdapter({ agent: setupAgent() });
  vi.spyOn(browserApi, "agentSetup").mockImplementation((id) => (bound ? connected : waiting).adapter.readSnapshot(id));
  vi.spyOn(browserApi, "computers").mockImplementation(async () => ({
    computers: [
      {
        computerId: SETUP_COMPUTER_ID,
        displayName: "Review Mac",
        platform: "darwin",
        connectionStatus: "online",
        providerReadiness: [{ provider: "codex", status: "ready", observedAt: SETUP_NOW }],
        connectedAt: SETUP_NOW,
        lastSeenAt: SETUP_NOW,
        observedAt: SETUP_NOW,
        createdAt: SETUP_NOW,
        agentIds: bound ? [SETUP_AGENT_ID] : [],
      },
    ],
  }));
  const bind = vi.spyOn(browserApi, "rebindAgentComputer").mockImplementation(async () => {
    bound = true;
    return {} as never;
  });
  vi.spyOn(browserApi, "refreshAgentSetup").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
  const list = () => ({
    agents: [
      {
        ...setupAgent(bound ? {} : { computer: null }),
        activity: { state: "idle" as const },
        usage: { windowDays: 30 as const, tasks: 0, failed: 0, tokens: 0 },
      },
    ],
  });
  vi.spyOn(browserApi, "agents").mockImplementation(async () => list());
  const view = await renderInRouter(<Capture />);
  client.setQueryData(queryKeys.agents.list(SETUP_USER_ID), list());
  view.rerender(
    <>
      <Capture />
      <AgentSetupPage agentId={SETUP_AGENT_ID} />
    </>,
  );
  await waitFor(() => expect(bind).toHaveBeenCalledWith(SETUP_AGENT_ID, SETUP_COMPUTER_ID));
  await waitFor(() => expect(vi.mocked(browserApi.agentSetup).mock.calls.length).toBeGreaterThanOrEqual(2));
  view.rerender(
    <>
      <Capture />
      <HomeComputerProbe />
    </>,
  );
  expect(await screen.findByText(SETUP_COMPUTER_ID)).toBeTruthy();
});
