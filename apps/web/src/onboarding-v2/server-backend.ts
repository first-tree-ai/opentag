/**
 * The flow, against the real Server.
 *
 * Everything here is polled rather than pushed, because that is what the Server offers: there is no
 * socket that tells a browser a Computer arrived or a probe came back. One interval drives the
 * whole connect step — the countdown, the arrival, and the readiness that follows it — so the page
 * never has two clocks disagreeing about the same moment.
 */

import type { AccountComputerSummary, AgentRuntimeProvider, ImBindingHandoffStatus } from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserApi } from "../api.js";
import type { MessagingCliStatus, RuntimeStatus } from "../setup/checks.js";
import type { CreatedAgent, OnboardingBackend, PlanSignIn } from "./backend.js";
import { COPY } from "./copy.js";
import type {
  AgentDraft,
  ConnectState,
  CreationState,
  MessagingProvider,
  MessagingState,
  ReadinessFacts,
} from "./flow.js";

/** The existing onboarding polls Computers at this rate while it waits for one. */
const COMPUTER_POLL_MS = 1_500;
/** The Feishu attempt is a QR the user scans on a phone; there is nothing to see faster than this. */
const FEISHU_POLL_MS = 2_000;
/** How often to ask whether the Agent has actually become reachable through its messaging app. */
const HANDOFF_POLL_MS = 2_000;

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Which Computer this run is waiting for.
 *
 * The Computers response carries no link back to the code that was issued, so "a Computer appeared"
 * is not the same claim as "my Computer appeared". Every connection visible before the code was
 * issued is recorded, and only a Computer that is absent from that baseline — or one whose
 * `connectedAt` has moved since — counts as this run's arrival. Without that, someone else's
 * machine registering would satisfy this reader's step.
 */
function findArrival(
  computers: readonly AccountComputerSummary[],
  baseline: ReadonlyMap<string, string | null>,
): AccountComputerSummary | undefined {
  return computers.find(
    (computer) =>
      computer.connectionStatus === "online" &&
      computer.connectedAt !== null &&
      (!baseline.has(computer.computerId) || baseline.get(computer.computerId) !== computer.connectedAt),
  );
}

/**
 * What a handoff status means for the step the reader is on.
 *
 * The status separates two unlike things that both report `handoffReady: false`. An *active*
 * binding is connected and waiting to be observed, which resolves on its own. Any other state —
 * provisioning, revoked, errored, disabled — is a messaging app that is not connected, and no
 * amount of waiting fixes it: the answer is the step that connects one.
 */
function readMessaging(handoff: ImBindingHandoffStatus | undefined): MessagingState {
  if (handoff?.handoffReady) return { kind: "connected" };
  if (handoff?.bindingState === "active") return { kind: "waiting-handoff" };
  return { kind: "idle" };
}

/**
 * The Computer a repair code was issued for, once it has answered.
 *
 * Nothing is inferred here. The code named this machine, so the only question is whether it has
 * come back — which is a fresh `connectedAt` on that exact Computer, and cannot be satisfied by
 * any other machine connecting during the wait.
 */
