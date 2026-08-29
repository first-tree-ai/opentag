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
  MessagingProvider,
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
 * The verdict carries the Provider it is about. A reader who goes back and picks a different
 * runtime must not be handed the previous one's result while the next poll is still in flight —
 * the Agent's provider cannot be changed after it is created, so a stale `ready` would commit them
 * to a runtime nothing ever checked.
 *
 * A Computer that has reported nothing yet is `checking` rather than absent: it is the daemon's
 * first probe that has not landed, not a failure, and showing a failure there would accuse a
 * machine that has not answered yet. The same applies to each messaging CLI, which is read by
 * Provider rather than by position — the Server sends only what it has observed, in its own
 * canonical order, so position 0 is whichever CLI happened to report, not the one being asked about.
 */
function readReadiness(computer: WorkspaceComputerSummary, runtime: AgentRuntimeProvider | undefined): ReadinessFacts {
  const provider = runtime ? computer.providerReadiness?.find((entry) => entry.provider === runtime) : undefined;
  const messagingCli: Partial<Record<MessagingProvider, MessagingCliStatus>> = {};
  for (const entry of computer.imCliReadiness ?? []) messagingCli[entry.provider] = entry.status;
  return {
    runtime: (provider?.status ?? "checking") as RuntimeStatus,
    runtimeProvider: runtime,
    messagingCli,
  };
}

/**
 * The draft is observed, not owned: the page holds it, and this hook only needs the runtime from it
 * so a readiness read asks about the Provider the reader actually chose. Taking it as an argument
 * keeps that dependency visible instead of threading it through every call.
 */
