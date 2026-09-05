/**
 * Agent Setup: the canonical setup surface for one exact Agent.
 *
 * Everything on this page is read out of the F0 `AgentSetupSnapshot`: the stage, the Computer and
 * runtime identities, the Messaging Provider, the blockers, and — most importantly — the actions.
 * Nothing here guesses from inventory, and no stage is synthesized on the page; the snapshot the
 * adapter returns is the whole truth the page renders. That is what makes Provider identity safe
 * across a Slack round trip: the browser leaves and comes back to a fresh mount, and the waiting
 * app is still the one the snapshot names, not one a destroyed page once chose.
 *
 * The actions map one-to-one onto the shared contract. Messaging can be started only from a
 * not-configured snapshot; a current binding is reauthorized (or, for Feishu, replaced) in place;
 * moving to a different Provider is an explicit unbind followed by the fresh choice the cleared
 * snapshot then offers. There is no direct switch.
 */

import type {
  AgentSetupAction,
  AgentSetupSnapshot,
  ImProvider,
  ProviderCliHandoffProgress,
} from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "../api.js";
import { AgentComputerChoice, type AgentComputerInventoryAdapter } from "../features/agents/agent-computer-choice.js";
import { platformLabel } from "../features/agents/agent-presentation.js";
import {
  ComputerConnect,
  type ComputerConnectAdapter,
  createAgentTargetedComputerConnectAdapter,
} from "../features/computer-connect/computer-connect.js";
import { isTerminalResourceError } from "../features/resource/resource-state.js";
import { formatDateTime, spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderAlternateBrand, messagingProviderLabel } from "../im/provider-label.js";
import { slackConfigurationMessage } from "../im/slack-configuration.js";
import * as m from "../paraglide/messages.js";
import { QrCode, WAITING_LINE } from "../setup/index.js";
import { Banner, Button, Dialog, Icon, Loader, StatusIndicator, type StatusTone, Text } from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { BrandMark } from "./brand-mark.js";
import type { FlowState } from "./flow.js";
import { providerCliWaitingCopy } from "./messaging-readiness-copy.js";
import "./onboarding-v2.css";
import { preparationIsTransitional, preparationSummaryRows } from "./preparation-readiness.js";
import { CheckLine } from "./readiness-list.js";
import { type AgentSetupAdapter, createHttpSetupAdapter } from "./setup-adapter.js";
import { CardCopy, DoneStep, StepRail } from "./steps.js";

/** The snapshot doubles as the observation channel while the outside world is expected to move it. */
const SETUP_POLL_MS = 2_000;
/** How many times to report readiness before the reader is offered an explicit retry. */
const READY_REPORT_ATTEMPTS = 3;
/**
 * The finite budget for automatic local-preparation polls (a required IM CLI still waiting or
 * checking behind the gate, a Runtime report missing or still checking): 30 polls at 2s is
 * roughly a one-minute observation window. Exhaustion stops the timer; an explicit Check again
 * restarts a fresh window. The budget never resets on an unchanged snapshot, and
 * Messaging/offline observation keeps its unbounded beat.
 */
const BOUNDED_POLL_ATTEMPTS = 30;

/**
 * Arms one automatic-read observation window. The window is single-flight across effect
 * restarts: an automatic read an earlier window started is awaited before a new one begins, and
 * a manual refresh deliberately supersedes its reply through the request lifecycle instead.
 */
function armAutomaticPollWindow(
  pollClass: Exclude<SetupPollClass, undefined>,
  budget: { current: number },
  inFlight: { current: Promise<boolean> | undefined },
  read: () => Promise<boolean>,
): () => void {
  let cancelled = false;
  let timer: number | undefined;
  const poll = async (): Promise<void> => {
    let turn = inFlight.current;
    if (turn === undefined) {
      if (pollClass === "bounded") budget.current -= 1;
      turn = read();
      inFlight.current = turn;
    }
    await turn;
    if (inFlight.current === turn) inFlight.current = undefined;
    if (cancelled) return;
    if (pollClass === "bounded" && budget.current <= 0) return;
    timer = window.setTimeout(() => void poll(), SETUP_POLL_MS);
  };
  timer = window.setTimeout(() => void poll(), SETUP_POLL_MS);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

const SECTION = "flex flex-col gap-6";
const SECTION_HEADER = "flex flex-col gap-1";
const HINT = "text-sm text-kumo-subtle m-0";
const CHOICE_GRID = "otv2-choices--grid grid gap-3 m-0 p-0 list-none";
const CARD =
  "otv2-choice flex w-full items-center gap-4 rounded-xl bg-kumo-base p-4 ring ring-kumo-line cursor-pointer";
const IDENTITY_ROW = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3";

export interface AgentSetupPageProps {
  /** The exact Agent this surface sets up. Never an index, a name, or a guess. */
  readonly agentId: string;
  /** Defaults to the HTTP adapter over the browser API; tests and the lab pass the in-memory one. */
  readonly adapter?: AgentSetupAdapter;
  /** Keeps Computer inventory, binding, and connect-code work behind the Lab's in-memory seam. */
  readonly computerAdapter?: {
    readonly connect: ComputerConnectAdapter;
    readonly inventory: AgentComputerInventoryAdapter;
  };
  /** An external Lab mutation asks the mounted page to re-read without resetting its local UI. */
  readonly refreshSignal?: number;
  /** Review Lab intercepts Provider URLs so a simulated OAuth round trip stays inside the Lab. */
  readonly onExternalNavigation?: (url: string) => void;
  /** Returns to this exact Agent; Setup presents it as Back before ready and Open after ready. */
  readonly onOpenAgent?: () => void;
  /** Told once the snapshot's stage is `ready`, so the route can mark setup complete. */
  readonly onReady?: (agentId: string) => Promise<void> | void;
  /** A staging Re-board stays inspectable until the tester explicitly finishes the review. */
  readonly reviewMode?: boolean;
  /** A Slack callback failure to surface once after the fixed return route remounts. */
  readonly slackOAuthError?: string;
}

type SetupPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "load-failed"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: AgentSetupSnapshot };

type SetupPollClass = "bounded" | "unbounded" | undefined;

/**
 * How a snapshot the outside world is still moving should be watched. Messaging authorizing,
 * waiting-handoff, and an offline Computer keep the existing unbounded beat. Local preparation
 * polls inside a finite budget only while a leg is genuinely transitional: a required IM CLI
 * whose report is missing or still checking, or a Runtime report missing or still
 * checking. A settled manual-action failure (install, sign-in, unavailable) never polls on its
 * own — nothing on this page can install, sign in, or repair a CLI. Check again or returning
 * to this page retrieves a fresh snapshot after an operator acts.
 */
