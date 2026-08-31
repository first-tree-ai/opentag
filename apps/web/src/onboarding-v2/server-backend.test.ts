/**
 * The Server-backed half of the onboarding seam, driven through stubbed `browserApi` calls.
 *
 * Which Computer a run adopts is the Server's own verdict — the issued code's status read, which
 * says pending until a machine redeems it and then names the exact Computer that did. The
 * interesting behaviour is all in what the hook refuses to conclude from anything else: a Computers
 * list full of arrivals, a verdict meant for a superseded code, or a redeemed machine that has not
 * actually connected yet. Those are the cases here.
 */

import type {
  AgentAdminConfig,
  AgentListItem,
  ComputerConnectCodeStatus,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import type { AgentDraft, Runtime } from "./flow.js";
import { useServerBackend } from "./server-backend.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const OTHER_COMPUTER_ID = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REPLACEMENT_CODE_ID = "8b2d0f63-0b9c-4d8e-9f2a-3b4c5d6e7f8a";
/** The Server's redemption time; every connected fixture connects after it. */
const REDEEMED_AT = "2026-08-29T00:00:05.000Z";

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

/** The Agent a resumed run finds, bound to a Computer that has since gone silent. */
function existingAgent(): AgentListItem {
  return {
    id: AGENT_ID,
    name: "opentag",
    displayName: "opentag",
    createdBy: { userId: USER_ID, displayName: "Ada" },
    computer: { computerId: COMPUTER_ID, displayName: "Ada's Mac", platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    activity: { state: "idle" },
    usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * Each entry answers one `computers()` call, in order; the last entry answers every call after it.
 * The first call is the redemption-confirmed read — the hook no longer takes a baseline, because it
 * never infers an arrival from this list.
 */
function computersReturning(...pages: readonly (readonly WorkspaceComputerSummary[])[]) {
  let call = 0;
  return vi.spyOn(browserApi, "computers").mockImplementation(async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? [];
    call += 1;
    return { computers: [...page] };
  });
}

function issuing(
  overrides: Partial<{ connectCodeId: string; bootstrapCommand: string; expiresIn: number; issuedAt: string }> = {},
) {
  return vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
    connectCodeId: CONNECT_CODE_ID,
    bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh' -- connect ABC",
    expiresIn: EXPIRES_IN_S,
    issuedAt: NOW,
    ...overrides,
  });
}

/** The Server's verdict on the issued code. Pending until a test says otherwise. */
function verdict(
  overrides: { connectCodeId?: string; state?: "pending" | "expired" | "revoked" } = {},
): ComputerConnectCodeStatus {
  return {
    connectCodeId: overrides.connectCodeId ?? CONNECT_CODE_ID,
    state: overrides.state ?? "pending",
    computerId: null,
    redeemedAt: null,
  };
}

function redeemed(computerId: string = COMPUTER_ID, redeemedAt: string = REDEEMED_AT): ComputerConnectCodeStatus {
  return { connectCodeId: CONNECT_CODE_ID, state: "redeemed", computerId, redeemedAt };
}

/**
 * Each entry answers one `computerConnectCodeStatus()` call, in order; the last entry answers every
 * call after it. With no entries the code stays pending forever.
 */
function verdictsReturning(...pages: readonly ComputerConnectCodeStatus[]) {
  let call = 0;
  return vi.spyOn(browserApi, "computerConnectCodeStatus").mockImplementation(async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? verdict();
    call += 1;
    return page;
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
    // The flow now reads what the Account already has before it renders, so a fresh Account has to
    // be stated: no Agents, and therefore no messaging binding.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    // A code the test says nothing about stays pending: the wait never concludes without a verdict.
    verdictsReturning();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("issuing the code", () => {
    it("issues the code without consulting the Computers list", async () => {
      const order: string[] = [];
      vi.spyOn(browserApi, "computers").mockImplementation(async () => {
        order.push("computers");
        return { computers: [] };
      });
      vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => {
        order.push("issue");
        return {
          connectCodeId: CONNECT_CODE_ID,
          bootstrapCommand: "sh install",
          expiresIn: EXPIRES_IN_S,
          issuedAt: NOW,
        };
      });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();

      // No baseline, in either order: the Computers list is not evidence of which machine answered.
      expect(order).toEqual(["issue"]);
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

    it("issues one code per visit even where React double-invokes the step effect", async () => {
      // The issue request starts from a plain call that marks the connection ref synchronously.
      // StrictMode is the cheapest place a second run would show up as a second POST.
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

  describe("the Server's redemption verdict", () => {
    it("keeps waiting while the code is pending, whatever the Computers list shows", async () => {
      // A Computer already enrolled, one enrolling mid-wait, one reconnecting: none of them is
      // evidence about this code, and none of them is read as this run's arrival.
      const foreign = computer({ computerId: OTHER_COMPUTER_ID, displayName: "Bob's Mac", ...ready() });
      computersReturning([foreign]);
      issuing();

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 3);

      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.readiness).toBeUndefined();
    });

    it("adopts the exact Computer the verdict names, once it connects", async () => {
      computersReturning([computer(ready())]);
      issuing();
      verdictsReturning(redeemed());

      const view = mount();
      await connected(view);

      expect(view.result.current.connect).toMatchObject({ kind: "connected", computerName: "Ada's Mac" });
      expect(view.result.current.readiness).toEqual({
        runtime: "ready",
        runtimeProvider: "codex",
        messagingCli: {},
      });
    });

    it("never selects an unrelated Computer that enrolls or reconnects during the wait", async () => {
      // The colleague case the list heuristic could not answer: Bob's machine shows up online while
      // this run's code is pending, and is still there when the verdict names Ada's.
      const bobs = computer({ computerId: OTHER_COMPUTER_ID, displayName: "Bob's Mac", ...ready() });
      computersReturning([bobs, computer(ready())]);
      issuing();
      verdictsReturning(verdict(), redeemed());

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("issued");

      await tick(POLL_MS);
      expect(view.result.current.connect).toMatchObject({ kind: "connected", computerName: "Ada's Mac" });
    });

    it("keeps waiting when the redeemed Computer has not connected yet", async () => {
      // Redemption is durable and immediate; reachability is neither. The verdict names the machine
      // the moment the code is spent, and the step waits for that exact machine — and no other —
      // to come online.
      const offline = computer({ ...ready(), connectionStatus: "offline", connectedAt: null, lastSeenAt: null });
      computersReturning([offline], [computer(ready())]);
      issuing();
      verdictsReturning(redeemed());

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("issued");

      await tick(POLL_MS);
      expect(view.result.current.connect).toMatchObject({ kind: "connected", computerName: "Ada's Mac" });
    });

    it("does not adopt the redeemed Computer on a connection that predates the redemption", async () => {
      // A repaired machine can still be showing its old connection while the exchange lands. The
      // connection that counts is the one the redemption bought.
      const stale = computer({ ...ready(), connectedAt: "2026-08-28T00:00:00.000Z" });
      computersReturning([stale], [computer(ready())]);
      issuing();
      verdictsReturning(redeemed());

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("issued");

      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("connected");
    });

    it("ends the wait when the Server reports the code expired, ahead of the local clock", async () => {
      computersReturning([]);
      issuing();
      verdictsReturning(verdict(), verdict({ state: "expired" }));

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("issued");

      await tick(POLL_MS);
      expect(view.result.current.connect).toMatchObject({ kind: "expired" });
    });

    it("ends the wait when the Server reports the code revoked, and never names a Computer", async () => {
      computersReturning([computer(ready())]);
      issuing();
      verdictsReturning(verdict({ state: "revoked" }));

      const view = mount();
      await connected(view);

      // Fail closed: a revoked code reads exactly like an expired one, and the machine that happens
      // to be online nearby is not adopted.
      expect(view.result.current.connect.kind).toBe("expired");
    });

    it("expires recoverably, command and Refresh intact, when the Server disowns the code", async () => {
      computersReturning([computer(ready())]);
      const issue = issuing();
      vi.spyOn(browserApi, "computerConnectCodeStatus").mockRejectedValue(
        new ApiError(404, "The requested resource was not found", "RESOURCE_NOT_FOUND", "deterministic"),
      );

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);

      // The raw 404 is never shown, no Computer is adopted, and the dead command keeps its Refresh.
      expect(view.result.current.connect).toEqual({
        kind: "expired",
        command: "sh -c 'curl -fsSL https://example.test/install.sh' -- connect ABC",
      });
      expect(view.result.current.error).toBeUndefined();
      expect(view.result.current.readiness).toBeUndefined();

      const second = deferred<ComputerConnectCodeStatus>();
      vi.mocked(browserApi.computerConnectCodeStatus).mockImplementation(() => second.promise);
      issue.mockResolvedValue({
        connectCodeId: REPLACEMENT_CODE_ID,
        bootstrapCommand: "sh install-2",
        expiresIn: EXPIRES_IN_S,
        issuedAt: new Date(Date.now()).toISOString(),
      });
      act(() => view.result.current.refreshConnectCode());
      await settle();

      // Refresh reissues and waits on the new code; nothing from the disowned one carries over.
      expect(issue).toHaveBeenCalledTimes(2);
      expect(view.result.current.connect).toMatchObject({ kind: "issued", command: "sh install-2" });
      await tick(POLL_MS);
      expect(browserApi.computerConnectCodeStatus).toHaveBeenCalledWith(REPLACEMENT_CODE_ID);
      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.readiness).toBeUndefined();
    });

    it("keeps waiting when the status read fails, and says so", async () => {
      computersReturning([]);
      issuing();
      vi.spyOn(browserApi, "computerConnectCodeStatus").mockRejectedValue(new Error("gateway timeout"));

      const view = mount();
      await connected(view);

      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.error).toBe("gateway timeout");
    });

    it("keeps waiting when the Computers read fails after redemption, and recovers", async () => {
      let call = 0;
      vi.spyOn(browserApi, "computers").mockImplementation(async () => {
        call += 1;
        if (call === 1) throw new Error("gateway timeout");
        return { computers: [computer(ready())] };
      });
      issuing();
      verdictsReturning(redeemed());

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.error).toBe("gateway timeout");

      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("connected");
      expect(view.result.current.error).toBeUndefined();
    });
  });

  describe("reading readiness", () => {
    it("reports checking, not a failure, while the Computer has reported nothing", async () => {
      computersReturning([computer()]);
      issuing();
      verdictsReturning(redeemed());

      const view = mount();
      await connected(view);

      expect(view.result.current.readiness).toEqual({
        runtime: "checking",
        runtimeProvider: "codex",
        messagingCli: {},
      });
    });

    it("reports checking when the chosen runtime has no observation of its own", async () => {
      computersReturning([computer(ready("codex"))]);
      issuing();
      verdictsReturning(redeemed());

      const view = mount(draft("claude-code"));
      await connected(view);

      expect(view.result.current.readiness?.runtime).toBe("checking");
    });

    it("reads the runtime the draft chose rather than the first one reported", async () => {
      computersReturning([
        computer({
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: NOW },
            { provider: "claude-code", status: "install", observedAt: NOW },
          ],
        }),
      ]);
      issuing();
      verdictsReturning(redeemed());

      const view = mount(draft("claude-code"));
      await connected(view);

      expect(view.result.current.readiness?.runtime).toBe("install");
    });

    it("keeps re-reading readiness after the Computer is connected, so a repair turns green", async () => {
      computersReturning(
        [computer({ providerReadiness: [{ provider: "codex", status: "sign-in", observedAt: NOW }] })],
        [computer(ready())],
      );
      issuing();
      verdictsReturning(redeemed());

      const view = mount();
      await connected(view);
      expect(view.result.current.readiness?.runtime).toBe("sign-in");

      await tick(POLL_MS);
      expect(view.result.current.readiness?.runtime).toBe("ready");
    });
  });

  describe("repairing the Agent's own Computer", () => {
    /** A resumed run whose Agent's Computer has gone silent: the step repairs that exact machine. */
    function resumingOntoDepartedComputer() {
      vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [existingAgent()] });
    }

    it("issues a repair code for the departed Computer and adopts it on the Server's verdict", async () => {
      resumingOntoDepartedComputer();
      verdictsReturning(redeemed());
      const departed = computer({ connectionStatus: "offline", connectedAt: null, lastSeenAt: null });
      computersReturning([departed], [computer(ready())]);
      const issue = issuing();

      const view = mount();
      await settle();
      expect(view.result.current.connect.kind).toBe("idle");

      act(() => view.result.current.issueConnectCode());
      await settle();
      expect(issue).toHaveBeenCalledWith({ mode: "repair", targetComputerId: COMPUTER_ID });

      await tick(POLL_MS);
      expect(view.result.current.connect).toMatchObject({ kind: "connected", computerName: "Ada's Mac" });
    });

    it("keeps waiting while the repair code is pending and another machine reconnects", async () => {
      resumingOntoDepartedComputer();
      const departed = computer({ connectionStatus: "offline", connectedAt: null, lastSeenAt: null });
      const foreign = computer({ computerId: OTHER_COMPUTER_ID, displayName: "Bob's Mac", ...ready() });
      computersReturning([departed], [departed, foreign]);
      issuing();
      verdictsReturning();

      const view = mount();
      await settle();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 2);

      expect(view.result.current.connect.kind).toBe("issued");
    });
  });

  describe("expiry", () => {
    it("expires the code on the Server's clock and keeps the command on screen", async () => {
      computersReturning([]);
      issuing({ expiresIn: 3 });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 3);

      expect(view.result.current.connect).toMatchObject({ kind: "expired" });
    });

    it("stops polling once the code has expired, so a later redemption cannot satisfy it", async () => {
      const verdicts = verdictsReturning();
      issuing({ expiresIn: 3 });

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 3);
      const afterExpiry = verdicts.mock.calls.length;
      await tick(POLL_MS * 4);

      expect(view.result.current.connect.kind).toBe("expired");
      expect(verdicts).toHaveBeenCalledTimes(afterExpiry);
    });

    it("replaces an expired code with a fresh one and starts waiting again", async () => {
      computersReturning([computer(ready())]);
      const issue = issuing({ expiresIn: 3 });
      const verdicts = verdictsReturning();

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS * 3);
      expect(view.result.current.connect.kind).toBe("expired");

      issue.mockResolvedValue({
        connectCodeId: REPLACEMENT_CODE_ID,
        bootstrapCommand: "sh install-2",
        expiresIn: EXPIRES_IN_S,
        issuedAt: new Date(Date.now()).toISOString(),
      });
      act(() => view.result.current.refreshConnectCode());
      await settle();
      expect(view.result.current.connect).toMatchObject({ kind: "issued", command: "sh install-2" });

      // The wait tracks the replacement code, not the expired one.
      verdicts.mockImplementation(async (connectCodeId: string) =>
        connectCodeId === REPLACEMENT_CODE_ID ? { ...redeemed(), connectCodeId } : verdict(),
      );
      await tick(POLL_MS);
      expect(view.result.current.connect.kind).toBe("connected");
    });
  });

  describe("superseded attempts", () => {
    it("discards a redemption verdict that was in flight for a superseded code", async () => {
      const stale = deferred<ComputerConnectCodeStatus>();
      let call = 0;
      vi.spyOn(browserApi, "computerConnectCodeStatus").mockImplementation(() => {
        call += 1;
        // 1 = the poll left in flight across the refresh, 2+ = the fresh code's polls.
        return call === 1 ? stale.promise : Promise.resolve(verdict());
      });
      computersReturning([computer(ready())]);
      issuing();

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);

      act(() => view.result.current.refreshConnectCode());
      await settle();
      await act(async () => {
        stale.resolve(redeemed());
        await Promise.resolve();
      });

      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.readiness).toBeUndefined();
    });

    it("discards a Computers reply that was in flight for a superseded code", async () => {
      const stale = deferred<{ computers: WorkspaceComputerSummary[] }>();
      vi.spyOn(browserApi, "computers").mockImplementation(() => stale.promise);
      issuing();
      verdictsReturning(redeemed());

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);

      act(() => view.result.current.refreshConnectCode());
      await settle();
      await act(async () => {
        stale.resolve({ computers: [computer(ready())] });
        await Promise.resolve();
      });

      // The in-flight read belonged to the old code's wait; the fresh code is still pending, so
      // nothing is adopted from it.
      expect(view.result.current.connect.kind).toBe("issued");
      expect(view.result.current.readiness).toBeUndefined();
    });

    it("stops polling once the hook is unmounted", async () => {
      const verdicts = verdictsReturning();
      issuing();

      const view = mount();
      act(() => view.result.current.issueConnectCode());
      await settle();
      await tick(POLL_MS);
      const before = verdicts.mock.calls.length;
      view.unmount();
      await tick(POLL_MS * 3);

      expect(verdicts).toHaveBeenCalledTimes(before);
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
      computersReturning([computer(ready("claude-code"))]);
      issuing();
      verdictsReturning(redeemed());
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
      expect(view.result.current.agent).toEqual({ id: AGENT_ID, name: "opentag", runtimeProvider: "codex" });
    });

    it("returns to a pressable state after a failed creation, and the retry succeeds", async () => {
      computersReturning([computer(ready())]);
      issuing();
      verdictsReturning(redeemed());
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
      computersReturning([computer(ready())]);
      issuing();
      verdictsReturning(redeemed());
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
      computersReturning([computer(ready())]);
      issuing();
      verdictsReturning(redeemed());
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
      computersReturning([computer(ready())]);
      issuing();
      verdictsReturning(redeemed());
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
