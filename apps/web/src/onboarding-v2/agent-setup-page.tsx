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

import type { AgentSetupAction, AgentSetupSnapshot, ImProvider } from "@opentag/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api.js";
import { AgentComputerChoice, type AgentComputerInventoryAdapter } from "../features/agents/agent-computer-choice.js";
import { platformLabel } from "../features/agents/agent-presentation.js";
import {
  ComputerConnect,
  type ComputerConnectAdapter,
  createAgentTargetedComputerConnectAdapter,
} from "../features/computer-connect/computer-connect.js";
import { isTerminalResourceError } from "../features/resource/resource-state.js";
import { formatDateTime, formatRelativeTime, spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderAlternateBrand, messagingProviderLabel } from "../im/provider-label.js";
import { slackConfigurationMessage } from "../im/slack-configuration.js";
import * as m from "../paraglide/messages.js";
import { QrCode, WAITING_LINE } from "../setup/index.js";
import { Banner, Button, Dialog, Icon, Loader, StatusIndicator, Text } from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { BrandMark } from "./brand-mark.js";
import { COPY, RUNTIME_COPY } from "./copy.js";
import type { FlowState } from "./flow.js";
import { ImCliReadinessList, type ImCliStatuses } from "./im-cli-status.js";
import { providerCliWaitingCopy } from "./messaging-readiness-copy.js";
import "./onboarding-v2.css";
import { type AgentSetupAdapter, createHttpSetupAdapter } from "./setup-adapter.js";
import { CardCopy, DoneStep, StepRail } from "./steps.js";

/** The snapshot doubles as the observation channel while the outside world is expected to move it. */
const SETUP_POLL_MS = 2_000;
/** How many times to report readiness before the reader is offered an explicit retry. */
const READY_REPORT_ATTEMPTS = 3;

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

