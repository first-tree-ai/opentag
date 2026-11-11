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
 * Custom Slack Apps additionally read their authenticated configuration endpoint; that entry is
 * independent of first-party OAuth availability and does not extend the setup action contract.
 * The actions map one-to-one onto the shared contract. Messaging can be started only from a
 * not-configured snapshot; a current binding is reauthorized in place. Existing Computer, runtime
 * Provider and messaging identities cannot be replaced; empty configuration can finish creation.
 */

import type { AgentSetupSnapshot } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAgentSetupStageReport } from "../analytics/milestones.js";
import { browserApi } from "../api.js";
import { useInAppShell } from "../features/shell/shell-context.js";
import type { SlackSetupApi } from "../im/slack-custom-app.js";
import * as m from "../paraglide/messages.js";
import { syncAgentQueries } from "../query/agent-sync.js";
import { Banner, Button, Loader, Text } from "../ui/design-system.js";
import { type AgentSetupComputerAdapter, LocalPreparationSections } from "./computer-setup-section.js";
import type { FlowState } from "./flow.js";
import { MessagingSetupSection } from "./messaging-setup-section.js";
import { type AgentSetupAdapter, createHttpSetupAdapter } from "./setup-adapter.js";
import { SetupLogo } from "./setup-logo.js";
import { DoneStep, StepRail } from "./steps.js";
import {
  type AgentSetupController,
  BOUNDED_POLL_ATTEMPTS,
  BOUNDED_POLL_WINDOW_MS,
  preparationShowsAutomaticChecking,
  type ReadyReport,
  SETUP_POLL_MS,
  setupSnapshotIsTransitional,
  slackSetupErrorMessage,
  snapshotPollClass,
  useAgentSetup,
  useReadyReport,
} from "./use-agent-setup.js";
import "./onboarding-v2.css";

export { BOUNDED_POLL_ATTEMPTS, BOUNDED_POLL_WINDOW_MS, SETUP_POLL_MS, setupSnapshotIsTransitional };

const SECTION_HEADER = "flex flex-col gap-1";

export type AgentSetupPreviewView = "checks" | "complete" | "computer" | "messaging";

export interface AgentSetupPageProps {
  /** The exact Agent this surface sets up. Never an index, a name, or a guess. */
  readonly agentId: string;
  /** Defaults to the HTTP adapter over the browser API; tests and the lab pass the in-memory one. */
  readonly adapter?: AgentSetupAdapter;
  /** Keeps Computer inventory, binding, and connect-code work behind the Lab's in-memory seam. */
  readonly computerAdapter?: AgentSetupComputerAdapter;
  /** An external Lab mutation asks the mounted page to re-read without resetting its local UI. */
  readonly refreshSignal?: number;
  /** Review Lab intercepts Provider URLs so a simulated OAuth round trip stays inside the Lab. */
  readonly onExternalNavigation?: (url: string) => void;
  /** Lets the Review Lab open a later screen directly without changing the production default. */
  readonly previewInitialView?: AgentSetupPreviewView;
  /** Reports the screen the production surface is actually showing to its Review Lab controls. */
  readonly onPreviewViewChange?: (view: AgentSetupPreviewView) => void;
  /** Opens this exact Agent; offered as the completion action once setup is ready. */
  readonly onOpenAgent?: () => void;
  /** Leaves setup for the Agent list. Offered in the header at every stage; the list resumes unfinished setup. */
  readonly onBackToAgents?: () => void;
  /** Rendered in the header; the caller supplies it because only the route knows an Account session exists. */
  readonly accountControl?: ReactNode;
  /** The route supplies brand navigation after Account admission. */
  readonly brandControl?: ReactNode;
  /** Told once the snapshot's stage is `ready`, so the route can mark setup complete. */
  readonly onReady?: (agentId: string) => Promise<void> | void;
  /** A staging Re-board stays inspectable until the tester explicitly finishes the review. */
  readonly reviewMode?: boolean;
  /** A Slack callback failure to surface once after the fixed return route remounts. */
  readonly slackOAuthError?: string;
}

