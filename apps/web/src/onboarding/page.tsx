import type {
  AgentRuntimeProvider,
  AgentSummary,
  CreateAgentRequest,
  MeMembership,
  TeamComputerSummary,
  UserProfile,
} from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browserApi } from "../api.js";
import { ComputerSetup } from "../computer-setup.js";
import { FeishuSetup, type FeishuSetupControl } from "../im/feishu-setup.js";
import {
  deriveOnboardingState,
  type OnboardingAgent,
  type OnboardingCurrentState,
  type OnboardingFacts,
  type OnboardingProvider,
  type OnboardingState,
} from "./flow.js";
import { productionRuntimeFactsAdapter, type RuntimeFactsAdapter, type RuntimeFactsResult } from "./runtime-facts.js";

const FEISHU_BOT_APP_LINK = "https://applink.feishu.cn/client/bot/open";
const CREATE_INTENT_VERSION = 1;

type PageLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "ready"; readonly snapshot: OnboardingSnapshot };

interface OnboardingSnapshot {
  readonly agents: readonly AgentSummary[];
  readonly computers: readonly TeamComputerSummary[];
  readonly targetAgent: AgentSummary | undefined;
  readonly targetCandidates: readonly AgentSummary[];
  readonly handoff: OnboardingFacts["handoff"];
  readonly runtime: RuntimeFactsResult;
}

interface RouteSelection {
  readonly computerId: string;
  readonly provider?: AgentRuntimeProvider;
}

interface CreationIntentRecord {
  readonly version: typeof CREATE_INTENT_VERSION;
  readonly teamId: string;
  readonly creationIntentId: string;
  readonly request: Omit<CreateAgentRequest, "creationIntentId">;
}

interface CreationState {
  readonly key: string;
  readonly kind: "pending" | "error";
  readonly message?: string;
}

export interface OnboardingPageProps {
  readonly membership: MeMembership;
  readonly user: UserProfile;
  readonly runtimeFacts?: RuntimeFactsAdapter;
}

/**
 * Owns the whole conditional onboarding page. The page persists no step: each
 * reload starts from authoritative Team, Computer, Agent, runtime and handoff
 * facts, plus only the explicit route/identity choices and replay intent.
 */
