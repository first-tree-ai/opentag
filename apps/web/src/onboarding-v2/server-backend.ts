/**
 * The flow, against the real Server.
 *
 * Everything here is polled rather than pushed, because that is what the Server offers: there is no
 * socket that tells a browser a Computer arrived or a probe came back. One interval drives the
 * whole connect step — the countdown, the arrival, and the readiness that follows it — so the page
 * never has two clocks disagreeing about the same moment.
 */

import type { AgentRuntimeProvider, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserApi } from "../api.js";
import type { CreatedAgent, OnboardingBackend, PlanSignIn } from "./backend.js";
import { COPY } from "./copy.js";
import type {
  AgentDraft,
  ConnectState,
  CreationState,
  MessagingCliStatus,
  MessagingState,
  ReadinessFacts,
  RuntimeStatus,
} from "./flow.js";

/** The existing onboarding polls Computers at this rate while it waits for one. */
const COMPUTER_POLL_MS = 1_500;
/** The Feishu attempt is a QR the user scans on a phone; there is nothing to see faster than this. */
const FEISHU_POLL_MS = 2_000;

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Which Computer this run is waiting for.
 *
 * The Computers response carries no link back to the code that was issued, so "a Computer appeared"
 * is not the same claim as "my Computer appeared". Every enrollment visible before the code was
 * issued is recorded, and only a Computer that is absent from that baseline — or one whose
 * `connectedAt` has moved since — counts as this run's arrival. Without that, someone else's
 * machine registering would satisfy this reader's step.
 */
function findArrival(
  computers: readonly WorkspaceComputerSummary[],
  baseline: ReadonlyMap<string, string | null>,
): WorkspaceComputerSummary | undefined {
  return computers.find(
    (computer) =>
      computer.connectionStatus === "online" &&
      computer.connectedAt !== null &&
      (!baseline.has(computer.computerId) || baseline.get(computer.computerId) !== computer.connectedAt),
  );
}

/**
 * A Computer's readiness, read for the runtime this draft actually chose.
 *
 * A Computer that has reported nothing yet is `checking` rather than absent: it is the daemon's
 * first probe that has not landed, not a failure, and showing a failure there would accuse a
 * machine that has not answered yet. The same applies to the messaging CLI.
 */
function readReadiness(computer: WorkspaceComputerSummary, runtime: AgentRuntimeProvider | undefined): ReadinessFacts {
  const provider = runtime ? computer.providerReadiness?.find((entry) => entry.provider === runtime) : undefined;
  const messagingCli = computer.imCliReadiness?.[0];
  return {
    runtime: (provider?.status ?? "checking") as RuntimeStatus,
    messagingCli: (messagingCli?.status ?? "checking") as MessagingCliStatus,
  };
}

/**
 * The draft is observed, not owned: the page holds it, and this hook only needs the runtime from it
 * so a readiness read asks about the Provider the reader actually chose. Taking it as an argument
 * keeps that dependency visible instead of threading it through every call.
 */