export function AgentSetupPage({
  accountControl,
  agentId,
  brandControl,
  adapter,
  computerAdapter,
  onBackToAgents,
  onExternalNavigation,
  onOpenAgent,
  onPreviewViewChange,
  onReady,
  previewInitialView,
  refreshSignal,
  reviewMode = false,
  slackOAuthError,
}: AgentSetupPageProps) {
  const queryClient = useQueryClient();
  const resolvedAdapter = useMemo(
    () => adapter ?? createHttpSetupAdapter(browserApi, queryClient),
    [adapter, queryClient],
  );
  // Keyed on the exact target: a different Agent's setup is a different task, and remounting is
  // what retires everything the previous one still had in flight.
  return (
    <AgentSetupPageContent
      accountControl={accountControl}
      adapter={resolvedAdapter}
      agentId={agentId}
      brandControl={brandControl}
      computerAdapter={computerAdapter}
      key={agentId}
      onBackToAgents={onBackToAgents}
      onExternalNavigation={onExternalNavigation}
      onOpenAgent={onOpenAgent}
      onPreviewViewChange={onPreviewViewChange}
      onReady={onReady}
      previewInitialView={previewInitialView}
      refreshSignal={refreshSignal}
      reviewMode={reviewMode}
      slackOAuthError={slackOAuthError}
      syncAgentCachesOnReady={adapter === undefined}
    />
  );
}

function AgentSetupPageContent({
  accountControl,
  agentId,
  brandControl,
  adapter,
  computerAdapter,
  onBackToAgents,
  onExternalNavigation,
  onOpenAgent,
  onPreviewViewChange,
  onReady,
  previewInitialView,
  refreshSignal,
  reviewMode = false,
  slackOAuthError,
  syncAgentCachesOnReady = false,
}: Omit<AgentSetupPageProps, "adapter"> & {
  readonly adapter: AgentSetupAdapter;
  /**
   * Whether observing a completed messaging binding synchronizes the shared Agent caches. Only
   * the production adapter does; Lab and in-memory adapters keep their isolation from the real
   * QueryClient.
   */
  readonly syncAgentCachesOnReady?: boolean;
}) {
  const queryClient = useQueryClient();
  const embedded = useInAppShell();
  const Main = embedded ? "div" : "main";
  const controller = useAgentSetup(agentId, adapter, onExternalNavigation);
  const previousRefreshSignal = useRef(refreshSignal);
  const [oauthError] = useState(() => (slackOAuthError ? slackSetupErrorMessage(slackOAuthError) : undefined));
  const snapshot = controller.phase.kind === "ready" ? controller.phase.snapshot : undefined;
  const report = useReadyReport(snapshot, agentId, onReady, reviewMode);
  // The stages between a connected Computer and a usable Agent, which is where a reader who never
  // holds a conversation actually stops. Reported per stage, not per re-read.
  useAgentSetupStageReport(agentId, snapshot?.stage);

  /*
   * A completed authorization/handoff changes the Agent's messaging evidence, so the shared
   * Agent, binding, and handoff caches synchronize exactly once per completion: when a ready
   * binding is first observed under a binding identity and credential generation this mounted
   * page has not synced yet. That covers the already-ready first snapshot on return from OAuth,
   * a completion the poll observes, and a reauthorization that completes between two reads
   * without the transitional state ever being shown — while repeated snapshots of the same
   * completion (the 2s beat, focus returns) never sync twice. Syncing at the completion
   * boundary, rather than on navigation away, is what lets a reader who returns home inside the
   * 30s freshness window re-read instead of trusting the binding cached before Setup. The Setup
   * snapshot read itself is not one of the synced keys.
   */
  const syncedCompletion = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!syncAgentCachesOnReady) return;
    const messaging = snapshot?.messaging;
    if (messaging?.kind !== "ready") return;
    const completion = `${messaging.provider}:${messaging.bindingId}:${messaging.credentialGeneration}`;
    if (syncedCompletion.current === completion) return;
    syncedCompletion.current = completion;
    void syncAgentQueries(queryClient, agentId);
  }, [syncAgentCachesOnReady, snapshot, queryClient, agentId]);

  useEffect(() => {
    if (previousRefreshSignal.current === refreshSignal) return;
    previousRefreshSignal.current = refreshSignal;
    controller.reload();
  }, [controller.reload, refreshSignal]);

  return (
    <div
      className={`otv2-shell flex flex-col bg-kumo-canvas ${embedded ? "min-h-0" : "min-h-screen"}`}
      data-ui="agent-setup"
    >
      {!embedded && (
        <header className="flex items-center justify-between gap-2 p-6">
          {brandControl ?? <SetupLogo label={m.onboarding_v2_brand_name()} />}
          <div className="ml-auto flex items-center gap-2">
            {onBackToAgents ? (
              <Button onClick={onBackToAgents} variant="ghost">
                {m.onboarding_v2_back_to_agents()}
              </Button>
            ) : null}
            {accountControl}
          </div>
        </header>
      )}
      <Main className={`otv2-frame mx-auto flex w-full flex-1 flex-col gap-6 ${embedded ? "" : "p-6"}`}>
        <SetupPhaseView
          slackApi={adapter.slackSetup}
          agentId={agentId}
          computerAdapter={computerAdapter}
          controller={controller}
          oauthError={oauthError}
          onOpenAgent={onOpenAgent}
          onPreviewViewChange={onPreviewViewChange}
          previewInitialView={previewInitialView}
          report={report}
        />
      </Main>
    </div>
  );
}