function snapshotPollClass(snapshot: AgentSetupSnapshot): SetupPollClass {
  if (snapshot.messaging.kind === "authorizing" || snapshot.messaging.kind === "waiting-handoff") return "unbounded";
  if (snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "offline") return "unbounded";
  if (
    (snapshot.stage === "needs-runtime" || snapshot.stage === "needs-provider-clis") &&
    preparationIsTransitional(snapshot)
  )
    return "bounded";
  if (snapshot.runtime.kind === "waiting") return "bounded";
  if (snapshot.runtime.kind === "observed" && snapshot.runtime.status === "checking") return "bounded";
  return undefined;
}

/** A snapshot the outside world is still moving: read it again on a beat until it settles. */
export function setupSnapshotIsTransitional(snapshot: AgentSetupSnapshot): boolean {
  return snapshotPollClass(snapshot) !== undefined;
}

function setupReadError(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : m.onboarding_v2_setup_load_failed();
}

function isTerminalSetupReadError(cause: unknown): boolean {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  return isTerminalResourceError(error) || (error instanceof ApiError && error.code === "AGENT_LIFECYCLE_CONFLICT");
}

function providerTitle(provider: ImProvider): string {
  return messagingProviderLabel(provider);
}

/* One recovery message per known Server code, then a per-Provider fallback. */
const FEISHU_ACTION_ERRORS: Record<string, () => string> = {
  FEISHU_APP_ALREADY_BOUND: () => m.im_feishu_app_already_connected({ provider: providerTitle("feishu") }),
  FEISHU_SCOPE_REAUTH_REQUIRED: () => m.im_feishu_permissions_missing({ provider: providerTitle("feishu") }),
  IM_BINDING_SCOPE_REAUTH_REQUIRED: () => m.im_feishu_permissions_missing({ provider: providerTitle("feishu") }),
  FEISHU_UPSTREAM_UNAVAILABLE: () => m.im_feishu_unavailable({ provider: providerTitle("feishu") }),
};

function setupActionErrorMessage(action: AgentSetupAction, cause: unknown): string {
  if (cause instanceof ApiError && cause.code === "IM_BINDING_UNBIND_REQUIRED" && cause.unbindRequired) {
    return spaceScriptBoundary(
      m.onboarding_v2_setup_messaging_switch_required({
        current: providerTitle(cause.unbindRequired.currentProvider),
        requested: providerTitle(cause.unbindRequired.requestedProvider),
      }),
    );
  }
  if (action.kind === "unbind-messaging") {
    return spaceScriptBoundary(m.im_disconnect_failed({ providerName: providerTitle(action.provider) }));
  }
  if (action.kind === "cancel-messaging-attempt") {
    return spaceScriptBoundary(m.im_feishu_cancel_failed({ provider: providerTitle("feishu") }));
  }
  const provider = "provider" in action ? action.provider : undefined;
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (provider === "slack" && code) return spaceScriptBoundary(slackConfigurationMessage(code));
  const known = code === undefined ? undefined : FEISHU_ACTION_ERRORS[code];
  if (known) return spaceScriptBoundary(known());
  return provider === "slack"
    ? spaceScriptBoundary(m.im_slack_authorization_failed({ provider: providerTitle("slack") }))
    : spaceScriptBoundary(m.im_feishu_authorization_failed({ provider: providerTitle("feishu") }));
}

function slackSetupErrorMessage(code: string): string {
  return spaceScriptBoundary(slackConfigurationMessage(code));
}

/**
 * Performs the write side of an action. `bind-computer` and `repair-computer` are absent: they
 * gate the surfaces that do the work, and those surfaces report back on their own. A Slack answer
 * is a URL to leave for; every other action is followed by a fresh read.
 */
async function performSetupAction(
  adapter: AgentSetupAdapter,
  agentId: string,
  action: AgentSetupAction,
): Promise<string | undefined> {
  switch (action.kind) {
    case "refresh":
      await adapter.refreshPreparation(agentId);
      return undefined;
    case "start-messaging":
      if (action.provider === "feishu") {
        await adapter.startFeishuAttempt(agentId, "create", { kind: "unbound" });
        return undefined;
      }
      return adapter.startSlackInstall(agentId, "create", { kind: "unbound" });
    case "cancel-messaging-attempt":
      await adapter.cancelFeishuAttempt(action.attemptId);
      return undefined;
    case "reauthorize-messaging":
      if (action.provider === "feishu") {
        await adapter.startFeishuAttempt(agentId, "reauthorize", {
          kind: "bound",
          provider: "feishu",
          bindingId: action.bindingId,
          credentialGeneration: action.credentialGeneration,
        });
        return undefined;
      }
      return adapter.startSlackInstall(agentId, "reauthorize", {
        kind: "bound",
        provider: "slack",
        bindingId: action.bindingId,
        credentialGeneration: action.credentialGeneration,
      });
    case "replace-messaging":
      await adapter.startFeishuAttempt(agentId, "replace", {
        kind: "bound",
        provider: "feishu",
        bindingId: action.bindingId,
        credentialGeneration: action.credentialGeneration,
      });
      return undefined;
    case "unbind-messaging":
      await adapter.unbindMessaging(agentId, action.provider, action.bindingId);
      return undefined;
    default:
      return undefined;
  }
}

/**
 * One numbered sequence of reads and writes per mounted target. `next` starts a read; `hold`
 * freezes the on-screen snapshot while a write is in flight; `isCurrent` lets any reply find out
 * whether something newer has already superseded it. Retired on unmount and on target change.
 */
interface RequestLifecycle {
  readonly next: () => number;
  readonly hold: () => void;
  readonly isCurrent: (ticket: number) => boolean;
}

function useRequestLifecycle(): RequestLifecycle {
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Retire everything still in flight: nothing an unmounted target asked for may land.
      generation.current += 1;
    };
  }, []);
  return useMemo(
    () => ({
      next: () => ++generation.current,
      hold: () => {
        generation.current += 1;
      },
      isCurrent: (ticket: number) => mounted.current && generation.current === ticket,
    }),
    [],
  );
}

function useSnapshotReader(
  agentId: string,
  adapter: AgentSetupAdapter,
  lifecycle: RequestLifecycle,
): { phase: SetupPhase; refreshError: string | undefined; read: () => Promise<boolean> } {
  const [phase, setPhase] = useState<SetupPhase>({ kind: "loading" });
  const [refreshError, setRefreshError] = useState<string>();
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  /*
   * A terminal answer fails closed: an Agent the Server will not show this Account is not a
   * thing to retry, and falling through to any creation path would collide with reality.
   * Over a good snapshot a failed re-read is said beside it; the snapshot itself stays put.
   */
  const failRead = useCallback((cause: unknown) => {
    if (isTerminalSetupReadError(cause)) {
      setRefreshError(undefined);
      setPhase({ kind: "unavailable" });
      return;
    }
    if (phaseRef.current.kind === "ready") setRefreshError(setupReadError(cause));
    else setPhase({ kind: "load-failed", message: setupReadError(cause) });
  }, []);

  const read = useCallback(async (): Promise<boolean> => {
    const ticket = lifecycle.next();
    try {
      const snapshot = await adapter.readSnapshot(agentId);
      if (!lifecycle.isCurrent(ticket)) return false;
      setRefreshError(undefined);
      setPhase({ kind: "ready", snapshot });
      return true;
    } catch (cause) {
      if (!lifecycle.isCurrent(ticket)) return false;
      failRead(cause);
      return false;
    }
  }, [adapter, agentId, lifecycle, failRead]);

  useEffect(() => {
    setPhase({ kind: "loading" });
    setRefreshError(undefined);
    void read();
  }, [read]);

  return { phase, refreshError, read };
}

