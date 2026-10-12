import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { AgentSetupPage } from "./agent-setup-page.js";
import { SETUP_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

afterEach(() => vi.restoreAllMocks());

it("offers a custom Slack App in the creation guide even without OAuth setup actions", async () => {
  const memory = createMemorySetupAdapter({ agent: setupAgent() });
  const oauth = vi.spyOn(memory.adapter, "startSlackInstall");
  const openAgent = vi.fn();
  const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
  const readSnapshot = vi.fn().mockResolvedValue({
    ...snapshot,
    actions: snapshot.actions.filter((action) => action.kind !== "start-messaging"),
  });
  vi.spyOn(browserApi, "slackConfiguration").mockResolvedValue({
    agentDisplayName: "Reviewer",
    eventsUrl: `https://qa.example/api/v1/agents/${SETUP_AGENT_ID}/im-binding/slack/events`,
    allowedIntent: "create",
    blockedReason: null,
    expectedMessaging: { kind: "unbound" },
    preferredRecovery: "credentials",
    binding: null,
    identityClosure: null,
    handoff: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <AgentSetupPage agentId={SETUP_AGENT_ID} adapter={{ ...memory.adapter, readSnapshot }} onOpenAgent={openAgent} />
    </QueryClientProvider>,
  );
  try {
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use your own Slack App" }));
    expect(await screen.findByRole("link", { name: "Create App in Slack" })).toBeTruthy();
    expect(screen.getByLabelText("Signing Secret")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    expect(openAgent).toHaveBeenCalledTimes(1);
    expect(oauth).not.toHaveBeenCalled();
  } finally {
    result.unmount();
    client.clear();
  }
});
