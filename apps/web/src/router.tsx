import type {
  AgentAdminConfig,
  AgentDetail,
  AgentSummary,
  AuthProvidersResponse,
  Computer,
  ImBindingHandoffStatus,
  ImBindingSummary,
  MeMembership,
  MeResponse,
  TeamComputerSummary,
  TeamMemberSummary,
} from "@opentag/shared/browser";
import { MembershipRoleSchema } from "@opentag/shared/browser";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
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
import { AgentIntegrationsTab, AgentSkillsTab } from "./agent-detail-capabilities.js";
import { ApiError, browserApi } from "./api.js";
// Google-provided, pre-approved button asset: https://developers.google.com/identity/branding-guidelines
import googleSignInButton from "./assets/google-sign-in-light@2x.png";
import { CreateTeamForm } from "./create-team-form.js";
import { IntegrationsPage } from "./features/integrations-page.js";
import { SkillsPage } from "./features/skills-page.js";
import { UsagePage } from "./features/usage-page.js";
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
  SettingsList,
  SettingsRow,
  StatusIndicator,
  type StatusTone,
  Tabs,
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

type AgentListItem = AgentSummary & {
  evidenceConfirmed: boolean;
  computerConnectionStatus: TeamComputerSummary["connectionStatus"] | null;
  computerEvidenceConfirmed: boolean;
};
type AgentDetailView = AgentDetail & { availability: AgentAvailability };

function projectAgentAvailability(
  agent: AgentSummary,
  computer: TeamComputerSummary | undefined,
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
  bindingEvidenceConfirmed: boolean,
  handoffEvidenceConfirmed: boolean,
): AgentAvailability {
  const computerReady = computer?.connectionStatus === "online";
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
  if (agent.runtimeProvider !== "codex") {
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
  return {
    agents: agents.map((agent) => ({
      ...agent,
      evidenceConfirmed: true,
      computerConnectionStatus:
        computers.find((computer) => computer.id === agent.computer.id)?.connectionStatus ?? null,
      computerEvidenceConfirmed: computersResult.kind === "ready",
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
      evidenceConfirmed: false,
      computerConnectionStatus: null,
      computerEvidenceConfirmed: false,
    })),
  };
}

function markAgentDetailUnconfirmed(agent: AgentDetailView): AgentDetailView {
  return {
    ...agent,
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
    onBackgroundError?: (value: T, error: Error) => T;
    revalidateMs?: number;
    refreshOnFocus?: boolean;
  } = {},
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
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
    load(true);
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
  }, [key, options.refreshOnFocus, options.revalidateMs]);
  return state;
}

function isTerminalResourceError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

