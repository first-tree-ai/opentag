import type {
  AgentRuntimeProvider,
  AgentSummary,
  MeWorkspace,
  UserProfile,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AgentCreationFacts, AgentCreationFlow } from "../agent-creation/agent-creation-flow.js";
import { browserApi } from "../api.js";
import { ComputerSetup } from "../computer-setup.js";
import { FeishuSetup, type FeishuSetupControl } from "../im/feishu-setup.js";
import { Button, buttonClassName } from "../ui/design-system.js";
import {
  deriveOnboardingState,
  type OnboardingAgent,
  type OnboardingCurrentState,
  type OnboardingFacts,
  type OnboardingProvider,
  type OnboardingState,
} from "./flow.js";
import {
  productionRuntimeFactsAdapter,
  type RuntimeFactsAdapter,
  type RuntimeFactsResult,
  type RuntimeProviderFact,
  type RuntimeProviderStatus,
} from "./runtime-facts.js";

const FEISHU_BOT_APP_LINK = "https://applink.feishu.cn/client/bot/open";
/** A Computer republishes Provider readiness about twice a minute, so a slower poll loses nothing. */
const RUNTIME_POLL_INTERVAL_MS = 5_000;
const RUNTIME_POLL_LIMIT_MS = 10 * 60 * 1_000;
/** States that only an action taken outside this page can advance, and that no child polls for. */
const RUNTIME_WAIT_STATES: readonly OnboardingCurrentState["kind"][] = ["provider", "agent-runtime"];
/** The application route this page hands the Workspace over to once setup is complete. */
const AGENTS_ROUTE = "/agents";

function agentGeneralRoute(agentId: string): string {
  return `${AGENTS_ROUTE}/${agentId}`;
}

type PageLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "ready"; readonly snapshot: OnboardingSnapshot };

type CompletionState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly error: Error };

interface OnboardingSnapshot {
  readonly agents: readonly AgentSummary[];
  readonly computers: readonly WorkspaceComputerSummary[];
  readonly targetAgent: AgentSummary | undefined;
  readonly targetCandidates: readonly AgentSummary[];
  readonly handoff: OnboardingFacts["handoff"];
  readonly runtime: RuntimeFactsResult;
}

type JourneyStatus = "complete" | "current" | "upcoming";
type JourneyFactStatus = "attention" | "current" | "ready" | "waiting";

interface JourneyFact {
  readonly label: string;
  readonly status: JourneyFactStatus;
  readonly value: string;
}

interface OnboardingJourneyState {
  readonly activeStep: 1 | 2;
  readonly agentName: string;
  readonly messaging: JourneyStatus;
  readonly prepareFacts: readonly JourneyFact[];
  readonly prepare: JourneyStatus;
  readonly stageDescription: string;
  readonly stageStatus: string;
  readonly stageTitle: string;
}

export interface OnboardingPageProps {
  readonly membership: MeWorkspace;
  readonly onSetupReady?: (agentId: string) => Promise<void>;
  readonly onTargetAgentChange?: (agentId: string) => void;
  readonly targetAgentId?: string;
  readonly user: UserProfile;
  readonly runtimeFacts?: RuntimeFactsAdapter;
}

/**
 * Owns the whole conditional onboarding page. The page persists no step: each
 * reload starts from authoritative Workspace, Computer, Agent, runtime and handoff
 * facts, plus only the explicit route/identity choices and replay intent.
 */