function findRepaired(
  computers: readonly AccountComputerSummary[],
  targetComputerId: string,
  baseline: ReadonlyMap<string, string | null>,
): AccountComputerSummary | undefined {
  const target = computers.find((computer) => computer.computerId === targetComputerId);
  if (!target || target.connectionStatus !== "online" || target.connectedAt === null) return undefined;
  return baseline.get(targetComputerId) === target.connectedAt ? undefined : target;
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
function readReadiness(computer: AccountComputerSummary, runtime: AgentRuntimeProvider | undefined): ReadinessFacts {
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
  const [computer, setComputer] = useState<AccountComputerSummary>();
  const [messaging, setMessaging] = useState<MessagingState>({ kind: "idle" });
  const [messagingProvider, setMessagingProvider] = useState<MessagingProvider>();
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
  /** Discards the reply of a read the reader has already asked to redo. */
  const resumeRun = useRef(0);

  /** The Computer this run connected. Messaging and creation both need it after the step is left. */
  const computerId = useRef<string | undefined>(undefined);
  const baseline = useRef<Map<string, string | null>>(new Map());
  const expiresAt = useRef(0);
  /** Bumped by every reissue and by unmount, so a reply from a superseded attempt is discarded. */
  const attempt = useRef(0);
  const creationRef = useRef<CreationState>("idle");
  const feishuTimer = useRef(0);
  /** The connection as it stands, readable from a callback without making an updater impure. */
  /**
   * The Computer this run is repairing, when it is repairing one. A code issued against it names
   * its target, so the machine that answers is that machine — there is nothing to infer, and
   * nothing about who owns what to decide from an arrival.
   */
  const repairTarget = useRef<string | undefined>(undefined);
  /**
   * Latched once the reader is past the step the connection belongs to. Losing a Computer matters
   * on that step, where it hides the command that brings the machine back; past it the Agent
   * already exists, and pulling someone out of choosing or scanning a messaging app over a lid
   * they are about to reopen costs more than it tells them.
   */
  const pastConnectStep = useRef(false);
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
         * machine was connected, not whether it is there now. Asserting a live connection from it
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
        const connected = online.get(existing.computer.computerId);
        // Offline or gone: the step issues a code that repairs this exact Computer.
        repairTarget.current = connected ? undefined : existing.computer.computerId;
        if (connected) {
          computerId.current = connected.computerId;
          setComputer(connected);
          // Already connected, so this step has nothing to ask for: it reports the machine rather
          // than issuing a command that would spend its validity unseen.
          setConnect({ kind: "connected", command: "", computerName: connected.displayName });
        }
        // An offline or missing Computer leaves the connection idle, which is what makes the step
        // issue a fresh code — and whatever machine answers it gets bound to this Agent.

        /*
         * Handoff readiness, not binding state. The Server refuses to complete setup unless the
         * Agent is genuinely reachable — an active binding, a ready runtime, a ready provider CLI
         * and an actual observation of the messaging identity. Slack's install marks the binding
         * active before that observation lands, so treating "installed" as "finished" is how a
         * real callback ends up asking to complete something the Server will refuse.
         */
        const handoff = await browserApi.imBindingHandoff(existing.id);
        if (!live()) return;
        setMessaging(readMessaging(handoff));

        /*
         * Which app is being waited on. The reader chose it on a page that a Slack install
         * destroys — the browser leaves for Slack and returns to a fresh mount — so the choice has
         * to come back from the binding rather than from state that did not survive the trip.
         * Without it the step knows it is waiting and not what for, and renders nothing.
         */
        if (handoff !== undefined) {
          /*
           * Best effort, and deliberately its own failure. Which app is waiting decides what this
           * step draws, not whether the run can continue — so a read that fails costs the reader
           * the branch and nothing else. Letting it join the resume would mean an unrelated
           * outage on this call strands a returning Account on an error instead.
           */
          try {
            const binding = await browserApi.imBinding(existing.id);
            if (!live()) return;
            if (binding?.provider === "feishu" || binding?.provider === "slack") {
              setMessagingProvider(binding.provider);
            }
          } catch {
            // The step falls back to asking, which is what it did before it could restore anything.
          }
        }
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

  const issue = useCallback(async () => {
    const mine = attempt.current + 1;
    attempt.current = mine;
    // Everything keyed to the run just superseded is released with it — what the reader can see as
    // well as what they cannot. A move left mid-flight would otherwise hold its own gate shut for
    // the rest of the session, and a move that was refused would leave behind an explanation that
    // no longer applies beside a control with nothing left to try.
    setConnect({ kind: "issuing" });
    setConnectionError(undefined);
    try {
      // Baselined before the code is issued, never after: a Computer that enrolls between the two
      // calls would otherwise be read as this run's arrival.
      const before = await browserApi.computers();
      if (!mounted.current || attempt.current !== mine) return;
      baseline.current = new Map(before.computers.map((computer) => [computer.computerId, computer.connectedAt]));
      /*
       * A Computer this Account already has is repaired, not replaced. The Agent is bound to that
       * exact machine, so a code that named no target would enrol a second Computer beside it and
       * leave the Agent pointing at the one that went away — a reinstall would cost an Account a
       * duplicate every time. Naming the target also settles which machine answered: the Server
       * repairs the Computer the code was issued for, so nothing has to be inferred from an
       * arrival.
       */
      const repairing = repairTarget.current;
      const issued = await browserApi.issueComputerConnectCode(
        repairing ? { mode: "repair", targetComputerId: repairing } : undefined,
      );
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
          const arrived = repairTarget.current
            ? findRepaired(value.computers, repairTarget.current, baseline.current)
            : findArrival(value.computers, baseline.current);
          // A reply can land after its code expired. Adopting outside this guard let an expired
          // attempt claim a machine, enable Continue, and create an Agent the page could then never
          // move past — so nothing is adopted unless the connection is still the one waiting.
          const waiting = connectRef.current;
          if (!arrived || waiting.kind !== "issued") return;
          /*
           * A machine that is not the one the Agent is bound to has to become it. An Agent's
           * Computer can be changed after creation even though its runtime cannot, so the honest
           * answer to "my laptop was replaced" is to move the Agent — not to insist the old machine
           * comes back, and not to quietly finish setup with the Agent still pointing at a machine
           * nobody checked. Until the move lands, this is not a connection worth reporting.
           */
          computerId.current = arrived.computerId;
          setComputer(arrived);
          setConnectionError(undefined);
          setConnect({ kind: "connected", command: waiting.command, computerName: arrived.displayName });
        },
        (cause: unknown) => {
          if (mounted.current && attempt.current === mine)
            setConnectionError(errorMessage(cause, COPY.errors.computers));
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
            // Held here, the reader is not pulled off a step they are working through — but the
            // Computer is still recorded, because reachability depends on it and a wait that has
            // gone stale cannot say what it is waiting for.
            //
            // This holds them against a *lost connection* only. Readiness going backwards is not
            // covered and is not meant to be: it fails the check the later step was reached
            // through, so the flow returns to the step whose check rows say which line failed.
            if (mineNow) setComputer(mineNow);
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

  /*
   * An installed messaging app is not a reachable Agent. Between the two sits an observation the
   * Server makes for itself, and only when it has been made will completing setup be allowed — so
   * this waits for it rather than asking and being refused.
   */
  useEffect(() => {
    if (messaging.kind !== "waiting-handoff" || !agent) return;
    const mine = attempt.current;
    const timer = window.setInterval(() => {
      void browserApi.imBindingHandoff(agent.id).then(
        (handoff) => {
          if (!mounted.current || attempt.current !== mine) return;
          // A binding can break while this waits — an authorization is revoked, the App is
          // disabled. That is not a longer wait, it is a messaging app to connect again, and the
          // step this returns to is the one that can do it.
          setMessaging(readMessaging(handoff));
        },
        () => undefined,
      );
    }, HANDOFF_POLL_MS);
    return () => window.clearInterval(timer);
  }, [agent, messaging.kind]);

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
                setMessaging({ kind: "waiting-handoff" });
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
    repairTarget.current = undefined;
    pastConnectStep.current = false;
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

  const startPlanSignIn = useCallback(() => undefined, []);

  const computerOnline = computer === undefined ? undefined : computer.connectionStatus === "online";

  const readiness = useMemo(
    () => (computer ? readReadiness(computer, draft.runtime) : undefined),
    [computer, draft.runtime],
  );

  return useMemo(
    () => ({
      agent,
      computerOnline,
      connect,
      createAgent,
      creation,
      error: actionError ?? connectionError,
      issueConnectCode,
      messaging,
      messagingProvider,
      planSignIn,
      readiness,
      refreshConnectCode,
      reset,
      markPastConnectStep,
      resumeError,
      resuming,
      retryResume,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
    }),
    [
      actionError,
      agent,
      computerOnline,
      connect,
      connectionError,
      createAgent,
      creation,
      issueConnectCode,
      messaging,
      messagingProvider,
      planSignIn,
      readiness,
      refreshConnectCode,
      reset,
      markPastConnectStep,
      resumeError,
      resuming,
      retryResume,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
    ],
  );
}
