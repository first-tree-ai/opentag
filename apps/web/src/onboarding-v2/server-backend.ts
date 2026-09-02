/**
 * The flow, against the real Server.
 *
 * Everything outside the shared ComputerConnect lifecycle is polled rather than pushed, because
 * that is what the Server offers. This adapter observes the selected Computer's availability and
 * readiness; issuance, redemption, expiry and reissue belong to ComputerConnect.
 */

import type {
  AccountComputerSummary,
  AgentListItem,
  AgentRuntimeProvider,
  ImBindingHandoffStatus,
} from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserApi } from "../api.js";
import type { ComputerConnectAdapter } from "../features/computer-connect/computer-connect.js";
import { formatRelativeTime } from "../i18n/format.js";
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

type AccountResumeSelection =
  | { kind: "none" }
  | { computer: AccountComputerSummary; kind: "computer" }
  | {
      agent: AgentListItem;
      boundComputer?: NonNullable<AgentListItem["computer"]>;
      kind: "agent";
      observedComputer?: AccountComputerSummary;
    };

function selectAccountResume(
  agents: readonly AgentListItem[],
  computers: readonly AccountComputerSummary[],
): AccountResumeSelection {
  const active = agents.filter((candidate) => candidate.status === "active");
  if (active.length === 0) {
    const computer = computers.find((candidate) => candidate.connectionStatus === "online") ?? computers[0];
    return computer ? { computer, kind: "computer" } : { kind: "none" };
  }
  const byId = new Map(computers.map((computer) => [computer.computerId, computer]));
  const bound = active.flatMap((agent) => (agent.computer ? [{ agent, computer: agent.computer }] : []));
  const selected =
    bound.find(({ computer }) => byId.get(computer.computerId)?.connectionStatus === "online") ?? bound[0];
  const agent = selected?.agent ?? active[0];
  if (!agent) return { kind: "none" };
  return {
    agent,
    kind: "agent",
    ...(selected ? { boundComputer: selected.computer, observedComputer: byId.get(selected.computer.computerId) } : {}),
  };
}

function knownComputer(computer: AccountComputerSummary): KnownComputer {
  return {
    id: computer.computerId,
    displayName: computer.displayName,
    availability: computer.connectionStatus,
    lastSeen: computer.lastSeenAt ? formatRelativeTime(computer.lastSeenAt) : undefined,
  };
}

function knownBoundComputer(
  computer: NonNullable<AgentListItem["computer"]>,
  observed: AccountComputerSummary | undefined,
): KnownComputer {
  return {
    id: computer.computerId,
    displayName: observed?.displayName ?? computer.displayName,
    availability: observed?.connectionStatus ?? "unknown",
    lastSeen: observed?.lastSeenAt ? formatRelativeTime(observed.lastSeenAt) : undefined,
  };
}

async function readMessagingProvider(agentId: string): Promise<MessagingProvider | undefined> {
  try {
    const binding = await browserApi.imBinding(agentId);
    return binding?.provider === "feishu" || binding?.provider === "slack" ? binding.provider : undefined;
  } catch {
    return undefined;
  }
}

async function deleteSetupAgent(agentId: string): Promise<void> {
  // A retry may arrive after suspension already succeeded, so a failed suspend does not prevent
  // the idempotent delete attempt from recovering the flow. The delete response is authoritative.
  try {
    await browserApi.suspendAgent(agentId);
  } catch {
    // The Agent may already be suspended after an interrupted earlier attempt.
  }
  await browserApi.deleteAgent(agentId);
}

/**
 * The draft is observed, not owned: the page holds it, and this hook only needs the runtime from it
 * so a readiness read asks about the Provider the reader actually chose. Taking it as an argument
 * keeps that dependency visible instead of threading it through every call.
 */
