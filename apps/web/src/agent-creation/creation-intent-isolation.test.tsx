import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { type AgentCreationFacts, AgentCreationFlow } from "./agent-creation-flow.js";

const accountId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const intentKey = `opentag.agent-creation.intent:${accountId}`;

const facts: AgentCreationFacts = {
  computers: [{ id: computerId, displayName: "Ada's Mac", connectionStatus: "online" }],
  providers: [{ computerId, provider: "codex", runtimeReady: true, status: "ready" }],
  runtimeEvidenceAvailable: true,
};

function storedIntentIds(): string[] {
  const raw = window.localStorage.getItem(intentKey);
  if (!raw) return [];
  return (JSON.parse(raw) as { records: { creationIntentId: string }[] }).records.map(
    (record) => record.creationIntentId,
  );
}

/** Fills one mounted form and submits it, without touching the other. */
function submit(form: HTMLElement, displayName: string): void {
  fireEvent.change(within(form).getByLabelText("Display name"), { target: { value: displayName } });
  fireEvent.click(within(form).getByRole("button", { name: "Create Agent" }));
}

describe("creation intents across concurrent forms", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps another form's in-flight intent when this one succeeds, so its retry stays idempotent", async () => {
    const requests: { creationIntentId: string | undefined; displayName: string }[] = [];
    let failSecond = true;
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (request) => {
      requests.push({ creationIntentId: request.creationIntentId, displayName: request.displayName });
      // The second Agent's response is lost after the Server committed it — the case the
      // creationIntentId exists to survive.
      if (request.displayName === "Second Agent" && failSecond) throw new Error("Connection lost after creation");
      return { id: computerId } as never;
    });

    const first = render(
      <AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    const second = render(
      <AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />,
    );

    // Both records exist before either resolves, which is what makes them concurrent controllers
    // rather than one form editing its own request.
    await act(async () => {
      submit(second.container, "Second Agent");
    });
    await act(async () => {
      submit(first.container, "First Agent");
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    const secondIntentId = requests.find((request) => request.displayName === "Second Agent")?.creationIntentId;
    expect(secondIntentId).toBeTruthy();

    // The first form succeeded and retired its own record. The other form's key is not its to erase.
    await waitFor(() => expect(storedIntentIds()).toEqual([secondIntentId]));

    // So the lost response retries under the original key rather than as a fresh creation.
    failSecond = false;
    await act(async () => {
      fireEvent.click(within(second.container).getByRole("button", { name: "Create Agent" }));
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.creationIntentId).toBe(secondIntentId);
    await waitFor(() => expect(window.localStorage.getItem(intentKey)).toBeNull());
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});