/** A snapshot the outside world is still moving: read it again on a beat until it settles. */
export function setupSnapshotIsTransitional(snapshot: AgentSetupSnapshot): boolean {
  if (snapshot.messaging.kind === "authorizing" || snapshot.messaging.kind === "waiting-handoff") return true;
  if (snapshot.computer.kind === "bound" && snapshot.computer.connectionStatus === "offline") return true;
  return snapshot.runtime.kind === "observed" && snapshot.runtime.status === "checking";
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
  const transitional = snapshot !== undefined && setupSnapshotIsTransitional(snapshot);
  useEffect(() => {
    if (!transitional || actions.busyKey !== undefined) return;
    let cancelled = false;
    let timer = window.setTimeout(async function poll() {
      await reader.read();
      // One observation at a time: overlapping reads would continuously retire one another when a
      // slow Server takes longer than the interval, leaving a transitional screen unable to move.
      if (!cancelled) timer = window.setTimeout(poll, SETUP_POLL_MS);
    }, SETUP_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [transitional, actions.busyKey, reader.read]);

  const reload = useCallback(() => void reader.read(), [reader.read]);
  return { ...reader, ...actions, reload };
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

function setupSteps(stage: AgentSetupSnapshot["stage"]): FlowState["steps"] {
  const computerComplete = stage === "needs-messaging" || stage === "ready";
  const messagingComplete = stage === "ready";
  return [
    { id: "agent", status: "complete" },
    { id: "computer", status: computerComplete ? "complete" : "current" },
    { id: "messaging", status: messagingComplete ? "complete" : computerComplete ? "current" : "upcoming" },
  ];
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
  const observationFailed = snapshot.blockers.some((blocker) => blocker.code === "resource-observation-failed");
  const canRefresh = snapshot.actions.some((action) => action.kind === "refresh");
  return (
    <>
      <StepRail steps={setupSteps(stage)} />
      <header className={SECTION_HEADER}>
        <Text as="h1" size="lg" variant="heading">
          {m.onboarding_v2_setup_title({ name: snapshot.agent.displayName })}
        </Text>
      </header>
      {observationFailed ? (
        <Banner variant="alert" role="alert" description={m.onboarding_v2_setup_observation_failed()} />
      ) : null}
      {controller.refreshError ? <Banner variant="error" role="alert" description={controller.refreshError} /> : null}
      {stage === "needs-computer" ? (
        <ComputerSetupSection
          agentId={agentId}
          computerAdapter={computerAdapter}
          onChanged={controller.reload}
          snapshot={snapshot}
        />
      ) : null}
      {stage === "needs-runtime" ? <RuntimeSetupSection snapshot={snapshot} /> : null}
      {stage === "needs-messaging" ? <MessagingSetupSection controller={controller} snapshot={snapshot} /> : null}
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
      {canRefresh && stage !== "ready" ? (
        <div className="flex">
          <Button
            disabled={controller.busyKey !== undefined}
            loading={controller.busyKey === "refresh"}
            onClick={() => void controller.act({ kind: "refresh" })}
            variant="secondary"
          >
            {m.onboarding_v2_setup_refresh()}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ComputerSetupSection({
  agentId,
  computerAdapter,
  onChanged,
  snapshot,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupPageProps["computerAdapter"];
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
      <section className={SECTION} data-state={computer.kind} data-ui="agent-setup-computer">
        <header className={SECTION_HEADER}>
          <Text as="h2" variant="heading">
            {m.onboarding_v2_connect_title()}
          </Text>
        </header>
        <div className={IDENTITY_ROW} data-ui="agent-setup-computer-identity">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint">
            <Icon name="laptop" />
          </span>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <Text as="h3" variant="heading">
              {computer.displayName}
            </Text>
            <span className="text-sm text-kumo-subtle">{platformLabel(computer.platform)}</span>
          </div>
        </div>
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
      </section>
    );
  }
  if (computer.kind === "observation-failed") {
    return (
      <section className={SECTION} data-state={computer.kind} data-ui="agent-setup-computer">
        <header className={SECTION_HEADER}>
          <Text as="h2" variant="heading">
            {m.onboarding_v2_connect_title()}
          </Text>
        </header>
        <div className={IDENTITY_ROW} data-ui="agent-setup-computer-identity">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint">
            <Icon name="laptop" />
          </span>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <Text as="h3" variant="heading">
              {computer.displayName}
            </Text>
            <span className="text-sm text-kumo-subtle">{platformLabel(computer.platform)}</span>
          </div>
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
    <section className={SECTION} data-state="not-bound" data-ui="agent-setup-computer">
      <header className={SECTION_HEADER}>
        <Text as="h2" variant="heading">
          {m.onboarding_v2_connect_title()}
        </Text>
        <p className={HINT}>{m.onboarding_v2_setup_computer_none({ name })}</p>
      </header>
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
  const [repairing, setRepairing] = useState(false);
  const repair = snapshot.actions.find(
    (action): action is Extract<AgentSetupAction, { kind: "repair-computer" }> =>
      action.kind === "repair-computer" && action.computerId === computer.computerId,
  );
  const offline = computer.kind === "bound" && computer.connectionStatus === "offline";
  return (
    <section className={SECTION} data-state={computer.kind} data-ui="agent-setup-computer">
      <header className={SECTION_HEADER}>
        <Text as="h2" variant="heading">
          {m.onboarding_v2_connect_title()}
        </Text>
      </header>
      <div className={IDENTITY_ROW} data-ui="agent-setup-computer-identity">
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint">
          <Icon name="laptop" />
        </span>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <Text as="h3" variant="heading">
            {computer.displayName}
          </Text>
          <span className="text-sm text-kumo-subtle">{platformLabel(computer.platform)}</span>
        </div>
        <StatusIndicator
          className="justify-self-end"
          label={offline ? m.onboarding_v2_connect_offline() : m.onboarding_v2_connect_online()}
          tone={offline ? "warning" : "success"}
        />
      </div>
      <div className="grid gap-1">
        <p className={HINT}>{m.onboarding_v2_connect_offline_for({ computerName: computer.displayName })}</p>
        {computer.lastSeenAt ? (
          <p className={HINT}>
            {m.onboarding_v2_connect_offline_last_seen({ when: formatRelativeTime(computer.lastSeenAt) })}
          </p>
        ) : null}
      </div>
      {repair ? (
        <div className="grid gap-3">
          <Button
            aria-controls="agent-setup-repair-command"
            aria-expanded={repairing}
            className="w-fit"
            onClick={() => setRepairing((current) => !current)}
            size="compact"
            variant="inline"
          >
            {repairing ? m.onboarding_v2_connect_hide_repair() : m.onboarding_v2_connect_generate_repair()}
          </Button>
          {repairing ? (
            <div id="agent-setup-repair-command">
              <ComputerConnect
                adapter={computerConnectAdapter}
                intent={{
                  mode: "repair",
                  target: { computerId: repair.computerId, displayName: computer.displayName },
                }}
                onConnected={onChanged}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RuntimeSetupSection({ snapshot }: { readonly snapshot: AgentSetupSnapshot }) {
  const { runtime, computer } = snapshot;
  const runtimeTitle = RUNTIME_COPY[runtime.provider].title;
  const computerName = computer.kind === "not-bound" ? "" : computer.displayName;
  const status = runtime.kind === "observed" ? runtime.status : "unavailable";
  return (
    <section className={SECTION} data-state={status} data-ui="agent-setup-runtime">
      <header className={SECTION_HEADER}>
        <Text as="h2" variant="heading">
          {m.onboarding_v2_setup_runtime_title({ runtime: runtimeTitle })}
        </Text>
      </header>
      {status === "checking" ? (
        <p className={WAITING_LINE} role="status">
          <span aria-hidden="true" className="ots-pulse shrink-0" />
          {m.onboarding_v2_setup_runtime_checking({ computerName, runtime: runtimeTitle })}
        </p>
      ) : (
        <div className="grid gap-1">
          <p className="text-sm text-kumo-strong m-0">{runtimeBlockerCopy(status, runtimeTitle, computerName)}</p>
          <p className={HINT}>
            {m.onboarding_v2_check_repair_hint()}{" "}
            <code className="rounded bg-kumo-recessed px-1 py-0.5">{COPY.check.repairCommand}</code>{" "}
            {m.onboarding_v2_check_repair_hint_suffix()}
          </p>
        </div>
      )}
    </section>
  );
}

function runtimeBlockerCopy(status: string, runtime: string, computerName: string): string {
  if (status === "install") return m.onboarding_v2_setup_runtime_install({ computerName, runtime });
  if (status === "sign-in") return m.onboarding_v2_setup_runtime_sign_in({ computerName, runtime });
  // `ready` never reaches this section: the stage would have moved past it.
  return m.onboarding_v2_setup_runtime_unavailable({ computerName, runtime });
}

function MessagingSetupSection({
  controller,
  snapshot,
}: {
  readonly controller: AgentSetupController;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { messaging } = snapshot;
  const cliStatuses: ImCliStatuses | undefined =
    snapshot.computer.kind === "bound"
      ? Object.fromEntries(snapshot.computer.imCliReadiness.map((entry) => [entry.provider, entry.status]))
      : undefined;
  return (
    <section className={SECTION} data-state={messaging.kind} data-ui="agent-setup-messaging">
      <header className={SECTION_HEADER}>
        <Text as="h2" variant="heading">
          {m.onboarding_v2_messaging_title()}
        </Text>
      </header>
      <ImCliReadinessList statuses={cliStatuses} />
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
      {messaging.progress ? <p className={HINT}>{providerCliWaitingCopy(messaging.progress)}</p> : null}
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