export function OnboardingPage({
  membership,
  user,
  runtimeFacts = productionRuntimeFactsAdapter,
}: OnboardingPageProps) {
  const [revision, setRevision] = useState(0);
  const [loadState, setLoadState] = useState<PageLoadState>({ kind: "loading" });
  const [creation, setCreation] = useState<CreationState>();
  const [creationRetry, setCreationRetry] = useState(0);
  const creationAttempt = useRef<string | undefined>(undefined);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit Server-fact reload trigger.
  useEffect(() => {
    let active = true;
    setLoadState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void loadSnapshot(membership.teamId, runtimeFacts).then(
      (snapshot) => active && setLoadState({ kind: "ready", snapshot }),
      (cause: unknown) =>
        active &&
        setLoadState({
          kind: "error",
          error: cause instanceof Error ? cause : new Error("Unable to load onboarding facts"),
        }),
    );
    return () => {
      active = false;
    };
  }, [membership.teamId, revision, runtimeFacts]);

  useEffect(() => {
    const refresh = () => reload();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [reload]);

  const resolved = useMemo(() => {
    if (loadState.kind !== "ready") return undefined;
    return resolveSnapshot(membership, loadState.snapshot);
  }, [loadState, membership]);

  useEffect(() => {
    if (!resolved?.state.canManage || resolved.state.currentState.kind !== "agent") return;
    const current = resolved.state.currentState;
    const request = normalizedAgentRequest(current);
    const key = `${request.computerId}:${request.runtimeProvider}:${creationRetry}`;
    if (creationAttempt.current === key) return;
    creationAttempt.current = key;
    setCreation({ key, kind: "pending" });
    let active = true;
    void createOnboardingAgent(membership.teamId, request).then(
      (agent) => {
        if (!active) return;
        rememberTargetAgent(membership.teamId, agent.id);
        setCreation(undefined);
        reload();
      },
      (cause: unknown) => {
        if (!active) return;
        setCreation({
          key,
          kind: "error",
          message: cause instanceof Error ? cause.message : "Unable to prepare OpenTag",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [creationRetry, membership.teamId, reload, resolved]);

  return (
    <div className="onboarding-shell">
      <OnboardingHeader user={user} />
      <main className="onboarding-main">
        <header className="onboarding-title">
          <span className="eyebrow">Onboarding</span>
          <h1>Set up OpenTag</h1>
          <p>Bring your first Team Agent to Feishu.</p>
        </header>
        {loadState.kind === "loading" ? <OnboardingLoading /> : null}
        {loadState.kind === "error" ? (
          <ActionSection title="We couldn’t load setup" description={loadState.error.message}>
            <button className="button" type="button" onClick={reload}>
              Try again
            </button>
          </ActionSection>
        ) : null}
        {loadState.kind === "ready" && resolved ? (
          <OnboardingContent
            canManage={resolved.state.canManage}
            creation={creation}
            onChooseAgent={(agentId) => {
              rememberTargetAgent(membership.teamId, agentId);
              reload();
            }}
            onChooseRoute={(selection) => {
              rememberRouteSelection(membership.teamId, selection);
              reload();
            }}
            onCreationRetry={() => {
              creationAttempt.current = undefined;
              setCreationRetry((value) => value + 1);
            }}
            onReload={reload}
            snapshot={loadState.snapshot}
            state={resolved.state}
            teamId={membership.teamId}
          />
        ) : null}
      </main>
    </div>
  );
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
      <a className="brand" href="/onboarding">
        OpenTag
      </a>
      <div className="onboarding-account">
        <span>{user.displayName}</span>
        <button
          className="secondary compact-button"
          disabled={logoutState === "pending"}
          type="button"
          onClick={logout}
        >
          {logoutState === "pending" ? "Signing out…" : logoutState === "error" ? "Retry sign out" : "Sign out"}
        </button>
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
  canManage,
  creation,
  onChooseAgent,
  onChooseRoute,
  onCreationRetry,
  onReload,
  snapshot,
  state,
  teamId,
}: {
  canManage: boolean;
  creation: CreationState | undefined;
  onChooseAgent: (agentId: string) => void;
  onChooseRoute: (selection: RouteSelection) => void;
  onCreationRetry: () => void;
  onReload: () => void;
  snapshot: OnboardingSnapshot;
  state: OnboardingState;
  teamId: string;
}) {
  if (snapshot.targetCandidates.length > 1 && !snapshot.targetAgent) {
    return (
      <ActionSection
        readonly={!canManage}
        title="Choose the Agent to finish"
        description="More than one existing Team Agent could be continued safely."
      >
        {canManage ? (
          <div className="onboarding-choice-list">
            {snapshot.targetCandidates.map((agent) => (
              <button
                className="onboarding-choice"
                key={agent.id}
                type="button"
                onClick={() => onChooseAgent(agent.id)}
              >
                <strong>{agent.displayName}</strong>
                <span>
                  {providerLabel(agent.runtimeProvider)} on {agent.computer.displayName}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <ReadOnlyCopy />
        )}
      </ActionSection>
    );
  }

  const current = state.currentState;
  if (current.kind === "team") {
    return <ActionSection title="Preparing your Team" description="OpenTag will continue automatically." pending />;
  }
  if (current.kind === "computer" && current.availability === "none") {
    if (canManage) {
      return (
        <section className="onboarding-action">
          <ComputerSetup teamId={teamId} onConnected={onReload} />
        </section>
      );
    }
    return (
      <ActionSection
        readonly
        title="Connect a Local Computer"
        description="Run one secure command in Terminal. OpenTag continues when the Computer connects."
      >
        <ReadOnlyCopy />
      </ActionSection>
    );
  }
  if (current.kind === "computer" && current.availability === "offline") {
    return (
      <ActionSection
        readonly={!canManage}
        title="Reconnect your Computer"
        description={`Open OpenTag on ${current.computers.map((computer) => computer.displayName).join(", ")}.`}
      >
        {canManage ? <ReloadButton onReload={onReload} /> : <ReadOnlyCopy />}
      </ActionSection>
    );
  }
  if (current.kind === "computer" && current.availability === "choice") {
    return (
      <ActionSection
        readonly={!canManage}
        title="Choose a runnable Computer"
        description="OpenTag could not safely choose between these Computers."
      >
        {canManage ? (
          <div className="onboarding-choice-list">
            {current.computers.map((computer) => {
              const providers = runnableProviders(snapshot.runtime, computer.id);
              const provider = providers.sort(compareProviderFacts)[0];
              return (
                <button
                  className="onboarding-choice"
                  key={computer.id}
                  type="button"
                  onClick={() =>
                    onChooseRoute({ computerId: computer.id, ...(provider ? { provider: provider.provider } : {}) })
                  }
                >
                  <strong>{computer.displayName}</strong>
                  <span>
                    {provider ? `${providerLabel(provider.provider)} ready` : "No runnable Provider confirmed"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <ReadOnlyCopy />
        )}
      </ActionSection>
    );
  }
  if (current.kind === "provider") {
    const factUnavailable = snapshot.runtime.kind === "unavailable";
    return (
      <ActionSection
        readonly={!canManage}
        title={factUnavailable ? "Confirm the runtime route" : "Prepare Codex or Claude Code"}
        description={
          factUnavailable
            ? "OpenTag cannot yet confirm an Agent-ready Provider on this Computer."
            : `Finish Provider setup on ${current.computer.displayName}, then check again.`
        }
      >
        {canManage ? <ReloadButton onReload={onReload} /> : <ReadOnlyCopy />}
      </ActionSection>
    );
  }
  if (current.kind === "agent") {
    return (
      <ActionSection
        title="Preparing OpenTag"
        description={`Using ${providerLabel(current.provider.provider)} on ${current.computer.displayName}.`}
        pending={creation?.kind !== "error"}
      >
        {creation?.kind === "error" ? (
          <div className="onboarding-feedback">
            <div className="notice error" role="alert">
              {creation.message}
            </div>
            <button className="button" type="button" onClick={onCreationRetry}>
              Try again
            </button>
          </div>
        ) : null}
      </ActionSection>
    );
  }
  if (current.kind === "agent-runtime") {
    const agent = snapshot.targetAgent;
    return (
      <ActionSection
        readonly={!canManage}
        title={`${agent?.displayName ?? "Your Agent"} needs its runtime route`}
        description="The Agent identity and Feishu setup are unchanged. Restore its bound Computer and Provider, then check again."
      >
        {canManage ? <ReloadButton onReload={onReload} /> : <ReadOnlyCopy />}
      </ActionSection>
    );
  }
  if (current.kind === "handoff") {
    return (
      <ActionSection
        readonly={!canManage}
        title={handoffTitle(current)}
        description="Authorize the Feishu Bot that your Team will mention."
      >
        {canManage ? (
          <FeishuSetup agentId={current.agent.id} onSuccess={onReload}>
            {(control) => <FeishuAction control={control} progress={current.progress} />}
          </FeishuSetup>
        ) : (
          <ReadOnlyCopy />
        )}
      </ActionSection>
    );
  }
  return (
    <ActionSection
      title="OpenTag is ready"
      description="Add the Bot to a Feishu group, then mention OpenTag with your first task."
    >
      <a className="button" href={FEISHU_BOT_APP_LINK} rel="noreferrer" target="_blank">
        Open Feishu
      </a>
      <p className="onboarding-helper">Setup is complete.</p>
    </ActionSection>
  );
}

function ActionSection({
  children,
  description,
  pending = false,
  readonly = false,
  title,
}: {
  children?: ReactNode;
  description: string;
  pending?: boolean;
  readonly?: boolean;
  title: string;
}) {
  return (
    <section className="onboarding-action" aria-busy={pending || undefined}>
      <div className="onboarding-action-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {readonly ? <span className="status-chip">Read only</span> : null}
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

function ReloadButton({ onReload }: { onReload: () => void }) {
  return (
    <button className="button" type="button" onClick={onReload}>
      Check again
    </button>
  );
}

function ReadOnlyCopy() {
  return <p className="notice">A Team admin can complete this action. Your factual progress will update here.</p>;
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
      <button className="button" type="button" onClick={() => void control.start(intent)}>
        {label}
      </button>
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

async function loadSnapshot(teamId: string, runtimeFacts: RuntimeFactsAdapter): Promise<OnboardingSnapshot> {
  const [{ computers }, { agents }] = await Promise.all([browserApi.computers(teamId), browserApi.agents(teamId)]);
  const targetCandidates = agents.filter((agent) => agent.status === "active");
  const remembered = readTargetAgent(teamId);
  const targetAgent =
    targetCandidates.find((agent) => agent.id === remembered) ??
    (targetCandidates.length === 1 ? targetCandidates[0] : undefined);
  if (targetAgent) rememberTargetAgent(teamId, targetAgent.id);
  const [runtime, handoff] = await Promise.all([
    runtimeFacts.load({ teamId, agents, computers }),
    targetAgent ? browserApi.imBindingHandoff(targetAgent.id) : Promise.resolve(undefined),
  ]);
  return { agents, computers, targetAgent, targetCandidates, handoff, runtime };
}

function resolveSnapshot(membership: MeMembership, snapshot: OnboardingSnapshot): { state: OnboardingState } {
  const route = readRouteSelection(membership.teamId);
  const providers = snapshot.runtime.kind === "available" ? snapshot.runtime.providers : [];
  const agent: OnboardingAgent | undefined = snapshot.targetAgent
    ? {
        id: snapshot.targetAgent.id,
        computerId: snapshot.targetAgent.computer.id,
        runtimeProvider: snapshot.targetAgent.runtimeProvider,
      }
    : undefined;
  return {
    state: deriveOnboardingState({
      team: { role: membership.role },
      computers: snapshot.computers.map(({ id, displayName, connectionStatus }) => ({
        id,
        displayName,
        connectionStatus,
      })),
      providers,
      ...(route ? { computerSelection: { computerId: route.computerId } } : {}),
      ...(route?.provider ? { providerSelection: { computerId: route.computerId, provider: route.provider } } : {}),
      agent,
      handoff: snapshot.handoff,
    }),
  };
}

function normalizedAgentRequest(
  current: Extract<OnboardingCurrentState, { kind: "agent" }>,
): Omit<CreateAgentRequest, "creationIntentId"> {
  return {
    name: "opentag",
    displayName: "OpenTag",
    computerId: current.computer.id,
    runtimeProvider: current.provider.provider,
  };
}

async function createOnboardingAgent(
  teamId: string,
  request: Omit<CreateAgentRequest, "creationIntentId">,
): Promise<{ id: string }> {
  return withCreationLock(teamId, async () => {
    const authoritative = (await browserApi.agents(teamId)).agents.filter((agent) => agent.status === "active");
    if (authoritative.length === 1) {
      clearCreationIntent(teamId);
      return authoritative[0] as { id: string };
    }
    if (authoritative.length > 1) throw new Error("Choose the Agent to continue before creating another one.");
    const record = getOrCreateCreationIntent(teamId, request);
    const created = await browserApi.createAgent(teamId, {
      ...record.request,
      creationIntentId: record.creationIntentId,
    });
    clearCreationIntent(teamId);
    return created;
  });
}

const memoryIntentRecords = new Map<string, CreationIntentRecord>();
const fallbackCreationLocks = new Map<string, Promise<void>>();

async function withCreationLock<T>(teamId: string, task: () => Promise<T>): Promise<T> {
  const lockName = `opentag:onboarding:create-agent:${teamId}`;
  if (navigator.locks) return navigator.locks.request(lockName, task);
  const prior = fallbackCreationLocks.get(lockName) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  fallbackCreationLocks.set(lockName, queued);
  await prior;
  try {
    return await task();
  } finally {
    release();
    if (fallbackCreationLocks.get(lockName) === queued) fallbackCreationLocks.delete(lockName);
  }
}

function getOrCreateCreationIntent(
  teamId: string,
  request: Omit<CreateAgentRequest, "creationIntentId">,
): CreationIntentRecord {
  const existing = readCreationIntent(teamId);
  if (existing && requestsEqual(existing.request, request)) return existing;
  // A different normalized route is the one intentional request change that replaces a pending replay record.
  const next: CreationIntentRecord = {
    version: CREATE_INTENT_VERSION,
    teamId,
    creationIntentId: crypto.randomUUID(),
    request,
  };
  memoryIntentRecords.set(teamId, next);
  try {
    window.localStorage.setItem(creationIntentKey(teamId), JSON.stringify(next));
  } catch {
    // The in-memory record still protects retries in this page lifetime.
  }
  return next;
}

function readCreationIntent(teamId: string): CreationIntentRecord | undefined {
  try {
    const raw = window.localStorage.getItem(creationIntentKey(teamId));
    if (!raw) return memoryIntentRecords.get(teamId);
    const value = JSON.parse(raw) as Partial<CreationIntentRecord>;
    if (
      value.version !== CREATE_INTENT_VERSION ||
      value.teamId !== teamId ||
      typeof value.creationIntentId !== "string" ||
      !value.request ||
      typeof value.request.computerId !== "string" ||
      (value.request.runtimeProvider !== "codex" && value.request.runtimeProvider !== "claude-code")
    ) {
      return undefined;
    }
    return value as CreationIntentRecord;
  } catch {
    return memoryIntentRecords.get(teamId);
  }
}

function clearCreationIntent(teamId: string): void {
  memoryIntentRecords.delete(teamId);
  try {
    window.localStorage.removeItem(creationIntentKey(teamId));
  } catch {
    // No durable record is available to clear.
  }
}

function requestsEqual(
  left: Omit<CreateAgentRequest, "creationIntentId">,
  right: Omit<CreateAgentRequest, "creationIntentId">,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function creationIntentKey(teamId: string): string {
  return `opentag.onboarding.creation-intent:${teamId}`;
}

function routeSelectionKey(teamId: string): string {
  return `opentag.onboarding.route:${teamId}`;
}

function readRouteSelection(teamId: string): RouteSelection | undefined {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(routeSelectionKey(teamId)) ?? "null",
    ) as Partial<RouteSelection> | null;
    if (!value || typeof value.computerId !== "string") return undefined;
    if (value.provider !== undefined && value.provider !== "codex" && value.provider !== "claude-code")
      return undefined;
    return { computerId: value.computerId, ...(value.provider ? { provider: value.provider } : {}) };
  } catch {
    return undefined;
  }
}

function rememberRouteSelection(teamId: string, selection: RouteSelection): void {
  try {
    window.localStorage.setItem(routeSelectionKey(teamId), JSON.stringify(selection));
  } catch {
    // The canonical route remains derivable when storage is unavailable.
  }
}

function targetAgentKey(teamId: string): string {
  return `opentag.onboarding.agent:${teamId}`;
}

function readTargetAgent(teamId: string): string | undefined {
  try {
    return window.localStorage.getItem(targetAgentKey(teamId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberTargetAgent(teamId: string, agentId: string): void {
  try {
    window.localStorage.setItem(targetAgentKey(teamId), agentId);
  } catch {
    // A unique authoritative Agent can still be recovered without storage.
  }
}

function runnableProviders(runtime: RuntimeFactsResult, computerId: string): OnboardingProvider[] {
  return runtime.kind === "available"
    ? runtime.providers.filter((provider) => provider.computerId === computerId && provider.runtimeReady)
    : [];
}

function compareProviderFacts(left: OnboardingProvider, right: OnboardingProvider): number {
  return left.provider === right.provider ? 0 : left.provider === "codex" ? -1 : 1;
}

function providerLabel(provider: AgentRuntimeProvider): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}