export function OnboardingPage({
  membership,
  onSetupReady,
  onTargetAgentChange,
  targetAgentId,
  user,
  runtimeFacts = productionRuntimeFactsAdapter,
}: OnboardingPageProps) {
  const [revision, setRevision] = useState(0);
  const [loadState, setLoadState] = useState<PageLoadState>({ kind: "loading" });
  const [refreshPending, setRefreshPending] = useState(false);
  const [attendedWindow, setAttendedWindow] = useState(0);
  const [selectedTargetAgentId, setSelectedTargetAgentId] = useState(targetAgentId);
  const [completionState, setCompletionState] = useState<CompletionState>({ kind: "idle" });
  const refreshInFlight = useRef(false);
  const completionInFlight = useRef<string | undefined>(undefined);
  const effectiveTargetAgentId = targetAgentId ?? selectedTargetAgentId;

  useEffect(() => {
    setSelectedTargetAgentId(targetAgentId);
  }, [targetAgentId]);

  const reload = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshPending(true);
    setRevision((value) => value + 1);
  }, []);
  /**
   * A refresh someone is present for: it reloads facts and restarts the bounded
   * polling window, so returning to a capped page resumes automatic progress.
   */
  const attendedReload = useCallback(() => {
    setAttendedWindow((value) => value + 1);
    reload();
  }, [reload]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit Server-fact reload trigger.
  useEffect(() => {
    let active = true;
    setLoadState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void loadSnapshot(membership.id, runtimeFacts, effectiveTargetAgentId).then(
      (snapshot) => {
        if (!active) return;
        refreshInFlight.current = false;
        setRefreshPending(false);
        setLoadState({ kind: "ready", snapshot });
      },
      (cause: unknown) => {
        if (!active) return;
        refreshInFlight.current = false;
        setRefreshPending(false);
        setLoadState({
          kind: "error",
          error: cause instanceof Error ? cause : new Error("Unable to load onboarding facts"),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [effectiveTargetAgentId, membership.id, revision, runtimeFacts]);

  useEffect(() => {
    const refresh = () => attendedReload();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") attendedReload();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [attendedReload]);

  const resolved = useMemo(() => {
    if (loadState.kind !== "ready") return undefined;
    return resolveSnapshot(loadState.snapshot);
  }, [loadState]);

  useEffect(() => {
    if (loadState.kind !== "ready" || !loadState.snapshot.targetAgent) return;
    const resolvedAgentId = loadState.snapshot.targetAgent.id;
    if (effectiveTargetAgentId === resolvedAgentId) return;
    setSelectedTargetAgentId(resolvedAgentId);
    onTargetAgentChange?.(resolvedAgentId);
  }, [effectiveTargetAgentId, loadState, onTargetAgentChange]);

  const completeSetup = useCallback(
    (agentId: string) => {
      if (!onSetupReady || completionInFlight.current === agentId) return;
      completionInFlight.current = agentId;
      setCompletionState({ kind: "pending" });
      void onSetupReady(agentId).catch((cause: unknown) => {
        completionInFlight.current = undefined;
        setCompletionState({
          kind: "error",
          error: cause instanceof Error ? cause : new Error("Unable to finish OpenTag setup"),
        });
      });
    },
    [onSetupReady],
  );

  useEffect(() => {
    if (resolved?.state.currentState.kind !== "ready") return;
    completeSetup(resolved.state.currentState.agent.id);
  }, [completeSetup, resolved]);
  const journey = onboardingJourney(
    resolved?.state.currentState,
    loadState.kind === "ready" ? loadState.snapshot : undefined,
  );

  const waitingForRuntime = resolved !== undefined && RUNTIME_WAIT_STATES.includes(resolved.state.currentState.kind);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attendedWindow deliberately restarts the bounded window.
  useEffect(() => {
    if (!waitingForRuntime) return;
    let elapsedMs = 0;
    const timer = window.setInterval(() => {
      elapsedMs += RUNTIME_POLL_INTERVAL_MS;
      // An unattended page goes quiet; the next attended refresh starts a fresh window.
      if (elapsedMs >= RUNTIME_POLL_LIMIT_MS) {
        window.clearInterval(timer);
        return;
      }
      if (document.visibilityState !== "hidden") reload();
    }, RUNTIME_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [attendedWindow, reload, waitingForRuntime]);

  return (
    <div className="onboarding-shell">
      <OnboardingHeader user={user} />
      <main className="onboarding-main">
        <div className="onboarding-layout">
          <OnboardingJourney journey={journey} />
          <section className="onboarding-workspace" aria-labelledby="onboarding-stage-title">
            <OnboardingStageHeader journey={journey} />
            <div className="onboarding-workspace-body">
              {loadState.kind === "loading" ? <OnboardingLoading /> : null}
              {loadState.kind === "error" ? (
                <ActionSection title="We couldn’t load setup" description={loadState.error.message}>
                  <Button onClick={reload}>Try again</Button>
                </ActionSection>
              ) : null}
              {loadState.kind === "ready" && resolved ? (
                <OnboardingContent
                  completionState={completionState}
                  onChooseAgent={(agentId) => {
                    setSelectedTargetAgentId(agentId);
                    onTargetAgentChange?.(agentId);
                  }}
                  onAgentCreated={(agentId) => {
                    setSelectedTargetAgentId(agentId);
                    onTargetAgentChange?.(agentId);
                  }}
                  onCompleteSetup={completeSetup}
                  onReload={attendedReload}
                  refreshPending={refreshPending}
                  snapshot={loadState.snapshot}
                  state={resolved.state}
                  workspaceId={membership.id}
                />
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function OnboardingJourney({ journey }: { journey: OnboardingJourneyState }) {
  return (
    <aside className="onboarding-journey">
      <div className="onboarding-journey-intro">
        <span className="eyebrow">Agent setup</span>
        <h1>Set up OpenTag</h1>
        <p>Prepare one Agent, then bring it into a shared conversation.</p>
      </div>
      <nav aria-label="Onboarding steps">
        <ol className="onboarding-steps">
          <JourneyStep
            description="Computer, runtime and identity"
            number="01"
            status={journey.prepare}
            title="Prepare your Agent"
          />
          <JourneyStep
            description="Authorize your messaging bot"
            number="02"
            status={journey.messaging}
            title="Add to Feishu"
          />
        </ol>
      </nav>
      <p className="onboarding-journey-note">
        Progress is saved from live server state. You can leave and return at any time.
      </p>
    </aside>
  );
}

function JourneyStep({
  description,
  number,
  status,
  title,
}: {
  description: string;
  number: string;
  status: JourneyStatus;
  title: string;
}) {
  const statusLabel = status === "complete" ? "Complete" : status === "current" ? "In progress" : "Up next";
  return (
    <li className="onboarding-step" data-status={status}>
      <span aria-hidden="true" className="onboarding-step-number">
        {status === "complete" ? "✓" : number}
      </span>
      <span className="onboarding-step-copy">
        <span className="onboarding-step-status">{statusLabel}</span>
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
    </li>
  );
}

function OnboardingStageHeader({ journey }: { journey: OnboardingJourneyState }) {
  return (
    <header className="onboarding-stage-header">
      <div className="onboarding-stage-copy">
        <span className="onboarding-stage-kicker">Step {String(journey.activeStep).padStart(2, "0")} / 02</span>
        <span className="onboarding-stage-status">{journey.stageStatus}</span>
        <h2 id="onboarding-stage-title">{journey.stageTitle}</h2>
        <p>{journey.stageDescription}</p>
      </div>
      <OnboardingStageContext journey={journey} />
    </header>
  );
}

function OnboardingStageContext({ journey }: { journey: OnboardingJourneyState }) {
  if (journey.activeStep === 1) {
    return (
      <section aria-label="Agent preparation summary">
        <dl className="onboarding-runtime-summary">
          {journey.prepareFacts.map((fact) => (
            <div data-status={fact.status} key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  const connected = journey.messaging === "complete";
  return (
    <section
      aria-label={`${journey.agentName} Agent ${connected ? "connected to" : "awaiting connection to"} Feishu`}
      className="onboarding-messaging-connection"
      data-status={connected ? "complete" : "current"}
    >
      <div className="onboarding-connection-endpoint">
        <span aria-hidden="true" className="onboarding-endpoint-mark">
          OT
        </span>
        <span>
          <small>Agent</small>
          <strong>{journey.agentName}</strong>
        </span>
      </div>
      <div className="onboarding-messaging-bridge">
        <span>{connected ? "Connected" : "Authorization"}</span>
      </div>
      <div className="onboarding-connection-endpoint onboarding-connection-endpoint-feishu">
        <span aria-hidden="true" className="onboarding-endpoint-mark">
          FS
        </span>
        <span>
          <small>Team chat</small>
          <strong>Feishu</strong>
        </span>
      </div>
    </section>
  );
}

function onboardingJourney(
  current: OnboardingCurrentState | undefined,
  snapshot: OnboardingSnapshot | undefined,
): OnboardingJourneyState {
  if (!current) {
    return {
      activeStep: 1,
      agentName: snapshot?.targetAgent?.displayName ?? "OpenTag",
      messaging: "upcoming",
      prepareFacts: [
        { label: "Computer", status: "current", value: "Checking" },
        { label: "Runtime", status: "waiting", value: "Waiting" },
        { label: "Agent", status: "waiting", value: "Not created" },
      ],
      prepare: "current",
      stageDescription: "We’re reading your Computer and runtime state.",
      stageStatus: "Checking setup",
      stageTitle: "Prepare your Agent",
    };
  }

  if (snapshot && !snapshot.targetAgent) {
    const relevantComputers = snapshot.computers;
    const onlineComputers = relevantComputers
      .filter((computer) => computer.connectionStatus === "online")
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
    const computerById = new Map(onlineComputers.map((computer) => [computer.computerId, computer]));
    const readyRoute =
      snapshot.runtime.kind === "available"
        ? snapshot.runtime.providers
            .filter((provider) => provider.runtimeReady && computerById.has(provider.computerId))
            .sort((left, right) => {
              const computerOrder = (computerById.get(left.computerId)?.displayName ?? "").localeCompare(
                computerById.get(right.computerId)?.displayName ?? "",
              );
              return computerOrder !== 0 ? computerOrder : compareProviderFacts(left, right);
            })[0]
        : undefined;
    const readyComputer = readyRoute ? computerById.get(readyRoute.computerId) : undefined;
    const computerFact = readyComputer
      ? journeyComputerRouteFact(readyComputer)
      : relevantComputers.length === 0
        ? { label: "Computer", status: "current" as const, value: "Not connected" }
        : onlineComputers.length === 0
          ? { label: "Computer", status: "attention" as const, value: "Reconnect" }
          : journeyComputerRouteFact(onlineComputers[0] as WorkspaceComputerSummary);
    const runtimeFact: JourneyFact = readyRoute
      ? { label: "Runtime", status: "ready", value: providerLabel(readyRoute.provider) }
      : relevantComputers.length === 0 || onlineComputers.length === 0
        ? { label: "Runtime", status: "waiting", value: "Waiting" }
        : snapshot.runtime.kind === "available"
          ? { label: "Runtime", status: "current", value: "Setup required" }
          : { label: "Runtime", status: "current", value: "Checking" };
    return {
      activeStep: 1,
      agentName: "OpenTag",
      messaging: "upcoming",
      prepare: "current",
      prepareFacts: [computerFact, runtimeFact, { label: "Agent", status: "current", value: "Name pending" }],
      stageDescription: "Name your Agent, then confirm its ready runtime.",
      stageStatus: readyRoute
        ? "Ready to create"
        : relevantComputers.length === 0
          ? "Computer needed"
          : onlineComputers.length === 0
            ? "Computer offline"
            : snapshot.runtime.kind === "available"
              ? "Runtime needs setup"
              : "Checking runtime",
      stageTitle: "Prepare your Agent",
    };
  }

  const messagingReady = snapshot?.handoff?.handoffReady === true;
  const prepareComplete = current.kind === "handoff" || current.kind === "ready";
  const messagingCurrent = current.kind === "handoff";
  const setupReady = current.kind === "ready";
  const agentNeedsAttention = current.kind === "agent-runtime";
  const runtimeProvider =
    current.kind === "agent"
      ? current.provider.provider
      : (snapshot?.targetAgent?.runtimeProvider ??
        (current.kind === "handoff" || current.kind === "ready" || current.kind === "agent-runtime"
          ? current.agent.runtimeProvider
          : undefined));
  const computerFact = journeyComputerFact(current, snapshot);
  const runtimeFact: JourneyFact =
    current.kind === "workspace" || current.kind === "computer"
      ? { label: "Runtime", status: "waiting", value: "Waiting" }
      : current.kind === "provider"
        ? { label: "Runtime", status: "current", value: "Setup required" }
        : current.kind === "agent-runtime"
          ? { label: "Runtime", status: "attention", value: "Needs attention" }
          : { label: "Runtime", status: "ready", value: runtimeProvider ? providerLabel(runtimeProvider) : "Ready" };
  const agentFact: JourneyFact = snapshot?.targetAgent
    ? { label: "Agent", status: agentNeedsAttention ? "attention" : "ready", value: snapshot.targetAgent.displayName }
    : current.kind === "agent"
      ? { label: "Agent", status: "current", value: "Name pending" }
      : prepareComplete
        ? { label: "Agent", status: "ready", value: "Prepared" }
        : { label: "Agent", status: "waiting", value: "Not created" };

  return {
    activeStep: prepareComplete ? 2 : 1,
    agentName: snapshot?.targetAgent?.displayName ?? "OpenTag",
    prepare: prepareComplete ? "complete" : "current",
    prepareFacts: [computerFact, runtimeFact, agentFact],
    messaging: setupReady || messagingReady ? "complete" : messagingCurrent ? "current" : "upcoming",
    stageDescription: prepareComplete
      ? setupReady
        ? "Your Agent is ready for the first conversation in Feishu."
        : "Authorize the bot people will mention in conversations."
      : "Confirm where your Agent runs, then give it a clear identity.",
    stageStatus: onboardingStageStatus(current),
    stageTitle: prepareComplete
      ? setupReady
        ? "Your Agent is ready"
        : "Add your Agent to Feishu"
      : "Prepare your Agent",
  };
}

function journeyComputerFact(current: OnboardingCurrentState, snapshot: OnboardingSnapshot | undefined): JourneyFact {
  if (current.kind === "workspace") return { label: "Computer", status: "current", value: "Checking" };
  if (current.kind === "computer") {
    if (current.availability === "none") return { label: "Computer", status: "current", value: "Not connected" };
    if (current.availability === "offline") return { label: "Computer", status: "attention", value: "Reconnect" };
    return { label: "Computer", status: "current", value: "Choose one" };
  }

  if (current.kind === "provider" || current.kind === "agent") {
    return journeyComputerRouteFact(current.computer);
  }

  const boundComputer = snapshot?.computers.find((computer) => computer.computerId === current.agent.computerId);
  if (boundComputer) return journeyComputerRouteFact(boundComputer);

  const knownName =
    snapshot?.targetAgent?.computer.computerId === current.agent.computerId
      ? snapshot.targetAgent.computer.displayName
      : undefined;
  return {
    label: "Computer",
    status: "attention",
    value: knownName ? `${knownName} unavailable` : "Unavailable",
  };
}

function journeyComputerRouteFact(
  computer: Pick<WorkspaceComputerSummary, "connectionStatus" | "displayName">,
): JourneyFact {
  return computer.connectionStatus === "online"
    ? { label: "Computer", status: "ready", value: computer.displayName }
    : { label: "Computer", status: "attention", value: `${computer.displayName} · Offline` };
}

function onboardingStageStatus(current: OnboardingCurrentState): string {
  if (current.kind === "workspace") return "Checking OpenTag";
  if (current.kind === "computer") {
    if (current.availability === "none") return "Computer needed";
    if (current.availability === "offline") return "Computer offline";
    return "Choose a Computer";
  }
  if (current.kind === "provider") return "Runtime needs setup";
  if (current.kind === "agent") return "Runtime ready";
  if (current.kind === "agent-runtime") return "Runtime needs attention";
  if (current.kind === "handoff") return "Agent prepared";
  return "Setup complete";
}

function OnboardingHeader({ user }: { user: UserProfile }) {
  const [logoutState, setLogoutState] = useState<"idle" | "pending" | "error">("idle");
  async function logout() {
    setLogoutState("pending");
    try {
      await browserApi.logout();
      window.location.assign("/login");
    } catch {
      setLogoutState("error");
    }
  }
  return (
    <header className="onboarding-header">
      <a className="brand" href={AGENTS_ROUTE}>
        OpenTag
      </a>
      <div className="onboarding-account">
        <span>{user.displayName}</span>
        <Button size="compact" variant="secondary" disabled={logoutState === "pending"} onClick={logout}>
          {logoutState === "pending" ? "Signing out…" : logoutState === "error" ? "Retry sign out" : "Sign out"}
        </Button>
      </div>
    </header>
  );
}

function OnboardingLoading() {
  return (
    <div aria-label="Loading current server state" className="loading-state onboarding-loading" role="status">
      <span />
      <span />
      <span />
    </div>
  );
}

function OnboardingContent({
  completionState,
  onAgentCreated,
  onChooseAgent,
  onCompleteSetup,
  onReload,
  refreshPending,
  snapshot,
  state,
  workspaceId,
}: {
  completionState: CompletionState;
  onAgentCreated: (agentId: string) => void;
  onChooseAgent: (agentId: string) => void;
  onCompleteSetup: (agentId: string) => void;
  onReload: () => void;
  refreshPending: boolean;
  snapshot: OnboardingSnapshot;
  state: OnboardingState;
  workspaceId: string;
}) {
  if (snapshot.targetCandidates.length > 0 && !snapshot.targetAgent) {
    return (
      <ActionSection
        title="Choose the Agent to finish"
        description="More than one existing Agent could be continued safely."
      >
        <div className="onboarding-choice-list">
          {snapshot.targetCandidates.map((agent) => (
            <button className="onboarding-choice" key={agent.id} type="button" onClick={() => onChooseAgent(agent.id)}>
              <strong>{agent.displayName}</strong>
              <span>
                {providerLabel(agent.runtimeProvider)} on {agent.computer.displayName}
              </span>
            </button>
          ))}
        </div>
      </ActionSection>
    );
  }
  if (!snapshot.targetAgent) {
    return (
      <section className="onboarding-action">
        <AgentCreationFlow
          facts={onboardingAgentCreationFacts(snapshot)}
          initialDisplayName="OpenTag"
          refreshing={refreshPending}
          workspaceId={workspaceId}
          onCreated={(agent) => onAgentCreated(agent.id)}
          onRefresh={onReload}
        />
      </section>
    );
  }

  const current = state.currentState;
  if (current.kind === "workspace") {
    return <ActionSection title="Preparing OpenTag" description="Setup will continue automatically." pending />;
  }
  if (current.kind === "computer" && current.availability === "none") {
    return (
      <section className="onboarding-action">
        <ComputerSetup workspaceId={workspaceId} onConnected={onReload} />
      </section>
    );
  }
  if (current.kind === "computer" && current.availability === "offline") {
    return (
      <ActionSection
        title="Reconnect your Computer"
        description={`Open OpenTag on ${current.computers.map((computer) => computer.displayName).join(", ")}.`}
      >
        <ReloadButton pending={refreshPending} onReload={onReload} />
      </ActionSection>
    );
  }
  if (current.kind === "computer" && current.availability === "choice") {
    return (
      <ActionSection
        title="Choose a runnable Computer"
        description="OpenTag could not safely choose between these Computers."
      />
    );
  }
  if (current.kind === "provider") {
    const factUnavailable = snapshot.runtime.kind === "unavailable";
    const attention = runtimeAttention(snapshot.runtime, current.computer.id);
    const copy = attention ? runtimeAttentionCopy(attention, current.computer.displayName) : undefined;
    return (
      <ActionSection
        title={copy?.title ?? (factUnavailable ? "Confirm the runtime route" : "Prepare Codex or Claude Code")}
        description={
          copy?.description ??
          (factUnavailable
            ? "OpenTag cannot yet confirm an Agent-ready Provider on this Computer."
            : `Finish Provider setup on ${current.computer.displayName}, then check again.`)
        }
      >
        <ReloadButton pending={refreshPending} onReload={onReload} />
      </ActionSection>
    );
  }
  if (current.kind === "agent") {
    return (
      <ActionSection
        title="Create the Agent"
        description={`The runnable route is ${providerLabel(current.provider.provider)} on ${current.computer.displayName}.`}
      />
    );
  }
  if (current.kind === "agent-runtime") {
    const agent = snapshot.targetAgent;
    const attention = runtimeAttention(snapshot.runtime, current.agent.computerId, current.agent.runtimeProvider);
    const copy = attention ? runtimeAttentionCopy(attention, agent?.computer.displayName ?? "its Computer") : undefined;
    return (
      <ActionSection
        title={copy?.title ?? `${agent?.displayName ?? "Your Agent"} needs its runtime route`}
        description={
          copy
            ? `${copy.description} The Agent identity and Feishu setup are unchanged.`
            : "The Agent identity and Feishu setup are unchanged. Restore its bound Computer and Provider, then check again."
        }
      >
        <ReloadButton pending={refreshPending} onReload={onReload} />
      </ActionSection>
    );
  }
  if (current.kind === "handoff") {
    return (
      <ActionSection title={handoffTitle(current)} description="Authorize the Feishu Bot people will mention.">
        <FeishuSetup agentId={current.agent.id} onSuccess={onReload}>
          {(control) => <FeishuAction control={control} progress={current.progress} />}
        </FeishuSetup>
      </ActionSection>
    );
  }
  if (completionState.kind === "pending") {
    return <ActionSection title="Finishing OpenTag setup" description="Saving the verified Agent handoff." pending />;
  }
  if (completionState.kind === "error") {
    return (
      <ActionSection title="We couldn’t finish setup" description={completionState.error.message}>
        <Button onClick={() => onCompleteSetup(current.agent.id)}>Try again</Button>
      </ActionSection>
    );
  }
  return (
    <ActionSection
      title="OpenTag is ready"
      description="Add the Bot to a Feishu group, then mention OpenTag with your first task."
    >
      <div className="actions">
        <a className={buttonClassName()} href={FEISHU_BOT_APP_LINK} rel="noreferrer" target="_blank">
          Open Feishu
        </a>
        <a className={buttonClassName({ variant: "secondary" })} href={agentGeneralRoute(current.agent.id)}>
          Manage this Agent
        </a>
      </div>
      <p className="onboarding-helper">Setup is complete.</p>
    </ActionSection>
  );
}

function ActionSection({
  children,
  description,
  pending = false,
  title,
}: {
  children?: ReactNode;
  description: string;
  pending?: boolean;
  title: string;
}) {
  return (
    <section className="onboarding-action" aria-busy={pending || undefined}>
      <div className="onboarding-action-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {pending ? (
        <p className="onboarding-pending" role="status">
          Working from current Server facts…
        </p>
      ) : null}
      {children}
    </section>
  );
}

function ReloadButton({ onReload, pending }: { onReload: () => void; pending: boolean }) {
  return (
    <div className="onboarding-feedback">
      <Button disabled={pending} onClick={onReload}>
        {pending ? "Checking…" : "Check again"}
      </Button>
      {pending ? (
        <p className="onboarding-helper" role="status">
          Refreshing Server facts…
        </p>
      ) : null}
    </div>
  );
}

function FeishuAction({
  control,
  progress,
}: {
  control: FeishuSetupControl;
  progress: Extract<OnboardingCurrentState, { kind: "handoff" }>["progress"];
}) {
  const intent =
    progress.kind === "attention" && progress.bindingState === "reauthorization_required" ? "reauthorize" : "create";
  const label =
    progress.kind === "none"
      ? "Connect existing or new Feishu Bot"
      : progress.kind === "attention" && progress.bindingState === "reauthorization_required"
        ? "Reauthorize Feishu"
        : "Resume Feishu setup";
  return (
    <div className="onboarding-feedback">
      <Button onClick={() => void control.start(intent)}>{label}</Button>
      {control.feedback}
    </div>
  );
}

function handoffTitle(current: Extract<OnboardingCurrentState, { kind: "handoff" }>): string {
  if (current.progress.kind === "none") return "Connect OpenTag to Feishu";
  if (current.progress.kind === "provisioning") return "Finish Feishu authorization";
  if (current.progress.kind === "active-not-ready") return "Finish Feishu handoff";
  return current.progress.bindingState === "reauthorization_required"
    ? "Update Feishu permissions"
    : "Repair Feishu authorization";
}

async function loadSnapshot(
  workspaceId: string,
  runtimeFacts: RuntimeFactsAdapter,
  targetAgentId?: string,
): Promise<OnboardingSnapshot> {
  const [{ computers }, { agents }] = await Promise.all([
    browserApi.computers(workspaceId),
    browserApi.agents(workspaceId),
  ]);
  const targetCandidates = agents.filter((agent) => agent.status === "active");
  const targetAgent =
    targetCandidates.find((agent) => agent.id === targetAgentId) ??
    (targetAgentId === undefined && targetCandidates.length === 1 ? targetCandidates[0] : undefined);
  const [runtime, handoff] = await Promise.all([
    runtimeFacts.load({ workspaceId, agents, computers }),
    targetAgent ? browserApi.imBindingHandoff(targetAgent.id) : Promise.resolve(undefined),
  ]);
  return { agents, computers, targetAgent, targetCandidates, handoff, runtime };
}

function resolveSnapshot(snapshot: OnboardingSnapshot): { state: OnboardingState } {
  const providers = snapshot.runtime.kind === "available" ? snapshot.runtime.providers : [];
  const agent: OnboardingAgent | undefined = snapshot.targetAgent
    ? {
        id: snapshot.targetAgent.id,
        computerId: snapshot.targetAgent.computer.computerId,
        runtimeProvider: snapshot.targetAgent.runtimeProvider,
      }
    : undefined;
  return {
    state: deriveOnboardingState({
      workspace: {},
      computers: snapshot.computers.map(({ computerId, displayName, connectionStatus }) => ({
        id: computerId,
        displayName,
        connectionStatus,
      })),
      providers,
      agent,
      handoff: snapshot.handoff,
    }),
  };
}

function onboardingAgentCreationFacts(snapshot: OnboardingSnapshot): AgentCreationFacts {
  const computers = snapshot.computers.map(({ computerId, displayName, connectionStatus }) => ({
    id: computerId,
    displayName,
    connectionStatus,
  }));
  const computerIds = new Set(computers.map((computer) => computer.id));
  return {
    computers,
    providers:
      snapshot.runtime.kind === "available"
        ? snapshot.runtime.providers.filter((provider) => computerIds.has(provider.computerId))
        : [],
    runtimeEvidenceAvailable: snapshot.runtime.kind === "available",
  };
}

function runtimeAttention(
  runtime: RuntimeFactsResult,
  computerId: string,
  provider?: AgentRuntimeProvider,
): (RuntimeProviderFact & { readonly status: Exclude<RuntimeProviderStatus, "ready"> }) | undefined {
  if (runtime.kind === "unavailable") return undefined;
  return [...runtime.providers]
    .filter(
      (fact): fact is RuntimeProviderFact & { readonly status: Exclude<RuntimeProviderStatus, "ready"> } =>
        fact.status !== undefined && fact.status !== "ready",
    )
    .filter(
      (fact) =>
        fact.computerId === computerId &&
        fact.runtimeReady === false &&
        (provider === undefined || fact.provider === provider),
    )
    .sort(compareProviderFacts)[0];
}

function runtimeAttentionCopy(
  fact: RuntimeProviderFact & { readonly status: Exclude<RuntimeProviderStatus, "ready"> },
  computerName: string,
): { readonly title: string; readonly description: string } {
  const label = providerLabel(fact.provider);
  switch (fact.status) {
    case "checking":
      return {
        title: `Checking ${label}`,
        description: `OpenTag is checking ${label} readiness on ${computerName}.`,
      };
    case "install":
      return { title: `Install ${label}`, description: `Install ${label} on ${computerName}, then check again.` };
    case "sign-in":
      return { title: `Sign in to ${label}`, description: `Sign in to ${label} on ${computerName}, then check again.` };
    case "unavailable":
      return {
        title: `Restore ${label}`,
        description: `${label} is currently unavailable on ${computerName}. Restore it, then check again.`,
      };
    default:
      return {
        title: `Prepare ${label}`,
        description: `Finish ${label} setup on ${computerName}, then check again.`,
      };
  }
}

function compareProviderFacts(left: OnboardingProvider, right: OnboardingProvider): number {
  return left.provider === right.provider ? 0 : left.provider === "codex" ? -1 : 1;
}

function providerLabel(provider: AgentRuntimeProvider): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}
