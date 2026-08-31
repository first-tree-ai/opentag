import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
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

const contextKey = "opentag.agent-creation.context";
const thisContext = "5c4b3a29-1e0d-4f8a-9b7c-6d5e4f3a2b11";
const otherContext = "6d5c4b3a-2f1e-4a9b-8c7d-7e6f5a4b3c22";

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
    window.sessionStorage.clear();
    // Every form in this process shares one browsing context, as two forms in one tab would.
    window.sessionStorage.setItem(contextKey, thisContext);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not replay a spent key for a later request that merely looks the same", async () => {
    // A reader who creates an Agent and later submits the same display name, Computer and Runtime
    // produces an identical fingerprint. Matching a spent record by shape would replay its key, and
    // the Server would hand back the Agent that key already created while the form reported a new
    // one — a success the reader never got. The honest answer is the name conflict.
    const keys: (string | undefined)[] = [];
    const created: string[] = [];
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (request) => {
      keys.push(request.creationIntentId);
      if (created.includes(request.displayName)) {
        throw new ApiError(
          409,
          "An active Agent with this name already exists for this Account",
          "AGENT_NAME_CONFLICT",
        );
      }
      created.push(request.displayName);
      return { id: computerId } as never;
    });

    const first = render(
      <AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(first.container, "Same Name");
    });
    await waitFor(() => expect(keys).toHaveLength(1));
    cleanup();

    const onCreated = vi.fn();
    const second = render(
      <AgentCreationFlow accountId={accountId} facts={facts} onCreated={onCreated} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(second.container, "Same Name");
    });

    await waitFor(() => expect(keys).toHaveLength(2));
    // A fresh key, so the Server judges the request rather than recognising a spent one.
    expect(keys[1]).not.toBe(keys[0]);
    // And the reader is not told an Agent was created when none was.
    expect(onCreated).not.toHaveBeenCalled();
    expect(created).toEqual(["Same Name"]);
  });

  it("does not resume a live record another browsing context wrote", async () => {
    // The other half of context scoping: another tab's unfinished request is not this page's to
    // finish, however ready its route looks. Resuming it would send someone else's request from a
    // page that never made it.
    window.localStorage.setItem(
      intentKey,
      JSON.stringify({
        version: 3,
        accountId,
        records: [
          {
            version: 3,
            accountId,
            contextId: otherContext,
            creationIntentId: "4d5e6f70-8192-4a34-bc5d-6e7f80910213",
            request: { name: "theirs", displayName: "Theirs", runtimeProvider: "codex", computerId },
          },
        ],
      }),
    );
    const created = vi.spyOn(browserApi, "createAgent").mockResolvedValue({ id: computerId } as never);

    render(<AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(created).not.toHaveBeenCalled();
  });

  it("lets a reloaded page still resume its own key after another context created an Agent", async () => {
    // The transition the in-memory reference cannot cover: A's page goes away. What is left is
    // durable state, so a remounted A must find its own record and resume it — which it can only do
    // if the other context's success left that record unmarked.
    const key = "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
    window.sessionStorage.setItem(contextKey, otherContext);
    window.localStorage.setItem(
      intentKey,
      JSON.stringify({
        version: 3,
        accountId,
        records: [
          {
            version: 3,
            accountId,
            contextId: thisContext,
            creationIntentId: key,
            request: { name: "reloaded", displayName: "Reloaded", runtimeProvider: "codex", computerId },
          },
        ],
      }),
    );
    const keys: (string | undefined)[] = [];
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (request) => {
      keys.push(request.creationIntentId);
      return { id: computerId } as never;
    });

    // Another context creates a different Agent while A is away.
    const other = render(
      <AgentCreationFlow accountId={accountId} facts={otherFacts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(other.container, "Other Agent");
    });
    await waitFor(() => expect(keys).toHaveLength(1));
    cleanup();

    // A's tab comes back — same browsing context, fresh page — and finishes what it started.
    window.sessionStorage.setItem(contextKey, thisContext);
    render(<AgentCreationFlow accountId={accountId} facts={facts} onCreated={() => {}} onRefresh={() => {}} />);

    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(key);
  });

  it("keeps a foreign key however long it has been there, since nothing bounds the request", async () => {
    // Elapsed time never proves a request settled: the browser request has no timeout, abort or
    // lease. A record written long ago may still be the only key its page can retry under, so age
    // alone may not remove it.
    const key = "3c4d5e6f-7081-4923-ab4c-5d6e7f809102";
    window.localStorage.setItem(
      intentKey,
      JSON.stringify({
        version: 3,
        accountId,
        records: [
          {
            version: 3,
            accountId,
            contextId: otherContext,
            creationIntentId: key,
            request: { name: "ancient", displayName: "Ancient", runtimeProvider: "codex", computerId },
            supersededAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
          },
        ],
      }),
    );
    vi.spyOn(browserApi, "createAgent").mockResolvedValue({ id: computerId } as never);

    const form = render(
      <AgentCreationFlow accountId={accountId} facts={otherFacts} onCreated={() => {}} onRefresh={() => {}} />,
    );
    await act(async () => {
      submit(form.container, "Fresh");
    });

    await waitFor(() => expect(storedRecords().length).toBeGreaterThan(1));
    expect(storedIntentIds()).toContain(key);
  });

  it("neither removes nor marks a record another browsing context wrote", async () => {
    // What every concurrency report here came down to: a page cannot tell an abandoned record from
    // one a live page is still waiting on, so it must not decide about records it did not write.
    // Marking one is as harmful as deleting it — a marked record never resumes, so a reload of the
    // page that owns it can no longer finish its own request.
    //
    // Two real tabs cannot be reproduced in this process — `createAgentOnce` memoises per key
    // within one module — but the durable state a second tab leaves behind can be, and that is
    // what this form has to leave alone.
    window.localStorage.setItem(
      intentKey,
      JSON.stringify({
        version: 3,
        accountId,
        records: [
          {
            version: 3,
            accountId,
            contextId: otherContext,
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

    // This form's own record is spent. The other context's is neither removed nor marked: nothing
    // here can tell whether that page is still waiting on it, so nothing here decides.
    await waitFor(() => expect(storedRecords().length).toBeGreaterThan(1));
    const foreign = storedRecords().find(
      (record) => record.creationIntentId === "7982bd97-1b0a-4c6f-8d2e-3f4a5b6c7d80",
    );
    expect(foreign).toBeTruthy();
    expect(foreign?.supersededAt).toBeUndefined();
    expect(
      storedRecords()
        .filter((record) => record.creationIntentId !== foreign?.creationIntentId)
        .every((record) => record.supersededAt !== undefined),
    ).toBe(true);
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