export function useServerBackend(draft: AgentDraft): OnboardingBackend {
  const [connect, setConnect] = useState<ConnectState>({ kind: "idle" });
  const [readiness, setReadiness] = useState<ReadinessFacts>();
  const [messaging, setMessaging] = useState<MessagingState>({ kind: "idle" });
  const [agent, setAgent] = useState<CreatedAgent>();
  const [creation, setCreation] = useState<CreationState>("idle");
  const [error, setError] = useState<string>();
  /**
   * No third-party plan sign-in exists on the Server yet, so this stays idle. It is part of the
   * cloud route, which is Coming soon; naming it here keeps the seam honest rather than pretending
   * the capability is somewhere else.
   */
  const [planSignIn] = useState<PlanSignIn>("idle");

  /** The Computer this run enrolled. Messaging and creation both need it after the step is left. */
  const computerId = useRef<string | undefined>(undefined);
  const baseline = useRef<Map<string, string | null>>(new Map());
  const expiresAt = useRef(0);
  /** Bumped by every reissue and by unmount, so a reply from a superseded attempt is discarded. */
  const attempt = useRef(0);
  const creationRef = useRef<CreationState>("idle");
  const runtime = useRef<AgentRuntimeProvider | undefined>(draft.runtime);
  runtime.current = draft.runtime;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
    };
  }, []);

  const issue = useCallback(async () => {
    const mine = attempt.current + 1;
    attempt.current = mine;
    setConnect({ kind: "issuing" });
    setError(undefined);
    try {
      // Baselined before the code is issued, never after: a Computer that enrolls between the two
      // calls would otherwise be read as this run's arrival.
      const before = await browserApi.computers();
      if (!mounted.current || attempt.current !== mine) return;
      baseline.current = new Map(before.computers.map((computer) => [computer.computerId, computer.connectedAt]));
      const issued = await browserApi.issueComputerConnectCode();
      if (!mounted.current || attempt.current !== mine) return;
      expiresAt.current = Date.parse(issued.issuedAt) + issued.expiresIn * 1_000;
      setConnect({ kind: "issued", command: issued.bootstrapCommand, expiresAt: expiresAt.current });
    } catch (cause) {
      if (!mounted.current || attempt.current !== mine) return;
      setConnect({ kind: "idle" });
      setError(errorMessage(cause, COPY.errors.connectCode));
    }
  }, []);

  const issueConnectCode = useCallback(() => {
    setConnect((current) => {
      if (current.kind !== "idle") return current;
      queueMicrotask(() => void issue());
      return { kind: "issuing" };
    });
  }, [issue]);

  const refreshConnectCode = useCallback(() => void issue(), [issue]);

  // One interval for the whole wait. It expires the code on the Server's own clock rather than a
  // local countdown, and hands over to the readiness poll below the moment a Computer arrives.
  useEffect(() => {
    if (connect.kind !== "issued") return;
    const mine = attempt.current;
    const timer = window.setInterval(() => {
      if (attempt.current !== mine) return;
      if (Date.now() >= expiresAt.current) {
        setConnect((current) => (current.kind === "issued" ? { kind: "expired", command: current.command } : current));
        return;
      }
      void browserApi.computers().then(
        (value) => {
          if (!mounted.current || attempt.current !== mine) return;
          const arrived = findArrival(value.computers, baseline.current);
          if (!arrived) return;
          computerId.current = arrived.computerId;
          setConnect((current) =>
            current.kind === "issued"
              ? { kind: "connected", command: current.command, computerName: arrived.displayName }
              : current,
          );
          setReadiness(readReadiness(arrived, runtime.current));
        },
        (cause: unknown) => {
          if (mounted.current && attempt.current === mine) setError(errorMessage(cause, COPY.errors.computers));
        },
      );
    }, COMPUTER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [connect.kind]);

  // Once the Computer is here, the same cadence keeps reading its readiness. The daemon re-probes on
  // its own schedule, so a failure that gets repaired in a terminal turns green here with no page
  // action — which is the whole reason the step offers a command instead of a retry button.
  useEffect(() => {
    if (connect.kind !== "connected") return;
    const mine = attempt.current;
    const timer = window.setInterval(() => {
      void browserApi.computers().then(
        (value) => {
          if (!mounted.current || attempt.current !== mine) return;
          const mineNow = value.computers.find((computer) => computer.computerId === computerId.current);
          if (mineNow) setReadiness(readReadiness(mineNow, runtime.current));
        },
        () => undefined,
      );
    }, COMPUTER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [connect.kind]);

  const createAgent = useCallback((draft: AgentDraft) => {
    const id = computerId.current;
    if (!id || !draft.runtime || creationRef.current !== "idle") return;
    const mine = attempt.current;
    creationRef.current = "creating";
    setCreation("creating");
    setError(undefined);
    void browserApi
      .createAgent({
        name: draft.name,
        displayName: draft.name,
        runtimeProvider: draft.runtime,
        computerId: id,
      })
      .then(
        (created) => {
          if (!mounted.current || attempt.current !== mine) return;
          creationRef.current = "created";
          setCreation("created");
          setAgent({ id: created.id, name: created.name });
        },
        (cause: unknown) => {
          if (!mounted.current || attempt.current !== mine) return;
          // A failed creation returns the step to a pressable state rather than stranding it: the
          // draft is still valid and the reader's next move is to try it again.
          creationRef.current = "idle";
          setCreation("idle");
          setError(errorMessage(cause, COPY.errors.createAgent));
        },
      );
  }, []);

  /** Lark issues a QR the user scans; Slack has nothing to show until its install is started. */
  const startMessaging = useCallback(
    (provider: "feishu" | "slack") => {
      if (provider !== "feishu" || !agent) return;
      setMessaging((current) => {
        if (current.kind !== "idle") return current;
        queueMicrotask(() => {
          void browserApi.createFeishuSetupAttempt(agent.id).then(
            (created) => {
              if (!mounted.current) return;
              setMessaging(created.qrUrl ? { kind: "waiting", qrValue: created.qrUrl } : { kind: "issuing" });
              pollFeishu(created.id);
            },
            (cause: unknown) => {
              if (!mounted.current) return;
              setMessaging({ kind: "idle" });
              setError(errorMessage(cause, COPY.errors.messaging));
            },
          );
        });
        return { kind: "issuing" };
      });

      function pollFeishu(attemptId: string) {
        const timer = window.setInterval(() => {
          void browserApi.feishuSetupAttempt(attemptId).then(
            (current) => {
              if (!mounted.current) {
                window.clearInterval(timer);
                return;
              }
              if (current.state === "succeeded") {
                window.clearInterval(timer);
                setMessaging({ kind: "connected" });
                return;
              }
              if (current.state === "failed" || current.state === "expired" || current.state === "canceled") {
                window.clearInterval(timer);
                setMessaging({ kind: "idle" });
                setError(COPY.errors.feishuAttempt);
                return;
              }
              if (current.qrUrl) setMessaging({ kind: "waiting", qrValue: current.qrUrl });
            },
            () => undefined,
          );
        }, FEISHU_POLL_MS);
      }
    },
    [agent],
  );

  /**
   * Slack's install happens on Slack's own pages. Sending the browser there ends this page's
   * involvement: the user comes back through the redirect the Server registered, not through a
   * state this hook is holding, so there is nothing here to poll.
   */
  const startSlackInstall = useCallback(() => {
    if (!agent) return;
    setMessaging((current) => (current.kind === "idle" ? { kind: "away" } : current));
    void browserApi.startSlackOAuth(agent.id, { intent: "create" }).then(
      (started) => {
        window.location.assign(started.authorizationUrl);
      },
      (cause: unknown) => {
        if (!mounted.current) return;
        setMessaging({ kind: "idle" });
        setError(errorMessage(cause, COPY.errors.messaging));
      },
    );
  }, [agent]);

  const reset = useCallback(() => {
    attempt.current += 1;
    computerId.current = undefined;
    baseline.current = new Map();
    expiresAt.current = 0;
    creationRef.current = "idle";
    setConnect({ kind: "idle" });
    setReadiness(undefined);
    setMessaging({ kind: "idle" });
    setAgent(undefined);
    setCreation("idle");
    setError(undefined);
  }, []);

  const startPlanSignIn = useCallback(() => undefined, []);

  return useMemo(
    () => ({
      agent,
      connect,
      createAgent,
      creation,
      error,
      issueConnectCode,
      messaging,
      planSignIn,
      readiness,
      refreshConnectCode,
      reset,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
    }),
    [
      agent,
      connect,
      createAgent,
      creation,
      error,
      issueConnectCode,
      messaging,
      planSignIn,
      readiness,
      refreshConnectCode,
      reset,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
    ],
  );
}
