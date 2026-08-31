/**
 * A stand-in for the Server and the Computer daemon, so the flow can be built and tuned without
 * either. It models only what the pages actually observe — a connect code that expires, a Computer
 * that shows up, a readiness probe that resolves to a scenario's outcome, and a QR code that gets
 * scanned — and deliberately not the protocol underneath any of it.
 *
 * Three of those events are things the outside world does, not things the page does. They default
 * to waiting for an explicit nudge, so a state can be looked at for as long as it takes; the timed
 * modes exist for judging the flow at its real pace.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessagingCliStatus, RuntimeStatus } from "../setup/checks.js";
import type { CreatedAgent, OnboardingBackend, PlanSignIn } from "./backend.js";
import type { AgentDraft, ConnectState, CreationState, MessagingState, ReadinessFacts } from "./flow.js";

export interface MockScenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly runtime: Exclude<RuntimeStatus, "checking">;
  readonly messagingCli: Exclude<MessagingCliStatus, "checking">;
}

export const SCENARIOS: readonly MockScenario[] = [
  {
    id: "all-ready",
    title: "Everything ready",
    description: "The runtime and the Lark CLI are both installed and signed in.",
    runtime: "ready",
    messagingCli: "ready",
  },
  {
    id: "runtime-install",
    title: "Runtime not installed",
    description: "The chosen agent CLI is missing, so sign-in cannot be answered yet.",
    runtime: "install",
    messagingCli: "ready",
  },
  {
    id: "runtime-sign-in",
    title: "Runtime not signed in",
    description: "The CLI runs but has no credential.",
    runtime: "sign-in",
    messagingCli: "ready",
  },
  {
    id: "messaging-install",
    title: "Lark CLI missing",
    description: "The easiest failure to miss: the agent is perfect but nothing can be delivered.",
    runtime: "ready",
    messagingCli: "install",
  },
  {
    id: "both-failing",
    title: "Runtime and Lark CLI missing",
    description: "Two failures at once, to check the plural copy and the list rhythm.",
    runtime: "install",
    messagingCli: "install",
  },
];

export type MockSpeed = "manual" | "realistic" | "fast";
export const MOCK_SPEEDS: readonly MockSpeed[] = ["manual", "realistic", "fast"];

interface Timings {
  readonly issueMs: number;
  readonly codeTtlMs: number;
  /** `null` means the event waits to be advanced by hand rather than on a clock. */
  readonly connectMs: number | null;
  readonly probeMs: number | null;
  readonly repairMs: number | null;
  readonly scanMs: number | null;
}

const TIMINGS: Record<MockSpeed, Timings> = {
  manual: { issueMs: 300, codeTtlMs: 15 * 60 * 1_000, connectMs: null, probeMs: null, repairMs: null, scanMs: null },
  // The production connect code is valid for 15 minutes.
  realistic: {
    issueMs: 500,
    codeTtlMs: 15 * 60 * 1_000,
    connectMs: 8_000,
    probeMs: 2_500,
    repairMs: 4_000,
    scanMs: 6_000,
  },
  fast: { issueMs: 150, codeTtlMs: 25_000, connectMs: 2_000, probeMs: 800, repairMs: 1_200, scanMs: 1_500 },
};

const COMPUTER_NAME = "MacBook Pro";
const SERVER_URL = "https://opentag.ai";
const INSTALLER_URL = "https://download.opentag.build/releases/prod/install.sh";

/**
 * The portable installer rather than npm. `npm i -g open-tag` needs a working Node on the machine
 * before OpenTag can be installed at all, which is a prerequisite the first command of onboarding
 * cannot assume; the portable release carries its own runtime and verifies its own checksum.
 *
 * The shim lands in `~/.local/bin`, which the installer adds to future shells but not to the one
 * running this line, so the connect call names that directory explicitly.
 *
 * Note this deliberately differs from what the Server's `buildComputerConnectCommand` produces
 * today. The Server still emits the npm form; changing it is a separate change to real behaviour.
 */
function connectCommand(code: string): string {
  return [
    `curl -fsSL ${INSTALLER_URL} | sh`,
    `PATH="$HOME/.local/bin\${PATH:+:$PATH}" opentag computer connect --server ${SERVER_URL} -- ${code}`,
  ].join(" && ");
}

