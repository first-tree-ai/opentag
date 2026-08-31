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
  return storedRecords().map((record) => record.creationIntentId);
}

function storedRecords(): { creationIntentId: string; supersededAt?: string }[] {
  const raw = window.localStorage.getItem(intentKey);
  if (!raw) return [];
  return (JSON.parse(raw) as { records: { creationIntentId: string; supersededAt?: string }[] }).records;
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
    vi.useRealTimers();
  });

  it("removes no record when a creation succeeds, whoever wrote it", async () => {
    // The invariant both concurrency reports come down to: a success may mark records spent, but it
    // may not take one away. Whether the other record belongs to another tab, to a request still in
    // flight, or to a page that has been waiting for an hour, it is somebody's idempotency key.
    //
    // Two real tabs cannot be reproduced here — `createAgentOnce` memoises per key within one
    // module, so a second form in this process joins the first request instead of making its own.
    // Asserting the invariant covers those cases without pretending to stage them.
    window.localStorage.setItem(
      intentKey,
      JSON.stringify({
        version: 3,
        accountId,
        records: [
          {
            version: 3,
            accountId,
            creationIntentId: "7982bd97-1b0a-4c6f-8d2e-3f4a5b6c7d80",
            request: { name: "other-tab", displayName: "Other Tab", runtimeProvider: "codex", computerId },
          },
        ],
      }),
    );
    vi.spyOn(browserApi, "createAgent").mockResolvedValue({ id: computerId } as never);

    const form = render(
      <AgentCreationFlow accountId={accountId} facts={otherFacts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(form.container, "Mine");
    });

    await waitFor(() => expect(storedRecords().every((record) => record.supersededAt !== undefined)).toBe(true));
    expect(storedIntentIds()).toContain("7982bd97-1b0a-4c6f-8d2e-3f4a5b6c7d80");
  });

  it("keeps a key whose request is still in flight however long it has been waiting", async () => {
    // Elapsed time never proves a page stopped waiting, so nothing about this record's age may
    // remove it. Only a mark that is a day old is collected, and this one was marked just now.
    const requests: (string | undefined)[] = [];
    let releaseFirst: ((reason: unknown) => void) | undefined;
    const firstSettled = new Promise<never>((_, reject) => {
      releaseFirst = reject;
    });
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (request) => {
      requests.push(request.creationIntentId);
      if (requests.length === 1) await firstSettled;
      return { id: computerId } as never;
    });

    const first = render(
      <AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(first.container, "Patient Agent");
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    const key = requests[0];

    // Six minutes pass with the request still outstanding — long past any deadline a claim on
    // elapsed time would have set.
    vi.setSystemTime(new Date(Date.now() + 6 * 60_000));
    const second = render(
      <AgentCreationFlow accountId={accountId} facts={otherFacts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(second.container, "Other Agent");
    });
    await waitFor(() => expect(requests).toHaveLength(2));

    expect(storedIntentIds()).toContain(key);
    releaseFirst?.(new Error("Connection lost after creation"));
    await waitFor(() => expect(within(first.container).queryByRole("button", { name: "Create Agent" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(first.container).getByRole("button", { name: "Create Agent" }));
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toBe(key);
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

    // B succeeded, so the records are marked spent. A is still waiting, and its key is still there.
    await waitFor(() => expect(storedRecords().every((record) => record.supersededAt !== undefined)).toBe(true));
    expect(storedIntentIds()).toContain(firstIntentId);

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

    // The first form succeeded, so every record is spent — but spent is marked, not deleted. The
    // other form is still waiting on its own key, and that key has to still be there.
    await waitFor(() => expect(storedRecords().every((record) => record.supersededAt !== undefined)).toBe(true));
    expect(storedIntentIds()).toContain(secondIntentId);

    // So the lost response retries under the original key rather than as a fresh creation.
    failSecond = false;
    await act(async () => {
      fireEvent.click(within(second.container).getByRole("button", { name: "Create Agent" }));
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]?.creationIntentId).toBe(secondIntentId);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});
