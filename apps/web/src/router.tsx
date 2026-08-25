import type {
  AgentAdminConfig,
  AgentDetail,
  AgentListItem as AgentListApiItem,
  AgentSummary,
  AuthProvidersResponse,
  Computer,
  ImBindingHandoffStatus,
  ImBindingSummary,
  MeMembership,
  MeResponse,
  ProviderReadinessStatus,
  TeamComputerSummary,
  TeamMemberSummary,
} from "@opentag/shared/browser";
import { MembershipRoleSchema } from "@opentag/shared/browser";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { type AgentCreationFacts, AgentCreationFlow } from "./agent-creation/agent-creation-flow.js";
import { ApiError, browserApi } from "./api.js";
// Google-provided, pre-approved button asset: https://developers.google.com/identity/branding-guidelines
import googleSignInButton from "./assets/google-sign-in-light@2x.png";
import { CreateTeamForm } from "./create-team-form.js";
import { AgentUsageTab } from "./features/agent-usage.js";
import { IntegrationsPage } from "./features/integrations-page.js";
import { SkillsPage } from "./features/skills-page.js";
import { TaskDetailPage, TasksPage } from "./features/tasks-page.js";
import { FeishuSetup } from "./im/feishu-setup.js";
import { SlackSetup } from "./im/slack-setup.js";
import { OnboardingPage } from "./onboarding/page.js";
import { RuntimeConfigurationForm } from "./runtime-configuration.js";
import {
  Button,
  buttonClassName,
  Dialog,
  Field,
  Icon,
  type IconName,
  SettingsList,
  SettingsRow,
  StatusIndicator,
  type StatusTone,
} from "./ui/design-system.js";

type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };
type AuthProvider = AuthProvidersResponse["providers"][number];

type AgentAvailability = {
  state: "ready" | "action_required" | "setting_up" | "not_connected" | "suspended" | "unconfirmed";
  reason:
    | "agent_suspended"
    | "agent_unconfirmed"
    | "computer_offline"
    | "runtime_unavailable"
    | "runtime_unconfirmed"
    | "im_not_connected"
    | "im_provisioning"
    | "im_reauthorization_required"
    | "im_error"
    | "handoff_unavailable"
    | "computer_unconfirmed"
    | "handoff_unconfirmed"
    | null;
  lastConfirmedAt: string | null;
  dependencies: {
    computer: { state: "ready" | "action_required" | "unconfirmed"; lastConfirmedAt: string | null };
    /** Readiness of the Agent's Provider on its Computer. `runtime_unavailable` is diagnosed from this. */
    runtime: { provider: AgentSummary["runtimeProvider"]; status: ProviderReadinessStatus | null };
    handoff: {
      state: "ready" | "action_required" | "setting_up" | "not_connected" | "unconfirmed";
      lastConfirmedAt: string | null;
    };
    channel: {
      state: "connected" | "not_connected" | "unconfirmed";
      provider: "feishu" | "slack" | null;
      botDisplayName: string | null;
    };
  };
};

type AgentListItem = AgentListApiItem & {
  availability: AgentAvailability;
  evidenceConfirmed: boolean;
};
type DetailEvidence<T> = { kind: "ready"; value: T | undefined } | { kind: "unconfirmed" };
type AgentDetailView = AgentDetail & {
  availability: AgentAvailability;
  messaging: DetailEvidence<ImBindingSummary>;
};