function AsyncState<T>({ state, children }: { state: LoadState<T>; children: (value: T) => ReactNode }) {
  if (state.kind === "loading")
    return (
      <div aria-label="Loading current server state" className="loading-state" role="status">
        <span />
        <span />
        <span />
      </div>
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
            <Route path="/agents/:agentId" element={<Navigate replace to="general" />} />
            <Route path="/agents/:agentId/access" element={<LegacyAgentAccessRedirect />} />
            <Route path="/agents/:agentId/:tab" element={<AgentDetailPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/resources" element={<Navigate replace to="/skills" />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/members" element={<MembersPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/workspace" element={<WorkspacePage />} />
            <Route path="/account/workspace" element={<Navigate replace to="/workspace" />} />
            <Route path="/settings" element={<Navigate replace to="/members" />} />
            <Route path="/settings/account" element={<Navigate replace to="/account" />} />
            <Route path="/settings/team" element={<Navigate replace to="/workspace" />} />
            <Route path="/settings/members" element={<Navigate replace to="/members" />} />
            <Route path="/settings/access" element={<Navigate replace to="/members" />} />
            <Route path="/settings/security" element={<Navigate replace to="/members" />} />
            <Route path="/settings/computers" element={<Navigate replace to="/agents/new" />} />
            <Route path="/settings/resources" element={<Navigate replace to="/skills" />} />
            <Route path="/settings/integrations" element={<Navigate replace to="/integrations" />} />
            <Route path="/settings/usage" element={<Navigate replace to="/usage" />} />
            <Route path="/settings/:section" element={<Navigate replace to="/members" />} />
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
            <NavLink to="/usage" onClick={() => setNavigationOpen(false)}>
              <WorkspaceNavIcon name="usage" />
              Usage
            </NavLink>
            <NavLink to="/members" onClick={() => setNavigationOpen(false)}>
              <WorkspaceNavIcon name="members" />
              Members
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

function WorkspaceNavIcon({ name }: { name: "agents" | "integrations" | "members" | "skills" | "tasks" | "usage" }) {
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
      {name === "usage" ? (
        <>
          <path d="M5 19V9M12 19V5M19 19v-7" />
          <path d="M3.5 19.5h17" />
        </>
      ) : null}
      {name === "members" ? (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19" />
          <circle cx="17" cy="10" r="2" />
          <path d="M16 14.5h1.5a3 3 0 0 1 3 3V19" />
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
      <Page title="Agents" description="Shared AI teammates configured for your team.">
        {!membership.setupCompletedAt && membership.role !== "admin" ? (
          <div className="notice" role="status">
            Team setup is not complete. An administrator needs to prepare the first Agent.
          </div>
        ) : null}
        <AsyncState state={state}>
          {(value) => (
            <AgentsContent
              agents={value.agents}
              canCreate={membership.role === "admin"}
              createTriggerRef={createTriggerRef}
              onCreate={() => setCreateOpen(true)}
            />
          )}
        </AsyncState>
      </Page>
      {createOpen ? <NewAgentDialog returnFocusRef={createTriggerRef} onClose={() => setCreateOpen(false)} /> : null}
    </>
  );
}

function AgentsContent({
  agents,
  canCreate,
  createTriggerRef,
  onCreate,
}: {
  agents: AgentListItem[];
  canCreate: boolean;
  createTriggerRef: RefObject<HTMLButtonElement | null>;
  onCreate: () => void;
}) {
  return agents.length === 0 && !canCreate ? (
    <EmptyState title="No Agents yet">An Admin can create the first Agent.</EmptyState>
  ) : (
    <AgentList agents={agents} canCreate={canCreate} createTriggerRef={createTriggerRef} onCreate={onCreate} />
  );
}

function AgentList({
  agents,
  canCreate,
  createTriggerRef,
  onCreate,
}: {
  agents: AgentListItem[];
  canCreate: boolean;
  createTriggerRef: RefObject<HTMLButtonElement | null>;
  onCreate: () => void;
}) {
  return (
    <section className="agent-list-section" aria-label="Agents">
      <div className="agent-card-grid">
        {canCreate ? <NewAgentCard onClick={onCreate} triggerRef={createTriggerRef} /> : null}
        {agents.map((agent) => (
          <AgentCard agent={agent} key={agent.id} />
        ))}
      </div>
    </section>
  );
}

function NewAgentCard({
  onClick,
  triggerRef,
}: {
  onClick: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button aria-label="New Agent" className="agent-create-card" onClick={onClick} ref={triggerRef} type="button">
      <span className="agent-create-card-icon" aria-hidden="true">
        <Icon name="plus" />
      </span>
      <strong>New Agent</strong>
      <small>Create a shared AI teammate.</small>
    </button>
  );
}

function AgentCard({ agent }: { agent: AgentListItem }) {
  const status =
    agent.status === "suspended"
      ? { label: "Suspended", reason: "Not receiving new work", tone: "neutral" as const }
      : !agent.evidenceConfirmed
        ? { label: "Unconfirmed", reason: "Unable to refresh Agent", tone: "neutral" as const }
        : !agent.computerEvidenceConfirmed || agent.computerConnectionStatus === null
          ? { label: "Unconfirmed", reason: "Unable to confirm runtime", tone: "neutral" as const }
          : agent.computerConnectionStatus === "online"
            ? { label: "Active", reason: "Computer online", tone: "success" as const }
            : { label: "Action required", reason: "Computer offline", tone: "warning" as const };
  return (
    <Link aria-label={`Open ${agent.displayName}`} className="agent-card" to={`/agents/${agent.id}/general`}>
      <article>
        <header className="agent-card-header">
          <span className="agent-identity">
            <span className="agent-avatar" aria-hidden="true">
              {initials(agent.displayName)}
            </span>
            <span>
              <strong>{agent.displayName}</strong>
              <small>@{agent.name}</small>
            </span>
          </span>
          <StatusIndicator detail={status.reason} label={status.label} tone={status.tone} />
        </header>
        <dl className="agent-card-facts">
          <div>
            <dt>Runtime</dt>
            <dd>{providerLabel(agent.runtimeProvider)}</dd>
          </div>
          <div>
            <dt>Computer</dt>
            <dd>
              {agent.computer.displayName} · {platformLabel(agent.computer.platform)}
            </dd>
          </div>
          <div>
            <dt>Manager</dt>
            <dd>{agent.manager.displayName}</dd>
          </div>
          <div>
            <dt>Messaging</dt>
            <dd>{receiveModeLabel(agent.receiveMode)}</dd>
          </div>
        </dl>
        <span className="agent-card-action" aria-hidden="true">
          View Agent <Icon name="chevron-right" />
        </span>
      </article>
    </Link>
  );
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
        <NewAgentMessagingStep agent={created} onFinish={() => navigate(`/agents/${created.id}/general`)} />
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
    if (created) navigate(`/agents/${created.id}/general`);
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

const agentSections = [
  { key: "general", label: "Overview" },
  { key: "runtime", label: "Runtime" },
  { key: "im", label: "Messaging" },
  { key: "integrations", label: "Integrations" },
  { key: "skills", label: "Skills" },
] as const;

// Integrations and Skills deliberately have independent routes. Their components
// own the preview/no-contract boundary until authoritative Agent assignments land.

function LegacyAgentAccessRedirect() {
  const { agentId = "" } = useParams();
  return <Navigate replace to={`/agents/${agentId}/general#permissions`} />;
}

function AgentDetailAnchor() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
  }, [hash]);
  return null;
}

function AgentDetailPage() {
  const { agentId = "", tab = "general" } = useParams();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const navigate = useNavigate();
  const state = useResource(() => loadAgentDetail(agentId), `${agentId}:${refreshVersion}`, {
    onBackgroundError: markAgentDetailUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  const currentSection = agentSections.find((section) => section.key === tab);
  if (!currentSection) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="object-page">
          <header className="object-header">
            <Link className="breadcrumb" to="/agents">
              <Icon name="arrow-left" />
              Agents
            </Link>
            <div className="object-title-row">
              <div className="object-identity">
                <span className="agent-avatar large" aria-hidden="true">
                  {initials(agent.displayName)}
                </span>
                <div>
                  <h1>{agent.displayName}</h1>
                  <p>
                    <span>@{agent.name}</span>
                    <span>Managed by {agent.manager.displayName}</span>
                  </p>
                </div>
              </div>
              <AgentAvailabilityAction agent={agent} />
            </div>
          </header>
          <label className="local-nav-select">
            <span>Agent section</span>
            <select value={tab} onChange={(event) => navigate(`/agents/${agentId}/${event.currentTarget.value}`)}>
              {agentSections.map((section) => (
                <option value={section.key} key={section.key}>
                  {section.label}
                </option>
              ))}
            </select>
          </label>
          <div className="object-layout">
            <Tabs collapseOnMobile label="Agent settings">
              {agentSections.map((section) => (
                <NavLink to={`/agents/${agentId}/${section.key}`} key={section.key}>
                  {section.label}
                </NavLink>
              ))}
            </Tabs>
            <div className="object-content">
              <header className="section-header">
                <h2>{currentSection.label}</h2>
                <p>{agentSectionDescription(currentSection.key)}</p>
              </header>
              <AgentTab agent={agent} tab={tab} onAgentChanged={() => setRefreshVersion((value) => value + 1)} />
              <AgentDetailAnchor />
            </div>
          </div>
        </section>
      )}
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
  const { membership, refreshMe } = useTeam();
  return (
    <Page
      action={
        <Link className={buttonClassName({ variant: "secondary" })} to="/workspaces/new">
          Create Workspace
        </Link>
      }
      title="Workspace"
      description="Manage the current Workspace and create additional Workspaces."
    >
      <WorkspaceSettings membership={membership} refreshMe={refreshMe} />
    </Page>
  );
}

function WorkspaceSettings({ membership, refreshMe }: { membership: MeMembership; refreshMe: () => void }) {
  return (
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
  );
}

function AgentTab({ agent, tab, onAgentChanged }: { agent: AgentDetailView; tab: string; onAgentChanged: () => void }) {
  if (tab === "general") return <GeneralTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "runtime") return <RuntimeTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "im") return <ImTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "integrations") return <AgentIntegrationsTab />;
  if (tab === "skills") return <AgentSkillsTab />;
  return <NotFoundPage />;
}

function GeneralTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  return (
    <div className="overview-stack">
      <section className="overview-section" aria-labelledby="agent-profile-heading">
        <div className="overview-section-heading">
          <div>
            <h3 id="agent-profile-heading">Agent profile</h3>
            <p>The stable identity teammates see when they work with this Agent.</p>
          </div>
        </div>
        <DefinitionList
          rows={[
            ["Agent name", `@${agent.name}`],
            ["Manager", agent.manager.displayName],
            ["Lifecycle", agent.status === "active" ? "Active" : "Suspended"],
            ["Created", formatDate(agent.createdAt)],
          ]}
        />
      </section>
      <section
        className="overview-section"
        id="permissions"
        aria-labelledby="workspace-permissions-heading"
        tabIndex={-1}
      >
        <div className="overview-section-heading">
          <div>
            <h3 id="workspace-permissions-heading">Workspace permissions</h3>
            <p>Agent permissions currently follow Workspace membership and role.</p>
          </div>
        </div>
        <SettingsList className="agent-permissions-list">
          <SettingsRow description="Send messages to this Agent and view its safe details." label="Use">
            <strong>All active Workspace members</strong>
          </SettingsRow>
          <SettingsRow description="Change settings, connections, and lifecycle." label="Manage">
            <strong>Workspace admins</strong>
          </SettingsRow>
        </SettingsList>
      </section>
      {agent.viewerCapabilities.canManage ? <AdminControls agent={agent} onAgentChanged={onAgentChanged} /> : null}
    </div>
  );
}

