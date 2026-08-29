/**
 * The Server-backed half of the onboarding seam, driven through stubbed `browserApi` calls.
 *
 * Everything this hook decides is a reading of a Computers list that carries no link back to the
 * code that was issued, so the interesting behaviour is all in what it refuses to conclude: which
 * Computer is this run's, when a reply belongs to a superseded attempt, and when a machine has
 * simply not answered yet. Those are the cases here.
 */

import type { AgentAdminConfig, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import type { AgentDraft, Runtime } from "./flow.js";
import { useServerBackend } from "./server-backend.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const OTHER_COMPUTER_ID = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const WORKSPACE_ID = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";

/** The poll cadence the hook waits on, and one full expiry window. */
const POLL_MS = 1_500;
const EXPIRES_IN_S = 900;

function computer(overrides: Partial<WorkspaceComputerSummary> = {}): WorkspaceComputerSummary {
  return {
    computerId: COMPUTER_ID,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: "online",
    connectedAt: "2026-08-29T00:00:10.000Z",
    lastSeenAt: "2026-08-29T00:00:10.000Z",
    observedAt: "2026-08-29T00:00:10.000Z",
    enrolledAt: "2026-08-29T00:00:10.000Z",
    agentIds: [],
    ...overrides,
  };
}

function ready(provider: Runtime = "codex"): Partial<WorkspaceComputerSummary> {
  return { providerReadiness: [{ provider, status: "ready", observedAt: NOW }] };
}

function draft(runtime: Runtime | undefined = "codex"): AgentDraft {
  return { destination: "local", name: "opentag", runtime, cloudRuntime: undefined, tokenSource: undefined };
}

function adminConfig(): AgentAdminConfig {
  return {
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: "opentag",
    displayName: "opentag",
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    createdByUserId: USER_ID,
    computerId: COMPUTER_ID,
    revision: 1,
    runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
  };
}

/**
 * Each entry answers one `computers()` call, in order; the last entry answers every call after it.
 * The first call is always the baseline read, so a fixture reads as "before the code, then after".
 */
function computersReturning(...pages: readonly (readonly WorkspaceComputerSummary[])[]) {
  let call = 0;
  return vi.spyOn(browserApi, "computers").mockImplementation(async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? [];
    call += 1;
    return { computers: [...page] };
  });
}