function useSetupActions(
  agentId: string,
  adapter: AgentSetupAdapter,
  lifecycle: RequestLifecycle,
  read: () => Promise<boolean>,
  onExternalNavigation?: AgentSetupPageProps["onExternalNavigation"],
): {
  actionError: string | undefined;
  busyKey: AgentSetupAction["kind"] | undefined;
  act: (action: AgentSetupAction) => Promise<boolean>;
} {
  const [actionError, setActionError] = useState<string>();
  const [busyKey, setBusyKey] = useState<AgentSetupAction["kind"]>();
  const busyRef = useRef(false);
  const actionRun = useRef(0);

  useEffect(() => {
    busyRef.current = false;
    return () => {
      actionRun.current += 1;
    };
  }, []);

  const act = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: action lifecycle intentionally stays atomic across navigation, refresh, and stale-tab recovery
    async (action: AgentSetupAction): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusyKey(action.kind);
      setActionError(undefined);
      // A poll started before the write could commit the state the write just made obsolete; the
      // hold keeps the on-screen snapshot frozen until the post-action read lifts it.
      lifecycle.hold();
      const mine = ++actionRun.current;
      const live = () => actionRun.current === mine;
      try {
        const navigate = await performSetupAction(adapter, agentId, action);
        if (!live()) return false;
        if (navigate !== undefined) {
          if (onExternalNavigation) onExternalNavigation(navigate);
          else window.location.assign(navigate);
          return true;
        }
        return await read();
      } catch (cause) {
        const message = setupActionErrorMessage(action, cause);
        // Another tab may have connected a Provider after this snapshot advertised a fresh start.
        // The structured conflict names that exact current binding; immediately re-read the
        // canonical snapshot so this tab replaces stale provider buttons with its unbind action.
        if (cause instanceof ApiError && cause.code === "IM_BINDING_UNBIND_REQUIRED" && cause.unbindRequired) {
          await read();
        }
        if (live()) setActionError(message);
        return false;
      } finally {
        if (live()) {
          busyRef.current = false;
          setBusyKey(undefined);
        }
      }
    },
    [adapter, agentId, lifecycle, onExternalNavigation, read],
  );

  return { actionError, busyKey, act };
}

interface AgentSetupController {
  readonly phase: SetupPhase;
  /** A background re-read that failed over a good snapshot. The snapshot stays; this is said beside it. */
  readonly refreshError: string | undefined;
  /** The last action's failure, in words that name what was being attempted. */
  readonly actionError: string | undefined;
  /** Which action kind is in flight, so every action control can refuse a second submission. */
  readonly busyKey: AgentSetupAction["kind"] | undefined;
  /** Runs one snapshot-listed action to completion and re-reads. Resolves false when it failed. */
  readonly act: (action: AgentSetupAction) => Promise<boolean>;
  /** A silent re-read, for surfaces that finished their own work (a bind, a repair). */
  readonly reload: () => void;
  /** An explicit Check again restarts the finite local-preparation observation window. */
  readonly resetPollBudget: () => void;
}

