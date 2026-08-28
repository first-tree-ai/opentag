/**
 * A stand-in for the Server and the Computer daemon, so the flow can be built and tuned without
 * either. It models only what the pages actually observe — a connect code that expires, a Computer
 * that shows up some seconds later, a readiness probe that resolves to a scenario's outcome, and a
 * QR code that gets scanned — and deliberately not the protocol underneath any of it.
 *
 * Every delay is named and adjustable so an interaction can be judged at real speed and then
 * exercised quickly, which is the whole point of having a mock at this stage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectState, MessagingCliStatus, MessagingState, ReadinessFacts, RuntimeStatus } from "./flow.js";

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
    description: "The runtime and the Feishu CLI are both installed and signed in.",
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
    title: "Feishu CLI missing",
    description: "The easiest failure to miss: the agent is perfect but nothing can be delivered.",
    runtime: "ready",
    messagingCli: "install",
  },
  {
    id: "both-failing",
    title: "Runtime and Feishu CLI missing",
    description: "Two failures at once, to check the plural copy and the list rhythm.",
    runtime: "install",
    messagingCli: "install",
  },
];

export type MockSpeed = "realistic" | "fast";

interface Timings {
  readonly issueMs: number;
  readonly connectMs: number;
  readonly codeTtlMs: number;
  readonly probeMs: number;
  readonly repairMs: number;
  readonly scanMs: number;
}

const TIMINGS: Record<MockSpeed, Timings> = {
  // The production connect code is valid for 15 minutes.
  realistic: {
    issueMs: 500,
    connectMs: 8_000,
    codeTtlMs: 15 * 60 * 1_000,
    probeMs: 2_500,
    repairMs: 4_000,
    scanMs: 6_000,
  },
  fast: { issueMs: 150, connectMs: 2_000, codeTtlMs: 25_000, probeMs: 800, repairMs: 1_200, scanMs: 1_500 },
};

const COMPUTER_NAME = "MacBook Pro";
const SERVER_URL = "https://opentag.ai";

function connectCommand(code: string): string {
  return `npm i -g open-tag && opentag computer connect --server ${SERVER_URL} -- ${code}`;
}

function randomCode(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export interface MockBackend {
  readonly connect: ConnectState;
  readonly readiness: ReadinessFacts | undefined;
  readonly messaging: MessagingState;
  /** Issues the first connect code. Safe to call repeatedly; only the idle state acts on it. */
  readonly issueConnectCode: () => void;
  /** Replaces an expired code with a fresh one, restarting the arrival timer. */
  readonly refreshConnectCode: () => void;
  readonly startMessaging: () => void;
  /** Lab controls — the page itself never offers these. */
  readonly connectNow: () => void;
  readonly expireNow: () => void;
  readonly repairNow: () => void;
  readonly scanNow: () => void;
  readonly reset: () => void;
}

export function useMockBackend(scenario: MockScenario, speed: MockSpeed): MockBackend {
  const timings = TIMINGS[speed];
  const [connect, setConnect] = useState<ConnectState>({ kind: "idle" });
  const [readiness, setReadiness] = useState<ReadinessFacts | undefined>(undefined);
  const [messaging, setMessaging] = useState<MessagingState>({ kind: "idle" });

  const timers = useRef<number[]>([]);
  const clearTimers = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
  }, []);
  const later = useCallback((run: () => void, delayMs: number) => {
    timers.current.push(window.setTimeout(run, delayMs));
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const arrive = useCallback(() => {
    setConnect((current) =>
      current.kind === "issued" || current.kind === "expired"
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

  // The readiness probe runs when the Computer arrives, exactly like the daemon's eager first probe.
  useEffect(() => {
    if (connect.kind !== "connected") return;
    setReadiness({ runtime: "checking", messagingCli: "checking" });
    const id = window.setTimeout(
      () => setReadiness({ runtime: scenario.runtime, messagingCli: scenario.messagingCli }),
      timings.probeMs,
    );
    return () => window.clearTimeout(id);
  }, [connect.kind, scenario.messagingCli, scenario.runtime, timings.probeMs]);

  const repairNow = useCallback(() => {
    setReadiness({ runtime: "checking", messagingCli: "checking" });
    later(() => setReadiness({ runtime: "ready", messagingCli: "ready" }), timings.repairMs);
  }, [later, timings.repairMs]);

  const startMessaging = useCallback(() => {
    setMessaging((current) => {
      if (current.kind !== "idle") return current;
      queueMicrotask(() => {
        later(() => {
          setMessaging({ kind: "waiting", qrValue: `https://opentag.ai/feishu/${randomCode()}` });
          later(() => setMessaging({ kind: "connected" }), timings.scanMs);
        }, timings.issueMs);
      });
      return { kind: "issuing" };
    });
  }, [later, timings.issueMs, timings.scanMs]);

  const reset = useCallback(() => {
    clearTimers();
    setConnect({ kind: "idle" });
    setReadiness(undefined);
    setMessaging({ kind: "idle" });
  }, [clearTimers]);

  return useMemo(
    () => ({
      connect,
      readiness,
      messaging,
      issueConnectCode,
      refreshConnectCode: issue,
      startMessaging,
      connectNow: arrive,
      expireNow: () =>
        setConnect((current) => (current.kind === "issued" ? { kind: "expired", command: current.command } : current)),
      repairNow,
      scanNow: () => setMessaging((current) => (current.kind === "waiting" ? { kind: "connected" } : current)),
      reset,
    }),
    [arrive, connect, issue, issueConnectCode, messaging, readiness, repairNow, reset, startMessaging],
  );
}
