import type {
  AgentRuntimeProvider,
  AgentSummary,
  UserProfile,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { type ReactNode, useMemo, useState } from "react";
import { type AgentCreationFacts, AgentCreationFlow } from "../agent-creation/agent-creation-flow.js";
import { browserApi } from "../api.js";
import feishuIconUrl from "../assets/feishu.svg";
import { FeishuSetup, type FeishuSetupControl } from "../im/feishu-setup.js";
import { Button, Link as KumoLink, LinkButton, Text } from "../ui/design-system.js";
import {
  deriveOnboardingState,
  type OnboardingAgent,
  type OnboardingCurrentState,
  type OnboardingFacts,
  type OnboardingProvider,
  type OnboardingState,
} from "./flow.js";
import type { RuntimeFactsResult, RuntimeProviderFact, RuntimeProviderStatus } from "./runtime-facts.js";

/**
 * `live` renders the production onboarding page. `preview` renders the same hierarchy, copy and
 * state communication from fixed facts for review, and never starts a Server write: no Agent
 * creation intent is read or resumed, and no Feishu setup lifecycle is mounted.
 */
export type OnboardingViewMode = "live" | "preview";

export interface OnboardingViewProps {
  readonly completionState: CompletionState;
  readonly load: OnboardingLoadState;
  readonly mode?: OnboardingViewMode;
  readonly onAgentCreated: (agentId: string) => void;
  readonly onChooseAgent: (agentId: string) => void;
  readonly onCompleteSetup: (agentId: string) => void;
  /** An attended refresh of Server facts from inside the current stage. */
  readonly onReload: () => void;
  /** Retries the failed initial load of Server facts. */
  readonly onRetryLoad: () => void;
  readonly refreshPending: boolean;
  readonly user: UserProfile;
  readonly accountId: string;
}

/**
 * The whole onboarding presentation, from the same derived state production uses. It owns no
 * Server facts, so the production page and the staging Scenario Preview render one page rather
 * than two.
 */
export function OnboardingView({
  completionState,
  load,
  mode = "live",
  onAgentCreated,
  onChooseAgent,
  onCompleteSetup,
  onReload,
  onRetryLoad,
  refreshPending,
  user,
  accountId,
}: OnboardingViewProps) {
  const snapshot = load.kind === "ready" ? load.snapshot : undefined;
  const resolved = useMemo(() => (snapshot ? resolveSnapshot(snapshot) : undefined), [snapshot]);
  const journey = onboardingJourney(resolved?.state.currentState, snapshot);
  return (
    <div className="min-h-screen bg-kumo-canvas" data-ui="onboarding-shell">
      <OnboardingHeader preview={mode === "preview"} user={user} />
      <main
        className="mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[minmax(14rem,18rem)_1fr] md:p-8"
        data-ui="onboarding-main"
      >
        <div className="contents" data-ui="onboarding-layout">
          <OnboardingJourney journey={journey} />
          <section
            className="grid gap-6 rounded-lg bg-kumo-base p-4 ring ring-kumo-line md:p-6"
            aria-labelledby="onboarding-stage-title"
            data-ui="onboarding-workspace"
          >
            <OnboardingStageHeader journey={journey} />
            <div className="grid gap-6" data-ui="onboarding-workspace-body">
              {load.kind === "loading" ? <OnboardingLoading /> : null}
              {load.kind === "error" ? (
                <ActionSection title="We couldn’t load setup" description={load.error.message}>
                  <Button onClick={onRetryLoad}>Try again</Button>
                </ActionSection>
              ) : null}
              {snapshot && resolved ? (
                <OnboardingContent
                  completionState={completionState}
                  mode={mode}
                  onChooseAgent={onChooseAgent}
                  onAgentCreated={onAgentCreated}
                  onCompleteSetup={onCompleteSetup}
                  onReload={onReload}
                  refreshPending={refreshPending}
                  snapshot={snapshot}
                  state={resolved.state}
                  accountId={accountId}
                />
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

const FEISHU_BOT_APP_LINK = "https://applink.feishu.cn/client/bot/open";

/** The application route this page hands the Workspace over to once setup is complete. */
const AGENTS_ROUTE = "/agents";

function agentGeneralRoute(agentId: string): string {
  return `${AGENTS_ROUTE}/${agentId}`;
}

export type OnboardingLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "ready"; readonly snapshot: OnboardingSnapshot };

export type CompletionState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly error: Error };

export interface OnboardingSnapshot {
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

/**
 * The state of the link between the Agent and Feishu, as the connection strip reports it. This is
 * finer than the step status: a step that is merely "current" covers a binding that has not been
 * started, one being provisioned, and one that has broken, and those ask different things of the
 * Account.
 */
type MessagingLink = "none" | "connecting" | "not-ready" | "attention" | "connected";

interface OnboardingJourneyState {
  readonly activeStep: 1 | 2;
  readonly agentName: string;
  readonly messaging: JourneyStatus;
  readonly messagingLink: MessagingLink;
  readonly prepareFacts: readonly JourneyFact[];
  readonly prepare: JourneyStatus;
  readonly stageDescription: string;
  readonly stageStatus: string;
  readonly stageTitle: string;
}

function OnboardingJourney({ journey }: { journey: OnboardingJourneyState }) {
  return (
    <aside className="grid content-start gap-4" data-ui="onboarding-journey">
      <div className="grid gap-1" data-ui="onboarding-journey-intro">
        <span className="text-xs font-medium uppercase text-kumo-subtle">Getting started</span>
        <Text as="h1" size="lg" variant="heading">
          Set up OpenTag
        </Text>
        <Text as="p" variant="secondary">
          An AI teammate your team mentions in Feishu, working on a Computer you connect.
        </Text>
      </div>
      <nav aria-label="Onboarding steps">
        <ol className="grid gap-2" data-ui="onboarding-steps">
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
      <p className="text-sm text-kumo-subtle" data-ui="onboarding-journey-note">
        You can leave and return at any time.
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
    <li className="flex items-start gap-3 rounded-md p-2" data-status={status} data-ui="onboarding-step">
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-tint text-sm font-medium"
        data-ui="onboarding-step-number"
      >
        {status === "complete" ? "✓" : number}
      </span>
      <span className="grid gap-1" data-ui="onboarding-step-copy">
        <span className="text-xs text-kumo-subtle" data-ui="onboarding-step-status">
          {statusLabel}
        </span>
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
    </li>
  );
}

function OnboardingStageHeader({ journey }: { journey: OnboardingJourneyState }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3" data-ui="onboarding-stage-header">
      <div className="grid gap-1" data-ui="onboarding-stage-copy">
        <span className="text-xs font-medium uppercase text-kumo-subtle" data-ui="onboarding-stage-kicker">
          Step {String(journey.activeStep).padStart(2, "0")} / 02
        </span>
        <span className="text-sm text-kumo-subtle" data-ui="onboarding-stage-status">
          {journey.stageStatus}
        </span>
        <Text as="h2" id="onboarding-stage-title" variant="heading">
          {journey.stageTitle}
        </Text>
        <Text as="p" variant="secondary">
          {journey.stageDescription}
        </Text>
      </div>
      <OnboardingStageContext journey={journey} />
    </header>
  );
}

function OnboardingStageContext({ journey }: { journey: OnboardingJourneyState }) {
  if (journey.activeStep === 1) {
    return (
      <section aria-label="Agent preparation summary">
        <dl className="grid gap-2 text-sm" data-ui="onboarding-runtime-summary">
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

  const link = MESSAGING_LINK_COPY[journey.messagingLink];
  return (
    <section
      aria-label={`${journey.agentName} Agent ${link.description} Feishu`}
      className="grid gap-3 rounded-md bg-kumo-recessed p-4"
      data-ui="onboarding-messaging-connection"
      data-status={link.status}
    >
      <div className="flex items-center gap-2" data-ui="onboarding-connection-endpoint">
        {/*
          This endpoint is the Agent, whose name the Account chose, so the mark is derived from that
          name rather than stamped with the product's own initials — an Agent named 小助手 is not OT.
        */}
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-full bg-kumo-brand text-kumo-inverse"
          data-ui="onboarding-endpoint-mark"
        >
          {[...journey.agentName.trim()][0] ?? "?"}
        </span>
        <span>
          <small>Agent</small>
          <strong>{journey.agentName}</strong>
        </span>
      </div>
      <div className="text-center text-sm text-kumo-subtle" data-ui="onboarding-messaging-bridge">
        <span>{link.label}</span>
      </div>
      <div className="flex items-center gap-2" data-ui="onboarding-connection-endpoint-feishu">
        {/* Feishu's own mark is what the Account recognises here; "FS" is an abbreviation nobody uses. */}
        <img alt="" className="size-8 rounded-full" data-ui="onboarding-endpoint-mark-image" src={feishuIconUrl} />
        <span>
          <small>Team chat</small>
          <strong>Feishu</strong>
        </span>
      </div>
    </section>
  );
}

/**
 * Every label is a state of the link itself, on one axis — whether work can be handed through it —
 * so the strip reads as one value changing rather than as unrelated words taking turns. What has to
 * happen to advance it is named by the action below, which is where the Account acts on it.
 *
 * Each label is held to the evidence the page actually has. `handoffReady` is a single combined
 * gate: the Server clears it when the Agent runtime is not ready, when the Feishu CLI is not ready,
 * or when the connection lease has lapsed, and it reports which of those only as one false. An
 * active binding that fails that gate is therefore not progress and not a severed transport; it is
 * a link the page cannot confirm, and it says exactly that.
 */
const MESSAGING_LINK_COPY: Record<
  MessagingLink,
  { label: string; description: string; status: "current" | "working" | "attention" | "complete" }
> = {
  none: { label: "Not connected", description: "not yet connected to", status: "current" },
  connecting: { label: "Connecting…", description: "connecting to", status: "working" },
  "not-ready": { label: "Not ready", description: "not confirmed ready to reach", status: "current" },
  attention: { label: "Needs attention", description: "needs attention on its link to", status: "attention" },
  connected: { label: "Connected", description: "connected to", status: "complete" },
};

function messagingLink(current: OnboardingCurrentState | undefined, messaging: JourneyStatus): MessagingLink {
  if (messaging === "complete") return "connected";
  if (current?.kind !== "handoff") return "none";
  // `provisioning` is the one state the Server states as an act in progress. `active-not-ready`
  // names no cause, and `attention` covers an expired authorization as much as a failure, so
  // neither is reported as movement or as a disconnection.
  if (current.progress.kind === "provisioning") return "connecting";
  if (current.progress.kind === "active-not-ready") return "not-ready";
  if (current.progress.kind === "attention") return "attention";
  return "none";
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
      messagingLink: "none",
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
      messagingLink: "none",
      prepare: "current",
      prepareFacts: [computerFact, runtimeFact, { label: "Agent", status: "current", value: "Not created" }],
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
  const messaging: JourneyStatus =
    setupReady || messagingReady ? "complete" : messagingCurrent ? "current" : "upcoming";
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
      ? { label: "Agent", status: "current", value: "Not created" }
      : prepareComplete
        ? { label: "Agent", status: "ready", value: "Prepared" }
        : { label: "Agent", status: "waiting", value: "Not created" };

  return {
    activeStep: prepareComplete ? 2 : 1,
    agentName: snapshot?.targetAgent?.displayName ?? "OpenTag",
    prepare: prepareComplete ? "complete" : "current",
    prepareFacts: [computerFact, runtimeFact, agentFact],
    messaging,
    messagingLink: messagingLink(current, messaging),
    stageDescription: prepareComplete
      ? setupReady
        ? "Your Agent is ready for the first conversation in Feishu."
        : ""
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

function OnboardingHeader({ preview, user }: { preview: boolean; user: UserProfile }) {
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
    <header
      className="flex items-center justify-between border-b border-kumo-line bg-kumo-base px-4 py-3 md:px-8"
      data-ui="onboarding-header"
    >
      <KumoLink href={AGENTS_ROUTE} className="font-semibold text-kumo-strong">
        OpenTag
      </KumoLink>
      <div className="flex items-center gap-3" data-ui="onboarding-account">
        <span>{user.displayName}</span>
        <Button size="compact" variant="secondary" disabled={preview || logoutState === "pending"} onClick={logout}>
          {logoutState === "pending" ? "Signing out…" : logoutState === "error" ? "Retry sign out" : "Sign out"}
        </Button>
      </div>
    </header>
  );
}

function OnboardingLoading() {
  return (
    <div aria-label="Loading current server state" className="grid gap-2" data-ui="onboarding-loading" role="status">
      <span className="h-3 animate-pulse rounded bg-kumo-tint" />
      <span className="h-3 animate-pulse rounded bg-kumo-tint" />
      <span className="h-3 w-2/3 animate-pulse rounded bg-kumo-tint" />
    </div>
  );
}

function OnboardingContent({
  completionState,
  mode,
  onAgentCreated,
  onChooseAgent,
  onCompleteSetup,
  onReload,
  refreshPending,
  snapshot,
  state,
  accountId,
}: {
  completionState: CompletionState;
  mode: OnboardingViewMode;
  onAgentCreated: (agentId: string) => void;
  onChooseAgent: (agentId: string) => void;
  onCompleteSetup: (agentId: string) => void;
  onReload: () => void;
  refreshPending: boolean;
  snapshot: OnboardingSnapshot;
  state: OnboardingState;
  accountId: string;
}) {
  if (snapshot.targetCandidates.length > 0 && !snapshot.targetAgent) {
    return (
      <ActionSection
        title="Choose the Agent to finish"
        description="More than one existing Agent could be continued safely."
      >
        <div className="grid gap-3" data-ui="onboarding-choice-list">
          {snapshot.targetCandidates.map((agent) => (
            <Button key={agent.id} type="button" variant="secondary" onClick={() => onChooseAgent(agent.id)}>
              <strong>{agent.displayName}</strong>
              <span>
                {providerLabel(agent.runtimeProvider)} on {agent.computer.displayName}
              </span>
            </Button>
          ))}
        </div>
      </ActionSection>
    );
  }
  if (!snapshot.targetAgent) {
    return (
      <section className="grid gap-4" data-ui="onboarding-action">
        <AgentCreationFlow
          // This branch is only reached with no Agent to continue, so the derived name cannot
          // collide with one. It stays out of the first run unless the display name derives to
          // nothing and the Account has to choose a name itself.
          agentNameDisclosure="when-required"
          facts={onboardingAgentCreationFacts(snapshot)}
          initialDisplayName="OpenTag"
          preview={mode === "preview"}
          refreshing={refreshPending}
          accountId={accountId}
          onCreated={(agent) => onAgentCreated(agent.id)}
          onRefresh={onReload}
        />
      </section>
    );
  }

  const current = state.currentState;
  // deriveOnboardingState resolves an existing Agent before it can report any of these, and
  // facts.agent comes straight from snapshot.targetAgent, so the AgentCreationFlow branch above
  // owns every one of them. The arm stays so the union remains exhaustive for the Agent-bound
  // narrowing below, and so a change to that guard degrades to a holding state instead of reading
  // `agent` off a variant that does not carry one.
  if (
    current.kind === "workspace" ||
    current.kind === "computer" ||
    current.kind === "provider" ||
    current.kind === "agent"
  ) {
    return <ActionSection title="Preparing OpenTag" description="Setup will continue automatically." pending />;
  }
  if (current.kind === "agent-runtime") {
    const agent = snapshot.targetAgent;
    const attention = runtimeAttention(snapshot.runtime, current.agent.computerId, current.agent.runtimeProvider);
    const copy = attention ? runtimeAttentionCopy(attention, agent?.computer.displayName ?? "its Computer") : undefined;
    return (
      <ActionSection
        title={copy?.title ?? `${agent?.displayName ?? "Your Agent"} needs a Runtime`}
        description={
          copy
            ? `${copy.description} The Agent identity and Feishu setup are unchanged.`
            : "The Agent identity and Feishu setup are unchanged. Restore its bound Computer and Runtime, then check again."
        }
      >
        <ReloadButton pending={refreshPending} onReload={onReload} />
      </ActionSection>
    );
  }
  if (current.kind === "handoff") {
    return (
      <ActionSection title={handoffTitle(current)} description="Authorize the Feishu bot people will mention.">
        {mode === "preview" ? (
          <FeishuAction control={INERT_FEISHU_SETUP} progress={current.progress} />
        ) : (
          <FeishuSetup agentId={current.agent.id} onSuccess={onReload}>
            {(control) => <FeishuAction control={control} progress={current.progress} />}
          </FeishuSetup>
        )}
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
      description="Add the bot to a Feishu group, then mention OpenTag with your first task."
    >
      <div className="flex flex-wrap gap-3">
        <LinkButton external href={FEISHU_BOT_APP_LINK} target="_blank" rel="noreferrer">
          Open Feishu
        </LinkButton>
        <LinkButton href={agentGeneralRoute(current.agent.id)} variant="secondary">
          Manage this Agent
        </LinkButton>
      </div>
      <p className="text-sm text-kumo-subtle" data-ui="onboarding-helper">
        Setup is complete.
      </p>
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
    <section className="grid gap-4" aria-busy={pending || undefined} data-ui="onboarding-action">
      <div data-ui="onboarding-action-heading">
        <div>
          <Text as="h2" variant="heading">
            {title}
          </Text>
          <Text as="p" variant="secondary">
            {description}
          </Text>
        </div>
      </div>
      {pending ? (
        <p className="text-sm text-kumo-subtle" data-ui="onboarding-pending" role="status">
          Working from current Server facts…
        </p>
      ) : null}
      {children}
    </section>
  );
}

function ReloadButton({ onReload, pending }: { onReload: () => void; pending: boolean }) {
  return (
    <div className="grid gap-2" data-ui="onboarding-feedback">
      <Button disabled={pending} onClick={onReload}>
        {pending ? "Checking…" : "Check again"}
      </Button>
      {pending ? (
        <p className="text-sm text-kumo-subtle" data-ui="onboarding-helper" role="status">
          Refreshing Server facts…
        </p>
      ) : null}
    </div>
  );
}

/** Preview shows the Feishu control without mounting a setup lifecycle that could start an attempt. */
const INERT_FEISHU_SETUP: FeishuSetupControl = { start: async () => false, feedback: null };

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
      ? "Connect a Feishu bot"
      : progress.kind === "attention" && progress.bindingState === "reauthorization_required"
        ? "Reauthorize Feishu"
        : "Resume Feishu setup";
  return (
    <div className="grid gap-2" data-ui="onboarding-feedback">
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

export function resolveSnapshot(snapshot: OnboardingSnapshot): { state: OnboardingState } {
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