function projectAgentAvailability(
  agent: AgentSummary,
  computer: TeamComputerSummary | undefined,
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
  bindingEvidenceConfirmed: boolean,
  handoffEvidenceConfirmed: boolean,
): AgentAvailability {
  const computerReady = computer?.connectionStatus === "online";
  const providerReadiness = computer?.providerReadiness?.find(
    (observation) => observation.provider === agent.runtimeProvider,
  );
  const handoffState =
    !bindingEvidenceConfirmed || !handoffEvidenceConfirmed
      ? ("unconfirmed" as const)
      : !binding
        ? ("not_connected" as const)
        : binding.bindingState === "provisioning"
          ? ("setting_up" as const)
          : binding.bindingState === "active" && handoff?.handoffReady
            ? ("ready" as const)
            : ("action_required" as const);
  const dependencies: AgentAvailability["dependencies"] = {
    computer: {
      state: computer ? (computerReady ? "ready" : "action_required") : "unconfirmed",
      lastConfirmedAt: computer?.lastSeenAt ?? null,
    },
    runtime: { provider: agent.runtimeProvider, status: providerReadiness?.status ?? null },
    handoff: { state: handoffState, lastConfirmedAt: binding?.lastConfirmedAt ?? null },
    channel: {
      state: !bindingEvidenceConfirmed ? "unconfirmed" : binding ? "connected" : "not_connected",
      provider: binding?.provider ?? null,
      botDisplayName: binding?.bot.displayName ?? null,
    },
  };
  if (agent.status === "suspended") {
    return { state: "suspended", reason: "agent_suspended", lastConfirmedAt: agent.updatedAt, dependencies };
  }
  if (!computer) {
    return { state: "unconfirmed", reason: "computer_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (!computerReady) {
    return {
      state: "action_required",
      reason: "computer_offline",
      lastConfirmedAt: computer?.lastSeenAt ?? null,
      dependencies,
    };
  }
  const runtimeReadiness = providerReadiness;
  if (!runtimeReadiness) {
    return { state: "unconfirmed", reason: "runtime_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (runtimeReadiness.status !== "ready") {
    return { state: "action_required", reason: "runtime_unavailable", lastConfirmedAt: null, dependencies };
  }
  if (!bindingEvidenceConfirmed || !handoffEvidenceConfirmed) {
    return { state: "unconfirmed", reason: "handoff_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (!binding) return { state: "not_connected", reason: "im_not_connected", lastConfirmedAt: null, dependencies };
  if (binding.bindingState === "provisioning") {
    return {
      state: "setting_up",
      reason: "im_provisioning",
      lastConfirmedAt: binding.lastConfirmedAt,
      dependencies,
    };
  }
  if (binding.bindingState === "reauthorization_required") {
    return {
      state: "action_required",
      reason: "im_reauthorization_required",
      lastConfirmedAt: binding.lastConfirmedAt,
      dependencies,
    };
  }
  if (binding.bindingState === "error" || binding.bindingState === "disabled") {
    return { state: "action_required", reason: "im_error", lastConfirmedAt: binding.lastConfirmedAt, dependencies };
  }
  if (!handoff?.handoffReady) {
    return {
      state: "action_required",
      reason: "handoff_unavailable",
      lastConfirmedAt: binding.lastConfirmedAt,
      dependencies,
    };
  }
  return { state: "ready", reason: null, lastConfirmedAt: binding.lastConfirmedAt, dependencies };
}

async function loadAgentList(teamId: string): Promise<{ agents: AgentListItem[] }> {
  const [{ agents }, computersResult] = await Promise.all([
    browserApi.agents(teamId),
    browserApi.computers(teamId).then(
      (value) => ({ kind: "ready" as const, value }),
      () => ({ kind: "unconfirmed" as const }),
    ),
  ]);
  const computers = computersResult.kind === "ready" ? computersResult.value.computers : [];
  if (computersResult.kind === "unconfirmed") {
    return {
      agents: agents.map((agent) => ({
        ...agent,
        availability: projectAgentAvailability(agent, undefined, undefined, undefined, false, false),
        evidenceConfirmed: true,
      })),
    };
  }
  const availability = await Promise.all(
    agents.map(async (agent) => {
      const [bindingResult, handoffResult] = await Promise.allSettled([
        browserApi.imBinding(agent.id),
        browserApi.imBindingHandoff(agent.id),
      ]);
      return projectAgentAvailability(
        agent,
        computers.find((computer) => computer.id === agent.computer.id),
        bindingResult.status === "fulfilled" ? bindingResult.value : undefined,
        handoffResult.status === "fulfilled" ? handoffResult.value : undefined,
        bindingResult.status === "fulfilled",
        handoffResult.status === "fulfilled",
      );
    }),
  );
  return {
    agents: agents.map((agent, index) => ({
      ...agent,
      availability:
        availability[index] ?? projectAgentAvailability(agent, undefined, undefined, undefined, false, false),
      evidenceConfirmed: true,
    })),
  };
}

async function loadAgentDetail(agentId: string): Promise<AgentDetailView> {
  const agent = await browserApi.agent(agentId);
  const [computersResult, bindingResult, handoffResult] = await Promise.allSettled([
    browserApi.computers(agent.teamId),
    browserApi.imBinding(agent.id),
    browserApi.imBindingHandoff(agent.id),
  ]);
  const computers = computersResult.status === "fulfilled" ? computersResult.value.computers : [];
  const binding = bindingResult.status === "fulfilled" ? bindingResult.value : undefined;
  const handoff = handoffResult.status === "fulfilled" ? handoffResult.value : undefined;
  return {
    ...agent,
    messaging:
      bindingResult.status === "fulfilled" ? { kind: "ready", value: bindingResult.value } : { kind: "unconfirmed" },
    availability: projectAgentAvailability(
      agent,
      computers.find((computer) => computer.id === agent.computer.id),
      binding,
      handoff,
      bindingResult.status === "fulfilled",
      handoffResult.status === "fulfilled",
    ),
  };
}

function markAgentListUnconfirmed(value: { agents: AgentListItem[] }): { agents: AgentListItem[] } {
  return {
    agents: value.agents.map((agent) => ({
      ...agent,
      availability: {
        ...agent.availability,
        state: "unconfirmed",
        reason: "agent_unconfirmed",
        lastConfirmedAt: null,
      },
      evidenceConfirmed: false,
    })),
  };
}

function markAgentDetailUnconfirmed(agent: AgentDetailView): AgentDetailView {
  return {
    ...agent,
    messaging: { kind: "unconfirmed" },
    availability: {
      ...agent.availability,
      state: "unconfirmed",
      reason: "agent_unconfirmed",
      lastConfirmedAt: null,
      dependencies: {
        ...agent.availability.dependencies,
        computer: { state: "unconfirmed", lastConfirmedAt: null },
        handoff: { state: "unconfirmed", lastConfirmedAt: null },
        channel: { ...agent.availability.dependencies.channel, state: "unconfirmed" },
      },
    },
  };
}

function useResource<T>(
  loader: () => Promise<T>,
  key: string,
  options: {
    initialValue?: T;
    keepPreviousData?: boolean;
    onBackgroundError?: (value: T, error: Error) => T;
    revalidateMs?: number;
    refreshOnFocus?: boolean;
  } = {},
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>(() =>
    options.initialValue === undefined ? { kind: "loading" } : { kind: "ready", value: options.initialValue },
  );
  const loaderRef = useRef(loader);
  const keyRef = useRef(key);
  const optionsRef = useRef(options);
  loaderRef.current = loader;
  keyRef.current = key;
  optionsRef.current = options;
  useEffect(() => {
    let active = true;
    let request = 0;
    let inFlight = false;
    const activeKey = key;
    const load = (showLoading: boolean) => {
      if (inFlight) return;
      inFlight = true;
      const currentRequest = ++request;
      if (showLoading) setState({ kind: "loading" });
      void loaderRef
        .current()
        .then(
          (value) =>
            active && keyRef.current === activeKey && request === currentRequest && setState({ kind: "ready", value }),
          (error: unknown) => {
            if (!active || keyRef.current !== activeKey || request !== currentRequest) return;
            const resolvedError = error instanceof Error ? error : new Error(String(error));
            if (showLoading || isTerminalResourceError(resolvedError)) {
              setState({ kind: "error", error: resolvedError });
              return;
            }
            setState((current) => {
              if (current.kind !== "ready" || !optionsRef.current.onBackgroundError) {
                return { kind: "error", error: resolvedError };
              }
              return {
                kind: "ready",
                value: optionsRef.current.onBackgroundError(current.value, resolvedError),
              };
            });
          },
        )
        .finally(() => {
          if (active && keyRef.current === activeKey && request === currentRequest) inFlight = false;
        });
    };
    const revalidate = () => load(false);
    load(!options.keepPreviousData && options.initialValue === undefined);
    const interval = options.revalidateMs ? window.setInterval(revalidate, options.revalidateMs) : undefined;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    if (options.refreshOnFocus) {
      window.addEventListener("focus", revalidate);
      document.addEventListener("visibilitychange", refreshVisible);
    }
    return () => {
      active = false;
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [key, options.initialValue, options.keepPreviousData, options.refreshOnFocus, options.revalidateMs]);
  return state;
}

function isTerminalResourceError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

function AsyncState<T>({
  state,
  children,
  loading,
}: {
  state: LoadState<T>;
  children: (value: T) => ReactNode;
  loading?: ReactNode;
}) {
  if (state.kind === "loading")
    return (
      loading ?? (
        <div aria-label="Loading current server state" className="loading-state" role="status">
          <span />
          <span />
          <span />
        </div>
      )
    );
  if (state.kind === "error")
    return (
      <div className="notice error" role="alert">
        {state.error.message}
      </div>
    );
  return children(state.value);
}

interface TeamSession {
  me: MeResponse;
  membership: MeMembership;
  refreshMe: () => void;
  selectTeam: (teamId: string) => void;
}

const teamContext = createContext<TeamSession | undefined>(undefined);
const TeamContext = teamContext.Provider;

function useTeam(): TeamSession {
  const value = useContext(teamContext);
  if (!value) throw new Error("Team context is missing");
  return value;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invites/:token" element={<InvitePage />} />
      <Route path="/teams/new" element={<Navigate replace to="/workspaces/new" />} />
      <Route path="/workspaces/new" element={<NewTeamPage />} />
      <Route element={<AuthenticatedTeamGate />}>
        <Route element={<TeamSetupGate />}>
          <Route path="/onboarding" element={<OnboardingRoute />} />
          <Route element={<AppShell />}>
            <Route index element={<Navigate replace to="/agents" />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/new" element={<NewAgentPage />} />
            <Route path="/agents/:agentId" element={<AgentDetailPage />} />
            <Route path="/agents/:agentId/access" element={<LegacyAgentAccessRedirect />} />
            <Route path="/agents/:agentId/usage" element={<AgentUsagePage />} />
            <Route path="/agents/:agentId/settings" element={<AgentSettingsPage />} />
            <Route path="/agents/:agentId/settings/:section" element={<AgentSettingsPage />} />
            <Route path="/agents/:agentId/:legacySection" element={<LegacyAgentSectionRedirect />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/resources" element={<Navigate replace to="/skills" />} />
            <Route path="/usage" element={<Navigate replace to="/agents" />} />
            <Route path="/members" element={<Navigate replace to="/workspace#members" />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/workspace" element={<WorkspacePage />} />
            <Route path="/account/workspace" element={<Navigate replace to="/workspace" />} />
            <Route path="/settings" element={<Navigate replace to="/workspace" />} />
            <Route path="/settings/account" element={<Navigate replace to="/account" />} />
            <Route path="/settings/team" element={<Navigate replace to="/workspace" />} />
            <Route path="/settings/members" element={<Navigate replace to="/workspace#members" />} />
            <Route path="/settings/access" element={<Navigate replace to="/workspace#members" />} />
            <Route path="/settings/security" element={<Navigate replace to="/workspace#members" />} />
            <Route path="/settings/computers" element={<Navigate replace to="/agents/new" />} />
            <Route path="/settings/resources" element={<Navigate replace to="/skills" />} />
            <Route path="/settings/integrations" element={<Navigate replace to="/integrations" />} />
            <Route path="/settings/usage" element={<Navigate replace to="/agents" />} />
            <Route path="/settings/:section" element={<Navigate replace to="/workspace" />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<StandaloneNotFoundPage />} />
    </Routes>
  );
}

function LoginPage() {
  const providers = useResource(() => browserApi.authProviders(), "auth-providers");
  const next = new URLSearchParams(useLocation().search).get("next") ?? "/agents";
  return (
    <main className="login-page decorative-page">
      <section aria-labelledby="login-title" className="login-card">
        <OpenTagBrandLockup />
        <header className="login-copy">
          <h1 id="login-title">Welcome back</h1>
          <p>Sign in to continue to OpenTag.</p>
        </header>
        <AsyncState state={providers}>
          {(value) => {
            const availableProviders = value.providers.filter(
              (provider: AuthProvider) => provider.enabled && provider.startUrl,
            );
            if (availableProviders.length === 0) {
              return (
                <p className="login-unavailable" role="status">
                  No sign-in methods are currently available.
                </p>
              );
            }
            return (
              <div className="login-actions">
                {availableProviders.map((provider: AuthProvider) => (
                  <LoginProviderLink key={provider.id} next={next} provider={provider} />
                ))}
              </div>
            );
          }}
        </AsyncState>
        <p className="login-access-note">Access is managed by your workspace.</p>
      </section>
    </main>
  );
}

function OpenTagBrandLockup() {
  return (
    <div className="login-brand-lockup">
      <svg aria-hidden="true" className="login-brand-mark" focusable="false" viewBox="0 0 48 48">
        <path
          d="M23.8 4.4c7.1-.8 14.3 2.6 17.6 8.2 3.5 5.9 3.1 15.3-.8 22-4.2 7.1-12.5 9.6-21.2 9.1-8.3-.5-14.1-4.2-15.2-11.3C2.9 24.6 4.9 15.2 11 9.9c3.3-2.9 7.8-4.9 12.8-5.5Z"
          fill="currentColor"
          stroke="var(--foreground)"
          strokeWidth="1.5"
        />
        <path
          d="M31.3 42.7c.1-6.3 3.8-10.6 11.8-12.7-1.4 6.7-5.7 11-11.8 12.7Z"
          fill="var(--surface)"
          stroke="var(--foreground)"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
        <circle cx="17.4" cy="23" fill="var(--foreground)" r="1.8" />
        <circle cx="29.4" cy="23" fill="var(--foreground)" r="1.8" />
      </svg>
      <span>OpenTag</span>
    </div>
  );
}

function LoginProviderLink({ next, provider }: { next: string; provider: AuthProvider }) {
  if (!provider.startUrl) return null;
  const google = provider.id === "google";
  const href = `${provider.startUrl}?next=${encodeURIComponent(next)}`;
  if (google) {
    return (
      <a className="login-provider-button login-provider-button--google" href={href}>
        <img alt="Sign in with Google" className="login-provider-button-image" src={googleSignInButton} />
      </a>
    );
  }

  return (
    <a className="login-provider-button" href={href}>
      <span className="login-provider-button-content">
        <span className="login-provider-button-label">Continue with {provider.id}</span>
      </span>
    </a>
  );
}

function InvitePage() {
  const { token = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedTeamHint = new URLSearchParams(location.search).get("joinedTeamId") ?? undefined;
  const preview = useResource(() => browserApi.invitationPreview(token), token);
  const [error, setError] = useState<string>();
  const [joining, setJoining] = useState(false);
  const joinInFlight = useRef(false);
  const completeJoin = useCallback(
    async (serverSelectedTeamId?: string) => {
      if (joinInFlight.current) return;
      joinInFlight.current = true;
      setJoining(true);
      try {
        if (serverSelectedTeamId) {
          const me = await browserApi.me();
          if (me.memberships.some((membership: MeMembership) => membership.teamId === serverSelectedTeamId)) {
            clearPendingInvitation(token);
            rememberTeamPreference(serverSelectedTeamId);
            navigate("/agents", { replace: true });
            return;
          }
        }
        const redemption = await browserApi.redeemInvitation(token);
        const me = await browserApi.me();
        if (!me.memberships.some((membership: MeMembership) => membership.teamId === redemption.membership.teamId)) {
          throw new Error("The invited Workspace is not available to the signed-in account");
        }
        clearPendingInvitation(token);
        rememberTeamPreference(redemption.membership.teamId);
        navigate("/agents", { replace: true });
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          rememberPendingInvitation(token);
          navigate(`/login?next=${encodeURIComponent(`/invites/${token}`)}`);
        } else {
          if (!serverSelectedTeamId) clearPendingInvitation(token);
          setError(cause instanceof Error ? cause.message : "The invitation could not be redeemed");
        }
      } finally {
        joinInFlight.current = false;
        setJoining(false);
      }
    },
    [navigate, token],
  );
  useEffect(() => {
    if (readPendingInvitation() === token) void completeJoin(selectedTeamHint);
  }, [completeJoin, selectedTeamHint, token]);
  function join() {
    setError(undefined);
    rememberPendingInvitation(token);
    void completeJoin(selectedTeamHint);
  }
  return (
    <main className="center-card decorative-page">
      <AsyncState state={preview}>
        {(value) => (
          <>
            <span className="eyebrow">Workspace invitation</span>
            <h1>Join {value.teamDisplayName}</h1>
            <p>
              This invitation grants the {value.role} role and expires {formatDate(value.expiresAt)}.
            </p>
            <Button disabled={joining} onClick={join}>
              {joining ? "Joining…" : "Join Workspace"}
            </Button>
          </>
        )}
      </AsyncState>
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
    </main>
  );
}

const SELECTED_TEAM_STORAGE_KEY = "opentag.selectedTeamId";
const PENDING_INVITATION_STORAGE_KEY = "opentag.pendingInvitationToken";
let memoryTeamPreference: string | undefined;
let memoryTeamPreferenceFallback = false;

function readPendingInvitation(): string | undefined {
  try {
    return window.sessionStorage.getItem(PENDING_INVITATION_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberPendingInvitation(token: string): void {
  try {
    window.sessionStorage.setItem(PENDING_INVITATION_STORAGE_KEY, token);
  } catch {
    // The explicit Join action can still continue when browser storage is unavailable.
  }
}

function clearPendingInvitation(token: string): void {
  try {
    if (window.sessionStorage.getItem(PENDING_INVITATION_STORAGE_KEY) === token) {
      window.sessionStorage.removeItem(PENDING_INVITATION_STORAGE_KEY);
    }
  } catch {
    // There is no pending browser state to clean up when storage is unavailable.
  }
}

function NewTeamPage() {
  const navigate = useNavigate();
  return (
    <main className="center-card decorative-page">
      <span className="eyebrow">OpenTag</span>
      <h1>Create your Workspace</h1>
      <p>You can invite people and add Agents next.</p>
      <CreateTeamForm
        onCreated={(created) => {
          rememberTeamPreference(created.id);
          navigate("/agents");
        }}
        onUnauthenticated={() => navigate(`/login?next=${encodeURIComponent("/teams/new")}`)}
      />
    </main>
  );
}

function AuthenticatedTeamGate() {
  const location = useLocation();
  const [meRevision, setMeRevision] = useState(0);
  const [selectedTeamId, setSelectedTeamId] = useState(readTeamPreference);
  const state = useResource(() => browserApi.me(), `me:${meRevision}`);
  if (state.kind === "error" && state.error instanceof ApiError && state.error.status === 401) {
    const requested = location.pathname === "/" ? "/agents" : `${location.pathname}${location.search}`;
    return <Navigate replace to={`/login?next=${encodeURIComponent(requested)}`} />;
  }
  return (
    <AsyncState state={state}>
      {(me) => {
        const membership =
          me.memberships.find((item: MeMembership) => item.teamId === selectedTeamId) ?? me.memberships[0];
        if (!membership) {
          return <WorkspaceSetupIncomplete onRetry={() => setMeRevision((value) => value + 1)} />;
        }
        const selectTeam = (teamId: string) => {
          if (!me.memberships.some((item: MeMembership) => item.teamId === teamId)) return;
          rememberTeamPreference(teamId);
          setSelectedTeamId(teamId);
        };
        return (
          <TeamContext value={{ me, membership, refreshMe: () => setMeRevision((value) => value + 1), selectTeam }}>
            <Outlet />
          </TeamContext>
        );
      }}
    </AsyncState>
  );
}

function WorkspaceSetupIncomplete({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="center-card decorative-page">
      <span className="eyebrow">Workspace setup</span>
      <h1>Workspace setup incomplete</h1>
      <p>OpenTag could not find a Workspace membership for this account.</p>
      <div className="notice error" role="alert">
        The server must finish Workspace setup before the Web app can continue.
      </div>
      <Button onClick={onRetry}>Check again</Button>
    </main>
  );
}

function OnboardingRoute() {
  const { me, membership, refreshMe } = useTeam();
  const [searchParams, setSearchParams] = useSearchParams();
  const targetAgentId = searchParams.get("agentId") ?? undefined;
  return (
    <OnboardingPage
      membership={membership}
      targetAgentId={targetAgentId}
      user={me.user}
      onSetupReady={async (agentId) => {
        await browserApi.completeTeamSetup(membership.teamId, agentId);
        refreshMe();
      }}
      onTargetAgentChange={(agentId) => {
        const next = new URLSearchParams(searchParams);
        next.set("agentId", agentId);
        setSearchParams(next, { replace: true });
      }}
    />
  );
}

function TeamSetupGate() {
  const { membership } = useTeam();
  const location = useLocation();
  const onboarding = location.pathname === "/onboarding";
  if (membership.setupCompletedAt) return onboarding ? <Navigate replace to="/agents" /> : <Outlet />;
  if (membership.role === "admin") return onboarding ? <Outlet /> : <Navigate replace to="/onboarding" />;
  return onboarding ? <Navigate replace to="/agents" /> : <Outlet />;
}

function readTeamPreference(): string | undefined {
  if (memoryTeamPreferenceFallback) return memoryTeamPreference;
  try {
    const value = window.localStorage.getItem(SELECTED_TEAM_STORAGE_KEY);
    if (value && value.length <= 64) {
      memoryTeamPreference = value;
      return value;
    }
    return undefined;
  } catch {
    return memoryTeamPreference;
  }
}

function rememberTeamPreference(teamId: string): void {
  memoryTeamPreference = teamId;
  try {
    window.localStorage.setItem(SELECTED_TEAM_STORAGE_KEY, teamId);
    memoryTeamPreferenceFallback = false;
  } catch {
    memoryTeamPreferenceFallback = true;
    // The authoritative membership still determines the available Team.
  }
}

function AppShell() {
  const { me, membership, selectTeam } = useTeam();
  const navigate = useNavigate();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"account">();
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const menu = accountMenuRef.current;
    const initialFocus = menu?.querySelector<HTMLElement>('[role="menuitem"]');
    initialFocus?.focus();

    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!accountMenuRef.current?.contains(target)) setOpenMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenMenu(undefined);
      accountTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);
  function handleAccountMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(
      accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Home") {
      items[0]?.focus();
    } else if (event.key === "End") {
      items.at(-1)?.focus();
    } else {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = activeIndex < 0 ? 0 : (activeIndex + direction + items.length) % items.length;
      items[nextIndex]?.focus();
    }
  }
  async function logout() {
    setLoggingOut(true);
    setAccountError(undefined);
    try {
      await browserApi.logout();
      navigate("/login", { replace: true });
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "Unable to sign out");
      setLoggingOut(false);
    }
  }
  return (
    <div className="shell">
      {navigationOpen ? (
        <button
          aria-label="Close navigation"
          className="sidebar-backdrop is-visible"
          type="button"
          onClick={() => setNavigationOpen(false)}
        />
      ) : null}
      <aside className={`sidebar${navigationOpen ? " is-open" : ""}`} aria-label="Primary navigation">
        <div className="sidebar-top">
          <Link className="brand" to="/agents" onClick={() => setNavigationOpen(false)}>
            OpenTag
          </Link>
          <nav aria-label="Product" className="primary-nav">
            <NavLink to="/agents" onClick={() => setNavigationOpen(false)}>
              <WorkspaceNavIcon name="agents" />
              Agents
            </NavLink>
            <NavLink to="/tasks" onClick={() => setNavigationOpen(false)}>
              <WorkspaceNavIcon name="tasks" />
              Tasks
            </NavLink>
            <NavLink to="/integrations" onClick={() => setNavigationOpen(false)}>
              <WorkspaceNavIcon name="integrations" />
              Integrations
            </NavLink>
            <NavLink to="/skills" onClick={() => setNavigationOpen(false)}>
              <WorkspaceNavIcon name="skills" />
              Skills
            </NavLink>
          </nav>
        </div>
        <div className="sidebar-bottom">
          <div className="account-menu" ref={accountMenuRef}>
            <button
              aria-label="Account menu"
              aria-controls="account-menu-popover"
              aria-expanded={openMenu === "account"}
              aria-haspopup="menu"
              className="account-row"
              ref={accountTriggerRef}
              type="button"
              onClick={() => setOpenMenu((value) => (value === "account" ? undefined : "account"))}
            >
              <span className="account-avatar" aria-hidden="true">
                {initials(me.user.displayName)}
              </span>
              <span className="account-copy">
                <strong>{me.user.displayName}</strong>
              </span>
              <span className="account-menu-dots" aria-hidden="true">
                <Icon name="more-vertical" />
              </span>
            </button>
            {openMenu === "account" ? (
              <div
                aria-label="Account"
                className="account-menu-popover"
                id="account-menu-popover"
                role="menu"
                onKeyDown={handleAccountMenuKeyDown}
              >
                <fieldset className="account-workspace-group">
                  <legend className="menu-label">Workspaces</legend>
                  {me.memberships.map((item: MeMembership) => {
                    const current = item.teamId === membership.teamId;
                    const content = (
                      <>
                        <span className="team-avatar" aria-hidden="true">
                          {initials(item.teamDisplayName)}
                        </span>
                        <span className="team-option-copy">
                          <strong>{item.teamDisplayName}</strong>
                          <small>{titleCase(item.role)}</small>
                        </span>
                        {current ? (
                          <span className="team-option-check" aria-hidden="true">
                            <Icon name="check" />
                          </span>
                        ) : null}
                      </>
                    );
                    return me.memberships.length > 1 ? (
                      <button
                        aria-current={current ? "true" : undefined}
                        className="account-workspace-option"
                        key={item.teamId}
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          setOpenMenu(undefined);
                          setNavigationOpen(false);
                          if (!current) {
                            navigate("/agents");
                            selectTeam(item.teamId);
                          }
                        }}
                      >
                        {content}
                      </button>
                    ) : (
                      <div aria-current="true" className="account-workspace-option is-static" key={item.teamId}>
                        {content}
                      </div>
                    );
                  })}
                </fieldset>
                <div className="account-menu-actions">
                  <NavLink
                    role="menuitem"
                    to="/workspace"
                    onClick={() => {
                      setOpenMenu(undefined);
                      setNavigationOpen(false);
                    }}
                  >
                    Workspace settings
                  </NavLink>
                  <NavLink
                    end
                    role="menuitem"
                    to="/account"
                    onClick={() => {
                      setOpenMenu(undefined);
                      setNavigationOpen(false);
                    }}
                  >
                    Account settings
                  </NavLink>
                  <button
                    className="account-signout"
                    disabled={loggingOut}
                    role="menuitem"
                    type="button"
                    onClick={() => void logout()}
                  >
                    {loggingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
                {accountError ? (
                  <span className="account-menu-error" role="alert">
                    {accountError}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="mobile-shell-bar">
          <Link className="mobile-brand" to="/agents" onClick={() => setNavigationOpen(false)}>
            OpenTag
          </Link>
          <Button size="compact" variant="secondary" onClick={() => setNavigationOpen(true)}>
            Menu
          </Button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function WorkspaceNavIcon({ name }: { name: "agents" | "integrations" | "skills" | "tasks" }) {
  return (
    <svg
      aria-hidden="true"
      className="primary-nav-icon"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {name === "agents" ? (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19" />
          <path d="M15.5 5.4a3 3 0 0 1 0 5.2M17 13.4a4.5 4.5 0 0 1 3.5 4.4V19" />
        </>
      ) : null}
      {name === "tasks" ? (
        <>
          <rect height="17" rx="2.2" width="17" x="3.5" y="3.5" />
          <path d="m7.5 12 3 3 6-6" />
        </>
      ) : null}
      {name === "integrations" ? (
        <>
          <path d="M8 12h8M12 8v8" />
          <path d="M7 4.5h10A2.5 2.5 0 0 1 19.5 7v10a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 17V7A2.5 2.5 0 0 1 7 4.5Z" />
        </>
      ) : null}
      {name === "skills" ? (
        <>
          <path d="m12 3 1.5 4.2L18 9l-4.5 1.8L12 15l-1.5-4.2L6 9l4.5-1.8L12 3Z" />
          <path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />
        </>
      ) : null}
    </svg>
  );
}

function AgentsPage() {
  const { membership } = useTeam();
  const [createOpen, setCreateOpen] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const state = useResource(() => loadAgentList(membership.teamId), membership.teamId, {
    onBackgroundError: markAgentListUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  return (
    <>
      <Page
        title="Agents"
        description="Monitor availability and 30-day usage across your AI teammates."
        action={
          membership.role === "admin" ? (
            <Button ref={createTriggerRef} size="compact" variant="outline" onClick={() => setCreateOpen(true)}>
              New Agent <Icon name="plus" />
            </Button>
          ) : undefined
        }
      >
        {!membership.setupCompletedAt && membership.role !== "admin" ? (
          <div className="notice" role="status">
            Team setup is not complete. An administrator needs to prepare the first Agent.
          </div>
        ) : null}
        <AsyncState state={state}>
          {(value) => <AgentsContent agents={value.agents} canCreate={membership.role === "admin"} />}
        </AsyncState>
      </Page>
      {createOpen ? <NewAgentDialog returnFocusRef={createTriggerRef} onClose={() => setCreateOpen(false)} /> : null}
    </>
  );
}

function AgentsContent({ agents, canCreate }: { agents: AgentListItem[]; canCreate: boolean }) {
  if (agents.length > 0) return <AgentList agents={agents} />;
  return (
    <EmptyState title="No Agents yet">
      {canCreate ? "Create the first shared AI teammate with New Agent." : "An Admin can create the first Agent."}
    </EmptyState>
  );
}

function AgentList({ agents }: { agents: AgentListItem[] }) {
  const sortedAgents = [...agents].sort(
    (left, right) => agentCardStatus(left).priority - agentCardStatus(right).priority,
  );
  return (
    <section className="agent-list-section" aria-label="Agents">
      <div className="agent-card-grid">
        {sortedAgents.map((agent) => (
          <AgentCard agent={agent} key={agent.id} />
        ))}
      </div>
    </section>
  );
}

function AgentCard({ agent }: { agent: AgentListItem }) {
  const { membership } = useTeam();
  const status = agentCardStatus(agent);
  /**
   * `AgentSettingsPage` bounces a viewer without `canManage` straight back to the Agent, and the list
   * response carries no per-Agent capability. Mirror the server rule so a member never gets an exit
   * that returns them to where they started.
   */
  const action = membership.role === "admin" ? status.action : undefined;
  const statusDetail: ReactNode =
    agent.activity.state === "working" && status.label === "Working" ? (
      <>Started {formatElapsedCompact(agent.activity.startedAt)} ago</>
    ) : status.detail ? (
      action ? (
        <>
          <span className="agent-state-reason">{status.detail}</span>
          <span className="agent-state-separator" aria-hidden="true">
            {" · "}
          </span>
          <Link
            className={buttonClassName({ className: "agent-reconnect", variant: "inline" })}
            to={`/agents/${agent.id}/settings/${action.section}`}
          >
            {action.label}
          </Link>
        </>
      ) : (
        status.detail
      )
    ) : undefined;
  return (
    <article className="agent-card" data-avatar-tone={agentAvatarTone(agent.id)} data-tone={status.tone}>
      <div className="agent-card-identity">
        <span className="agent-avatar" aria-hidden="true">
          {initials(agent.displayName)}
        </span>
        <div className="agent-card-identity-copy">
          <strong>{agent.displayName}</strong>
          <small>@{agent.name}</small>
        </div>
      </div>
      <div className="agent-card-state">
        <StatusIndicator className="agent-card-status" detail={statusDetail} label={status.label} tone={status.tone} />
      </div>
      <dl className="agent-card-usage">
        <div>
          <dt>Tasks</dt>
          <dd>{formatUsageNumber(agent.usage.tasks)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatUsageNumber(agent.usage.tokens)}</dd>
        </div>
      </dl>
      <Link aria-label={`Open ${agent.displayName}`} className="agent-card-action" to={`/agents/${agent.id}`}>
        <Icon name="chevron-right" />
      </Link>
    </article>
  );
}

const agentAvatarTones = ["brand", "amber", "blue", "neutral"] as const;

function agentAvatarTone(agentId: string): (typeof agentAvatarTones)[number] {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  }
  return agentAvatarTones[hash % agentAvatarTones.length] ?? "brand";
}

/**
 * Every state a viewer can act on carries the Settings section that explains it. A state without an
 * exit reads as a dead end: the card reports a failure the viewer cannot follow anywhere.
 */
function agentCardStatus(agent: AgentListItem): {
  action?: { label: string; section: AgentSettingsSection };
  detail?: string;
  label: string;
  priority: number;
  tone: StatusTone;
} {
  if (agent.status === "suspended") return { label: "Paused", priority: 4, tone: "neutral" };
  if (!agent.evidenceConfirmed) {
    return { detail: "Unable to refresh", label: "Unconfirmed", priority: 1, tone: "neutral" };
  }
  if (agent.availability.state === "unconfirmed") {
    return { detail: "Unable to confirm readiness", label: "Unconfirmed", priority: 1, tone: "neutral" };
  }
  if (agent.availability.state === "action_required") {
    const { action, detail } =
      agent.availability.reason === "computer_offline"
        ? { action: { label: "View Computer", section: "computer" as const }, detail: "Computer offline" }
        : agent.availability.reason === "runtime_unavailable"
          ? // Provider readiness is observed per Computer, so the Computer page is where it is explained.
            { action: { label: "View Computer", section: "computer" as const }, detail: "Computer not ready" }
          : { action: { label: "View messaging", section: "messaging" as const }, detail: "Messaging unavailable" };
    return {
      action,
      detail,
      label: "Needs attention",
      priority: 0,
      tone: "warning",
    };
  }
  if (agent.availability.state === "setting_up") {
    return { detail: "Messaging setup in progress", label: "Setting up", priority: 2, tone: "info" };
  }
  if (agent.availability.state === "not_connected") {
    return {
      action: { label: "Connect messaging", section: "messaging" },
      detail: "Messaging not connected",
      label: "Not connected",
      priority: 2,
      tone: "neutral",
    };
  }
  if (agent.activity.state === "working") {
    return {
      label: "Working",
      priority: 2,
      tone: "success",
    };
  }
  return { label: "Available", priority: 3, tone: "success" };
}

function formatElapsedCompact(value: string): string {
  const elapsedMinutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
    notation: value >= 1_000 ? "compact" : "standard",
  }).format(value);
}

function useOwnComputersResource(teamId: string, refreshVersion = 0) {
  return useResource(() => browserApi.ownComputers(), `${teamId}:${refreshVersion}`, {
    onBackgroundError: markOwnComputersUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
}

function NewAgentPage() {
  const { membership } = useTeam();
  const navigate = useNavigate();
  const [computerRefreshVersion, setComputerRefreshVersion] = useState(0);
  const [created, setCreated] = useState<AgentAdminConfig>();
  const computers = useOwnComputersResource(membership.teamId, computerRefreshVersion);
  if (membership.role !== "admin") return <UnavailablePage title="Admin access required" />;
  return (
    <Page
      title={created ? "Agent created" : "Create Agent"}
      description={
        created
          ? "Connect messaging now or continue from the Agent overview."
          : "Name the Agent and prepare where it runs."
      }
    >
      {created ? (
        <NewAgentMessagingStep agent={created} onFinish={() => navigate(`/agents/${created.id}`)} />
      ) : (
        <AgentCreationContent
          computers={computers}
          teamId={membership.teamId}
          onCreated={setCreated}
          onRefresh={() => setComputerRefreshVersion((current) => current + 1)}
        />
      )}
    </Page>
  );
}

function NewAgentDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: { current: HTMLButtonElement | null };
}) {
  const { membership } = useTeam();
  const navigate = useNavigate();
  const [computerRefreshVersion, setComputerRefreshVersion] = useState(0);
  const computers = useOwnComputersResource(membership.teamId, computerRefreshVersion);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<AgentAdminConfig>();
  const finish = () => {
    if (created) navigate(`/agents/${created.id}`);
  };
  const close = () => {
    if (created) finish();
    else onClose();
  };

  return (
    <Dialog
      busy={submitting}
      className="new-agent-dialog"
      closeLabel="Close new Agent dialog"
      returnFocusRef={returnFocusRef}
      title="New Agent"
      onClose={close}
    >
      {created ? (
        <NewAgentMessagingStep agent={created} onFinish={finish} />
      ) : (
        <AgentCreationContent
          computers={computers}
          teamId={membership.teamId}
          onCancel={onClose}
          onCreated={setCreated}
          onRefresh={() => setComputerRefreshVersion((current) => current + 1)}
          onSubmittingChange={setSubmitting}
        />
      )}
    </Dialog>
  );
}

function AgentCreationContent({
  computers,
  onCancel,
  onCreated,
  onRefresh,
  onSubmittingChange,
  teamId,
}: {
  computers: LoadState<{ computers: Computer[] }>;
  onCancel?: () => void;
  onCreated: (agent: AgentAdminConfig) => void;
  onRefresh: () => void;
  onSubmittingChange?: (submitting: boolean) => void;
  teamId: string;
}) {
  const current = computers.kind === "ready" ? computers.value : undefined;
  const [retained, setRetained] = useState(current);
  const [computerRefreshFocusActive, setComputerRefreshFocusActive] = useState(false);
  const computerRefreshFocusRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (computers.kind === "ready") setRetained(computers.value);
  }, [computers]);

  const refreshFocusTarget = onCancel ? (
    <span
      className="visually-hidden"
      ref={computerRefreshFocusRef}
      role={computerRefreshFocusActive ? "status" : undefined}
      tabIndex={-1}
    >
      {computerRefreshFocusActive
        ? computers.kind === "loading"
          ? "Refreshing Computers"
          : computers.kind === "error"
            ? "Computer refresh failed"
            : "Computer connection updated"
        : null}
    </span>
  ) : null;

  if (computers.kind === "error") {
    return (
      <>
        {refreshFocusTarget}
        <AsyncState state={computers}>{() => null}</AsyncState>
      </>
    );
  }
  const value = current ?? retained;
  if (!value) {
    return (
      <>
        {refreshFocusTarget}
        <AsyncState state={computers}>{() => null}</AsyncState>
      </>
    );
  }
  return (
    <>
      {refreshFocusTarget}
      <AgentCreationFlow
        facts={agentCreationFactsFromOwnComputers(value.computers)}
        refreshing={computers.kind === "loading"}
        teamId={teamId}
        onCancel={onCancel}
        onComputerRefreshFocus={() => {
          setComputerRefreshFocusActive(true);
          computerRefreshFocusRef.current?.focus();
        }}
        onCreated={onCreated}
        onRefresh={onRefresh}
        onSubmittingChange={onSubmittingChange}
      />
    </>
  );
}

function NewAgentMessagingStep({ agent, onFinish }: { agent: AgentAdminConfig; onFinish: () => void }) {
  return (
    <FeishuSetup agentId={agent.id} onSuccess={onFinish}>
      {(setup) => (
        <section className="agent-create-complete" aria-labelledby="agent-created-heading">
          <div>
            <span className="eyebrow">Agent created</span>
            <h2 id="agent-created-heading">Connect messaging</h2>
            <p>Connect a Feishu Bot so teammates can mention {agent.displayName}.</p>
          </div>
          <div className="agent-create-actions">
            <Button onClick={() => void setup.start()}>Connect Feishu</Button>
            <Button variant="secondary" onClick={onFinish}>
              Set up later
            </Button>
          </div>
          {setup.feedback}
        </section>
      )}
    </FeishuSetup>
  );
}

function agentCreationFactsFromOwnComputers(computers: readonly Computer[]): AgentCreationFacts {
  return {
    computers,
    providers: computers.flatMap((computer) =>
      (computer.providerReadiness ?? []).map((readiness) => ({
        computerId: computer.id,
        provider: readiness.provider,
        runtimeReady: readiness.status === "ready",
        status: readiness.status,
      })),
    ),
    runtimeEvidenceAvailable:
      computers.length === 0 || computers.some((computer) => computer.providerReadiness !== undefined),
  };
}

function markOwnComputersUnconfirmed(value: { computers: Computer[] }): { computers: Computer[] } {
  return {
    computers: value.computers.map(({ providerReadiness: _providerReadiness, ...computer }) => computer),
  };
}

type AgentSettingsSection = "instructions" | "execution" | "messaging" | "identity" | "computer" | "manage";
type AgentSettingsGroup = "work" | "contact" | "details";

const agentSettingsSections: ReadonlyArray<{
  key: AgentSettingsSection;
  label: string;
  group: AgentSettingsGroup;
  icon: IconName;
}> = [
  {
    key: "instructions",
    label: "Instructions & behavior",
    group: "work",
    icon: "instructions",
  },
  {
    key: "execution",
    label: "Model & reasoning",
    group: "work",
    icon: "model",
  },
  {
    key: "messaging",
    label: "Messaging",
    group: "contact",
    icon: "message",
  },
  {
    key: "identity",
    label: "Name",
    group: "details",
    icon: "user",
  },
  {
    key: "computer",
    label: "Connected computer",
    group: "details",
    icon: "laptop",
  },
  {
    key: "manage",
    label: "Manage Agent",
    group: "details",
    icon: "shield",
  },
];
const agentSettingsGroups = [
  { key: "work", label: "How it works" },
  { key: "contact", label: "Where it receives work" },
  { key: "details", label: "Agent details" },
] as const;

function LegacyAgentAccessRedirect() {
  return <Navigate replace to="/workspace#members" />;
}

function LegacyAgentSectionRedirect() {
  const { agentId = "", legacySection = "" } = useParams();
  const destinations: Record<string, string> = {
    general: `/agents/${agentId}`,
    runtime: `/agents/${agentId}/settings/execution`,
    im: `/agents/${agentId}/settings/messaging`,
  };
  const destination = destinations[legacySection];
  if (destination) return <Navigate replace to={destination} />;
  if (legacySection === "integrations" || legacySection === "skills") {
    return <LegacyAgentCapabilityPage capability={legacySection} />;
  }
  return <NotFoundPage />;
}

function LegacyAgentCapabilityPage({ capability }: { capability: "integrations" | "skills" }) {
  const { agentId = "" } = useParams();
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    onBackgroundError: markAgentDetailUnconfirmed,
  });
  const label = capability === "integrations" ? "integrations" : "skills";
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="object-page agent-profile-page">
          <AgentObjectHeader agent={agent} />
          <div className="agent-secondary-page">
            <header className="section-header">
              <h2>Agent {label} are not available here</h2>
              <p>
                OpenTag does not currently show {label} assigned to {agent.displayName}. The Workspace catalog is
                separate from this Agent.
              </p>
            </header>
            <div className="actions">
              <Link className={buttonClassName()} to={`/agents/${agent.id}`}>
                Back to {agent.displayName}
              </Link>
              <Link className={buttonClassName({ variant: "secondary" })} to={`/${capability}`}>
                Browse Workspace {label}
              </Link>
            </div>
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AgentDetailPage() {
  const { agentId = "" } = useParams();
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    onBackgroundError: markAgentDetailUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="object-page agent-profile-page">
          <AgentObjectHeader agent={agent} />
          <div className="agent-home">
            {agent.availability.state !== "ready" ? <AgentRecoveryBanner agent={agent} /> : null}
            <AgentCurrentActivity agent={agent} />
            <AgentContact agent={agent} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AgentObjectHeader({ agent, backToSettings }: { agent: AgentDetailView; backToSettings?: boolean }) {
  const { me } = useTeam();
  const showManager = agent.manager.userId !== me.user.id;
  return (
    <header className="object-header">
      <Link className="breadcrumb" to={backToSettings ? `/agents/${agent.id}` : "/agents"}>
        <Icon name="arrow-left" />
        {backToSettings ? agent.displayName : "Agents"}
      </Link>
      <div className="object-title-row">
        <div className="object-identity">
          <span className="agent-avatar large" aria-hidden="true">
            {initials(agent.displayName)}
          </span>
          <div className="object-identity-copy">
            <div className="agent-name-line">
              <h1>{agent.displayName}</h1>
              <AgentAvailabilityAction agent={agent} />
            </div>
            <p>
              <span>@{agent.name}</span>
              {showManager ? <span>Managed by {agent.manager.displayName}</span> : null}
            </p>
          </div>
        </div>
        <div className="agent-header-actions">
          {!backToSettings ? (
            <Link className="agent-usage-link" state={{ agent }} to={`/agents/${agent.id}/usage`}>
              Usage
            </Link>
          ) : null}
          {agent.viewerCapabilities.canManage && !backToSettings ? (
            <Link
              className={buttonClassName({ variant: "secondary" })}
              state={{ agent }}
              to={`/agents/${agent.id}/settings`}
            >
              <Icon name="settings" /> Settings
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function AgentRecoveryBanner({ agent }: { agent: AgentDetailView }) {
  const recovery = agentAvailabilityRecovery(agent);
  return (
    <section className="agent-recovery-banner" aria-label="Agent needs attention">
      <div>
        <strong>{availabilityStateLabel(agent.availability.state)}</strong>
        <p>{agentRecoveryMessage(agent)}</p>
      </div>
      {recovery ? (
        <Link className={buttonClassName({ size: "compact", variant: "secondary" })} state={{ agent }} to={recovery.to}>
          {recovery.label}
        </Link>
      ) : null}
    </section>
  );
}

function AgentCurrentActivity({ agent }: { agent: AgentDetailView }) {
  return (
    <section className="agent-home-section" aria-labelledby="current-activity-heading">
      <header className="agent-home-section-heading">
        <h2 id="current-activity-heading">Current work</h2>
      </header>
      {agent.activity.state === "working" ? (
        <div className="agent-current-work">
          <span className="agent-activity-pulse" aria-hidden="true" />
          <div>
            <strong>Handling a request</strong>
            <p>Started {formatRelativeTime(agent.activity.startedAt)}</p>
          </div>
        </div>
      ) : (
        <p className="agent-activity-empty">
          <strong>No active work</strong>
        </p>
      )}
    </section>
  );
}

function AgentContact({ agent }: { agent: AgentDetailView }) {
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  return (
    <section className="agent-home-section" aria-labelledby="agent-contact-heading">
      <header className="agent-home-section-heading">
        <h2 id="agent-contact-heading">Where to use this Agent</h2>
      </header>
      {agent.messaging.kind === "unconfirmed" ? (
        <div className="agent-contact-row is-unconfirmed">
          <span className="agent-contact-mark" aria-hidden="true">
            ?
          </span>
          <span className="agent-contact-copy">
            <strong>Unable to confirm messaging</strong>
            <small>Try again shortly</small>
          </span>
        </div>
      ) : binding ? (
        <div className="agent-contact-row">
          <span className="agent-contact-mark" aria-hidden="true">
            {titleCase(binding.provider).charAt(0)}
          </span>
          <span className="agent-contact-copy">
            <strong>
              {titleCase(binding.provider)} · @{agent.name}
            </strong>
            <small>{agentUseInstruction(agent, binding.provider)}</small>
          </span>
          {agent.viewerCapabilities.canManage ? (
            <Link
              className={buttonClassName({ size: "compact", variant: "outline" })}
              state={{ agent, returnLabel: agent.displayName, returnTo: `/agents/${agent.id}` }}
              to={`/agents/${agent.id}/settings/messaging`}
            >
              Manage
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="agent-contact-row is-empty">
          <span className="agent-contact-mark" aria-hidden="true">
            +
          </span>
          <span className="agent-contact-copy">
            <strong>No messaging connected</strong>
            <small>Connect Feishu or Slack to start sending work</small>
          </span>
          {agent.viewerCapabilities.canManage ? (
            <Link
              className={buttonClassName({ size: "compact", variant: "outline" })}
              state={{ returnLabel: agent.displayName, returnTo: `/agents/${agent.id}` }}
              to={`/agents/${agent.id}/settings/messaging`}
            >
              Connect
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}

function AgentUsagePage() {
  const { agentId = "" } = useParams();
  const location = useLocation();
  const routeState = location.state as { agent?: AgentDetailView } | null;
  const initialAgent = routeState?.agent?.id === agentId ? routeState.agent : undefined;
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    initialValue: initialAgent,
    onBackgroundError: markAgentDetailUnconfirmed,
  });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="object-page agent-profile-page">
          <AgentObjectHeader agent={agent} backToSettings />
          <div className="agent-secondary-page">
            <header className="section-header">
              <h2>Usage</h2>
              <p>Review token use over time.</p>
            </header>
            <AgentUsageTab agentId={agent.id} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AgentSettingsPage() {
  const { agentId = "", section } = useParams();
  const location = useLocation();
  const routeState = location.state as {
    agent?: AgentDetailView;
    returnLabel?: string;
    returnTo?: string;
  } | null;
  const initialAgent = routeState?.agent?.id === agentId ? routeState.agent : undefined;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const state = useResource(() => loadAgentDetail(agentId), `${agentId}:${refreshVersion}`, {
    initialValue: initialAgent,
    keepPreviousData: true,
    onBackgroundError: markAgentDetailUnconfirmed,
  });
  const selected = section as AgentSettingsSection | undefined;
  if (selected && !agentSettingsSections.some((item) => item.key === selected)) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => {
        if (!agent.viewerCapabilities.canManage) return <Navigate replace to={`/agents/${agent.id}`} />;
        const backTo = selected ? (routeState?.returnTo ?? `/agents/${agent.id}/settings`) : `/agents/${agent.id}`;
        const backLabel = selected ? (routeState?.returnLabel ?? "Agent settings") : agent.displayName;
        return (
          <section className="object-page agent-profile-page">
            <div className="agent-settings-page">
              <Link className="agent-page-back" to={backTo}>
                <Icon name="arrow-left" />
                Back to {backLabel}
              </Link>
              <div className="agent-settings-content">
                <AgentSettingsContent
                  agent={agent}
                  section={selected}
                  onAgentChanged={() => setRefreshVersion((value) => value + 1)}
                />
              </div>
            </div>
          </section>
        );
      }}
    </AsyncState>
  );
}

function AccountPage() {
  const { me, refreshMe } = useTeam();
  const location = useLocation();
  if (location.hash === "#workspace-management") {
    return <Navigate replace to="/workspace" />;
  }
  return (
    <Page title="Account" description="Manage your personal account details.">
      <AccountSettings refreshMe={refreshMe} user={me.user} />
    </Page>
  );
}

function WorkspacePage() {
  const { me, membership, refreshMe } = useTeam();
  const location = useLocation();

  useEffect(() => {
    if (location.hash !== "#members") return;
    document.getElementById("members")?.scrollIntoView({ block: "start" });
  }, [location.hash]);

  return (
    <Page
      action={
        <Link className={buttonClassName({ variant: "secondary" })} to="/workspaces/new">
          Create Workspace
        </Link>
      }
      title="Workspace"
      description="Manage the current Workspace, its members, and access."
    >
      <WorkspaceSettings currentUserId={me.user.id} membership={membership} refreshMe={refreshMe} />
    </Page>
  );
}

function WorkspaceSettings({
  currentUserId,
  membership,
  refreshMe,
}: {
  currentUserId: string;
  membership: MeMembership;
  refreshMe: () => void;
}) {
  return (
    <div className="settings-team-stack">
      <section aria-labelledby="workspace-profile-heading" className="account-workspace-profile">
        <header className="settings-subheader">
          <div>
            <h2 id="workspace-profile-heading">Workspace profile</h2>
            <p>Manage the name and CLI identity of the current Workspace.</p>
          </div>
          {membership.role !== "admin" ? (
            <span className="settings-role-badge">Your role: {titleCase(membership.role)}</span>
          ) : null}
        </header>
        <TeamProfileSettings membership={membership} refreshMe={refreshMe} />
      </section>
      <MembersSettings
        canManage={membership.role === "admin"}
        currentUserId={currentUserId}
        refreshMe={refreshMe}
        teamId={membership.teamId}
      />
    </div>
  );
}

function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  const tone = availabilityTone(agent.availability.state);
  const working = agent.availability.state === "ready" && agent.activity.state === "working";
  return (
    <div className="agent-availability-line">
      <StatusIndicator
        label={working ? "Working" : availabilityStateLabel(agent.availability.state)}
        tone={working ? "info" : tone}
      />
    </div>
  );
}

function AgentSettingsContent({
  agent,
  section,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  section: AgentSettingsSection | undefined;
  onAgentChanged: () => void;
}) {
  if (!section) return <AgentSettingsOverview agent={agent} />;
  if (section === "messaging") return <ImTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (section === "computer") return <AgentComputerSettings agent={agent} />;
  return <AgentConfigSettingsContent agent={agent} section={section} onAgentChanged={onAgentChanged} />;
}

function AgentConfigSettingsContent({
  agent,
  section,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  section: Exclude<AgentSettingsSection, "computer" | "messaging">;
  onAgentChanged: () => void;
}) {
  const configState = useResource(() => browserApi.agentConfig(agent.id), `${agent.id}:${section}`);
  return (
    <AsyncState state={configState}>
      {(config) => {
        if (section === "identity") {
          return <GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />;
        }
        if (section === "instructions" || section === "execution") {
          return (
            <RuntimeConfigurationForm
              initialConfig={config}
              save={(input) => browserApi.updateAgent(config.id, input)}
              section={section}
            />
          );
        }
        return <AgentManageSettings agent={agent} initialConfig={config} onAgentChanged={onAgentChanged} />;
      }}
    </AsyncState>
  );
}

function AgentSettingsOverview({ agent }: { agent: AgentDetailView }) {
  const configState = useResource(() => browserApi.agentConfig(agent.id), `${agent.id}:settings-overview`);
  return (
    <div className="agent-settings-overview">
      <header className="agent-settings-page-title">
        <h1>Agent settings</h1>
        <p>Change how {agent.displayName} works and receives requests.</p>
      </header>
      <AsyncState loading={<AgentSettingsDirectoryLoading />} state={configState}>
        {(config) => (
          <div className="agent-settings-groups">
            {agentSettingsGroups.map((group) => (
              <section className="agent-settings-group" key={group.key} aria-labelledby={`agent-settings-${group.key}`}>
                <h2 id={`agent-settings-${group.key}`}>{group.label}</h2>
                <div className="agent-settings-grid">
                  {agentSettingsSections
                    .filter((item) => item.group === group.key)
                    .map((item) => {
                      const content = (
                        <>
                          <span className="agent-settings-icon" aria-hidden="true">
                            <Icon name={item.icon} />
                          </span>
                          <span className="agent-settings-row-copy">
                            <strong>{item.label}</strong>
                            <small>{agentSettingsSummary(agent, config, item.key)}</small>
                          </span>
                        </>
                      );
                      const computerReady =
                        item.key === "computer" && agent.availability.dependencies.computer.state === "ready";
                      if (computerReady) {
                        return (
                          <div className="agent-settings-entry is-static" key={item.key}>
                            {content}
                          </div>
                        );
                      }
                      return (
                        <Link
                          className="agent-settings-entry"
                          key={item.key}
                          to={`/agents/${agent.id}/settings/${item.key}`}
                        >
                          {content}
                          <span className="agent-settings-row-value" aria-hidden="true">
                            {item.key === "computer" ? <small>Review</small> : null}
                            <Icon name="chevron-right" />
                          </span>
                        </Link>
                      );
                    })}
                </div>
              </section>
            ))}
          </div>
        )}
      </AsyncState>
    </div>
  );
}

function AgentSettingsDirectoryLoading() {
  return (
    <div aria-label="Loading Agent settings" className="agent-settings-loading" role="status">
      <div aria-hidden="true" className="agent-settings-groups">
        {agentSettingsGroups.map((group) => (
          <div className="agent-settings-group" key={group.key}>
            <span className="agent-settings-loading-label" />
            <div className="agent-settings-grid">
              {agentSettingsSections
                .filter((item) => item.group === group.key)
                .map((item) => (
                  <div className="agent-settings-entry is-static is-loading" key={item.key}>
                    <span className="agent-settings-icon" />
                    <span className="agent-settings-loading-copy">
                      <span className="agent-settings-loading-title" />
                      <span className="agent-settings-loading-summary" />
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function agentSettingsSummary(agent: AgentDetailView, config: AgentAdminConfig, section: AgentSettingsSection): string {
  if (section === "instructions") {
    return config.runtimeConfig.instructions.trim() ? "Custom instructions" : "Not configured";
  }
  if (section === "execution") {
    const provider = config.runtimeProvider === "codex" ? "Codex" : "Claude Code";
    const model = config.runtimeConfig.model ?? "Default model";
    const reasoning = config.runtimeConfig.reasoningEffort
      ? titleCase(config.runtimeConfig.reasoningEffort)
      : "Default reasoning";
    return `${provider} · ${model} · ${reasoning}`;
  }
  if (section === "messaging") {
    if (agent.messaging.kind === "unconfirmed") return "Messaging status is temporarily unavailable";
    const binding = agent.messaging.value;
    if (!binding) return "No messaging channel connected";
    const status =
      binding.bindingState === "active" && agent.availability.dependencies.handoff.state === "ready"
        ? "Connected"
        : messagingConnectionLabel(binding, agent.availability.dependencies.handoff.state);
    return `${titleCase(binding.provider)} · @${agent.name} · ${status}`;
  }
  if (section === "identity") return config.displayName;
  if (section === "computer") {
    const state = agent.availability.dependencies.computer.state;
    const status = state === "ready" ? "Online" : state === "action_required" ? "Offline" : "Unconfirmed";
    return `${agent.computer.displayName} · ${platformLabel(agent.computer.platform)} · ${status}`;
  }
  return config.status === "active" ? "Active" : "Paused";
}

function GeneralConfigForm({
  initialConfig,
  onAgentChanged,
}: {
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [displayName, setDisplayName] = useState(initialConfig.displayName);
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dirty = displayName !== config.displayName;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const updated = await browserApi.updateAgent(config.id, { expectedRevision: config.revision, displayName });
      setConfig(updated);
      setDisplayName(updated.displayName);
      setMessage("Name saved.");
      onAgentChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save name");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="form-card agent-settings-form" onSubmit={submit}>
      <header className="agent-settings-page-title">
        <h1>Name</h1>
        <p>Choose the name teammates see.</p>
      </header>
      <Field htmlFor="agent-display-name" label="Display name">
        <input
          className="ds-control"
          id="agent-display-name"
          name="displayName"
          required
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.currentTarget.value);
            setMessage(undefined);
          }}
        />
      </Field>
      {dirty ? (
        <div className="dirty-bar">
          <span>Unsaved changes</span>
          <div className="dirty-actions">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setDisplayName(config.displayName);
                setMessage(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

/**
 * Names the machine-level action that resolves the failure. Recovery is stated against the Computer
 * rather than a person: the Workspace has no authoritative operator field, and issue #125 makes the
 * Agent creator audit-only while stating that enrollment implies no control of the physical host.
 */
function computerRecoveryMessage(agent: AgentDetailView): string {
  const computerName = agent.computer.displayName;
  if (agent.availability.reason === "runtime_unavailable") {
    const { provider, status } = agent.availability.dependencies.runtime;
    const providerName = provider === "codex" ? "Codex" : "Claude Code";
    if (status === "install") return `${providerName} is not installed on ${computerName}.`;
    if (status === "sign-in") return `${providerName} is not signed in on ${computerName}.`;
    if (status === "checking") return `OpenTag is still checking ${providerName} on ${computerName}.`;
    return `${providerName} is unavailable on ${computerName}.`;
  }
  if (agent.availability.dependencies.computer.state !== "action_required") {
    return "OpenTag could not confirm this Computer's current connection.";
  }
  return `OpenTag is not running on ${computerName}. Start it there to bring this Computer back online.`;
}

function AgentComputerSettings({ agent }: { agent: AgentDetailView }) {
  const computerState = agent.availability.dependencies.computer;
  const runtimeUnavailable = agent.availability.reason === "runtime_unavailable";
  // A reachable Computer that cannot run this Agent's Provider is not "Online" for this Agent.
  const ready = computerState.state === "ready" && !runtimeUnavailable;
  const blocked = computerState.state === "action_required" || runtimeUnavailable;
  const computerStatus = ready
    ? "Online"
    : blocked
      ? runtimeUnavailable
        ? "Not ready"
        : "Offline"
      : "Unable to confirm";
  const computerTone: StatusTone = ready ? "success" : blocked ? "warning" : "neutral";
  return (
    <div className="agent-runtime-stack agent-settings-section-page">
      <section aria-labelledby="computer-heading" className="agent-runtime-section agent-runtime-computer">
        <header className="agent-runtime-section__header">
          <div>
            <h1 id="computer-heading">
              {agent.computer.displayName} · {platformLabel(agent.computer.platform)}
            </h1>
          </div>
          <StatusIndicator label={computerStatus} tone={computerTone} />
        </header>
        {ready ? null : (
          <div className="agent-runtime-computer__body">
            <div className="agent-runtime-recovery">
              {computerState.lastConfirmedAt ? (
                <p>
                  Last seen {formatRelativeTime(computerState.lastConfirmedAt)} ·{" "}
                  {formatDate(computerState.lastConfirmedAt)}
                </p>
              ) : null}
              <p>{computerRecoveryMessage(agent)}</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AgentManageSettings({
  agent,
  initialConfig,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const navigate = useNavigate();
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string>();
  const [confirmation, setConfirmation] = useState<"delete" | "pause">();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationText, setConfirmationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [restorePauseFocus, setRestorePauseFocus] = useState(false);
  const pauseButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmation || !restorePauseFocus) return;
    pauseButtonRef.current?.focus();
    setRestorePauseFocus(false);
  }, [confirmation, restorePauseFocus]);
  async function changeLifecycle(action: "suspend" | "reactivate") {
    try {
      setBusy(true);
      setMessage(undefined);
      setConfirmationError(undefined);
      setConfig(
        action === "suspend" ? await browserApi.suspendAgent(config.id) : await browserApi.reactivateAgent(config.id),
      );
      setMessage(action === "suspend" ? "Agent paused." : "Agent reactivated.");
      setRestorePauseFocus(confirmation === "pause");
      setConfirmation(undefined);
      onAgentChanged();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Unable to change Agent status";
      if (confirmation === "pause") setConfirmationError(error);
      else setMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function deleteAgent() {
    try {
      setBusy(true);
      setMessage(undefined);
      setConfirmationError(undefined);
      await browserApi.deleteAgent(config.id);
      navigate("/agents");
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : "Unable to delete Agent");
      setBusy(false);
    }
  }
  function closeConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }
  return (
    <section className="agent-manage-settings agent-settings-section-page">
      <header className="agent-settings-page-title">
        <h1>Manage Agent</h1>
        <p>Pause this Agent temporarily or remove it permanently.</p>
      </header>
      <SettingsList>
        <SettingsRow
          description={
            config.status === "active" ? "Stop accepting new requests until reactivated." : "Allow new requests again."
          }
          label={config.status === "active" ? "Pause Agent" : "Reactivate Agent"}
        >
          <Button
            ref={pauseButtonRef}
            variant="secondary"
            onClick={() => {
              if (config.status === "active" && agent.activity.state === "working") {
                setConfirmationError(undefined);
                setConfirmation("pause");
                return;
              }
              void changeLifecycle(config.status === "active" ? "suspend" : "reactivate");
            }}
          >
            {config.status === "active" ? "Pause" : "Reactivate"}
          </Button>
        </SettingsRow>
        <SettingsRow
          description={
            config.status === "active"
              ? "Pause this Agent before deleting it permanently."
              : "Permanently remove this Agent. This cannot be undone."
          }
          label="Delete Agent"
        >
          <Button
            disabled={config.status === "active"}
            ref={deleteButtonRef}
            variant="danger"
            onClick={() => {
              setConfirmationText("");
              setConfirmationError(undefined);
              setConfirmation("delete");
            }}
          >
            Delete permanently
          </Button>
        </SettingsRow>
      </SettingsList>
      {message ? <p role="status">{message}</p> : null}
      {confirmation === "pause" ? (
        <Dialog
          busy={busy}
          description="This Agent is handling a request. Pausing it stops new requests, but the current request may continue until it reaches a safe stopping point."
          returnFocusRef={pauseButtonRef}
          title={`Pause ${config.displayName}?`}
          onClose={closeConfirmation}
        >
          {confirmationError ? (
            <div className="notice error" role="alert">
              {confirmationError}
            </div>
          ) : null}
          <div className="dialog-actions actions">
            <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
              Keep active
            </Button>
            <Button disabled={busy} variant="primary" onClick={() => void changeLifecycle("suspend")}>
              {busy ? "Pausing…" : "Pause Agent"}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirmation === "delete" ? (
        <Dialog
          busy={busy}
          description="This permanently removes the Agent and its messaging connection. The Agent cannot be restored."
          returnFocusRef={deleteButtonRef}
          title={`Delete ${config.displayName}?`}
          onClose={closeConfirmation}
        >
          <div className="agent-delete-confirmation">
            <Field
              htmlFor="agent-delete-confirmation"
              label={
                <>
                  Type <strong>{config.displayName}</strong> to confirm
                </>
              }
            >
              <input
                autoComplete="off"
                id="agent-delete-confirmation"
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.currentTarget.value)}
              />
            </Field>
            {confirmationError ? (
              <div className="notice error" role="alert">
                {confirmationError}
              </div>
            ) : null}
            <div className="dialog-actions actions">
              <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
                Cancel
              </Button>
              <Button
                disabled={busy || confirmationText !== config.displayName}
                variant="danger"
                onClick={() => void deleteAgent()}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string>();
  const [reauthorizationNeeded, setReauthorizationNeeded] = useState(false);
  const [confirmation, setConfirmation] = useState<
    { kind: "all_messages" } | { bindingId: string; kind: "disable_binding" }
  >();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] = useState<"messaging" | "trigger_rules">();
  const allMessagesButtonRef = useRef<HTMLButtonElement>(null);
  const disableBindingButtonRef = useRef<HTMLButtonElement>(null);
  const messagingHeadingRef = useRef<HTMLHeadingElement>(null);
  const triggerRulesHeadingRef = useRef<HTMLHeadingElement>(null);
  const state = useResource(() => browserApi.imBinding(agent.id), `${agent.id}:${reload}`, {
    keepPreviousData: true,
  });
  useEffect(() => {
    if (confirmation || !restoreFocusTarget) return;
    const target = restoreFocusTarget === "messaging" ? messagingHeadingRef.current : triggerRulesHeadingRef.current;
    target?.focus();
    setRestoreFocusTarget(undefined);
  }, [confirmation, restoreFocusTarget]);
  async function changeReceiveMode(receiveMode: "mention_only" | "all_message") {
    try {
      setConfirmationBusy(true);
      setError(undefined);
      setConfirmationError(undefined);
      const config = await browserApi.agentConfig(agent.id);
      await browserApi.updateAgent(agent.id, { expectedRevision: config.revision, receiveMode });
      setReload((value) => value + 1);
      if (receiveMode === "all_message") setRestoreFocusTarget("trigger_rules");
      setConfirmation(undefined);
      onAgentChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "IM_BINDING_SCOPE_REAUTH_REQUIRED") {
        setReauthorizationNeeded(true);
      }
      const nextError = cause instanceof Error ? cause.message : "Unable to change receive mode";
      if (confirmation?.kind === "all_messages") setConfirmationError(nextError);
      else setError(nextError);
    } finally {
      setConfirmationBusy(false);
    }
  }
  async function disableBinding(bindingId: string) {
    try {
      setConfirmationBusy(true);
      setError(undefined);
      setConfirmationError(undefined);
      await browserApi.disableImBinding(bindingId);
      setReload((value) => value + 1);
      setRestoreFocusTarget("messaging");
      setConfirmation(undefined);
      onAgentChanged();
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : "Unable to disconnect messaging");
    } finally {
      setConfirmationBusy(false);
    }
  }
  function closeMessagingConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }
  return (
    <div className="agent-settings-section-page">
      <header className="agent-settings-page-title">
        <h1 ref={messagingHeadingRef} tabIndex={-1}>
          Messaging
        </h1>
        <p>Choose how teammates can contact and assign work to {agent.displayName}.</p>
      </header>
      <FeishuSetup
        agentId={agent.id}
        onSuccess={() => {
          setReload((value) => value + 1);
          onAgentChanged();
        }}
      >
        {(feishuSetup) => (
          <SlackSetup
            agentId={agent.id}
            onSuccess={() => {
              setReload((value) => value + 1);
              onAgentChanged();
            }}
          >
            {(slackSetup) => {
              const connectFeishu = async (intent: "create" | "reauthorize" | "replace" = "create") => {
                setError(undefined);
                if (await feishuSetup.start(intent)) setReauthorizationNeeded(false);
              };
              const connectSlack = async (intent: "create" | "reauthorize" | "replace" = "create") => {
                setError(undefined);
                if (await slackSetup.start(intent)) setReauthorizationNeeded(false);
              };
              return (
                <AsyncState state={state}>
                  {(binding) => (
                    <div className="im-stack">
                      {binding ? (
                        <>
                          <section className="im-section" aria-labelledby="contact-channel-heading">
                            <div className="im-section-heading">
                              <h3 id="contact-channel-heading">Contact channel</h3>
                              <p>See how teammates can reach this agent and check its connection status.</p>
                            </div>
                            <div className="binding-status">
                              <StatusIndicator
                                detail={`${titleCase(binding.provider)} · ${messagingConnectionLabel(
                                  binding,
                                  agent.availability.dependencies.handoff.state,
                                )}`}
                                label={binding.bot.displayName}
                                tone={messagingConnectionTone(binding, agent.availability.dependencies.handoff.state)}
                              />
                              <small>
                                {binding.lastConfirmedAt
                                  ? `Last checked ${formatDate(binding.lastConfirmedAt)}`
                                  : "Unable to confirm"}
                              </small>
                            </div>
                            <dl className="messaging-contact-facts">
                              <div>
                                <dt>Contact</dt>
                                <dd>@{agent.name}</dd>
                              </div>
                              <div>
                                <dt>How to use</dt>
                                <dd>{agentUseInstruction(agent, binding.provider)}</dd>
                              </div>
                            </dl>
                            {(binding.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
                            binding.provider === "feishu" &&
                            agent.viewerCapabilities.canManage ? (
                              <div className="im-actions">
                                <Button onClick={() => void connectFeishu("reauthorize")}>Reauthorize Feishu</Button>
                              </div>
                            ) : null}
                            {(binding.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
                            binding.provider === "slack" &&
                            agent.viewerCapabilities.canManage ? (
                              <div className="im-actions">
                                <Button onClick={() => void connectSlack("reauthorize")}>Reauthorize Slack</Button>
                              </div>
                            ) : null}
                            {binding.bindingState === "provisioning" &&
                            binding.provider === "slack" &&
                            agent.viewerCapabilities.canManage ? (
                              <SlackProvisioningActions onResume={() => void connectSlack("create")} />
                            ) : null}
                            {agent.viewerCapabilities.canManage ? (
                              <div className="im-actions messaging-connection-actions">
                                {binding.provider === "feishu" ? (
                                  <Button
                                    size="compact"
                                    variant="outline"
                                    onClick={() => void connectFeishu("replace")}
                                  >
                                    Change Feishu Bot
                                  </Button>
                                ) : null}
                                {binding.provider === "slack" && binding.bindingState !== "provisioning" ? (
                                  <Button size="compact" variant="outline" onClick={() => void connectSlack("replace")}>
                                    Change Slack App
                                  </Button>
                                ) : null}
                                <Button
                                  ref={disableBindingButtonRef}
                                  size="compact"
                                  variant="danger"
                                  onClick={() => {
                                    setConfirmationError(undefined);
                                    setConfirmation({ bindingId: binding.id, kind: "disable_binding" });
                                  }}
                                >
                                  Disconnect {titleCase(binding.provider)}
                                </Button>
                              </div>
                            ) : (
                              <p className="muted">Workspace admins manage this contact channel.</p>
                            )}
                          </section>
                          <section className="im-section" aria-labelledby="trigger-rules-heading">
                            <div className="im-section-heading">
                              <h3 id="trigger-rules-heading" ref={triggerRulesHeadingRef} tabIndex={-1}>
                                Trigger rules
                              </h3>
                              <p>Choose which incoming messages can start a task.</p>
                            </div>
                            <SettingsList className="agent-message-rules">
                              <SettingsRow description="Every direct message starts a task." label="Direct messages">
                                <strong>All messages</strong>
                              </SettingsRow>
                              <SettingsRow
                                description="Choose whether the agent responds only to mentions or to every message."
                                label={sharedConversationLabel(binding.provider)}
                              >
                                {agent.viewerCapabilities.canManage ? (
                                  <fieldset aria-label="Shared conversation trigger rule" className="segmented-control">
                                    {binding.receiveMode === "mention_only" ? (
                                      <>
                                        <span className="active">Mentions only</span>
                                        <button
                                          ref={allMessagesButtonRef}
                                          type="button"
                                          onClick={() => {
                                            setConfirmationError(undefined);
                                            setConfirmation({ kind: "all_messages" });
                                          }}
                                        >
                                          Every message
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        <button type="button" onClick={() => void changeReceiveMode("mention_only")}>
                                          Mentions only
                                        </button>
                                        <span className="active">Every message</span>
                                      </>
                                    )}
                                  </fieldset>
                                ) : (
                                  <strong>{receiveModeLabel(binding.receiveMode)}</strong>
                                )}
                              </SettingsRow>
                            </SettingsList>
                            {binding.pendingReceiveMode ? (
                              <p className="muted">
                                Scope upgrade pending: {receiveModeLabel(binding.pendingReceiveMode)} takes effect once{" "}
                                {titleCase(binding.provider)} grants the additional permissions through reauthorization.
                              </p>
                            ) : null}
                          </section>
                        </>
                      ) : (
                        <section className="im-section" aria-labelledby="contact-channel-heading">
                          <div className="im-section-heading">
                            <h3 id="contact-channel-heading">Contact channel</h3>
                            <p>See how teammates can reach this agent.</p>
                          </div>
                          <EmptyState title="No messaging channel">
                            Teammates cannot contact this agent until a supported bot is connected.
                          </EmptyState>
                          {agent.viewerCapabilities.canManage ? (
                            <div className="im-actions">
                              <Button onClick={() => void connectFeishu()}>Connect a Feishu Bot</Button>
                              <Button variant="secondary" onClick={() => void connectSlack()}>
                                Connect Slack App
                              </Button>
                            </div>
                          ) : (
                            <p className="muted">Workspace admins manage messaging setup.</p>
                          )}
                        </section>
                      )}
                      {feishuSetup.feedback}
                      {slackSetup.feedback}
                      {error ? (
                        <div className="notice error" role="alert">
                          {error}
                        </div>
                      ) : null}
                    </div>
                  )}
                </AsyncState>
              );
            }}
          </SlackSetup>
        )}
      </FeishuSetup>
      {confirmation?.kind === "all_messages" ? (
        <Dialog
          busy={confirmationBusy}
          description="Every new conversation message could start a task. This can share more conversation content and increase token usage."
          returnFocusRef={allMessagesButtonRef}
          title="Allow messages without mentions?"
          onClose={closeMessagingConfirmation}
        >
          {confirmationError ? (
            <div className="notice error" role="alert">
              {confirmationError}
            </div>
          ) : null}
          <div className="dialog-actions actions">
            <Button disabled={confirmationBusy} variant="ghost" onClick={closeMessagingConfirmation}>
              Keep mentions only
            </Button>
            <Button disabled={confirmationBusy} onClick={() => void changeReceiveMode("all_message")}>
              {confirmationBusy ? "Updating…" : "Allow every message"}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirmation?.kind === "disable_binding" ? (
        <Dialog
          busy={confirmationBusy}
          description="Teammates will no longer be able to assign new work to this agent until another messaging connection is added."
          returnFocusRef={disableBindingButtonRef}
          title="Disconnect messaging?"
          onClose={closeMessagingConfirmation}
        >
          {confirmationError ? (
            <div className="notice error" role="alert">
              {confirmationError}
            </div>
          ) : null}
          <div className="dialog-actions actions">
            <Button disabled={confirmationBusy} variant="ghost" onClick={closeMessagingConfirmation}>
              Keep connected
            </Button>
            <Button
              disabled={confirmationBusy}
              variant="danger"
              onClick={() => void disableBinding(confirmation.bindingId)}
            >
              {confirmationBusy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * A provisioning Slack binding may represent an active or terminal setup attempt. Only an explicit
 * Admin action may reuse the active attempt or create a successor after cancellation.
 */
function SlackProvisioningActions({ onResume }: { onResume: () => void }) {
  return (
    <div className="im-actions">
      <Button onClick={onResume}>Resume Slack setup</Button>
    </div>
  );
}

function imBindingStateLabel(binding: ImBindingSummary): string {
  if (binding.bindingState === "reauthorization_required" && binding.provider === "feishu") {
    return "Permissions update required";
  }
  return {
    active: "Configured",
    provisioning: "Setting up",
    reauthorization_required: "Permissions update required",
    error: "Needs attention",
    disabled: "Disabled",
  }[binding.bindingState];
}

function imBindingTone(binding: ImBindingSummary): StatusTone {
  const tones: Record<ImBindingSummary["bindingState"], StatusTone> = {
    active: "success",
    provisioning: "info",
    reauthorization_required: "warning",
    error: "danger",
    disabled: "neutral",
  };
  return tones[binding.bindingState];
}

function messagingConnectionLabel(
  binding: ImBindingSummary,
  handoffState: AgentAvailability["dependencies"]["handoff"]["state"],
): string {
  if (binding.bindingState !== "active") return imBindingStateLabel(binding);
  if (handoffState === "ready") return "Connected";
  if (handoffState === "setting_up") return "Setting up";
  if (handoffState === "unconfirmed") return "Unable to confirm";
  return "Needs attention";
}

function messagingConnectionTone(
  binding: ImBindingSummary,
  handoffState: AgentAvailability["dependencies"]["handoff"]["state"],
): StatusTone {
  if (binding.bindingState !== "active") return imBindingTone(binding);
  if (handoffState === "ready") return "success";
  if (handoffState === "setting_up") return "info";
  if (handoffState === "unconfirmed") return "neutral";
  return "warning";
}

function AccountSettings({ refreshMe, user }: { refreshMe: () => void; user: MeResponse["user"] }) {
  const saveInFlight = useRef(false);
  const confirmedDisplayNameRef = useRef(user.displayName);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const dirty = displayName !== user.displayName;

  useEffect(() => {
    if (confirmedDisplayNameRef.current === user.displayName) return;
    confirmedDisplayNameRef.current = user.displayName;
    setDisplayName(user.displayName);
  }, [user.displayName]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const updated = await browserApi.updateProfile({ displayName });
      setDisplayName(updated.displayName);
      setMessage("Account profile saved.");
      refreshMe();
    } catch (cause) {
      setDisplayName(user.displayName);
      setError(cause instanceof Error ? cause.message : "Unable to save the account profile");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <form className="settings-profile-form" onSubmit={submit}>
      <h2>Account profile</h2>
      <SettingsList>
        <SettingsRow label="Email" description="Your sign-in email cannot be changed here.">
          <Field
            className="settings-profile-field"
            hint="Read only"
            hintId="account-email-hint"
            htmlFor="account-email"
            label="Email"
          >
            <input
              aria-describedby="account-email-hint"
              className="ds-control"
              id="account-email"
              name="email"
              readOnly
              type="email"
              value={user.email}
            />
          </Field>
        </SettingsRow>
        <SettingsRow label="Display name" description="This identity is used throughout OpenTag.">
          <Field className="settings-profile-field" htmlFor="account-display-name" label="Display name">
            <input
              autoComplete="name"
              className="ds-control"
              id="account-display-name"
              maxLength={255}
              name="displayName"
              onChange={(event) => {
                setDisplayName(event.currentTarget.value);
                setMessage(undefined);
                setError(undefined);
              }}
              required
              value={displayName}
            />
          </Field>
        </SettingsRow>
      </SettingsList>
      {dirty ? (
        <div className="dirty-bar">
          <span>Unsaved changes</span>
          <div className="dirty-actions">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setDisplayName(user.displayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save account profile"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="settings-inline-status success" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function TeamProfileSettings({ membership, refreshMe }: { membership: MeMembership; refreshMe: () => void }) {
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [teamDisplayName, setTeamDisplayName] = useState(membership.teamDisplayName);
  const dirty = teamDisplayName !== membership.teamDisplayName;

  useEffect(() => {
    setTeamDisplayName(membership.teamDisplayName);
  }, [membership.teamDisplayName]);

  if (membership.role !== "admin") {
    return (
      <div className="settings-readonly-panel">
        <DefinitionList
          rows={[
            ["Workspace name", membership.teamDisplayName],
            ["CLI identifier", membership.teamName],
          ]}
        />
      </div>
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      setMessage(undefined);
      setError(undefined);
      await browserApi.updateTeam(membership.teamId, {
        displayName: teamDisplayName,
      });
      refreshMe();
      setMessage("Workspace profile saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the Workspace profile");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form aria-labelledby="workspace-profile-heading" className="settings-profile-form" onSubmit={submit}>
      <SettingsList>
        <SettingsRow label="Workspace name" description="What people see in navigation and invitations.">
          <Field className="settings-profile-field" htmlFor="workspace-profile-name" label="Workspace name">
            <input
              className="ds-control"
              id="workspace-profile-name"
              name="displayName"
              required
              value={teamDisplayName}
              onChange={(event) => {
                setTeamDisplayName(event.currentTarget.value);
                setMessage(undefined);
                setError(undefined);
              }}
            />
          </Field>
        </SettingsRow>
        <SettingsRow
          label="CLI identifier"
          description="Created automatically for CLI commands. It stays the same when you rename the Workspace."
        >
          <dl className="settings-readonly-value">
            <div>
              <dt className="visually-hidden">CLI identifier</dt>
              <dd>
                <code>{membership.teamName}</code>
              </dd>
            </div>
            <div>
              <dt className="visually-hidden">CLI command</dt>
              <dd>
                <small>
                  <code>--team {membership.teamName}</code>
                </small>
              </dd>
            </div>
          </dl>
        </SettingsRow>
      </SettingsList>
      {dirty ? (
        <div className="dirty-bar">
          <span>Unsaved changes</span>
          <div className="dirty-actions">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setTeamDisplayName(membership.teamDisplayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save Workspace profile"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="settings-inline-status success" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function MembersSettings({
  canManage,
  currentUserId,
  refreshMe,
  teamId,
}: {
  canManage: boolean;
  currentUserId: string;
  refreshMe: () => void;
  teamId: string;
}) {
  const [revision, setRevision] = useState(0);
  const state = useResource(() => browserApi.members(teamId), `${teamId}:${revision}`);
  const pendingUserIdsRef = useRef(new Set<string>());
  const [pendingUserIds, setPendingUserIds] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string>();

  async function changeRole(member: TeamMemberSummary, value: string) {
    if (value === member.role || pendingUserIdsRef.current.has(member.userId)) return;
    pendingUserIdsRef.current.add(member.userId);
    setPendingUserIds(new Set(pendingUserIdsRef.current));
    setError(undefined);
    try {
      const role = MembershipRoleSchema.parse(value);
      await browserApi.updateTeamMember(teamId, member.userId, { role });
      setRevision((current) => current + 1);
      if (member.userId === currentUserId) refreshMe();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update the member role");
    } finally {
      pendingUserIdsRef.current.delete(member.userId);
      setPendingUserIds(new Set(pendingUserIdsRef.current));
    }
  }

  return (
    <section className="settings-list-section settings-members-section" id="members">
      <header className="settings-subheader">
        <div>
          <h2>Members &amp; access</h2>
          <p>Review members, manage roles, and invite people to this Workspace.</p>
        </div>
      </header>
      <AsyncState state={state}>
        {(value) => {
          const adminCount = value.members.filter((member: TeamMemberSummary) => member.role === "admin").length;
          const members = [...value.members].sort((left, right) => {
            if (left.userId === currentUserId) return -1;
            if (right.userId === currentUserId) return 1;
            return left.displayName.localeCompare(right.displayName) || left.userId.localeCompare(right.userId);
          });
          return (
            <div className="settings-member-list">
              <div className="settings-member-summary">
                <p>
                  {value.members.length} {value.members.length === 1 ? "member" : "members"} · {adminCount}{" "}
                  {adminCount === 1 ? "admin" : "admins"}
                </p>
                {!canManage ? <span className="settings-role-badge">Read only</span> : null}
              </div>
              <table className="settings-member-table" aria-label="Members">
                <thead>
                  <tr className="settings-table-header">
                    <th scope="col">Member</th>
                    <th scope="col">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member: TeamMemberSummary) => (
                    <tr className="settings-member-row" key={member.userId}>
                      <th className="settings-member-identity" scope="row">
                        <span className="settings-member-avatar" aria-hidden="true">
                          {initials(member.displayName)}
                        </span>
                        <span>
                          <strong>{member.displayName}</strong>
                          {member.userId === currentUserId ? <small>You</small> : null}
                        </span>
                      </th>
                      <td data-label="Role">
                        {canManage ? (
                          <select
                            aria-label={`Role for ${member.displayName}`}
                            className="ds-control ds-control--compact"
                            disabled={pendingUserIds.has(member.userId)}
                            value={member.role}
                            onChange={(event) => void changeRole(member, event.currentTarget.value)}
                          >
                            {MembershipRoleSchema.options.map((role) => (
                              <option value={role} key={role}>
                                {titleCase(role)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="settings-value-badge">{titleCase(member.role)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </AsyncState>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      {canManage ? <InvitationSettings teamId={teamId} /> : null}
    </section>
  );
}

function InvitationSettings({
  onMutationPendingChange = () => undefined,
  presentation = "panel",
  teamId,
}: {
  onMutationPendingChange?: (pending: boolean) => void;
  presentation?: "dialog" | "panel";
  teamId: string;
}) {
  const state = useResource(() => browserApi.invitation(teamId), teamId);
  const [current, setCurrent] = useState<Awaited<ReturnType<typeof browserApi.invitation>>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  async function createInvitation() {
    await mutateInvitation(() => browserApi.createInvitation(teamId), "Invite link created.");
  }

  async function rotateInvitation() {
    if (!window.confirm("Replace this invite link? The current link will stop working immediately.")) return;
    await mutateInvitation(() => browserApi.rotateInvitation(teamId), "Invite link replaced.");
  }

  async function mutateInvitation(action: () => Promise<NonNullable<typeof current>>, successMessage: string) {
    setBusy(true);
    onMutationPendingChange(true);
    setError(undefined);
    setMessage(undefined);
    try {
      setCurrent(await action());
      setMessage(successMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update the invite link");
    } finally {
      setBusy(false);
      onMutationPendingChange(false);
    }
  }

  async function copyInvitation(inviteUrl: string) {
    setError(undefined);
    setMessage(undefined);
    try {
      if (!window.navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser");
      await window.navigator.clipboard.writeText(inviteUrl);
      setMessage("Invite link copied.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to copy the invite link");
    }
  }

  return (
    <section
      aria-labelledby={presentation === "panel" ? "invite-members-heading" : undefined}
      className={presentation === "dialog" ? "invitation-dialog-content" : "settings-invitation-panel"}
    >
      {presentation === "panel" ? (
        <>
          <h3 id="invite-members-heading">Invite members</h3>
          <p>This link lets anyone join as a member until it expires.</p>
        </>
      ) : null}
      <AsyncState state={state}>
        {(loaded) => {
          const invitation = current ?? loaded;
          return invitation ? (
            <>
              <label className="invite-link">
                Invite link
                <input
                  className="ds-control"
                  aria-label="Invite link"
                  readOnly
                  type="url"
                  value={invitation.inviteUrl}
                />
              </label>
              <p className="muted">Expires {formatInviteExpiry(invitation.expiresAt)}.</p>
              <div className={presentation === "dialog" ? "actions dialog-actions" : "actions"}>
                <Button onClick={() => void copyInvitation(invitation.inviteUrl)}>Copy link</Button>
                <Button disabled={busy} variant="secondary" onClick={() => void rotateInvitation()}>
                  {busy ? "Replacing…" : "Replace link"}
                </Button>
              </div>
            </>
          ) : (
            <div className="actions settings-invitation-create">
              <Button disabled={busy} onClick={() => void createInvitation()}>
                {busy ? "Creating…" : "Create invite link"}
              </Button>
            </div>
          );
        }}
      </AsyncState>
      {message ? <p className="notice success">{message}</p> : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Page({
  title,
  eyebrow,
  description,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function DefinitionList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="definition-list">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="empty-state">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

function UnavailablePage({ title }: { title: string }) {
  return (
    <section className="center-card">
      <h1>{title}</h1>
      <p>This capability is not available in the current release.</p>
      <Link to="/agents">Back to Agents</Link>
    </section>
  );
}

function NotFoundPage() {
  return (
    <section className="center-card">
      <h1>Page not found</h1>
      <p>The requested OpenTag page is not available.</p>
      <Link to="/agents">Back to Agents</Link>
    </section>
  );
}

function StandaloneNotFoundPage() {
  return (
    <main className="center-card decorative-page">
      <h1>Page not found</h1>
      <p>The requested OpenTag page is not available.</p>
      <Link to="/agents">Back to Agents</Link>
    </main>
  );
}

function titleCase(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function platformLabel(platform: AgentSummary["computer"]["platform"]): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}

function receiveModeLabel(receiveMode: AgentSummary["receiveMode"]): string {
  return receiveMode === "all_message" ? "Every message" : "Mentions only";
}

function availabilityTone(state: AgentAvailability["state"]): StatusTone {
  if (state === "ready") return "success";
  if (state === "setting_up") return "info";
  if (state === "action_required") return "warning";
  return "neutral";
}

function availabilityStateLabel(state: AgentAvailability["state"]): string {
  const labels = {
    ready: "Ready",
    action_required: "Needs attention",
    setting_up: "Setting up",
    not_connected: "Not connected",
    suspended: "Suspended",
    unconfirmed: "Unable to confirm",
  } satisfies Record<AgentAvailability["state"], string>;
  return labels[state];
}

function sharedConversationLabel(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? "Group chats" : "Channels";
}

function sharedConversationDestination(provider: ImBindingSummary["provider"], plural = false): string {
  if (provider === "feishu") return plural ? "connected Feishu group chats" : "a Feishu group chat";
  return plural ? "connected Slack channels" : "a Slack channel";
}

function agentUseInstruction(agent: AgentDetailView, provider: ImBindingSummary["provider"]): string {
  if (agent.receiveMode === "all_message") {
    return `Send @${agent.name} a direct message. It can also receive every message in ${sharedConversationDestination(provider, true)}.`;
  }
  return `Send @${agent.name} a direct message, or mention it in ${sharedConversationDestination(provider)}.`;
}

function agentAvailabilitySummary(agent: AgentDetailView): string {
  if (agent.availability.state === "ready") {
    const provider = agent.availability.dependencies.channel.provider;
    return provider ? `Available in ${titleCase(provider)}` : "Ready for new work";
  }
  return {
    action_required: "Cannot receive new work",
    setting_up: "Messaging setup in progress",
    not_connected: "Messaging is not connected",
    suspended: "Not receiving new work",
    unconfirmed: "Status temporarily unavailable",
  }[agent.availability.state];
}

function agentAvailabilityRecovery(agent: AgentDetailView): { label: string; to: string } | undefined {
  if (!agent.viewerCapabilities.canManage || agent.availability.state === "ready") return undefined;
  if (agent.availability.reason === "agent_suspended") {
    return { label: "Manage Agent", to: `/agents/${agent.id}/settings/manage` };
  }
  if (
    agent.availability.reason === "im_not_connected" ||
    agent.availability.reason === "im_provisioning" ||
    agent.availability.reason === "im_reauthorization_required" ||
    agent.availability.reason === "im_error"
  ) {
    return { label: "View messaging", to: `/agents/${agent.id}/settings/messaging` };
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return { label: "View messaging", to: `/agents/${agent.id}/settings/messaging` };
  }
  if (agent.availability.state === "unconfirmed") return undefined;
  return { label: "View Computer", to: `/agents/${agent.id}/settings/computer` };
}

function agentRecoveryMessage(agent: AgentDetailView): string {
  const messages: Record<NonNullable<AgentAvailability["reason"]>, string> = {
    agent_suspended: "This Agent is paused and cannot accept new requests.",
    agent_unconfirmed: "OpenTag could not confirm this Agent's current status.",
    computer_offline: "The assigned Computer is offline, so new requests cannot start.",
    runtime_unavailable: "The assigned Computer is not ready to run this Agent.",
    runtime_unconfirmed: "OpenTag could not confirm whether the assigned Computer is ready.",
    im_not_connected: "Connect Feishu or Slack so teammates can assign work to this agent.",
    im_provisioning: "The messaging connection is still being set up.",
    im_reauthorization_required: "The messaging connection needs permission to continue receiving requests.",
    im_error: "The messaging connection needs attention before it can receive requests.",
    handoff_unavailable: "Messages cannot currently be handed off to this Agent.",
    computer_unconfirmed: "OpenTag could not confirm the assigned Computer's connection.",
    handoff_unconfirmed: "OpenTag could not confirm whether messaging is available.",
  };
  return agent.availability.reason ? messages[agent.availability.reason] : agentAvailabilitySummary(agent);
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "OT";
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatRelativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  if (elapsedSeconds < 60) return "just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} ${elapsedMinutes === 1 ? "minute" : "minutes"} ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} ${elapsedDays === 1 ? "day" : "days"} ago`;
}

function formatInviteExpiry(value: string) {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(date);
  return `${day} at ${time}`;
}