function useAgentSetup(
  agentId: string,
  adapter: AgentSetupAdapter,
  onExternalNavigation?: AgentSetupPageProps["onExternalNavigation"],
): AgentSetupController {
  const lifecycle = useRequestLifecycle();
  const reader = useSnapshotReader(agentId, adapter, lifecycle);
  const actions = useSetupActions(agentId, adapter, lifecycle, reader.read, onExternalNavigation);

  const snapshot = reader.phase.kind === "ready" ? reader.phase.snapshot : undefined;
  const pollClass = snapshot === undefined ? undefined : snapshotPollClass(snapshot);
  const pollBudget = useRef(BOUNDED_POLL_ATTEMPTS);
  /**
   * The one automatic read the mounted controller allows at a time. A manual refresh deliberately
   * supersedes a pending automatic read through the request lifecycle, but a new poll effect must
   * never start a second automatic read while an earlier one is still in flight.
   */
  const autoPollInFlight = useRef<Promise<boolean> | undefined>(undefined);
  // A stateful restart signal: an explicit Check again must reopen a bounded observation window
  // even when the busyKey updates around the refresh are collapsed into one render.
  const [pollRestartKey, setPollRestartKey] = useState(0);
  /** An explicit Check again opens a fresh bounded observation window. */
  const resetPollBudget = useCallback(() => {
    pollBudget.current = BOUNDED_POLL_ATTEMPTS;
    setPollRestartKey((value) => value + 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pollRestartKey explicitly restarts the observation window.
  useEffect(() => {
    if (pollClass === undefined || actions.busyKey !== undefined) return;
    return armAutomaticPollWindow(pollClass, pollBudget, autoPollInFlight, reader.read);
  }, [pollClass, actions.busyKey, pollRestartKey, reader.read]);

  /*
   * A window or tab returning to view re-reads the canonical snapshot: the outside world (a
   * daemon reconnect, a Runtime report, a handoff) may have moved it while the reader was away.
   * The refresh rides the same request lifecycle as every other read — a reply superseded by a
   * newer read or by an action is discarded, a transient failure over a good snapshot keeps the
   * last-good snapshot on screen, and the automatic poll window never overlaps itself — and it
   * is skipped while an action is in flight and when no snapshot is on screen yet (loading,
   * load-failed, and unavailable keep their own manual flows).
   */
  useEffect(() => {
    if (actions.busyKey !== undefined || reader.phase.kind !== "ready") return;
    let cancelled = false;
    let returnRead: Promise<boolean> | undefined;
    const refreshOnReturn = (): void => {
      if (document.visibilityState !== "visible" || returnRead !== undefined) return;
      resetPollBudget();
      const pending = autoPollInFlight.current;
      // A return queues one fresh read behind an existing poll, never another concurrent one.
      const turn =
        pending === undefined
          ? reader.read()
          : pending.then(() => (cancelled || document.visibilityState !== "visible" ? false : reader.read()));
      returnRead = turn;
      autoPollInFlight.current = turn;
      void turn.then(() => {
        if (returnRead === turn) returnRead = undefined;
        if (autoPollInFlight.current === turn) autoPollInFlight.current = undefined;
      });
    };
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    window.addEventListener("pageshow", refreshOnReturn);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      window.removeEventListener("pageshow", refreshOnReturn);
    };
  }, [actions.busyKey, reader.phase.kind, reader.read, resetPollBudget]);

  const reload = useCallback(() => void reader.read(), [reader.read]);
  return { ...reader, ...actions, reload, resetPollBudget };
}

type ReadyReport = { readonly onFinish: () => void; readonly state: "failed" | "pending" | "ready" } | undefined;

/**
 * Reporting readiness once the stage is `ready`. Reported from the render that first sees it —
 * not from the button that happened to produce it — so it is true for a reader who arrives
 * already finished. Refusals get a small bounded budget, then an explicit retry.
 */
function useReadyReport(
  snapshot: AgentSetupSnapshot | undefined,
  agentId: string,
  onReady: AgentSetupPageProps["onReady"],
  reviewMode: boolean,
): ReadyReport {
  const reported = useRef<string | undefined>(undefined);
  const [reportAttempt, setReportAttempt] = useState(0);
  const [reportFailed, setReportFailed] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  useEffect(() => {
    if (snapshot?.stage !== "ready" || !onReady) return;
    if (reported.current === agentId || reportFailed || (reviewMode && !reviewConfirmed)) return;
    // Claimed before the call so a re-render cannot report twice, and released if it fails.
    reported.current = agentId;
    let live = true;
    void Promise.resolve(onReady(agentId)).catch(() => {
      if (!live) return;
      reported.current = undefined;
      if (reportAttempt + 1 < READY_REPORT_ATTEMPTS) setReportAttempt(reportAttempt + 1);
      else setReportFailed(true);
    });
    return () => {
      live = false;
    };
  }, [snapshot?.stage, agentId, onReady, reportAttempt, reportFailed, reviewMode, reviewConfirmed]);

  if (!onReady) return undefined;
  if (reportFailed) {
    return {
      onFinish: () => {
        setReportAttempt(0);
        setReportFailed(false);
      },
      state: "failed",
    };
  }
  if (reviewMode) return { onFinish: () => setReviewConfirmed(true), state: reviewConfirmed ? "pending" : "ready" };
  return undefined;
}

export function AgentSetupPage({
  agentId,
  adapter,
  computerAdapter,
  onExternalNavigation,
  onOpenAgent,
  onReady,
  refreshSignal,
  reviewMode = false,
  slackOAuthError,
}: AgentSetupPageProps) {
  const resolvedAdapter = useMemo(() => adapter ?? createHttpSetupAdapter(), [adapter]);
  // Keyed on the exact target: a different Agent's setup is a different task, and remounting is
  // what retires everything the previous one still had in flight.
  return (
    <AgentSetupPageContent
      adapter={resolvedAdapter}
      agentId={agentId}
      computerAdapter={computerAdapter}
      key={agentId}
      onExternalNavigation={onExternalNavigation}
      onOpenAgent={onOpenAgent}
      onReady={onReady}
      refreshSignal={refreshSignal}
      reviewMode={reviewMode}
      slackOAuthError={slackOAuthError}
    />
  );
}

function AgentSetupPageContent({
  agentId,
  adapter,
  computerAdapter,
  onExternalNavigation,
  onOpenAgent,
  onReady,
  refreshSignal,
  reviewMode = false,
  slackOAuthError,
}: Omit<AgentSetupPageProps, "adapter"> & { readonly adapter: AgentSetupAdapter }) {
  const controller = useAgentSetup(agentId, adapter, onExternalNavigation);
  const previousRefreshSignal = useRef(refreshSignal);
  const [oauthError] = useState(() => (slackOAuthError ? slackSetupErrorMessage(slackOAuthError) : undefined));
  const snapshot = controller.phase.kind === "ready" ? controller.phase.snapshot : undefined;
  const report = useReadyReport(snapshot, agentId, onReady, reviewMode);
  const ready = snapshot?.stage === "ready";

  useEffect(() => {
    if (previousRefreshSignal.current === refreshSignal) return;
    previousRefreshSignal.current = refreshSignal;
    controller.reload();
  }, [controller.reload, refreshSignal]);

  return (
    <div className="otv2-shell flex min-h-screen flex-col bg-kumo-canvas" data-ui="agent-setup">
      <header className="flex items-center justify-between p-6">
        <span className="text-lg font-semibold text-kumo-strong">{m.onboarding_v2_brand_name()}</span>
        {onOpenAgent && !ready ? (
          <Button onClick={onOpenAgent} variant="ghost">
            {m.onboarding_v2_back_to_agent()}
          </Button>
        ) : null}
      </header>
      <main className="otv2-frame mx-auto flex w-full flex-1 flex-col gap-6 p-6">
        {oauthError ? <Banner variant="error" role="alert" description={oauthError} /> : null}
        <SetupPhaseView
          agentId={agentId}
          computerAdapter={computerAdapter}
          controller={controller}
          onOpenAgent={onOpenAgent}
          report={report}
        />
      </main>
    </div>
  );
}

function SetupPhaseView({
  agentId,
  computerAdapter,
  controller,
  onOpenAgent,
  report,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupPageProps["computerAdapter"];
  readonly controller: AgentSetupController;
  readonly onOpenAgent?: () => void;
  readonly report: ReadyReport;
}) {
  const { phase } = controller;
  if (phase.kind === "loading") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3" data-ui="agent-setup-loading">
        <Loader />
        <p className="text-sm text-kumo-subtle m-0" role="status">
          {m.onboarding_v2_loading()}
        </p>
      </div>
    );
  }
  if (phase.kind === "unavailable") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2" data-ui="agent-setup-unavailable">
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_setup_unavailable_title()}
        </Text>
        <p className="text-sm text-kumo-subtle m-0 max-w-prose text-center">
          {m.onboarding_v2_setup_unavailable_detail()}
        </p>
      </div>
    );
  }
  if (phase.kind === "load-failed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3" data-ui="agent-setup-load-failed">
        <p className="text-sm text-kumo-danger m-0" role="alert">
          {phase.message}
        </p>
        <Button onClick={controller.reload}>{m.onboarding_v2_nav_retry()}</Button>
      </div>
    );
  }
  return (
    <AgentSetupSnapshotView
      agentId={agentId}
      computerAdapter={computerAdapter}
      controller={controller}
      onOpenAgent={onOpenAgent}
      report={report}
      snapshot={phase.snapshot}
    />
  );
}

function setupSteps(stage: AgentSetupSnapshot["stage"], awaitingPreparationContinue: boolean): FlowState["steps"] {
  const computerComplete = !awaitingPreparationContinue && (stage === "needs-messaging" || stage === "ready");
  const messagingComplete = stage === "ready";
  return [
    { id: "agent", status: "complete" },
    { id: "computer", status: computerComplete ? "complete" : "current" },
    { id: "messaging", status: messagingComplete ? "complete" : computerComplete ? "current" : "upcoming" },
  ];
}

