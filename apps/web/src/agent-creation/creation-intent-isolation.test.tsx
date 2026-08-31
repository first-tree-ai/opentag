import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { type AgentCreationFacts, AgentCreationFlow } from "./agent-creation-flow.js";

const accountId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const intentKey = `opentag.agent-creation.intent:${accountId}`;

const secondComputerId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";

function factsFor(id: string, displayName: string): AgentCreationFacts {
  return {
    computers: [{ id, displayName, connectionStatus: "online" }],
    providers: [{ computerId: id, provider: "codex", runtimeReady: true, status: "ready" }],
    runtimeEvidenceAvailable: true,
  };
}

const facts = factsFor(computerId, "Ada's Mac");
/** A second page looking at a different Computer, so it cannot auto-resume the first page's route. */
const otherFacts = factsFor(secondComputerId, "Zulu Tower");

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

  it("publishes a record already claimed, never briefly unclaimed", async () => {
    // Ownership at mount is decided by the claim, so a record must never be readable in storage
    // without one. Appending first and claiming afterwards left a window — measured at 0.2 ms in a
    // real browser — where a form mounting inside it would take ownership of a live key.
    const writes: { id: string; claimed: boolean }[][] = [];
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => {
      if (key === intentKey) {
        writes.push(
          (JSON.parse(value) as { records: { creationIntentId: string; claimedAt?: string }[] }).records.map(
            (record) => ({ id: record.creationIntentId, claimed: record.claimedAt !== undefined }),
          ),
        );
      }
      realSetItem(key, value);
    });
    vi.spyOn(browserApi, "createAgent").mockResolvedValue({ id: computerId } as never);

    const form = render(
      <AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(form.container, "First Agent");
    });

    const appearances = writes.filter((records) => records.length > 0);
    expect(appearances.length).toBeGreaterThan(0);
    // Every write that carries the record carries its claim; there is no unclaimed publication.
    for (const records of appearances) {
      expect(records.every((record) => record.claimed)).toBe(true);
    }
    setItem.mockRestore();
  });

  it("keeps an earlier page's in-flight intent when a later page mounts on top of it", async () => {
    // The ordering that matters: page A persists its record and is still waiting when page B
    // mounts, so B loads A's record as its own pendingIntent. B must not read a key someone is
    // waiting on as an abandoned record it may retire.
    //
    // B is given a different Computer deliberately. Two real tabs see the same facts, and in that
    // shape B simply auto-resumes A's record and the Server deduplicates on the shared
    // creationIntentId — safe, but safe because of server idempotency rather than the claim. This
    // is the only shape where the claim is what carries the guarantee, which is why it is the
    // regression worth having.
    const requests: { creationIntentId: string | undefined; displayName: string }[] = [];
    let releaseFirst: ((value: never) => void) | undefined;
    let failFirst = true;
    const firstSettled = new Promise<never>((_, reject) => {
      releaseFirst = reject as (value: never) => void;
    });
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (request) => {
      requests.push({ creationIntentId: request.creationIntentId, displayName: request.displayName });
      if (request.displayName === "First Agent" && failFirst) await firstSettled;
      return { id: computerId } as never;
    });

    const first = render(
      <AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(first.container, "First Agent");
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    const firstIntentId = requests[0]?.creationIntentId;
    expect(storedIntentIds()).toEqual([firstIntentId]);

    // B mounts only now, so A's record is the only thing in storage for it to load.
    const second = render(
      <AgentCreationFlow accountId={accountId} facts={otherFacts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(second.container, "Second Agent");
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    // B succeeded and retired its own record. A is still waiting, and its key is still there.
    await waitFor(() => expect(storedIntentIds()).toEqual([firstIntentId]));

    // A's response was lost after the Server committed it; the retry must carry the original key.
    failFirst = false;
    releaseFirst?.(new Error("Connection lost after creation") as never);
    // The button reads "Creating…" while the request is in flight; wait for the failure to land
    // before retrying, or the click goes to a form that is still submitting.
    await waitFor(() => expect(within(first.container).queryByRole("alert")).toBeTruthy());
    await waitFor(() => expect(within(first.container).queryByRole("button", { name: "Create Agent" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(first.container).getByRole("button", { name: "Create Agent" }));
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.creationIntentId).toBe(firstIntentId);
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