export function useServerBackend(draft: AgentDraft): OnboardingBackend {
  const [computer, setComputer] = useState<AccountComputerSummary>();
  const [selectedComputer, setSelectedComputer] = useState<KnownComputer>();
  const [messaging, setMessaging] = useState<MessagingState>({ kind: "idle" });
  const [messagingProvider, setMessagingProvider] = useState<MessagingProvider>();
  const [agent, setAgent] = useState<CreatedAgent>();
  const [agentRestored, setAgentRestored] = useState(false);
  const [resumeBlocked, setResumeBlocked] = useState<{ agentId: string; agentName: string }>();
  const [discardingAgent, setDiscardingAgent] = useState(false);
  const [computerPreviouslyConfirmed, setComputerPreviouslyConfirmed] = useState(false);
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
  const [pastComputerStep, setPastComputerStep] = useState(false);
  const [lastPassedReadiness, setLastPassedReadiness] = useState<ReadinessFacts>();
  const [computerPollEpoch, setComputerPollEpoch] = useState(0);
  const computerPollEpochRef = useRef(computerPollEpoch);
  computerPollEpochRef.current = computerPollEpoch;
  /** Discards the reply of a read the reader has already asked to redo. */
  const resumeRun = useRef(0);

  /** The Computer this run connected. Messaging and creation both need it after the step is left. */
  const computerId = useRef<string | undefined>(undefined);
  /** Bumped by reset and unmount so replies from an abandoned run are discarded. */
  const attempt = useRef(0);
  const creationRef = useRef<CreationState>("idle");
  const feishuTimer = useRef(0);
  const mounted = useRef(true);
  const discardRunning = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
      window.clearInterval(feishuTimer.current);
    };
  }, []);

  const applyResumeSelection = useCallback((selected: AccountResumeSelection): string | undefined => {
    // A fresh read replaces what the previous read selected rather than merging into it:
    // whatever the Account no longer reports is gone, and retaining it would let a stale
    // Agent answer for — or be deleted in place of — the state the page is showing now.
    creationRef.current = "idle";
    computerId.current = undefined;
    setAgent(undefined);
    setAgentRestored(false);
    setResumeBlocked(undefined);
    setComputerPreviouslyConfirmed(false);
    setCreation("idle");
    setMessaging({ kind: "idle" });
    setMessagingProvider(undefined);
    setComputer(undefined);
    setSelectedComputer(undefined);
    if (selected.kind === "none") return undefined;
    if (selected.kind === "computer") {
      computerId.current = selected.computer.computerId;
      setComputer(selected.computer);
      setSelectedComputer(knownComputer(selected.computer));
      return undefined;
    }
    const resumed = selected.agent;
    if (!selected.boundComputer) {
      setResumeBlocked({ agentId: resumed.id, agentName: resumed.displayName });
      return undefined;
    }
    setAgent({ id: resumed.id, name: resumed.name, runtimeProvider: resumed.runtimeProvider });
    setAgentRestored(true);
    creationRef.current = "created";
    setCreation("created");
    setComputerPreviouslyConfirmed(true);
    computerId.current = selected.boundComputer.computerId;
    setSelectedComputer(knownBoundComputer(selected.boundComputer, selected.observedComputer));
    if (selected.observedComputer) setComputer(selected.observedComputer);
    return resumed.id;
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
      const [{ agents }, { computers }] = await Promise.all([browserApi.agents(), browserApi.computers()]);
      if (!live()) return;
      const selected = selectAccountResume(agents, computers);
      const resumedAgentId = applyResumeSelection(selected);
      if (!resumedAgentId) return;

      const handoff = await browserApi.imBindingHandoff(resumedAgentId);
      if (!live()) return;
      setMessaging(readMessaging(handoff));
      if (!handoff) return;
      const provider = await readMessagingProvider(resumedAgentId);
      if (live() && provider) setMessagingProvider(provider);
    } catch (cause) {
      // Reading is the only way to tell a returning Account from a new one, so a failed read is
      // not "you must be new": starting over from here ends at a name collision. It is reported,
      // and the reader is given the read back rather than a form they cannot submit.
      if (live()) setResumeError(errorMessage(cause, COPY.errors.resume));
    } finally {
      if (live()) setResuming(false);
    }
  }, [applyResumeSelection]);

  useEffect(() => {
    void readAccount();
  }, [readAccount]);

  const computerConnected = useCallback((connected: AccountComputerSummary) => {
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
    if (!draft.runtime || creationRef.current !== "idle") return;
    const mine = attempt.current;
    creationRef.current = "creating";
    setCreation("creating");
    setActionError(undefined);
    void browserApi
      .createAgent({
        name: draft.name,
        displayName: draft.name,
        runtimeProvider: draft.runtime,
        ...(id ? { computerId: id } : {}),
      })
      .then(
        (created) => {
          if (!mounted.current || attempt.current !== mine) return;
          creationRef.current = "created";
          setCreation("created");
          setAgentRestored(false);
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
                setActionError(m.onboarding_v2_errors_feishu_attempt({ provider: messagingProviderLabel("feishu") }));
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

  const discardAgent = useCallback(async (): Promise<boolean> => {
    // The confirmation names exactly one Agent: the blocked screen takes the whole page when
    // it is shown, and only without it does the Computer step name the restored Agent. Delete
    // only the Agent that was named — never a stale one retained from an earlier read.
    const targetId = resumeBlocked?.agentId ?? agent?.id;
    if (!targetId || discardRunning.current) return false;
    discardRunning.current = true;
    setDiscardingAgent(true);
    setActionError(undefined);
    attempt.current += 1;
    window.clearInterval(feishuTimer.current);
    try {
      await deleteSetupAgent(targetId);
      if (!mounted.current) return false;
      creationRef.current = "idle";
      setAgent(undefined);
      setAgentRestored(false);
      setResumeBlocked(undefined);
      setCreation("idle");
      setMessaging({ kind: "idle" });
      setMessagingProvider(undefined);
      setComputerPreviouslyConfirmed(false);
      setPastComputerStep(false);
      setLastPassedReadiness(undefined);
      await readAccount();
      return true;
    } catch (cause) {
      if (mounted.current) setActionError(errorMessage(cause, COPY.errors.discardAgent));
      return false;
    } finally {
      discardRunning.current = false;
      if (mounted.current) setDiscardingAgent(false);
    }
  }, [agent?.id, readAccount, resumeBlocked?.agentId]);

  const reset = useCallback(() => {
    attempt.current += 1;
    setComputerPollEpoch((current) => current + 1);
    window.clearInterval(feishuTimer.current);
    creationRef.current = "idle";
    setMessaging({ kind: "idle" });
    setAgent(undefined);
    setAgentRestored(false);
    setResumeBlocked(undefined);
    setComputerPreviouslyConfirmed(false);
    setCreation("idle");
    setResuming(false);
    setResumeError(undefined);
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

  const computerConnectAdapter = useMemo<ComputerConnectAdapter | undefined>(() => {
    // The same displayed recovery target as discardAgent: a blocked screen's Agent first,
    // then the Agent the Computer step is showing.
    const targetAgentId = resumeBlocked?.agentId ?? agent?.id;
    if (!targetAgentId) return undefined;
    return {
      issue: (intent) =>
        browserApi.issueComputerConnectCode(
          intent.mode === "repair"
            ? {
                mode: "repair",
                targetAgentId,
                targetComputerId: intent.target.computerId,
              }
            : { mode: "create", targetAgentId },
        ),
      status: (connectCodeId) => browserApi.computerConnectCodeStatus(connectCodeId),
      computers: () => browserApi.computers(),
    };
  }, [agent?.id, resumeBlocked?.agentId]);

  return useMemo(
    () => ({
      agent,
      agentRestored,
      computerConnectAdapter,
      computerOnline,
      computerConnected,
      createAgent,
      creation,
      discardAgent,
      discardingAgent,
      error: actionError,
      knownComputers,
      markPastComputerStep,
      messaging,
      messagingProvider,
      planSignIn,
      readiness,
      reset,
      computerPreviouslyConfirmed,
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
      agentRestored,
      computerConnectAdapter,
      computerOnline,
      computerConnected,
      createAgent,
      creation,
      discardAgent,
      discardingAgent,
      knownComputers,
      markPastComputerStep,
      messaging,
      messagingProvider,
      planSignIn,
      readiness,
      reset,
      computerPreviouslyConfirmed,
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