function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  const recovery = agentAvailabilityRecovery(agent);
  const tone = availabilityTone(agent.availability.state);
  return (
    <div className={`availability-action ${tone}`}>
      <StatusIndicator
        detail={agentAvailabilitySummary(agent)}
        label={availabilityStateLabel(agent.availability.state)}
        tone={tone}
      />
      {recovery ? <Link to={recovery.to}>{recovery.label}</Link> : null}
    </div>
  );
}

function AdminControls({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="admin-controls" id="admin-controls">
      <button
        aria-expanded={open}
        className="admin-controls-trigger"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close Agent administration" : "Open Agent administration"}
      </button>
      {open ? <GeneralAdminForm agent={agent} onAgentChanged={onAgentChanged} /> : null}
    </div>
  );
}

function GeneralAdminForm({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const configState = useResource(() => browserApi.agentConfig(agent.id), agent.id);
  return (
    <AsyncState state={configState}>
      {(config) => <GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />}
    </AsyncState>
  );
}

function GeneralConfigForm({
  initialConfig,
  onAgentChanged,
}: {
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const navigate = useNavigate();
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "");
    try {
      setConfig(await browserApi.updateAgent(config.id, { expectedRevision: config.revision, displayName }));
      setMessage("General settings saved.");
      onAgentChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save General settings");
    }
  }
  async function changeLifecycle(action: "suspend" | "reactivate") {
    try {
      setConfig(
        action === "suspend" ? await browserApi.suspendAgent(config.id) : await browserApi.reactivateAgent(config.id),
      );
      setMessage(action === "suspend" ? "Agent suspended." : "Agent reactivated.");
      onAgentChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to change Agent lifecycle");
    }
  }
  async function deleteAgent() {
    if (
      !window.confirm(
        `Permanently delete ${config.displayName}? This will end its active Sessions and clear its IM credential and runtime configuration. Session and message history will be retained, but the Agent cannot be restored.`,
      )
    )
      return;
    try {
      await browserApi.deleteAgent(config.id);
      navigate("/agents");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to delete Agent");
    }
  }
  return (
    <form className="form-card" onSubmit={submit}>
      <h2>Admin configuration</h2>
      <Field htmlFor="agent-display-name" label="Display name">
        <input
          className="ds-control"
          defaultValue={config.displayName}
          id="agent-display-name"
          key={config.revision}
          name="displayName"
          required
        />
      </Field>
      <Button type="submit">Save General settings</Button>
      <div className="actions">
        {config.status === "active" ? (
          <Button variant="secondary" onClick={() => void changeLifecycle("suspend")}>
            Suspend Agent
          </Button>
        ) : (
          <>
            <Button onClick={() => void changeLifecycle("reactivate")}>Reactivate Agent</Button>
            <Button variant="danger" onClick={() => void deleteAgent()}>
              Delete Agent permanently
            </Button>
          </>
        )}
      </div>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

function RuntimeTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const state = useResource(
    () => (agent.viewerCapabilities.canManage ? browserApi.agentConfig(agent.id) : Promise.resolve(undefined)),
    `${agent.id}:${agent.viewerCapabilities.canManage}`,
  );
  const computerState = agent.availability.dependencies.computer;
  const computerStatus =
    computerState.state === "ready"
      ? "Online"
      : computerState.state === "action_required"
        ? "Offline"
        : "Unable to confirm";
  const computerTone: StatusTone =
    computerState.state === "ready" ? "success" : computerState.state === "action_required" ? "warning" : "neutral";
  return (
    <AsyncState state={state}>
      {(config) => (
        <div className="agent-runtime-stack">
          <section aria-labelledby="computer-heading" className="agent-runtime-section agent-runtime-computer">
            <header className="agent-runtime-section__header">
              <div>
                <h3 id="computer-heading">Computer</h3>
                <p>The Computer assigned to run this Agent.</p>
              </div>
              <StatusIndicator label={computerStatus} tone={computerTone} />
            </header>
            <div className="agent-runtime-computer__body">
              <div>
                <strong>
                  {agent.computer.displayName} · {platformLabel(agent.computer.platform)}
                </strong>
              </div>
              {computerState.state !== "ready" ? (
                <div className="agent-runtime-recovery">
                  {computerState.lastConfirmedAt ? <p>Last seen {formatDate(computerState.lastConfirmedAt)}</p> : null}
                  <p>
                    {computerState.state === "action_required"
                      ? "New Turns can start after this Computer reconnects."
                      : "OpenTag could not confirm this Computer's current connection."}
                  </p>
                  <Button size="compact" variant="outline" onClick={onAgentChanged}>
                    Check again
                  </Button>
                </div>
              ) : null}
            </div>
          </section>
          {config ? (
            <RuntimeConfigurationForm
              initialConfig={config}
              save={(input) => browserApi.updateAgent(config.id, input)}
            />
          ) : (
            <div className="agent-runtime-settings">
              <section aria-labelledby="runtime-heading" className="agent-runtime-section">
                <header className="agent-runtime-section__header">
                  <div>
                    <h3 id="runtime-heading">Runtime</h3>
                    <p>Choose how this Agent runs.</p>
                  </div>
                </header>
                <dl className="agent-runtime-facts">
                  <div>
                    <dt>Provider</dt>
                    <dd>{providerLabel(agent.runtimeProvider)}</dd>
                  </div>
                </dl>
                <p className="agent-runtime-note">Model and reasoning settings are visible only to Admins.</p>
              </section>
              <section aria-labelledby="agent-instructions-heading" className="agent-runtime-section">
                <header className="agent-runtime-section__header">
                  <div>
                    <h3 id="agent-instructions-heading">Agent instructions</h3>
                    <p>Set the guidance applied to every Turn this Agent runs.</p>
                  </div>
                </header>
                <p className="agent-runtime-note">Agent instructions are visible only to Admins.</p>
              </section>
            </div>
          )}
        </div>
      )}
    </AsyncState>
  );
}

function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string>();
  const [reauthorizationNeeded, setReauthorizationNeeded] = useState(false);
  const state = useResource(() => browserApi.imBinding(agent.id), `${agent.id}:${reload}`);
  async function changeReceiveMode(receiveMode: "mention_only" | "all_message") {
    if (
      receiveMode === "all_message" &&
      !window.confirm(
        "All-message mode may expose more conversation content and increase token usage and cost. Continue?",
      )
    )
      return;
    try {
      const config = await browserApi.agentConfig(agent.id);
      await browserApi.updateAgent(agent.id, { expectedRevision: config.revision, receiveMode });
      setReload((value) => value + 1);
      onAgentChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "IM_BINDING_SCOPE_REAUTH_REQUIRED") {
        setReauthorizationNeeded(true);
      }
      setError(cause instanceof Error ? cause.message : "Unable to change receive mode");
    }
  }
  return (
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
                            <p>Where teammates can reach this Agent and whether the connection is available.</p>
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
                                ? `Confirmed ${formatDate(binding.lastConfirmedAt)}`
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
                              <dd>{agentUseInstruction(agent, titleCase(binding.provider))}</dd>
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
                                <Button size="compact" variant="outline" onClick={() => void connectFeishu("replace")}>
                                  Replace Feishu Bot
                                </Button>
                              ) : null}
                              {binding.provider === "slack" && binding.bindingState !== "provisioning" ? (
                                <Button size="compact" variant="outline" onClick={() => void connectSlack("replace")}>
                                  Replace Slack App
                                </Button>
                              ) : null}
                              <Button
                                size="compact"
                                variant="danger"
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      "Disable this IM binding? New IM work will stop until another binding is connected.",
                                    )
                                  )
                                    return;
                                  void browserApi.disableImBinding(binding.id).then(
                                    () => {
                                      setReload((value) => value + 1);
                                      onAgentChanged();
                                    },
                                    (cause: unknown) =>
                                      setError(cause instanceof Error ? cause.message : "Unable to disable IM binding"),
                                  );
                                }}
                              >
                                Disable IM binding
                              </Button>
                            </div>
                          ) : (
                            <p className="muted">Workspace admins manage this contact channel.</p>
                          )}
                        </section>
                        <section className="im-section" aria-labelledby="trigger-rules-heading">
                          <div className="im-section-heading">
                            <h3 id="trigger-rules-heading">Trigger rules</h3>
                            <p>Which incoming messages can start Agent work.</p>
                          </div>
                          <SettingsList className="agent-message-rules">
                            <SettingsRow description="A direct message can always start work." label="Direct messages">
                              <strong>Always</strong>
                            </SettingsRow>
                            <SettingsRow
                              description={
                                binding.receiveMode === "mention_only"
                                  ? `Teammates must mention @${agent.name}.`
                                  : "Every new conversation message can start work."
                              }
                              label={`${titleCase(binding.provider)} conversations`}
                            >
                              {agent.viewerCapabilities.canManage ? (
                                <fieldset aria-label="Conversation trigger rule" className="segmented-control">
                                  {binding.receiveMode === "mention_only" ? (
                                    <>
                                      <span className="active">Mentions only</span>
                                      <button type="button" onClick={() => void changeReceiveMode("all_message")}>
                                        All messages
                                      </button>
                                    </>
                                  ) : (
                                    <>
                                      <button type="button" onClick={() => void changeReceiveMode("mention_only")}>
                                        Mentions only
                                      </button>
                                      <span className="active">All messages</span>
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
                          <p>Where teammates can reach this Agent.</p>
                        </div>
                        <EmptyState title="No messaging channel">
                          Teammates cannot contact this Agent until a supported bot is connected.
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
  if (handoffState === "ready") return "Available";
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

function MembersPage() {
  const { me, membership, refreshMe } = useTeam();
  return (
    <Page title="Members" description="Manage members, invitations, and roles.">
      <MembersSettings
        canManage={membership.role === "admin"}
        currentUserId={me.user.id}
        refreshMe={refreshMe}
        teamId={membership.teamId}
      />
    </Page>
  );
}

function TasksPage() {
  return (
    <Page title="Tasks" description="Track work assigned to Agents.">
      <CapabilityUnavailable
        details={[
          "The current server does not expose a Tasks API.",
          "No sample, inferred, or locally generated Task records are shown.",
        ]}
        status="Coming later"
        title="Tasks are not available yet"
      >
        Tasks will appear here after OpenTag can load authoritative Task records from the server.
      </CapabilityUnavailable>
    </Page>
  );
}

function CapabilityUnavailable({
  action,
  children,
  details,
  status = "Not enabled",
  title,
}: {
  action?: { label: string; to: string };
  children: ReactNode;
  details: readonly string[];
  status?: string;
  title: string;
}) {
  return (
    <section className="settings-unavailable">
      <span className="settings-state-label">{status}</span>
      <h2>{title}</h2>
      <p>{children}</p>
      <ul>
        {details.map((detail) => (
          <li key={detail}>{detail}</li>
        ))}
      </ul>
      {action ? (
        <Link className="settings-state-action" to={action.to}>
          {action.label} <Icon name="arrow-right" />
        </Link>
      ) : null}
    </section>
  );
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

function providerLabel(provider: AgentSummary["runtimeProvider"]): string {
  return provider === "claude-code" ? "Claude Code" : "Codex";
}

function platformLabel(platform: AgentSummary["computer"]["platform"]): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}

function receiveModeLabel(receiveMode: AgentSummary["receiveMode"]): string {
  return receiveMode === "all_message" ? "All messages" : "Mentions only";
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
    action_required: "Action required",
    setting_up: "Setting up",
    not_connected: "Not connected",
    suspended: "Suspended",
    unconfirmed: "Unable to confirm",
  } satisfies Record<AgentAvailability["state"], string>;
  return labels[state];
}

function agentUseInstruction(agent: AgentDetailView, channelLabel: string): string {
  if (agent.receiveMode === "all_message") {
    return `Send a direct message to @${agent.name}. In connected ${channelLabel} conversations, it can also receive messages without a mention.`;
  }
  return `Send a direct message, or mention @${agent.name} in a ${channelLabel} conversation.`;
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
    return { label: "Manage", to: `/agents/${agent.id}/general#admin-controls` };
  }
  if (
    agent.availability.reason === "im_not_connected" ||
    agent.availability.reason === "im_provisioning" ||
    agent.availability.reason === "im_reauthorization_required" ||
    agent.availability.reason === "im_error"
  ) {
    return { label: "Review messaging", to: `/agents/${agent.id}/im` };
  }
  if (agent.availability.reason === "handoff_unavailable") return undefined;
  if (agent.availability.state === "unconfirmed") return undefined;
  return { label: "Review runtime", to: `/agents/${agent.id}/runtime` };
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "OT";
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function agentSectionDescription(section: (typeof agentSections)[number]["key"]): string {
  const descriptions = {
    general: "Review this Agent's identity, ownership, and Workspace permissions.",
    runtime: "Review this Agent's Computer, runtime, and instructions.",
    im: "See where teammates can contact this Agent and which messages trigger work.",
    integrations: "Review the external services and data available to this Agent.",
    skills: "Review the reusable skills assigned to this Agent.",
  } satisfies Record<(typeof agentSections)[number]["key"], string>;
  return descriptions[section];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatInviteExpiry(value: string) {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(date);
  return `${day} at ${time}`;
}