function SetupPhaseView({
  slackApi,
  agentId,
  computerAdapter,
  controller,
  oauthError,
  onOpenAgent,
  onPreviewViewChange,
  previewInitialView,
  report,
}: {
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupPageProps["computerAdapter"];
  readonly slackApi?: SlackSetupApi;
  readonly controller: AgentSetupController;
  readonly oauthError?: string;
  readonly onOpenAgent?: () => void;
  readonly onPreviewViewChange?: (view: AgentSetupPreviewView) => void;
  readonly previewInitialView?: AgentSetupPreviewView;
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
      oauthError={oauthError}
      onOpenAgent={onOpenAgent}
      onPreviewViewChange={onPreviewViewChange}
      previewInitialView={previewInitialView}
      report={report}
      snapshot={phase.snapshot}
      slackApi={slackApi}
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
  return stage === "needs-messaging" && !awaitingPreparationContinue;
}

function AgentSetupSnapshotView({
  slackApi,
  agentId,
  computerAdapter,
  controller,
  oauthError,
  onOpenAgent,
  onPreviewViewChange,
  previewInitialView,
  report,
  snapshot,
}: {
  readonly slackApi?: SlackSetupApi;
  readonly agentId: string;
  readonly computerAdapter?: AgentSetupPageProps["computerAdapter"];
  readonly controller: AgentSetupController;
  readonly oauthError?: string;
  readonly onOpenAgent?: () => void;
  readonly onPreviewViewChange?: (view: AgentSetupPreviewView) => void;
  readonly previewInitialView?: AgentSetupPreviewView;
  readonly report: ReadyReport;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const { stage } = snapshot;
  const [preparationAccepted, setPreparationAccepted] = useState(
    () => previewInitialView === "messaging" || messagingHasStarted(snapshot) || oauthError !== undefined,
  );
  const focusMessagingAfterContinue = useRef(false);
  const messagingHeadingRef = useRef<HTMLHeadingElement>(null);
  const awaitingPreparationContinue = isAwaitingPreparationContinue(snapshot, preparationAccepted);
  const showingPreparation = shouldShowPreparation(stage, awaitingPreparationContinue);
  const observationFailed = snapshot.blockers.some((blocker) => blocker.code === "resource-observation-failed");
  const computerObservationFailed = snapshot.computer.kind === "observation-failed";
  const refreshAction = setupRefreshAction(snapshot, controller);

  useEffect(() => {
    const view: AgentSetupPreviewView =
      stage === "needs-computer"
        ? "computer"
        : showingPreparation
          ? "checks"
          : stage === "needs-messaging"
            ? "messaging"
            : "complete";
    onPreviewViewChange?.(view);
  }, [onPreviewViewChange, showingPreparation, stage]);

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
        <header className={`${SECTION_HEADER} otv2-messaging-heading`}>
          <Text as="h1" ref={messagingHeadingRef} headingSize="section" tabIndex={-1} variant="heading">
            {snapshot.messaging.kind === "blocked"
              ? m.onboarding_v2_messaging_recovery_title()
              : m.onboarding_v2_messaging_title()}
          </Text>
        </header>
      ) : null}
      <SetupSnapshotBanners
        actionError={controller.actionError}
        observationFailed={observationFailed}
        refreshError={controller.refreshError}
        showingPreparation={showingPreparation}
      />
      <LocalPreparationSections
        agentId={agentId}
        computerAdapter={computerAdapter}
        computerRefreshAction={computerObservationFailed ? refreshAction : undefined}
        onChanged={controller.reload}
        showCompletedPreparation={awaitingPreparationContinue}
        snapshot={snapshot}
      />
      <SetupStageNavigation
        computerObservationFailed={computerObservationFailed}
        controller={controller}
        onContinue={continueToMessaging}
        ready={awaitingPreparationContinue}
        refreshAction={refreshAction}
        showingPreparation={showingPreparation}
        snapshot={snapshot}
      />
      {stage === "needs-messaging" && !awaitingPreparationContinue ? (
        <MessagingSetupSection
          controller={controller}
          oauthError={oauthError}
          refreshAction={computerObservationFailed ? undefined : refreshAction}
          snapshot={snapshot}
          slackApi={slackApi}
        />
      ) : null}
      {stage === "ready" ? (
        <div className="otv2-messaging-settings" data-ui="agent-setup-ready">
          <DoneStep
            presentation="settings"
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

function SetupSnapshotBanners({
  actionError,
  observationFailed,
  refreshError,
  showingPreparation,
}: {
  readonly actionError?: string;
  readonly observationFailed: boolean;
  readonly refreshError?: string;
  readonly showingPreparation: boolean;
}) {
  return (
    <>
      {observationFailed ? (
        <Banner variant="alert" role="alert" description={m.onboarding_v2_setup_observation_failed()} />
      ) : null}
      {refreshError ? <Banner variant="error" role="alert" description={refreshError} /> : null}
      {showingPreparation && actionError ? <Banner variant="error" role="alert" description={actionError} /> : null}
    </>
  );
}

function setupRefreshAction(snapshot: AgentSetupSnapshot, controller: AgentSetupController): ReactNode {
  if (
    snapshot.stage === "needs-messaging" &&
    snapshot.messaging.kind === "authorizing" &&
    snapshot.messaging.provider === "feishu" &&
    snapshot.messaging.activation
  ) {
    return undefined;
  }
  const canRefresh = snapshot.actions.some((action) => action.kind === "refresh");
  return canRefresh && snapshot.stage !== "ready" ? <SetupRefreshButton controller={controller} /> : undefined;
}

function SetupStageNavigation({
  computerObservationFailed,
  controller,
  onContinue,
  ready,
  refreshAction,
  showingPreparation,
  snapshot,
}: {
  readonly computerObservationFailed: boolean;
  readonly controller: AgentSetupController;
  readonly onContinue: () => void;
  readonly ready: boolean;
  readonly refreshAction?: ReactNode;
  readonly showingPreparation: boolean;
  readonly snapshot: AgentSetupSnapshot;
}) {
  // The repair command window polls the computer every few seconds and advances on its own, so a
  // manual "Check again" next to it would only duplicate that.
  const connectWindowShown =
    snapshot.stage === "needs-computer" &&
    snapshot.computer.kind === "bound" &&
    snapshot.computer.connectionStatus === "offline";
  if (!showingPreparation) {
    return computerObservationFailed || connectWindowShown || snapshot.messaging.kind === "waiting-handoff"
      ? null
      : refreshAction;
  }
  const pollClass = snapshotPollClass(snapshot);
  const observingAutomatically = pollClass === "bounded" && !controller.pollExhausted;
  const genuineChecking = preparationShowsAutomaticChecking(snapshot);
  // Hide Check again only while a real waiting/checking observation is in flight. Settled
  // install/sign-in/unavailable rows keep the immediate retry while background GETs continue.
  const preparationRefreshAction =
    !computerObservationFailed && !connectWindowShown && !(observingAutomatically && genuineChecking)
      ? refreshAction
      : undefined;
  return (
    <PreparationNavigation
      checking={observingAutomatically && genuineChecking}
      onContinue={onContinue}
      pollExhausted={controller.pollExhausted}
      ready={ready}
      refreshAction={preparationRefreshAction}
      snapshot={snapshot}
    />
  );
}

function preparationHint(input: {
  cloud: boolean;
  ready: boolean;
  checking: boolean;
  pollExhausted: boolean;
  refreshAction?: ReactNode;
}): string {
  if (input.cloud) {
    if (input.ready) return m.onboarding_v2_prep_cloud_continue_ready();
    return input.pollExhausted
      ? m.onboarding_v2_prep_checking_paused()
      : m.onboarding_v2_prep_cloud_continue_unavailable();
  }
  // Every row ready, or a row checking, already says so in the row itself; the footer adds nothing.
  if (input.ready || input.checking) return "";
  if (input.pollExhausted) return m.onboarding_v2_prep_checking_paused();
  return input.refreshAction ? m.onboarding_v2_prep_complete_action() : m.onboarding_v2_prep_continue_waiting();
}

function PreparationNavigation({
  checking,
  onContinue,
  pollExhausted,
  ready,
  refreshAction,
  snapshot,
}: {
  readonly checking: boolean;
  readonly onContinue: () => void;
  readonly pollExhausted: boolean;
  readonly ready: boolean;
  readonly refreshAction?: ReactNode;
  readonly snapshot: AgentSetupSnapshot;
}) {
  const hintId = useId();
  // While a computer is being connected or repaired, the command window is the page's only status
  // and the step advances on its own once the computer is online: no hint and no disabled Continue.
  if (snapshot.stage === "needs-computer" && !ready) {
    return refreshAction ? <div className="otv2-step-footer__actions">{refreshAction}</div> : null;
  }
  const hint = preparationHint({
    cloud: snapshot.computer.kind === "cloud",
    ready,
    checking,
    pollExhausted,
    refreshAction: snapshot.stage === "needs-computer" ? undefined : refreshAction,
  });
  return (
    <div className="otv2-step-footer" data-state={ready ? "ready" : "blocked"} data-ui="onboarding-v2-step-2-nav">
      <p className="flex items-center gap-2 text-sm text-kumo-subtle m-0" id={hintId} role="status">
        {hint}
      </p>
      <div className="otv2-step-footer__actions">
        {refreshAction}
        <Button aria-describedby={hintId} className="otv2-step-footer__action" disabled={!ready} onClick={onContinue}>
          {m.onboarding_v2_nav_next()}
        </Button>
      </div>
    </div>
  );
}

function SetupRefreshButton({ controller }: { readonly controller: AgentSetupController }) {
  return (
    <Button
      className="otv2-step-footer__secondary-action"
      disabled={controller.busyKey !== undefined}
      loading={controller.busyKey?.kind === "refresh"}
      onClick={() => {
        controller.resetPollBudget();
        void controller.act({ kind: "refresh" });
      }}
      variant="secondary"
    >
      {m.onboarding_v2_setup_refresh()}
    </Button>
  );
}
