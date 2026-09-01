/**
 * The flow, against the real Server.
 *
 * Everything outside the shared ComputerConnect lifecycle is polled rather than pushed, because
 * that is what the Server offers. This adapter observes the selected Computer's availability and
 * readiness; issuance, redemption, expiry and reissue belong to ComputerConnect.
 */

import type {
  AgentRuntimeProvider,
  FeishuBrand,
  ImBindingHandoffStatus,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserApi } from "../api.js";
import { formatRelativeTime } from "../i18n/format.js";
import { defaultFeishuBrand } from "../im/brand.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import type { MessagingCliStatus, RuntimeStatus } from "../setup/checks.js";
import type { CreatedAgent, KnownComputer, OnboardingBackend, PlanSignIn } from "./backend.js";
import { COPY } from "./copy.js";
import {
  type AgentDraft,
  type CreationState,
  type MessagingProvider,
  type MessagingState,
  type ReadinessFacts,
  readinessPassed,
} from "./flow.js";

/** Availability and readiness keep settling while the Computer step is open. */
const COMPUTER_POLL_MS = 1_500;
/** The Feishu attempt is a QR the user scans on a phone; there is nothing to see faster than this. */
const FEISHU_POLL_MS = 2_000;
/** How often to ask whether the Agent has actually become reachable through its messaging app. */
const HANDOFF_POLL_MS = 2_000;