export function useServerBackend(draft: AgentDraft): OnboardingBackend {
  const [connect, setConnect] = useState<ConnectState>({ kind: "idle" });
  const [computer, setComputer] = useState<WorkspaceComputerSummary>();
  const [messaging, setMessaging] = useState<MessagingState>({ kind: "idle" });
  const [agent, setAgent] = useState<CreatedAgent>();
  const [creation, setCreation] = useState<CreationState>("idle");
  /**
   * Two kinds of failure, kept apart. The connection error belongs to the poll and is retired by
   * the next successful one. An action error belongs to something the reader did — creating the
   * Agent, starting a messaging app — and only that action may clear it, or a poll a second later
   * would erase the explanation while they were still reading it.
   */
  const [connectionError, setConnectionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  /**
   * No third-party plan sign-in exists on the Server yet, so this stays idle. It is part of the
   * cloud route, which is Coming soon; naming it here keeps the seam honest rather than pretending
   * the capability is somewhere else.
   */
  const [planSignIn] = useState<PlanSignIn>("idle");
  const [resuming, setResuming] = useState(true);
  const [resumeError, setResumeError] = useState<string>();
  const [rebindRefused, setRebindRefused] = useState(false);
  /** Discards the reply of a read the reader has already asked to redo. */
  const resumeRun = useRef(0);

  /** The Computer this run enrolled. Messaging and creation both need it after the step is left. */
  const computerId = useRef<string | undefined>(undefined);
  const baseline = useRef<Map<string, string | null>>(new Map());
  const expiresAt = useRef(0);
  /** Bumped by every reissue and by unmount, so a reply from a superseded attempt is discarded. */
  const attempt = useRef(0);
  const creationRef = useRef<CreationState>("idle");
  const feishuTimer = useRef(0);
  /** The connection as it stands, readable from a callback without making an updater impure. */
  /** The Computer the Agent is bound to on the Server, which a new machine has to replace. */
  const boundComputerId = useRef<string | undefined>(undefined);
  /** The name last shown for the machine being moved onto, so a retry can report the same one. */
  const computerNameRef = useRef("");
  /**
   * Whether a move is in flight or has been refused. Without it the poll that discovered the new
   * machine would ask again on every tick, because a refusal changes nothing that poll can see —
   * and this is a write that takes row locks, not a read.
   */
  const rebindState = useRef<"idle" | "moving" | "refused">("idle");
  /** The Computer a refused move was for, so asking again does not wait on a fresh arrival. */
  const rebindTarget = useRef<string | undefined>(undefined);
  /**
   * Latched once the reader is past the step the connection belongs to. Losing a Computer matters
   * on that step, where it hides the command that brings the machine back; past it the Agent
   * already exists, and pulling someone out of choosing or scanning a messaging app over a lid
   * they are about to reopen costs more than it tells them.
   */
  const pastConnectStep = useRef(false);
  const agentRef = useRef<CreatedAgent | undefined>(undefined);
  agentRef.current = agent;
  const connectRef = useRef<ConnectState>({ kind: "idle" });
  connectRef.current = connect;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
      window.clearInterval(feishuTimer.current);
    };
  }, []);

  /**
   * What the Account already has.
   *
   * This flow is the setup gate's only exit, which makes re-entry ordinary rather than exceptional:
   * a Slack install leaves the page and the gate sends the return trip back here, a tab is
   * refreshed, a machine wakes up. Starting from an empty draft each time would ask for an Agent
   * that already exists — and the second attempt is refused, because an Account's active Agent
   * names are unique. So the page picks up where the Server says it is.
   */
  const readAccount = useCallback(async () => {
    const mine = resumeRun.current + 1;
    resumeRun.current = mine;
    const live = () => mounted.current && resumeRun.current === mine;
    setResumeError(undefined);
    setResuming(true);
    try {
      {
        const { agents } = await browserApi.agents();
        if (!live()) return;
        const active = agents.filter((candidate) => candidate.status === "active");
        if (active.length === 0) return;

        /*
         * The Agent names its Computer, but that is a foreign key rather than a state: it says which
         * machine was enrolled, not whether it is there now. Asserting a live connection from it
         * would put "Your computer is connected." on screen while the Server says otherwise, and
         * hide the command that is the only way to bring the machine back — so the connection is
         * read, not inferred. One extra round trip buys not saying something untrue.
         */
        const { computers } = await browserApi.computers();
        if (!live()) return;
        const online = new Map(
          computers.filter((one) => one.connectionStatus === "online").map((one) => [one.computerId, one]),
        );
        // Where the Account has more than one, the Agent whose Computer is actually there is the one
        // this run can finish. Otherwise the first, which is the Server's own order.
        const existing = active.find((candidate) => online.has(candidate.computer.computerId)) ?? active[0];
        if (!existing) return;
        setAgent({ id: existing.id, name: existing.name, runtimeProvider: existing.runtimeProvider });
        creationRef.current = "created";
        setCreation("created");
        boundComputerId.current = existing.computer.computerId;
        const enrolled = online.get(existing.computer.computerId);
        if (enrolled) {
          computerId.current = enrolled.computerId;
          setComputer(enrolled);
          // Already enrolled, so this step has nothing to ask for: it reports the machine rather
          // than issuing a command that would spend its validity unseen.
          setConnect({ kind: "connected", command: "", computerName: enrolled.displayName });
        }
        // An offline or missing Computer leaves the connection idle, which is what makes the step
        // issue a fresh code — and whatever machine answers it gets bound to this Agent.

        const binding = await browserApi.imBinding(existing.id);
        if (!live()) return;
        // Only a live binding finishes the flow. One that is provisioning, broken or disabled is a
        // messaging app still to be connected, which is exactly the step this lands on.
        if (binding?.bindingState === "active") setMessaging({ kind: "connected" });
      }
    } catch (cause) {
      // Reading is the only way to tell a returning Account from a new one, so a failed read is
      // not "you must be new": starting over from here ends at a name collision. It is reported,
      // and the reader is given the read back rather than a form they cannot submit.
      if (live()) setResumeError(errorMessage(cause, COPY.errors.resume));
    } finally {
      if (live()) setResuming(false);
    }
  }, []);

  useEffect(() => {
    void readAccount();
  }, [readAccount]);

  /**
   * Moves the Agent onto a Computer and only then reports the connection. Saying "connected" before
   * the move lands would mean "this machine is yours" about a machine the Agent is not on.
   */
  const moveAgent = useCallback((agentId: string, targetComputerId: string, computerName: string, mine: number) => {
    if (rebindState.current === "moving") return;
    rebindState.current = "moving";
    void browserApi.rebindAgentComputer(agentId, targetComputerId).then(
      () => {
        // The run this move belongs to. A Start over while it was in flight would otherwise let it
        // land on the run that replaced it: the connection would read as live before the new run
        // had issued a code, and nothing on screen could move it on.
        if (!mounted.current || attempt.current !== mine) return;
        rebindState.current = "idle";
        boundComputerId.current = targetComputerId;
        computerId.current = targetComputerId;
        setRebindRefused(false);
        setActionError(undefined);
        setConnectionError(undefined);
        setConnect((current) =>
          current.kind === "connected"
            ? current
            : {
                kind: "connected",
                command: connectRef.current.kind === "issued" ? connectRef.current.command : "",
                computerName,
              },
        );
      },
      (cause: unknown) => {
        if (!mounted.current || attempt.current !== mine) return;
        rebindState.current = "refused";
        setRebindRefused(true);
        setActionError(errorMessage(cause, COPY.errors.rebind));
      },
    );
  }, []);

  const issue = useCallback(async () => {
    const mine = attempt.current + 1;
    attempt.current = mine;
    // Everything keyed to the run just superseded is released with it. A move left mid-flight would
    // otherwise hold its own gate shut for the rest of the session — its reply is discarded by the
    // run check above, so the branch that would have reopened the gate never runs.
    rebindState.current = "idle";
    rebindTarget.current = undefined;
    setConnect({ kind: "issuing" });
    setConnectionError(undefined);
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
      setConnectionError(errorMessage(cause, COPY.errors.connectCode));
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
          // A reply can land after its code expired. Adopting outside this guard let an expired
          // attempt claim a machine, enable Continue, and create an Agent the page could then never
          // move past — so nothing is adopted unless the connection is still the one waiting.
          const waiting = connectRef.current;
          if (!arrived || waiting.kind !== "issued") return;
          const settled = () => {
            computerId.current = arrived.computerId;
            setComputer(arrived);
            setConnectionError(undefined);
            setConnect({ kind: "connected", command: waiting.command, computerName: arrived.displayName });
          };
          /*
           * A machine that is not the one the Agent is bound to has to become it. An Agent's
           * Computer can be changed after creation even though its runtime cannot, so the honest
           * answer to "my laptop was replaced" is to move the Agent — not to insist the old machine
           * comes back, and not to quietly finish setup with the Agent still pointing at a machine
           * nobody checked. Until the move lands, this is not a connection worth reporting.
           */
          const resumedAgent = agentRef.current;
          if (resumedAgent && boundComputerId.current !== arrived.computerId) {
            // Asked once. A refusal rests until the reader asks again rather than repeating on the
            // next tick: the Server can refuse this while a delivery is in flight, and that clears
            // on its own, so the answer is a button and not a loop nobody can see.
            if (rebindState.current !== "idle") return;
            rebindTarget.current = arrived.computerId;
            computerNameRef.current = arrived.displayName;
            moveAgent(resumedAgent.id, arrived.computerId, arrived.displayName, mine);
            return;
          }
          settled();
        },
        (cause: unknown) => {
          if (mounted.current && attempt.current === mine)
            setConnectionError(errorMessage(cause, COPY.errors.computers));
        },
      );
    }, COMPUTER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [connect.kind, moveAgent]);

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
          /*
           * A machine can leave after it arrived — a lid closes, a daemon stops. Checking only on
           * the way in left the page saying "Your computer is connected." about a machine the
           * Server had already given up on, with the command that could bring it back hidden
           * because the command only renders when the connection is *not* live.
           *
           * Returning to idle is what reopens that command. It is held back once a messaging app is
           * under way: by then the Agent exists, and pulling someone out of a QR scan over a lid
           * they are about to open again would cost more than it tells them.
           */
          if (mineNow?.connectionStatus !== "online") {
            if (pastConnectStep.current) return;
            computerId.current = undefined;
            setComputer(undefined);
            setConnect({ kind: "idle" });
            return;
          }
          setComputer(mineNow);
          // A poll that succeeds retires whatever the last failed one put on screen; otherwise
          // "We lost contact" stays above "Your computer is connected."
          setConnectionError(undefined);
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
    setActionError(undefined);
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
          boundComputerId.current = id;
          setAgent({ id: created.id, name: created.name, runtimeProvider: created.runtimeProvider });
        },
        (cause: unknown) => {
          if (!mounted.current || attempt.current !== mine) return;
          // A failed creation returns the step to a pressable state rather than stranding it: the
          // draft is still valid and the reader's next move is to try it again.
          creationRef.current = "idle";
          setCreation("idle");
          setActionError(errorMessage(cause, COPY.errors.createAgent));
        },
      );
  }, []);

  /** Lark issues a QR the user scans; Slack has nothing to show until its install is started. */
  const startMessaging = useCallback(
    (provider: "feishu" | "slack") => {
      if (provider !== "feishu" || !agent) return;
      setMessaging((current) => {
        // A refused attempt is retried only when the reader asks for it, never on sight.
        if (current.kind !== "idle" && current.kind !== "failed") return current;
        const mine = attempt.current;
        queueMicrotask(() => {
          void browserApi.createFeishuSetupAttempt(agent.id).then(
            (created) => {
              if (!mounted.current || attempt.current !== mine) return;
              setMessaging(created.qrUrl ? { kind: "waiting", qrValue: created.qrUrl } : { kind: "issuing" });
              pollFeishu(created.id, mine);
            },
            (cause: unknown) => {
              if (!mounted.current || attempt.current !== mine) return;
              setMessaging({ kind: "failed" });
              setActionError(errorMessage(cause, COPY.errors.messaging));
            },
          );
        });
        return { kind: "issuing" };
      });

      function pollFeishu(attemptId: string, mine: number) {
        // The handle is held so `reset()` can end a poll the reader walked away from. Without it a
        // Start over left the previous attempt running, and its eventual success connected the
        // messaging app of a flow that no longer existed.
        window.clearInterval(feishuTimer.current);
        feishuTimer.current = window.setInterval(() => {
          if (!mounted.current || attempt.current !== mine) {
            window.clearInterval(feishuTimer.current);
            return;
          }
          void browserApi.feishuSetupAttempt(attemptId).then(
            (current) => {
              if (!mounted.current || attempt.current !== mine) {
                window.clearInterval(feishuTimer.current);
                return;
              }
              if (current.state === "succeeded") {
                window.clearInterval(feishuTimer.current);
                setMessaging({ kind: "connected" });
                return;
              }
              if (current.state === "failed" || current.state === "expired" || current.state === "canceled") {
                window.clearInterval(feishuTimer.current);
                setMessaging({ kind: "failed" });
                setActionError(COPY.errors.feishuAttempt);
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
        setActionError(errorMessage(cause, COPY.errors.messaging));
      },
    );
  }, [agent]);

  const reset = useCallback(() => {
    attempt.current += 1;
    window.clearInterval(feishuTimer.current);
    computerId.current = undefined;
    baseline.current = new Map();
    expiresAt.current = 0;
    creationRef.current = "idle";
    setConnect({ kind: "idle" });
    setComputer(undefined);
    setMessaging({ kind: "idle" });
    setAgent(undefined);
    setCreation("idle");
    boundComputerId.current = undefined;
    rebindState.current = "idle";
    rebindTarget.current = undefined;
    pastConnectStep.current = false;
    setRebindRefused(false);
    setResuming(false);
    setResumeError(undefined);
    setActionError(undefined);
    setConnectionError(undefined);
  }, []);

  /** Told by the page when the reader has moved past the step the connection belongs to. */
  const markPastConnectStep = useCallback(() => {
    pastConnectStep.current = true;
  }, []);

  /** Reads the Account again after a failed read, which is the only way out of that state. */
  const retryResume = useCallback(() => {
    void readAccount();
  }, [readAccount]);

  /**
   * Asks for a refused move again, and sends it rather than waiting for the poll to rediscover the
   * machine. The poll's arrival branch only runs while a connect code is live, so a reader who
   * waited out a refusal — which is the sensible thing to do with one that clears on its own —
   * would otherwise press a button that did nothing.
   */
  const retryRebind = useCallback(() => {
    const agentId = agentRef.current?.id;
    const target = rebindTarget.current;
    if (!agentId || !target) return;
    rebindState.current = "idle";
    setRebindRefused(false);
    setActionError(undefined);
    moveAgent(agentId, target, computerNameRef.current, attempt.current);
  }, [moveAgent]);

  const startPlanSignIn = useCallback(() => undefined, []);

  const readiness = useMemo(
    () => (computer ? readReadiness(computer, draft.runtime) : undefined),
    [computer, draft.runtime],
  );

  return useMemo(
    () => ({
      agent,
      connect,
      createAgent,
      creation,
      error: actionError ?? connectionError,
      issueConnectCode,
      messaging,
      planSignIn,
      readiness,
      refreshConnectCode,
      reset,
      markPastConnectStep,
      resumeError,
      resuming,
      retryRebind: rebindRefused ? retryRebind : undefined,
      retryResume,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
    }),
    [
      actionError,
      agent,
      connect,
      connectionError,
      createAgent,
      creation,
      issueConnectCode,
      messaging,
      planSignIn,
      readiness,
      refreshConnectCode,
      reset,
      markPastConnectStep,
      rebindRefused,
      resumeError,
      resuming,
      retryRebind,
      retryResume,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
    ],
  );
}