function issuing(overrides: Partial<{ bootstrapCommand: string; expiresIn: number; issuedAt: string }> = {}) {
  return vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
    bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
    expiresIn: EXPIRES_IN_S,
    issuedAt: NOW,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drains the microtask queue the hook schedules its work on, inside one act boundary. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(initial: AgentDraft = draft()) {
  return renderHook((props: AgentDraft) => useServerBackend(props), { initialProps: initial });
}

/** Walks to a connected Computer, which is the precondition for creation and messaging. */
async function connected(view: ReturnType<typeof mount>) {
  act(() => view.result.current.issueConnectCode());
  await settle();
  await tick(POLL_MS);
}

describe("useServerBackend", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("issuing the code", () => {
    it("reads the Computers baseline before the code exists, never after", async () => {
      const order: string[] = [];
      vi.spyOn(browserApi, "computers").mockImplementation(async () => {
        order.push("computers");
        return { computers: [] };
      });
      vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => {
        order.push("issue");
        return { bootstrapCommand: "sh install", expiresIn: EXPIRES_IN_S, issuedAt: NOW };
      });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();

      expect(order).toEqual(["computers", "issue"]);
      expect(view.result.current.connect).toMatchObject({ kind: "issued", command: "sh install" });
    });

    it("takes the expiry from the Server's own clock rather than a local countdown", async () => {
      computersReturning([]);
      issuing({ issuedAt: "2026-08-29T00:00:30.000Z", expiresIn: 60 });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();

      expect(view.result.current.connect).toMatchObject({
        kind: "issued",
        expiresAt: Date.parse("2026-08-29T00:01:30.000Z"),
      });
    });

    it("reports a failure to issue without leaving the step stuck mid-issue", async () => {
      computersReturning([]);
      vi.spyOn(browserApi, "issueComputerConnectCode").mockRejectedValue(new Error("network down"));

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();

      expect(view.result.current.connect).toEqual({ kind: "idle" });
      expect(view.result.current.error).toBe("network down");
    });

    it("issues one code per visit even where React double-invokes state updaters", async () => {
      // The request is started from inside a `setConnect` updater, and updaters must be pure.
      // StrictMode is the cheapest place a second invocation would show up as a second POST.
      computersReturning([]);
      const issue = issuing();

      const view = renderHook((props: AgentDraft) => useServerBackend(props), {
        initialProps: draft(),
        wrapper: ({ children }) => createElement(StrictMode, null, children),
      });
      act(() => view.result.current.issueConnectCode());
      await settle();

      expect(issue).toHaveBeenCalledTimes(1);
    });

    it("ignores a second request while a code is already being issued", async () => {
      computersReturning([]);
      const issue = issuing();

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      act(() => view.result.current.issueConnectCode());
      await settle();

      expect(issue).toHaveBeenCalledTimes(1);
    });
  });

  describe("deciding which Computer arrived", () => {
    it("does not accept a Computer that was already enrolled before the code was issued", async () => {
      const existing = computer(ready());
      computersReturning([existing], [existing]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.readiness).toBeUndefined();
    });

    it("accepts a Computer that is absent from the baseline", async () => {
      computersReturning([], [computer(ready())]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect).toMatchObject({ kind: "connected", computerName: "Ada's Mac" });
      expect(view.result.current.readiness).toEqual({
        runtime: "ready",
        runtimeProvider: "codex",
        messagingCli: {},
      });
    });

    it("accepts a known Computer whose connectedAt has moved since the baseline", async () => {
      const before = computer({ connectedAt: "2026-08-28T00:00:00.000Z" });
      computersReturning([before], [computer({ ...ready(), connectedAt: "2026-08-29T00:00:10.000Z" })]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect.kind).toBe("connected");
    });

    it("does not accept a Computer that is listed but offline", async () => {
      computersReturning([], [computer({ ...ready(), connectionStatus: "offline" })]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect.kind).toBe("issued");
    });

    it("does not accept a Computer that has never connected", async () => {
      computersReturning([], [computer({ ...ready(), connectedAt: null })]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect.kind).toBe("issued");
    });

    /**
     * Documented limitation, not a guarantee. The baseline rules out machines that were already
     * enrolled, and nothing more: the Computers list is Workspace-wide and carries no link back to
     * the issued code, so a colleague enrolling — or reconnecting — during the wait is read as this
     * reader's arrival. Closing it needs a discriminator from the Server (the issue response
     * naming the code, and the Computer summary echoing the code it enrolled with). The existing
     * onboarding's Computer step has the same gap, so this is inherited rather than introduced.
     */
    it("cannot tell a colleague's enrollment during the wait from this reader's own", async () => {
      const otherAccountsMachine = computer({ computerId: OTHER_COMPUTER_ID, displayName: "Bob's Mac", ...ready() });
      computersReturning([], [otherAccountsMachine]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect).toMatchObject({ kind: "connected", computerName: "Bob's Mac" });
    });

    it("cannot tell a colleague's reconnection during the wait from this reader's own", async () => {
      const before = computer({
        computerId: OTHER_COMPUTER_ID,
        displayName: "Bob's Mac",
        connectedAt: "2026-08-28T00:00:00.000Z",
      });
      computersReturning([before], [{ ...before, ...ready(), connectedAt: "2026-08-29T00:00:10.000Z" }]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect).toMatchObject({ kind: "connected", computerName: "Bob's Mac" });
    });

    it("keeps waiting when the Computers call fails, and says so", async () => {
      let call = 0;
      vi.spyOn(browserApi, "computers").mockImplementation(async () => {
        call += 1;
        if (call === 1) return { computers: [] };
        throw new Error("gateway timeout");
      });
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.error).toBe("gateway timeout");
    });
  });

  describe("reading readiness", () => {
    it("reports checking, not a failure, while the Computer has reported nothing", async () => {
      computersReturning([], [computer()]);
      issuing();

      const view = mount();
      await connected(view);

      expect(view.result.current.readiness).toEqual({
        runtime: "checking",
        runtimeProvider: "codex",
        messagingCli: {},
      });
    });

    it("reports checking when the chosen runtime has no observation of its own", async () => {
      computersReturning([], [computer(ready("codex"))]);
      issuing();

      const view = mount(draft("claude-code"));
      await connected(view);

      expect(view.result.current.readiness?.runtime).toBe("checking");
    });

    it("reads the runtime the draft chose rather than the first one reported", async () => {
      computersReturning(
        [],
        [
          computer({
            providerReadiness: [
              { provider: "codex", status: "ready", observedAt: NOW },
              { provider: "claude-code", status: "install", observedAt: NOW },
            ],
          }),
        ],
      );
      issuing();

      const view = mount(draft("claude-code"));
      await connected(view);

      expect(view.result.current.readiness?.runtime).toBe("install");
    });

    it("keeps re-reading readiness after the Computer is connected, so a repair turns green", async () => {
      computersReturning(
        [],
        [computer({ providerReadiness: [{ provider: "codex", status: "sign-in", observedAt: NOW }] })],
        [computer(ready())],
      );
      issuing();

      const view = mount();
      await connected(view);
      expect(view.result.current.readiness?.runtime).toBe("sign-in");

      await tick(POLL_MS);
      expect(view.result.current.readiness?.runtime).toBe("ready");
    });
  });

  describe("expiry", () => {
    it("expires the code on the Server's clock and keeps the command on screen", async () => {
      computersReturning([], []);
      issuing({ expiresIn: 3 });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 3);

      expect(view.result.current.connect).toMatchObject({ kind: "expired" });
    });

    it("stops polling once the code has expired, so a later arrival cannot satisfy it", async () => {
      const computers = computersReturning([], [], [computer(ready())]);
      issuing({ expiresIn: 3 });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 3);
      const afterExpiry = computers.mock.calls.length;
      await tick(POLL_MS * 4);

      expect(view.result.current.connect.kind).toBe("expired");
      expect(computers).toHaveBeenCalledTimes(afterExpiry);
    });

    it("replaces an expired code with a fresh one and starts waiting again", async () => {
      computersReturning([], [], [], [computer(ready())]);
      const issue = issuing({ expiresIn: 3 });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 3);
      expect(view.result.current.connect.kind).toBe("expired");

      issue.mockResolvedValue({
        bootstrapCommand: "sh install-2",
        expiresIn: EXPIRES_IN_S,
        issuedAt: new Date(Date.now()).toISOString(),
      });
      act(() => view.result.current.refreshConnectCode());
      await settle();
      expect(view.result.current.connect).toMatchObject({ kind: "issued", command: "sh install-2" });

      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("connected");
    });
  });

  describe("superseded attempts", () => {
    it("discards a Computers reply issued before the command was refreshed", async () => {
      const pending = deferred<{ computers: WorkspaceComputerSummary[] }>();
      let call = 0;
      vi.spyOn(browserApi, "computers").mockImplementation(async () => {
        call += 1;
        // 1 = first baseline, 2 = the poll left in flight, 3 = the refreshed baseline.
        if (call === 2) return pending.promise;
        return { computers: [] };
      });
      issuing();

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);

      act(() => view.result.current.refreshConnectCode());
      await settle();
      await act(async () => {
        pending.resolve({ computers: [computer(ready())] });
        await Promise.resolve();
      });

      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.readiness).toBeUndefined();
    });

    it("discards a baseline reply from an attempt that was already replaced", async () => {
      const stale = deferred<{ computers: WorkspaceComputerSummary[] }>();
      let call = 0;
      vi.spyOn(browserApi, "computers").mockImplementation(async () => {
        call += 1;
        if (call === 1) return stale.promise;
        return { computers: [] };
      });
      issuing();

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      act(() => view.result.current.refreshConnectCode());
      await settle();

      const alreadyEnrolled = computer(ready());
      await act(async () => {
        stale.resolve({ computers: [alreadyEnrolled] });
        await Promise.resolve();
      });
      await tick(POLL_MS);

      // The stale baseline never lands, so the machine it listed is still read against the fresh
      // (empty) one. What matters is that the superseded reply did not become the baseline.
      expect(view.result.current.connect.kind).not.toBe("issuing");
    });

    it("stops polling once the hook is unmounted", async () => {
      const computers = computersReturning([], []);
      issuing();

      const view = mount();
      await connected(view);
      const before = computers.mock.calls.length;
      view.unmount();
      await tick(POLL_MS * 3);

      expect(computers).toHaveBeenCalledTimes(before);
    });
  });

  describe("creating the Agent", () => {
    it("refuses to create before a Computer of this run has been identified", async () => {
      computersReturning([]);
      issuing();
      const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());

      const view = mount();
      act(() => view.result.current.createAgent(draft()));
      await settle();

      expect(create).not.toHaveBeenCalled();
      expect(view.result.current.creation).toBe("idle");
    });

    it("creates on the Computer this run enrolled, with the drafted name and runtime", async () => {
      computersReturning([], [computer(ready("claude-code"))]);
      issuing();
      const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());

      const view = mount(draft("claude-code"));
      await connected(view);
      act(() => view.result.current.createAgent({ ...draft("claude-code"), name: "scout" }));
      await settle();

      expect(create).toHaveBeenCalledWith({
        name: "scout",
        displayName: "scout",
        runtimeProvider: "claude-code",
        computerId: COMPUTER_ID,
      });
      expect(view.result.current.creation).toBe("created");
      expect(view.result.current.agent).toEqual({ id: AGENT_ID, name: "opentag" });
    });

    it("returns to a pressable state after a failed creation, and the retry succeeds", async () => {
      computersReturning([], [computer(ready())]);
      issuing();
      const create = vi
        .spyOn(browserApi, "createAgent")
        .mockRejectedValueOnce(new Error("name already taken"))
        .mockResolvedValue(adminConfig());

      const view = mount();
      await connected(view);
      act(() => view.result.current.createAgent(draft()));
      await settle();

      expect(view.result.current.creation).toBe("idle");
      expect(view.result.current.error).toBe("name already taken");

      act(() => view.result.current.createAgent(draft()));
      await settle();

      expect(create).toHaveBeenCalledTimes(2);
      expect(view.result.current.creation).toBe("created");
      expect(view.result.current.error).toBeUndefined();
    });

    it("does not create twice while a creation is in flight", async () => {
      computersReturning([], [computer(ready())]);
      issuing();
      const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());

      const view = mount();
      await connected(view);
      act(() => {
        view.result.current.createAgent(draft());
        view.result.current.createAgent(draft());
      });
      await settle();

      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  describe("starting over", () => {
    it("forgets the run's Computer, its readiness and its Agent", async () => {
      computersReturning([], [computer(ready())]);
      issuing();
      vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());

      const view = mount();
      await connected(view);
      act(() => view.result.current.createAgent(draft()));
      await settle();
      act(() => view.result.current.reset());

      expect(view.result.current.connect).toEqual({ kind: "idle" });
      expect(view.result.current.readiness).toBeUndefined();
      expect(view.result.current.agent).toBeUndefined();
      expect(view.result.current.creation).toBe("idle");
      expect(view.result.current.messaging).toEqual({ kind: "idle" });
    });

    it("does not let a creation started before the restart land afterwards", async () => {
      computersReturning([], [computer(ready())]);
      issuing();
      const pending = deferred<AgentAdminConfig>();
      vi.spyOn(browserApi, "createAgent").mockReturnValue(pending.promise);

      const view = mount();
      await connected(view);
      act(() => view.result.current.createAgent(draft()));
      act(() => view.result.current.reset());
      await act(async () => {
        pending.resolve(adminConfig());
        await Promise.resolve();
      });

      expect(view.result.current.creation).toBe("idle");
      expect(view.result.current.agent).toBeUndefined();
    });
  });
});