export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
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
  if (handoff?.bindingState === "active") {
    return {
      kind: "waiting-handoff",
      ...("providerCli" in handoff && handoff.providerCli ? { providerCli: handoff.providerCli } : {}),
    };
  }
  return { kind: "idle" };
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
  const [computer, setComputer] = useState<WorkspaceComputerSummary>();
  const [selectedComputer, setSelectedComputer] = useState<KnownComputer>();
  const [messaging, setMessaging] = useState<MessagingState>({ kind: "idle" });
  const [messagingProvider, setMessagingProvider] = useState<MessagingProvider>();
  const [agent, setAgent] = useState<CreatedAgent>();
  const [creation, setCreation] = useState<CreationState>("idle");
  const [actionError, setActionError] = useState<string>();
  /**
   * No third-party plan sign-in exists on the Server yet, so this stays idle. It is part of the
   * cloud route, which is Coming soon; naming it here keeps the seam honest rather than pretending
   * the capability is somewhere else.
   */
  const [planSignIn] = useState<PlanSignIn>("idle");
  const [resuming, setResuming] = useState(true);
  const [resumeError, setResumeError] = useState<string>();
  const [resumeBlocked, setResumeBlocked] = useState<{ agentId: string; agentName: string }>();
  const [pastComputerStep, setPastComputerStep] = useState(false);
  const [lastPassedReadiness, setLastPassedReadiness] = useState<ReadinessFacts>();
  const [computerPollEpoch, setComputerPollEpoch] = useState(0);
  const computerPollEpochRef = useRef(computerPollEpoch);
  computerPollEpochRef.current = computerPollEpoch;
  /** Discards the reply of a read the reader has already asked to redo. */
  const resumeRun = useRef(0);

  /** The Computer this run enrolled. Messaging and creation both need it after the step is left. */
  const computerId = useRef<string | undefined>(undefined);
  /** Bumped by reset and unmount so replies from an abandoned run are discarded. */
  const attempt = useRef(0);
  const creationRef = useRef<CreationState>("idle");
  const feishuTimer = useRef(0);
  /** The attempt a code on screen belongs to, so switching brand can release it before minting. */
  const feishuAttemptId = useRef<string | undefined>(undefined);
  /** Bumped whenever a code is superseded, so the poll watching the old one stops on its own. */
  const feishuGeneration = useRef(0);
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
    setResumeBlocked(undefined);
    setResuming(true);
    try {
      {
        const [{ agents }, { computers }] = await Promise.all([browserApi.agents(), browserApi.computers()]);
        if (!live()) return;
        const active = agents.filter((candidate) => candidate.status === "active");

        /*
         * Redeeming a Computer command and creating its Agent are separate durable writes. A
         * refresh can land between them, so inventory must be resumed even when no Agent exists
         * yet; otherwise the page would forget the enrolled Computer and issue a second create
         * command. Prefer the reachable row where legacy data contains more than one.
         */
        if (active.length === 0) {
          const enrolled = computers.find((candidate) => candidate.connectionStatus === "online") ?? computers[0];
          if (!enrolled) return;
          computerId.current = enrolled.computerId;
          setComputer(enrolled);
          setSelectedComputer({
            id: enrolled.computerId,
            displayName: enrolled.displayName,
            availability: enrolled.connectionStatus,
            lastSeen: enrolled.lastSeenAt ? formatRelativeTime(enrolled.lastSeenAt) : undefined,
          });
          return;
        }

        /*
         * The Agent names its Computer, but that is a foreign key rather than a state: it says which
         * machine was enrolled, not whether it is there now. Asserting a live connection from it
         * would put "Your computer is connected." on screen while the Server says otherwise, and
         * hide the command that is the only way to bring the machine back — so the connection is
         * read, not inferred. One extra round trip buys not saying something untrue.
         */
        const byId = new Map(computers.map((one) => [one.computerId, one]));
        /*
         * Only an Agent that has a Computer can be resumed here. Adopting an unbound one would
         * report a connection and then stop at messaging, which refuses an Agent with nowhere to
         * run. Where the Account has more than one, the Agent whose Computer is actually there is
         * the one this run can finish; otherwise the first, which is the Server's own order.
         */
        const bound = active.flatMap((candidate) =>
          candidate.computer ? [{ agent: candidate, computer: candidate.computer }] : [],
        );
        const existing =
          bound.find(({ computer }) => byId.get(computer.computerId)?.connectionStatus === "online") ?? bound[0];
        if (!existing) {
          const unfinishable = active[0];
          // Named, because "you have no Agent" would be false and would send the reader into a
          // creation form that ends at the name it already has.
          if (unfinishable) {
            setResumeBlocked({ agentId: unfinishable.id, agentName: unfinishable.displayName });
          }
          return;
        }
        const { agent: resumed, computer: resumedComputer } = existing;
        setAgent({ id: resumed.id, name: resumed.name, runtimeProvider: resumed.runtimeProvider });
        creationRef.current = "created";
        setCreation("created");
        const enrolled = byId.get(resumedComputer.computerId);
        computerId.current = resumedComputer.computerId;
        setSelectedComputer({
          id: resumedComputer.computerId,
          displayName: enrolled?.displayName ?? resumedComputer.displayName,
          availability: enrolled?.connectionStatus ?? "unknown",
          lastSeen: enrolled?.lastSeenAt ? formatRelativeTime(enrolled.lastSeenAt) : undefined,
        });
        if (enrolled) {
          setComputer(enrolled);
        }

        /*
         * Handoff readiness, not binding state. The Server refuses to complete setup unless the
         * Agent is genuinely reachable — an active binding, a ready runtime, a ready provider CLI
         * and an actual observation of the messaging identity. Slack's install marks the binding
         * active before that observation lands, so treating "installed" as "finished" is how a
         * real callback ends up asking to complete something the Server will refuse.
         */
        const handoff = await browserApi.imBindingHandoff(resumed.id);
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
            const binding = await browserApi.imBinding(resumed.id);
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

  const computerConnected = useCallback((connected: WorkspaceComputerSummary) => {
    computerId.current = connected.computerId;
    setComputer(connected);
    setSelectedComputer({
      id: connected.computerId,
      displayName: connected.displayName,
      availability: "online",
      lastSeen: connected.lastSeenAt ? formatRelativeTime(connected.lastSeenAt) : undefined,
    });
  }, []);

  // Availability is independent of a connection attempt. Keep observing the selected Computer so
  // opening OpenTag on that machine is the default recovery path and needs no repair code at all.
  // The same read keeps readiness fresh once it is online.
  useEffect(() => {
    const selectedId = selectedComputer?.id;
    if (!selectedId) return;
    const mine = attempt.current;
    const observationRun = computerPollEpoch;
    const timer = window.setInterval(() => {
      void browserApi.computers().then(
        (value) => {
          if (!mounted.current || attempt.current !== mine || computerPollEpochRef.current !== observationRun) return;
          const observed = value.computers.find((candidate) => candidate.computerId === selectedId);
          setComputer(observed);
          setSelectedComputer((current) =>
            current?.id === selectedId
              ? {
                  id: selectedId,
                  displayName: observed?.displayName ?? current.displayName,
                  availability: observed?.connectionStatus ?? "unknown",
                  lastSeen: observed?.lastSeenAt ? formatRelativeTime(observed.lastSeenAt) : current.lastSeen,
                }
              : current,
          );
        },
        () => undefined,
      );
    }, COMPUTER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [computerPollEpoch, selectedComputer?.id]);

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

  /** Feishu issues a QR the user scans; Slack has nothing to show until its install is started. */
  const startMessaging = useCallback(
    (provider: "feishu" | "slack", brand: FeishuBrand = defaultFeishuBrand()) => {
      if (provider !== "feishu" || !agent) return;
      setMessaging((current) => {
        /*
         * A refused attempt is retried only when the reader asks for it, never on sight — and a
         * code already on screen is left alone, unless the ask is for the other brand. That is the
         * switch: the domain is fixed when the code is minted, so the only way to show a Lark code
         * is to stop waiting on the Feishu one and issue another.
         */
        const switching = current.kind === "waiting" && current.brand !== brand;
        if (!switching && current.kind !== "idle" && current.kind !== "failed") return current;
        /*
         * Superseding one code has its own generation. The flow-wide `attempt` counter also gates
         * the Computer readiness poll, so bumping that to retire a QR would quietly stop the page
         * noticing the machine it is waiting on.
         */
        feishuGeneration.current += 1;
        window.clearInterval(feishuTimer.current);
        const superseded = switching ? feishuAttemptId.current : undefined;
        const mine = attempt.current;
        const mineFeishu = feishuGeneration.current;
        const live = () => mounted.current && attempt.current === mine && feishuGeneration.current === mineFeishu;
        queueMicrotask(() => {
          /*
           * The cancel is awaited rather than fired alongside, and its failure is fatal to the
           * switch: `createOrReuse` hands back the attempt that is still awaiting a scan, so
           * creating after a cancel that did not land returns the very code the reader asked to
           * leave — a switch that silently does nothing. Better to say it failed.
           */
          const released = superseded ? browserApi.cancelFeishuSetupAttempt(superseded) : Promise.resolve();
          void released
            .then(() => (live() ? browserApi.createFeishuSetupAttempt(agent.id, "create", brand) : undefined))
            .then(
              (created) => {
                if (!live() || !created) return;
                feishuAttemptId.current = created.id;
                setMessaging(
                  created.qrUrl
                    ? { kind: "waiting", qrValue: created.qrUrl, brand: created.brand }
                    : { kind: "issuing" },
                );
                pollFeishu(created.id, live);
              },
              (cause: unknown) => {
                if (!live()) return;
                setMessaging({ kind: "failed" });
                setActionError(errorMessage(cause, COPY.errors.messaging));
              },
            );
        });
        return { kind: "issuing" };
      });

      function pollFeishu(attemptId: string, live: () => boolean) {
        /*
         * Each poll clears its own handle, never the shared ref. A request that was already in
         * flight when the reader switched brand resolves *after* the replacement poll is installed,
         * and the ref by then names the new interval — so clearing through it would stop watching
         * the code that is actually on screen, and nothing would ever re-arm it.
         *
         * The ref is still held, because `reset()` has no handle of its own: without it a Start
         * over left the previous attempt running, and its eventual success connected the messaging
         * app of a flow that no longer existed.
         */
        window.clearInterval(feishuTimer.current);
        const handle = window.setInterval(() => {
          if (!live()) {
            window.clearInterval(handle);
            return;
          }
          void browserApi.feishuSetupAttempt(attemptId).then(
            (current) => {
              if (!live()) {
                window.clearInterval(handle);
                return;
              }
              if (current.state === "succeeded") {
                window.clearInterval(handle);
                setMessaging({ kind: "waiting-handoff" });
                return;
              }
              if (current.state === "failed" || current.state === "expired" || current.state === "canceled") {
                window.clearInterval(handle);
                setMessaging({ kind: "failed" });
                setActionError(m.onboarding_v2_errors_feishu_attempt({ provider: messagingProviderLabel("feishu") }));
                return;
              }
              if (current.qrUrl) setMessaging({ kind: "waiting", qrValue: current.qrUrl, brand: current.brand });
            },
            () => undefined,
          );
        }, FEISHU_POLL_MS);
        feishuTimer.current = handle;
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
    setComputerPollEpoch((current) => current + 1);
    window.clearInterval(feishuTimer.current);
    feishuAttemptId.current = undefined;
    feishuGeneration.current += 1;
    creationRef.current = "idle";
    setMessaging({ kind: "idle" });
    setAgent(undefined);
    setCreation("idle");
    setResuming(false);
    setResumeError(undefined);
    setResumeBlocked(undefined);
    setActionError(undefined);
    setPastComputerStep(false);
    setLastPassedReadiness(undefined);
  }, []);

  /** Reads the Account again after a failed read, which is the only way out of that state. */
  const retryResume = useCallback(() => {
    void readAccount();
  }, [readAccount]);

  const startPlanSignIn = useCallback(() => undefined, []);
  const markPastComputerStep = useCallback(() => setPastComputerStep(true), []);

  const computerOnline =
    selectedComputer?.availability === "online"
      ? true
      : selectedComputer?.availability === "offline"
        ? false
        : undefined;
  const knownComputers = selectedComputer ? [selectedComputer] : [];

  const liveReadiness = useMemo(
    () => (computer?.connectionStatus === "online" ? readReadiness(computer, draft.runtime) : undefined),
    [computer, draft.runtime],
  );
  useEffect(() => {
    if (readinessPassed(liveReadiness, draft.runtime)) setLastPassedReadiness(liveReadiness);
  }, [draft.runtime, liveReadiness]);
  const readiness = liveReadiness ?? (pastComputerStep ? lastPassedReadiness : undefined);

  return useMemo(
    () => ({
      agent,
      computerOnline,
      computerConnected,
      createAgent,
      creation,
      error: actionError,
      knownComputers,
      markPastComputerStep,
      messaging,
      messagingProvider,
      planSignIn,
      readiness,
      reset,
      resumeError,
      resumeBlocked,
      resuming,
      retryResume,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
      selectedComputerId: selectedComputer?.id,
    }),
    [
      actionError,
      agent,
      computerOnline,
      computerConnected,
      createAgent,
      creation,
      knownComputers,
      markPastComputerStep,
      messaging,
      messagingProvider,
      planSignIn,
      readiness,
      reset,
      resumeError,
      resumeBlocked,
      resuming,
      retryResume,
      startMessaging,
      startPlanSignIn,
      startSlackInstall,
      selectedComputer?.id,
    ],
  );
}