function messagingHasStarted(snapshot: AgentSetupSnapshot): boolean {
  return snapshot.stage === "needs-messaging" && snapshot.messaging.kind !== "not-configured";
}

function isAwaitingPreparationContinue(snapshot: AgentSetupSnapshot, preparationAccepted: boolean): boolean {
  return snapshot.stage === "needs-messaging" && snapshot.messaging.kind === "not-configured" && !preparationAccepted;
}

function shouldShowPreparation(stage: AgentSetupSnapshot["stage"], awaitingPreparationContinue: boolean): boolean {
  return (
    stage === "needs-computer" ||
    stage === "needs-runtime" ||
    stage === "needs-provider-clis" ||
    awaitingPreparationContinue
  );
}

function shouldShowSetupTitle(stage: AgentSetupSnapshot["stage"], awaitingPreparationContinue: boolean): boolean {
  return stage === "ready" || (stage === "needs-messaging" && !awaitingPreparationContinue);
}

function AgentSetupSnapshotView({
  agentId,
  computerAdapter,
  controller,
  onOpenAgent,
  report,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupPageProps["computerAdapter"];
  readonly controller: AgentSetupController;
  readonly onOpenAgent?: () => void;
  readonly report: ReadyReport;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { stage } = snapshot;
  const [preparationAccepted, setPreparationAccepted] = useState(() => messagingHasStarted(snapshot));
  const focusMessagingAfterContinue = useRef(false);
  const messagingHeadingRef = useRef<HTMLHeadingElement>(null);
  const awaitingPreparationContinue = isAwaitingPreparationContinue(snapshot, preparationAccepted);
  const showingPreparation = shouldShowPreparation(stage, awaitingPreparationContinue);
  const observationFailed = snapshot.blockers.some((blocker) => blocker.code === "resource-observation-failed");
  const computerObservationFailed = snapshot.computer.kind === "observation-failed";
  const canRefresh = snapshot.actions.some((action) => action.kind === "refresh");
  const refreshAction = canRefresh && stage !== "ready" ? <SetupRefreshButton controller={controller} /> : undefined;

  useEffect(() => {
    if (stage !== "needs-messaging" && preparationAccepted) setPreparationAccepted(false);
  }, [preparationAccepted, stage]);

  useEffect(() => {
    if (!focusMessagingAfterContinue.current || !preparationAccepted || stage !== "needs-messaging") return;
    messagingHeadingRef.current?.focus();
    focusMessagingAfterContinue.current = false;
  }, [preparationAccepted, stage]);

  const continueToMessaging = () => {
    focusMessagingAfterContinue.current = true;
    setPreparationAccepted(true);
  };

  return (
    <>
      <StepRail steps={setupSteps(stage, awaitingPreparationContinue)} />
      {shouldShowSetupTitle(stage, awaitingPreparationContinue) ? (
        <header className={SECTION_HEADER}>
          <Text as="h1" ref={messagingHeadingRef} size="lg" tabIndex={-1} variant="heading">
            {m.onboarding_v2_setup_title({ name: snapshot.agent.displayName })}
          </Text>
        </header>
      ) : null}
      {observationFailed ? (
        <Banner variant="alert" role="alert" description={m.onboarding_v2_setup_observation_failed()} />
      ) : null}
      {controller.refreshError ? <Banner variant="error" role="alert" description={controller.refreshError} /> : null}
      <LocalPreparationSections
        agentId={agentId}
        computerAdapter={computerAdapter}
        computerRefreshAction={computerObservationFailed ? refreshAction : undefined}
        onChanged={controller.reload}
        showCompletedPreparation={awaitingPreparationContinue}
        snapshot={snapshot}
      />
      {computerObservationFailed ? null : refreshAction}
      {showingPreparation ? (
        <PreparationNavigation onContinue={continueToMessaging} ready={awaitingPreparationContinue} />
      ) : null}
      {stage === "needs-messaging" && !awaitingPreparationContinue ? (
        <MessagingSetupSection controller={controller} snapshot={snapshot} />
      ) : null}
      {stage === "ready" ? (
        <div data-ui="agent-setup-ready">
          <DoneStep
            action={onOpenAgent ? { label: m.onboarding_v2_open_agent(), onClick: onOpenAgent } : undefined}
            completion={report}
            name={snapshot.agent.name}
            provider={snapshot.messaging.kind === "ready" ? snapshot.messaging.provider : undefined}
          />
        </div>
      ) : null}
    </>
  );
}

function PreparationNavigation({ onContinue, ready }: { readonly onContinue: () => void; readonly ready: boolean }) {
  const hintId = useId();
  return (
    <div className="otv2-step-footer" data-state={ready ? "ready" : "blocked"} data-ui="onboarding-v2-step-2-nav">
      <p className="text-sm text-kumo-subtle m-0" id={hintId} role="status">
        {ready ? m.onboarding_v2_prep_continue_ready() : m.onboarding_v2_prep_continue_waiting()}
      </p>
      <Button aria-describedby={hintId} className="otv2-step-footer__action" disabled={!ready} onClick={onContinue}>
        {m.onboarding_v2_nav_next()}
      </Button>
    </div>
  );
}

function SetupRefreshButton({ controller }: { readonly controller: AgentSetupController }) {
  return (
    <div className="flex">
      <Button
        disabled={controller.busyKey !== undefined}
        loading={controller.busyKey === "refresh"}
        onClick={() => {
          controller.resetPollBudget();
          void controller.act({ kind: "refresh" });
        }}
        variant="secondary"
      >
        {m.onboarding_v2_setup_refresh()}
      </Button>
    </div>
  );
}

function LocalPreparationSections({
  agentId,
  computerAdapter,
  computerRefreshAction,
  onChanged,
  showCompletedPreparation,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupPageProps["computerAdapter"];
  readonly computerRefreshAction?: ReactNode;
  readonly onChanged: () => void;
  readonly showCompletedPreparation: boolean;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { stage } = snapshot;
  return (
    <>
      {stage === "needs-computer" ? (
        <ComputerSetupSection
          agentId={agentId}
          computerAdapter={computerAdapter}
          refreshAction={computerRefreshAction}
          onChanged={onChanged}
          snapshot={snapshot}
        />
      ) : null}
      {stage === "needs-runtime" || stage === "needs-provider-clis" || showCompletedPreparation ? (
        <PreparationSummarySection snapshot={snapshot} />
      ) : null}
    </>
  );
}

function ComputerSetupSection({
  agentId,
  computerAdapter,
  refreshAction,
  onChanged,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupPageProps["computerAdapter"];
  readonly refreshAction?: ReactNode;
  readonly onChanged: () => void;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { computer } = snapshot;
  const serverComputerConnectAdapter = useMemo(() => createAgentTargetedComputerConnectAdapter(agentId), [agentId]);
  const computerConnectAdapter = computerAdapter?.connect ?? serverComputerConnectAdapter;
  if (computer.kind === "not-bound") {
    return (
      <NotBoundComputerSection
        agentId={agentId}
        computerConnectAdapter={computerConnectAdapter}
        inventoryAdapter={computerAdapter?.inventory}
        name={snapshot.agent.displayName}
        onChanged={onChanged}
        snapshot={snapshot}
      />
    );
  }
  if (computer.kind === "requires-rebind") {
    const canBind = snapshot.actions.some((action) => action.kind === "bind-computer");
    return (
      <section className="otv2-computer-step flex flex-col" data-state={computer.kind} data-ui="agent-setup-computer">
        <ComputerStepHeader name={snapshot.agent.displayName} />
        <div className="otv2-computer-step__body">
          <ComputerSummary
            metadata={platformLabel(computer.platform)}
            status={m.onboarding_v2_connect_no_computer_status()}
            title={computer.displayName}
            tone="neutral"
          />
          <p className={HINT}>
            {m.onboarding_v2_setup_computer_rebind({
              computerName: computer.displayName,
              name: snapshot.agent.displayName,
            })}
          </p>
          {canBind ? (
            <AgentComputerChoice
              adapter={computerConnectAdapter}
              agentId={agentId}
              inventoryAdapter={computerAdapter?.inventory}
              onBound={onChanged}
            />
          ) : null}
        </div>
      </section>
    );
  }
  if (computer.kind === "observation-failed") {
    return (
      <section className="otv2-computer-step flex flex-col" data-state={computer.kind} data-ui="agent-setup-computer">
        <ComputerStepHeader name={snapshot.agent.displayName} />
        <div className="otv2-computer-step__body">
          <ComputerSummary
            metadata={platformLabel(computer.platform)}
            status={m.onboarding_v2_connect_unconfirmed()}
            title={computer.displayName}
            tone="warning"
          />
          {refreshAction}
        </div>
      </section>
    );
  }
  return (
    <BoundComputerSection
      computer={computer}
      computerConnectAdapter={computerConnectAdapter}
      onChanged={onChanged}
      snapshot={snapshot}
    />
  );
}

function ComputerStepHeader({ name }: { readonly name: string }) {
  return (
    <header className="grid gap-1" data-ui="agent-setup-computer-header">
      <Text as="h1" size="lg" variant="heading">
        {m.onboarding_v2_connect_title()}
      </Text>
      <p className={HINT}>{m.onboarding_v2_connect_description({ name })}</p>
      <p className="flex items-center gap-2 text-sm text-kumo-subtle m-0">
        <span aria-hidden="true" className="text-kumo-brand">
          <Icon name="shield" />
        </span>
        {m.onboarding_v2_connect_privacy()}
      </p>
    </header>
  );
}

function ComputerSummary({
  metadata,
  status,
  title,
  tone,
}: {
  readonly metadata?: string;
  readonly status: string;
  readonly title: string;
  readonly tone: StatusTone;
}) {
  return (
    <div
      className="otv2-computer-summary grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2"
      data-ui="agent-setup-computer-summary"
    >
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint text-kumo-brand"
      >
        <Icon name="laptop" />
      </span>
      <span className="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden">
        <strong className="truncate text-sm font-medium text-kumo-strong" title={title}>
          {title}
        </strong>
        {metadata ? <span className="shrink-0 text-sm text-kumo-subtle">{metadata}</span> : null}
      </span>
      <StatusIndicator className="justify-self-end" label={status} tone={tone} />
    </div>
  );
}

function NotBoundComputerSection({
  agentId,
  computerConnectAdapter,
  inventoryAdapter,
  name,
  onChanged,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerConnectAdapter: ComputerConnectAdapter;
  readonly inventoryAdapter?: AgentComputerInventoryAdapter;
  readonly name: string;
  readonly onChanged: () => void;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const canBind = snapshot.actions.some((action) => action.kind === "bind-computer");
  return (
    <section className="otv2-computer-step flex flex-col" data-state="not-bound" data-ui="agent-setup-computer">
      <ComputerStepHeader name={name} />
      <div className="otv2-computer-step__body">
        <ComputerSummary
          status={m.onboarding_v2_connect_no_computer_status()}
          title={m.onboarding_v2_connect_no_computer_title()}
          tone="neutral"
        />
        {/*
         * Giving an Agent a Computer is the same work here as in its Settings, so the same surface
         * does it — including the choice when the Account genuinely has one to make.
         */}
        {canBind ? (
          <AgentComputerChoice
            adapter={computerConnectAdapter}
            agentId={agentId}
            inventoryAdapter={inventoryAdapter}
            onBound={onChanged}
          />
        ) : null}
      </div>
    </section>
  );
}

function BoundComputerSection({
  computer,
  computerConnectAdapter,
  onChanged,
  snapshot,
}: {
  readonly computer: Extract<AgentSetupSnapshot["computer"], { kind: "bound" }>;
  readonly computerConnectAdapter: ComputerConnectAdapter;
  readonly onChanged: () => void;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const repair = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "repair-computer" }> =>
      action.kind === "repair-computer" && action.computerId === computer.computerId,
  );
  const offline = computer.kind === "bound" && computer.connectionStatus === "offline";
  return (
    <section className="otv2-computer-step flex flex-col" data-state={computer.kind} data-ui="agent-setup-computer">
      <ComputerStepHeader name={snapshot.agent.displayName} />
      <div className="otv2-computer-step__body">
        <ComputerSummary
          metadata={platformLabel(computer.platform)}
          status={offline ? m.onboarding_v2_connect_offline() : m.onboarding_v2_connect_online()}
          title={computer.displayName}
          tone={offline ? "warning" : "success"}
        />
        {repair ? (
          <ComputerConnect
            adapter={computerConnectAdapter}
            intent={{
              mode: "repair",
              target: { computerId: repair.computerId, displayName: computer.displayName },
            }}
            onConnected={onChanged}
          />
        ) : null}
      </div>
    </section>
  );
}

function PreparationSummarySection({ snapshot }: { readonly snapshot: AgentSetupSnapshot }) {
  const rows = useMemo(() => preparationSummaryRows(snapshot), [snapshot]);
  const { computer } = snapshot;
  if (computer.kind === "not-bound") return null;
  return (
    <section className="otv2-preparation flex flex-col" data-ui="agent-setup-preparation">
      <header className={SECTION_HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_prep_title()}
        </Text>
        <p className={HINT}>{m.onboarding_v2_prep_intro()}</p>
      </header>
      <div className="otv2-preparation__checks">
        <ComputerSummary
          metadata={platformLabel(computer.platform)}
          status={m.onboarding_v2_connect_online()}
          title={computer.displayName}
          tone="success"
        />
        <ol aria-label={m.onboarding_v2_prep_title()} className="otv2-readiness" data-ui="readiness-list">
          <CheckLine check={rows.runtime} component="runtime" position={1} />
          <CheckLine check={rows.messaging} component="messaging-support" position={2} />
        </ol>
      </div>
    </section>
  );
}

function MessagingSetupSection({
  controller,
  snapshot,
}: {
  readonly controller: AgentSetupController;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { messaging } = snapshot;
  return (
    <section className={SECTION} data-state={messaging.kind} data-ui="agent-setup-messaging">
      <header className={SECTION_HEADER}>
        <Text as="h2" variant="heading">
          {m.onboarding_v2_messaging_title()}
        </Text>
      </header>
      {messaging.kind === "not-configured" ? (
        <MessagingStartChoice busyKey={controller.busyKey} onStart={controller.act} snapshot={snapshot} />
      ) : null}
      {messaging.kind === "authorizing" && messaging.provider === "feishu" ? (
        <FeishuAuthorizing
          busyKey={controller.busyKey}
          messaging={messaging}
          onAct={controller.act}
          snapshot={snapshot}
        />
      ) : null}
      {messaging.kind === "authorizing" && messaging.provider === "slack" ? (
        <SlackAuthorizing messaging={messaging} />
      ) : null}
      {messaging.kind === "waiting-handoff" ? (
        <MessagingHandoff controller={controller} messaging={messaging} snapshot={snapshot} />
      ) : null}
      {messaging.kind === "blocked" ? (
        <BlockedMessaging controller={controller} messaging={messaging} snapshot={snapshot} />
      ) : null}
      {controller.actionError && messaging.kind !== "blocked" && messaging.kind !== "waiting-handoff" ? (
        <Banner variant="error" role="alert" description={controller.actionError} />
      ) : null}
    </section>
  );
}

/** The fresh Provider choice — the only place Messaging can be started, and only when the snapshot says so. */
function MessagingStartChoice({
  busyKey,
  onStart,
  snapshot,
}: {
  readonly busyKey: AgentSetupAction["kind"] | undefined;
  readonly onStart: (action: AgentSetupAction) => Promise<boolean>;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const startActions = snapshot.actions.filter(
    (action): action is Extract<AgentSetupAction, { kind: "start-messaging" }> => action.kind === "start-messaging",
  );
  if (startActions.length === 0) return <p className={HINT}>{m.onboarding_v2_messaging_description()}</p>;
  return (
    <>
      <p className={HINT}>{m.onboarding_v2_messaging_description()}</p>
      <ul className={CHOICE_GRID} data-ui="agent-setup-messaging-choices">
        {startActions.map((action) => (
          <li key={action.provider}>
            <Button
              className={CARD}
              disabled={busyKey !== undefined}
              loading={busyKey === "start-messaging"}
              onClick={() => void onStart(action)}
              variant="ghost"
            >
              <BrandMark brand={action.provider} label={providerTitle(action.provider)} />
              <CardCopy
                description={
                  action.provider === "feishu"
                    ? m.onboarding_v2_messaging_feishu_description({
                        provider: messagingProviderAlternateBrand(),
                      })
                    : m.onboarding_v2_messaging_provider_description({
                        provider: providerTitle(action.provider),
                      })
                }
                title={providerTitle(action.provider)}
              />
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

function FeishuAuthorizing({
  busyKey,
  messaging,
  onAct,
  snapshot,
}: {
  readonly busyKey: AgentSetupAction["kind"] | undefined;
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "authorizing"; provider: "feishu" }>;
  readonly onAct: (action: AgentSetupAction) => Promise<boolean>;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const cancel = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "cancel-messaging-attempt" }> =>
      action.kind === "cancel-messaging-attempt" && action.attemptId === messaging.attemptId,
  );
  return (
    <>
      <p className={WAITING_LINE} role="status">
        <span aria-hidden="true" className="ots-pulse shrink-0" />
        {m.onboarding_v2_messaging_waiting()}
      </p>
      <p className={HINT}>
        {spaceScriptBoundary(m.onboarding_v2_messaging_lark_intro({ provider: providerTitle("feishu") }))}
      </p>
      {messaging.qrUrl ? <QrCode value={messaging.qrUrl} /> : null}
      <p className={HINT}>{m.im_feishu_qr_expires({ date: formatDateTime(messaging.expiresAt) })}</p>
      {cancel ? (
        <div>
          <Button
            disabled={busyKey !== undefined}
            loading={busyKey === "cancel-messaging-attempt"}
            onClick={() => void onAct(cancel)}
            variant="ghost"
          >
            {m.common_cancel()}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SlackAuthorizing({
  messaging,
}: {
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "authorizing"; provider: "slack" }>;
}) {
  return (
    <>
      <p className={WAITING_LINE} role="status">
        <span aria-hidden="true" className="ots-pulse shrink-0" />
        {spaceScriptBoundary(m.onboarding_v2_messaging_slack_waiting({ provider: providerTitle("slack") }))}
      </p>
      <p className={HINT}>
        {m.onboarding_v2_setup_slack_install_expires({ date: formatDateTime(messaging.expiresAt) })}
      </p>
    </>
  );
}

function messagingHandoffCopy(progress: ProviderCliHandoffProgress, provider: ImProvider): string {
  if (progress.phase === "preparing_cli") {
    return m.onboarding_v2_setup_messaging_confirming_computer({ provider: providerTitle(provider) });
  }
  if (progress.reason === "upgrade_required") {
    return m.onboarding_v2_setup_messaging_computer_attention({ provider: providerTitle(provider) });
  }
  if (progress.phase === "needs_attention" && !progress.reason) {
    return m.onboarding_v2_setup_messaging_computer_attention({ provider: providerTitle(provider) });
  }
  return providerCliWaitingCopy(progress);
}

function MessagingHandoff({
  controller,
  messaging,
  snapshot,
}: {
  readonly controller: AgentSetupController;
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "waiting-handoff" }>;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const [unbindAsked, setUnbindAsked] = useState(false);
  const unbindButtonRef = useRef<HTMLButtonElement>(null);
  const unbind = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "unbind-messaging" }> =>
      action.kind === "unbind-messaging" &&
      action.provider === messaging.provider &&
      action.bindingId === messaging.bindingId,
  );
  return (
    <>
      <p className={WAITING_LINE} role="status">
        <span aria-hidden="true" className="ots-pulse shrink-0" />
        {m.onboarding_v2_messaging_confirming()}
      </p>
      {messaging.progress ? (
        <p className={HINT}>{messagingHandoffCopy(messaging.progress, messaging.provider)}</p>
      ) : null}
      {!messaging.progress && messaging.provider === "slack" ? (
        <p className={HINT}>
          {m.onboarding_v2_messaging_slack_observe({ provider: providerTitle(messaging.provider) })}
        </p>
      ) : null}
      {unbind ? (
        <div>
          <Button
            disabled={controller.busyKey !== undefined}
            onClick={() => setUnbindAsked(true)}
            ref={unbindButtonRef}
            variant="secondary-destructive"
          >
            {m.im_disconnect({ providerName: providerTitle(unbind.provider) })}
          </Button>
        </div>
      ) : null}
      {controller.actionError && !unbindAsked ? (
        <Banner variant="error" role="alert" description={controller.actionError} />
      ) : null}
      {unbind && unbindAsked ? (
        <UnbindMessagingDialog
          action={unbind}
          busyKey={controller.busyKey}
          error={controller.actionError}
          onAct={controller.act}
          onClose={() => setUnbindAsked(false)}
          returnFocusRef={unbindButtonRef}
        />
      ) : null}
    </>
  );
}

function blockedMessagingCopy(messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "blocked" }>): string {
  const provider = providerTitle(messaging.provider);
  if (messaging.code === "reauthorization-required") {
    return m.onboarding_v2_setup_messaging_reauth_required({ provider });
  }
  if (messaging.code === "provider-error") return m.onboarding_v2_setup_messaging_provider_error({ provider });
  if (messaging.code === "unbind-required") return m.onboarding_v2_setup_messaging_unbind_required({ provider });
  return m.onboarding_v2_setup_messaging_auth_failed({ provider });
}

function currentBindingOf(
  messaging: AgentSetupSnapshot["messaging"],
): { provider: ImProvider; bindingId: string } | undefined {
  if (messaging.kind === "waiting-handoff" || messaging.kind === "ready") {
    return { provider: messaging.provider, bindingId: messaging.bindingId };
  }
  if (messaging.kind === "blocked" && messaging.bindingId) {
    return { provider: messaging.provider, bindingId: messaging.bindingId };
  }
  return undefined;
}

function BlockedMessaging({
  controller,
  messaging,
  snapshot,
}: {
  readonly controller: AgentSetupController;
  readonly messaging: Extract<AgentSetupSnapshot["messaging"], { kind: "blocked" }>;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const [unbindAsked, setUnbindAsked] = useState(false);
  const unbindButtonRef = useRef<HTMLButtonElement>(null);
  const binding = currentBindingOf(messaging);
  const switchBlocker = snapshot.blockers.find(
    (blocker): blocker is Extract<AgentSetupSnapshot["blockers"][number], { code: "messaging-unbind-required" }> =>
      blocker.code === "messaging-unbind-required",
  );
  const reauthorize = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "reauthorize-messaging" }> =>
      action.kind === "reauthorize-messaging" &&
      binding !== undefined &&
      action.provider === binding.provider &&
      action.bindingId === binding.bindingId,
  );
  const replace = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "replace-messaging" }> =>
      action.kind === "replace-messaging" && binding !== undefined && action.bindingId === binding.bindingId,
  );
  const unbind = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "unbind-messaging" }> =>
      action.kind === "unbind-messaging" &&
      binding !== undefined &&
      action.provider === binding.provider &&
      action.bindingId === binding.bindingId,
  );
  const busy = controller.busyKey !== undefined;
  return (
    <>
      <div className={IDENTITY_ROW} data-ui="agent-setup-messaging-identity">
        <ProviderIcon className="size-6" provider={messaging.provider} />
        <strong className="min-w-0 text-base font-semibold text-kumo-strong">
          {providerTitle(messaging.provider)}
        </strong>
        <StatusIndicator
          className="justify-self-end"
          label={m.onboarding_v2_setup_messaging_needs_attention()}
          tone="warning"
        />
      </div>
      <p className={HINT}>{blockedMessagingCopy(messaging)}</p>
      {switchBlocker ? (
        <p className={HINT}>
          {m.onboarding_v2_setup_messaging_switch_required({
            current: providerTitle(switchBlocker.currentProvider),
            requested: providerTitle(switchBlocker.requestedProvider),
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {reauthorize ? (
          <Button
            disabled={busy}
            loading={controller.busyKey === "reauthorize-messaging"}
            onClick={() => void controller.act(reauthorize)}
          >
            {messaging.code === "reauthorization-required" ? m.im_update_permissions() : m.im_reconnect()}
          </Button>
        ) : null}
        {replace ? (
          <Button
            disabled={busy}
            loading={controller.busyKey === "replace-messaging"}
            onClick={() => void controller.act(replace)}
            variant="secondary"
          >
            {m.im_change_bot()}
          </Button>
        ) : null}
        {unbind ? (
          <Button
            disabled={busy}
            onClick={() => setUnbindAsked(true)}
            ref={unbindButtonRef}
            variant="secondary-destructive"
          >
            {m.im_disconnect({ providerName: providerTitle(unbind.provider) })}
          </Button>
        ) : null}
      </div>
      {controller.actionError && !unbindAsked ? (
        <Banner variant="error" role="alert" description={controller.actionError} />
      ) : null}
      {unbind && unbindAsked ? (
        <UnbindMessagingDialog
          action={unbind}
          busyKey={controller.busyKey}
          error={controller.actionError}
          onAct={controller.act}
          onClose={() => setUnbindAsked(false)}
          returnFocusRef={unbindButtonRef}
        />
      ) : null}
    </>
  );
}

/**
 * Disconnecting a messaging app is irreversible from this page and takes the Agent's channel down
 * with it, so it is asked rather than done: what will happen, a safe default focus, and a busy
 * state that cannot be dismissed while the outcome is uncertain.
 */
function UnbindMessagingDialog({
  action,
  busyKey,
  error,
  onAct,
  onClose,
  returnFocusRef,
}: {
  readonly action: Extract<AgentSetupAction, { kind: "unbind-messaging" }>;
  readonly busyKey: AgentSetupAction["kind"] | undefined;
  readonly error: string | undefined;
  readonly onAct: (action: AgentSetupAction) => Promise<boolean>;
  readonly onClose: () => void;
  readonly returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const providerName = providerTitle(action.provider);
  const busy = busyKey === "unbind-messaging";
  return (
    <Dialog
      busy={busy}
      description={m.im_disconnect_description({ providerName })}
      returnFocusRef={returnFocusRef}
      role="alertdialog"
      title={m.im_disconnect_title({ providerName })}
      onClose={onClose}
    >
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      <div className="flex flex-wrap justify-end gap-3">
        <Button disabled={busy} onClick={onClose} variant="ghost">
          {m.im_disconnect_cancel()}
        </Button>
        <Button
          disabled={busy}
          loading={busy}
          onClick={() =>
            void onAct(action).then((ok) => {
              if (ok) onClose();
            })
          }
          variant="danger"
        >
          {m.im_disconnect({ providerName })}
        </Button>
      </div>
    </Dialog>
  );
}