/**
 * A command of exactly the shape a real one has, for the moment before one has been issued. Built
 * from the same parts and the same code length, so the block it renders is the same height at any
 * width. That identity is what keeps the arrival of the real command from moving anything — there
 * is no reserved height doing the work, and none is needed.
 */
export const PLACEHOLDER_CONNECT_COMMAND = connectCommand("0".repeat(32));

/**
 * Matches the Server's connect code: `generateSecret(24)`, so 24 random bytes rendered base64url,
 * which is 32 characters. The exact shape matters here because it is what sets the length of the
 * command block the whole step is built around.
 */
function randomCode(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomId(): string {
  return randomCode().slice(0, 16);
}

/** The one thing the outside world could do next, for the control that stands in for it. */
export interface PendingEvent {
  readonly label: string;
  readonly run: () => void;
}

export type { PlanSignIn } from "./backend.js";

/** How long the mock pretends creating an Agent takes. */
const CREATE_AGENT_MS = 900;

export interface MockBackend extends OnboardingBackend {
  /** What is waiting to happen, if anything: the Computer arriving, the probe, or the scan. */
  readonly pending: PendingEvent | undefined;
  /** Lab controls — the page itself never offers these. */
  readonly expireNow: () => void;
  readonly repairNow: () => void;
}

export function useMockBackend(scenario: MockScenario, speed: MockSpeed): MockBackend {
  const timings = TIMINGS[speed];
  const [connect, setConnect] = useState<ConnectState>({ kind: "idle" });
  const [readiness, setReadiness] = useState<ReadinessFacts | undefined>(undefined);
  const [messaging, setMessaging] = useState<MessagingState>({ kind: "idle" });
  /** The result a running check will settle on, held so it can be applied on a clock or by hand. */
  const [checkResult, setCheckResult] = useState<ReadinessFacts | undefined>(undefined);
  const [planSignIn, setPlanSignIn] = useState<PlanSignIn>("idle");
  const [creation, setCreation] = useState<CreationState>("idle");
  const [agent, setAgent] = useState<CreatedAgent>();

  const timers = useRef<number[]>([]);
  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);
  const later = useCallback((run: () => void, delayMs: number | null) => {
    if (delayMs === null) return;
    timers.current.push(window.setTimeout(run, delayMs));
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Only a live code can produce a Computer. The arrival outlives an expiry, so without this guard
  // an expired code would still "connect" and the expiry scenario would report an impossible
  // success. A reissue clears pending timers, so the guard is all an expiry needs.
  const arrive = useCallback(() => {
    setConnect((current) =>
      current.kind === "issued"
        ? { kind: "connected", command: current.command, computerName: COMPUTER_NAME }
        : current,
    );
  }, []);

  const issue = useCallback(() => {
    clearTimers();
    setConnect({ kind: "issuing" });
    later(() => {
      setConnect({ kind: "issued", command: connectCommand(randomCode()), expiresAt: Date.now() + timings.codeTtlMs });
      later(arrive, timings.connectMs);
    }, timings.issueMs);
  }, [arrive, clearTimers, later, timings.codeTtlMs, timings.connectMs, timings.issueMs]);

  const issueConnectCode = useCallback(() => {
    setConnect((current) => {
      if (current.kind !== "idle") return current;
      queueMicrotask(issue);
      return { kind: "issuing" };
    });
  }, [issue]);

  // Expiry is observed rather than scheduled, so a backgrounded tab that misses its timer still
  // resolves to the correct state the moment it is looked at again.
  useEffect(() => {
    if (connect.kind !== "issued") return;
    const remaining = connect.expiresAt - Date.now();
    if (remaining <= 0) {
      setConnect({ kind: "expired", command: connect.command });
      return;
    }
    const id = window.setTimeout(
      () =>
        setConnect((current) => (current.kind === "issued" ? { kind: "expired", command: current.command } : current)),
      remaining,
    );
    return () => window.clearTimeout(id);
  }, [connect]);

  // The check runs when the Computer arrives, exactly like the daemon's eager first probe.
  useEffect(() => {
    if (connect.kind !== "connected") return;
    setReadiness({ runtime: "checking", messagingCli: { feishu: "checking", slack: "checking" } });
    setCheckResult({
      runtime: scenario.runtime,
      messagingCli: { feishu: scenario.messagingCli, slack: scenario.messagingCli },
    });
  }, [connect.kind, scenario.messagingCli, scenario.runtime]);

  const settleCheck = useCallback(() => {
    setCheckResult((target) => {
      if (target) setReadiness(target);
      return undefined;
    });
  }, []);

  useEffect(() => {
    if (!checkResult || timings.probeMs === null) return;
    const id = window.setTimeout(settleCheck, timings.probeMs);
    return () => window.clearTimeout(id);
  }, [checkResult, settleCheck, timings.probeMs]);

  const repairNow = useCallback(() => {
    setReadiness({ runtime: "checking", messagingCli: { feishu: "checking", slack: "checking" } });
    setCheckResult({ runtime: "ready", messagingCli: { feishu: "ready", slack: "ready" } });
  }, []);

  /** Only Lark has something to issue up front; Slack waits for the user to start its install. */
  const startMessaging = useCallback(
    (provider: "feishu" | "slack") => {
      if (provider !== "feishu") return;
      setMessaging((current) => {
        if (current.kind !== "idle") return current;
        queueMicrotask(() => {
          later(() => {
            setMessaging({ kind: "waiting", qrValue: `https://opentag.ai/feishu/${randomId()}` });
            later(() => setMessaging({ kind: "waiting-handoff" }), timings.scanMs);
          }, timings.issueMs);
        });
        return { kind: "issuing" };
      });
    },
    [later, timings.issueMs, timings.scanMs],
  );

  const startSlackInstall = useCallback(() => {
    setMessaging((current) => (current.kind === "idle" ? { kind: "away" } : current));
    later(
      () => setMessaging((current) => (current.kind === "away" ? { kind: "waiting-handoff" } : current)),
      timings.scanMs,
    );
  }, [later, timings.scanMs]);

  const startPlanSignIn = useCallback(() => {
    setPlanSignIn((current) => (current === "idle" ? "pending" : current));
  }, []);

  /** The Agent the real backend would have created, on the same seam and the same states. */
  const createAgent = useCallback(
    (draft: AgentDraft) => {
      setCreation((current) => {
        if (current !== "idle") return current;
        later(() => {
          setCreation("created");
          setAgent({ id: randomId(), name: draft.name, runtimeProvider: draft.runtime ?? "codex" });
        }, CREATE_AGENT_MS);
        return "creating";
      });
    },
    [later],
  );

  const reset = useCallback(() => {
    clearTimers();
    setPlanSignIn("idle");
    setCreation("idle");
    setAgent(undefined);
    setConnect({ kind: "idle" });
    setReadiness(undefined);
    setCheckResult(undefined);
    setMessaging({ kind: "idle" });
  }, [clearTimers]);

  const pending = useMemo<PendingEvent | undefined>(() => {
    if (connect.kind === "issued") return { label: "Connect computer", run: arrive };
    if (checkResult) return { label: "Return check result", run: settleCheck };
    if (planSignIn === "pending") return { label: "Approve sign-in", run: () => setPlanSignIn("signed-in") };
    if (messaging.kind === "waiting")
      return { label: "Scan QR code", run: () => setMessaging({ kind: "waiting-handoff" }) };
    if (messaging.kind === "away")
      return { label: "Return from Slack", run: () => setMessaging({ kind: "waiting-handoff" }) };
    if (messaging.kind === "waiting-handoff")
      return { label: "Confirm reachable", run: () => setMessaging({ kind: "connected" }) };
    return undefined;
  }, [arrive, checkResult, connect.kind, messaging.kind, planSignIn, settleCheck]);

  return useMemo(
    () => ({
      agent,
      // The mock's Computer does not leave once it has arrived.
      computerOnline: connect.kind === "connected" ? true : undefined,
      connect,
      createAgent,
      creation,
      error: undefined,
      readiness,
      messaging,
      messagingProvider: undefined,
      planSignIn,
      // The mock has nothing to read back; it is the flow as it runs the first time.
      resuming: false,
      resumeError: undefined,
      resumeBlocked: undefined,
      retryResume: () => undefined,
      markPastConnectStep: () => undefined,
      startPlanSignIn,
      issueConnectCode,
      refreshConnectCode: issue,
      startMessaging,
      startSlackInstall,
      pending,
      expireNow: () =>
        setConnect((current) => (current.kind === "issued" ? { kind: "expired", command: current.command } : current)),
      repairNow,
      reset,
    }),
    [
      agent,
      connect,
      createAgent,
      creation,
      issue,
      issueConnectCode,
      messaging,
      pending,
      planSignIn,
      readiness,
      repairNow,
      reset,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
    ],
  );
}
