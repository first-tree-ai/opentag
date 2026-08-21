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
import { AgentNameSchema, MembershipRoleSchema } from "@opentag/shared/browser";
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
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, browserApi } from "./api.js";
import { ComputerSetup } from "./computer-setup.js";
import { CreateTeamForm } from "./create-team-form.js";
import { IntegrationsPage } from "./features/integrations-page.js";
import { SkillsPage } from "./features/skills-page.js";
import { UsagePage } from "./features/usage-page.js";
import { FeishuSetup } from "./im/feishu-setup.js";
import { OnboardingPage } from "./onboarding/page.js";
import { RuntimeConfigurationForm } from "./runtime-configuration.js";
import { Button, buttonClassName, Dialog, Field, Icon, StatusIndicator, type StatusTone } from "./ui/design-system.js";

type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };

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

type AgentListItem = AgentSummary & { evidenceConfirmed: boolean };
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
  const { agents } = await browserApi.agents(teamId);
  return { agents: agents.map((agent) => ({ ...agent, evidenceConfirmed: true })) };
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
  return { agents: value.agents.map((agent) => ({ ...agent, evidenceConfirmed: false })) };
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
        <Route path="/onboarding" element={<OnboardingRoute />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate replace to="/agents" />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<NewAgentPage />} />
          <Route path="/agents/:agentId" element={<Navigate replace to="general" />} />
          <Route path="/agents/:agentId/:tab" element={<AgentDetailPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/resources" element={<Navigate replace to="/skills" />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/settings" element={<Navigate replace to="/members" />} />
          <Route path="/settings/account" element={<Navigate replace to="/account" />} />
          <Route path="/settings/team" element={<Navigate replace to="/account#workspace-management" />} />
          <Route path="/settings/members" element={<Navigate replace to="/members" />} />
          <Route path="/settings/access" element={<Navigate replace to="/members" />} />
          <Route path="/settings/security" element={<Navigate replace to="/members" />} />
          <Route path="/settings/computers" element={<Navigate replace to="/agents#agent-runtime" />} />
          <Route path="/settings/resources" element={<Navigate replace to="/skills" />} />
          <Route path="/settings/integrations" element={<Navigate replace to="/integrations" />} />
          <Route path="/settings/usage" element={<Navigate replace to="/usage" />} />
          <Route path="/settings/:section" element={<Navigate replace to="/members" />} />
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
    <main className="center-card decorative-page">
      <span className="eyebrow">OpenTag</span>
      <h1>Sign in</h1>
      <p>Choose an available sign-in method. Permissions are checked by the server on every request.</p>
      <AsyncState state={providers}>
        {(value) => (
          <div className="actions">
            {value.providers
              .filter((provider: AuthProvidersResponse["providers"][number]) => provider.enabled && provider.startUrl)
              .map((provider: AuthProvidersResponse["providers"][number]) => (
                <a
                  className={buttonClassName()}
                  href={`${provider.startUrl}?next=${encodeURIComponent(next)}`}
                  key={provider.id}
                >
                  Continue with {provider.id === "google" ? "Google" : provider.id}
                </a>
              ))}
          </div>
        )}
      </AsyncState>
    </main>
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
  const { me, membership } = useTeam();
  return <OnboardingPage membership={membership} user={me.user} />;
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
                {me.memberships.length > 1 ? (
                  <fieldset className="account-workspace-group">
                    <legend className="menu-label">Switch Workspace</legend>
                    {me.memberships.map((item: MeMembership) => {
                      const current = item.teamId === membership.teamId;
                      return (
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
                        </button>
                      );
                    })}
                    <Link
                      className="account-workspace-manage"
                      role="menuitem"
                      to="/account#workspace-management"
                      onClick={() => {
                        setOpenMenu(undefined);
                        setNavigationOpen(false);
                      }}
                    >
                      <span>Manage Workspaces</span>
                      <Icon name="chevron-right" />
                    </Link>
                  </fieldset>
                ) : null}
                <div className="account-menu-actions">
                  <Link
                    role="menuitem"
                    to="/account"
                    onClick={() => {
                      setOpenMenu(undefined);
                      setNavigationOpen(false);
                    }}
                  >
                    Account settings
                  </Link>
                  <button disabled={loggingOut} role="menuitem" type="button" onClick={() => void logout()}>
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
      <Page
        title="Agents"
        description="Shared AI teammates configured for your team."
        action={
          membership.role === "admin" ? (
            <Button ref={createTriggerRef} onClick={() => setCreateOpen(true)}>
              New Agent
            </Button>
          ) : undefined
        }
      >
        <AsyncState state={state}>{(value) => <AgentsContent agents={value.agents} />}</AsyncState>
        <section className="agent-runtime-section" id="agent-runtime">
          <header className="settings-subheader">
            <div>
              <span className="eyebrow">Infrastructure</span>
              <h2>Agent runtime</h2>
              <p>Connect and inspect the computers available to run Agents.</p>
            </div>
          </header>
          <ComputersSettings canManage={membership.role === "admin"} teamId={membership.teamId} />
        </section>
      </Page>
      {createOpen ? <NewAgentDialog returnFocusRef={createTriggerRef} onClose={() => setCreateOpen(false)} /> : null}
    </>
  );
}

function AgentsContent({ agents }: { agents: AgentListItem[] }) {
  return agents.length === 0 ? (
    <EmptyState title="No Agents yet">An Admin can create the first Agent.</EmptyState>
  ) : (
    <AgentList agents={agents} />
  );
}

function AgentList({ agents }: { agents: AgentListItem[] }) {
  return (
    <section className="agent-list-section" aria-label="Agents">
      <div className="agent-summary-strip">
        <span>
          <strong>{agents.length}</strong> Agents
        </span>
      </div>
      <div className="agent-table">
        <div className="agent-table-header" aria-hidden="true">
          <span>Agent</span>
          <span>State</span>
          <span />
        </div>
        <div className="agent-table-body">
          {agents.map((agent) => (
            <AgentRow agent={agent} key={agent.id} />
          ))}
        </div>
      </div>
    </section>
  );
}

function AgentRow({ agent }: { agent: AgentListItem }) {
  const status =
    agent.status === "suspended"
      ? { label: "Suspended", reason: "Not receiving new work", tone: "neutral" as const }
      : agent.evidenceConfirmed
        ? { label: "Active", reason: undefined, tone: "success" as const }
        : { label: "Unconfirmed", reason: "Unable to refresh Agent", tone: "neutral" as const };
  return (
    <div className="agent-row">
      <Link aria-label={`Open ${agent.displayName}`} className="agent-row-link" to={`/agents/${agent.id}/general`} />
      <span className="agent-identity">
        <span className="agent-avatar" aria-hidden="true">
          {initials(agent.displayName)}
        </span>
        <span>
          <strong>{agent.displayName}</strong>
          <small>
            @{agent.name} · {providerLabel(agent.runtimeProvider)}
          </small>
        </span>
      </span>
      <span className="cell-stack availability-cell" data-label="State">
        <StatusIndicator detail={status.reason} label={status.label} tone={status.tone} />
      </span>
      <span className="agent-row-action" aria-hidden="true">
        <Icon name="chevron-right" />
      </span>
    </div>
  );
}

function useOwnComputersResource(teamId: string) {
  return useResource(() => browserApi.ownComputers(), teamId, {
    onBackgroundError: markOwnComputersUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
}

function NewAgentPage() {
  const { membership } = useTeam();
  const navigate = useNavigate();
  const computers = useOwnComputersResource(membership.teamId);
  if (membership.role !== "admin") return <UnavailablePage title="Admin access required" />;
  return (
    <Page title="Create Agent" description="Create the identity first. Complete its setup from the Agent overview.">
      <AgentCreationContent
        computers={computers}
        teamId={membership.teamId}
        onCreated={(agentId) => navigate(`/agents/${agentId}/general`)}
      />
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
  const computers = useOwnComputersResource(membership.teamId);
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog
      busy={submitting}
      className="new-agent-dialog"
      closeLabel="Close new Agent dialog"
      description="Give the Agent an identity and choose where it runs. You can finish its setup from the overview."
      eyebrow="Create"
      returnFocusRef={returnFocusRef}
      title="New Agent"
      onClose={onClose}
    >
      <AgentCreationContent
        computers={computers}
        presentation="dialog"
        teamId={membership.teamId}
        onCancel={onClose}
        onCreated={(agentId) => navigate(`/agents/${agentId}/general`)}
        onSubmittingChange={setSubmitting}
      />
    </Dialog>
  );
}

function AgentCreationContent({
  computers,
  onCancel,
  onCreated,
  onSubmittingChange,
  presentation = "page",
  teamId,
}: {
  computers: LoadState<{ computers: Computer[] }>;
  onCancel?: () => void;
  onCreated: (agentId: string) => void;
  onSubmittingChange?: (submitting: boolean) => void;
  presentation?: "dialog" | "page";
  teamId: string;
}) {
  const [error, setError] = useState<string>();
  const [nameError, setNameError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [computerId, setComputerId] = useState("");
  const [runtimeProvider, setRuntimeProvider] = useState<"codex" | "claude-code">("codex");
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const creationIntentRef = useRef<{ fingerprint: string; id: string } | null>(null);

  useEffect(() => {
    if (presentation === "dialog" && computers.kind === "ready") firstFieldRef.current?.focus();
  }, [computers.kind, presentation]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) return;
    const data = new FormData(event.currentTarget);
    setError(undefined);
    setNameError(undefined);
    const name = AgentNameSchema.safeParse(String(data.get("name") ?? ""));
    if (!name.success) {
      setNameError(name.error.issues[0]?.message ?? "Agent name is invalid");
      return;
    }
    const input = {
      name: name.data,
      displayName: String(data.get("displayName") ?? ""),
      runtimeProvider: String(data.get("runtimeProvider") ?? "codex") as "codex" | "claude-code",
      computerId: String(data.get("computerId") ?? ""),
    };
    const fingerprint = JSON.stringify(input);
    if (creationIntentRef.current?.fingerprint !== fingerprint) {
      creationIntentRef.current = { fingerprint, id: crypto.randomUUID() };
    }
    inFlightRef.current = true;
    setSubmitting(true);
    onSubmittingChange?.(true);
    try {
      const created = await browserApi.createAgent(teamId, {
        creationIntentId: creationIntentRef.current.id,
        ...input,
      });
      onCreated(created.id);
    } catch (cause) {
      if (cause instanceof ApiError) {
        const issue = cause.issues?.find(({ path }) => path[0] === "name");
        if (issue) {
          setNameError(issue.message);
          return;
        }
      }
      setError(cause instanceof Error ? cause.message : "Agent creation failed");
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  return (
    <AsyncState state={computers}>
      {(value) => {
        const computer = value.computers.find((candidate) => candidate.id === computerId) ?? value.computers[0];
        const selectedComputerId = computer?.id ?? "";
        const readiness = computer?.providerReadiness?.find((entry) => entry.provider === runtimeProvider);
        return value.computers.length === 0 ? (
          <EmptyState title="Connect a Local Computer first">
            Open the{" "}
            <Link to="/agents#agent-runtime" onClick={onCancel}>
              Agent runtime
            </Link>{" "}
            section to generate a connection command.
          </EmptyState>
        ) : (
          <form className="form-card agent-create-form" onSubmit={submit}>
            <Field
              className="agent-create-field"
              hint="How teammates will see this Agent in lists and conversations."
              hintId="new-agent-display-name-hint"
              htmlFor="new-agent-display-name"
              label="Display name"
            >
              <input
                aria-describedby="new-agent-display-name-hint"
                className="ds-control"
                id="new-agent-display-name"
                ref={firstFieldRef}
                name="displayName"
                placeholder="Research Assistant"
                disabled={submitting}
                required
              />
            </Field>
            <Field
              className="agent-create-field"
              error={nameError}
              errorId="agent-name-error"
              hint="Used for mentions. Lowercase letters, numbers, and hyphens only."
              hintId="new-agent-name-hint"
              htmlFor="new-agent-name"
              label="Agent name"
            >
              <span className="agent-name-input">
                <span aria-hidden="true">@</span>
                <input
                  aria-describedby={nameError ? "new-agent-name-hint agent-name-error" : "new-agent-name-hint"}
                  aria-invalid={nameError ? true : undefined}
                  id="new-agent-name"
                  name="name"
                  onChange={() => setNameError(undefined)}
                  placeholder="research-assistant"
                  disabled={submitting}
                  required
                />
              </span>
            </Field>
            <div className="agent-create-grid">
              <Field className="agent-create-field" htmlFor="new-agent-provider" label="Provider">
                <select
                  className="ds-control"
                  id="new-agent-provider"
                  name="runtimeProvider"
                  disabled={submitting}
                  value={runtimeProvider}
                  onChange={(event) => setRuntimeProvider(event.currentTarget.value as "codex" | "claude-code")}
                >
                  <option value="codex">Codex</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </Field>
              <Field className="agent-create-field" htmlFor="new-agent-computer" label="Computer">
                <select
                  className="ds-control"
                  id="new-agent-computer"
                  name="computerId"
                  disabled={submitting}
                  required
                  value={selectedComputerId}
                  onChange={(event) => setComputerId(event.currentTarget.value)}
                >
                  {value.computers.map((computer: Computer) => (
                    <option value={computer.id} key={computer.id}>
                      {computer.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div
              className={`notice ${readiness?.status === "ready" && computer?.connectionStatus === "online" ? "" : "warning"}`}
              role="status"
            >
              {providerReadinessMessage(computer, runtimeProvider, readiness?.status)}
            </div>
            <p className="agent-create-note">New Agents receive only direct mentions by default.</p>
            {error ? (
              <div className="notice error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="agent-create-actions">
              {presentation === "dialog" ? (
                <Button disabled={submitting} variant="secondary" onClick={onCancel}>
                  Cancel
                </Button>
              ) : null}
              <Button disabled={submitting} type="submit">
                {submitting ? "Creating…" : "Create Agent"}
              </Button>
            </div>
          </form>
        );
      }}
    </AsyncState>
  );
}

function markOwnComputersUnconfirmed(value: { computers: Computer[] }): { computers: Computer[] } {
  return {
    computers: value.computers.map(({ providerReadiness: _providerReadiness, ...computer }) => computer),
  };
}

function providerReadinessMessage(
  computer: Computer | undefined,
  provider: "codex" | "claude-code",
  status: "checking" | "install" | "sign-in" | "ready" | "unavailable" | undefined,
): string {
  const label = providerLabel(provider);
  if (computer?.connectionStatus === "offline") {
    return `${computer.displayName} is offline. You can still create this Agent; ${label} Turns will fail without starting and can be retried when this Computer reconnects. No other Provider will be substituted.`;
  }
  if (status === "ready") return `${label} is ready on ${computer?.displayName ?? "this Computer"}.`;
  const action =
    status === "checking"
      ? "readiness is still being checked"
      : status === "install"
        ? "must be installed"
        : status === "sign-in"
          ? "requires sign-in"
          : status === "unavailable"
            ? "is currently unavailable"
            : "readiness has not been reported by this Computer";
  return `${label} ${action}. You can still create this Agent; its Turns will fail without starting and can be retried after readiness is restored. No other Provider will be substituted.`;
}

const agentSections = [
  { key: "general", label: "Overview" },
  { key: "runtime", label: "Runtime" },
  { key: "im", label: "Messaging" },
  { key: "access", label: "Access" },
] as const;

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
            <nav className="local-nav" aria-label="Agent settings">
              {agentSections.map((section) => (
                <NavLink to={`/agents/${agentId}/${section.key}`} key={section.key}>
                  {section.label}
                </NavLink>
              ))}
            </nav>
            <div className="object-content">
              <header className="section-header">
                <h2>{currentSection.label}</h2>
                <p>{agentSectionDescription(currentSection.key)}</p>
              </header>
              <AgentTab agent={agent} tab={tab} onAgentChanged={() => setRefreshVersion((value) => value + 1)} />
            </div>
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AccountPage() {
  const { me, membership, refreshMe } = useTeam();
  const location = useLocation();
  return (
    <Page title="Account" description="Manage your profile and advanced account options.">
      <div className="account-settings-stack">
        <AccountSettings refreshMe={refreshMe} user={me.user} />
        <details
          className="account-advanced"
          id="workspace-management"
          open={location.hash === "#workspace-management"}
        >
          <summary>Advanced</summary>
          <div className="account-advanced-content">
            <header className="settings-subheader">
              <div>
                <h2>Workspace management</h2>
                <p>For people who operate more than one organization.</p>
              </div>
            </header>
            <TeamProfileSettings membership={membership} refreshMe={refreshMe} />
            <div className="account-workspace-create">
              <div>
                <strong>Additional Workspace</strong>
                <p>Create another isolated organization for a separate client or team.</p>
              </div>
              <Link className={buttonClassName({ variant: "secondary" })} to="/workspaces/new">
                Create another Workspace
              </Link>
            </div>
          </div>
        </details>
      </div>
    </Page>
  );
}

function AgentTab({ agent, tab, onAgentChanged }: { agent: AgentDetailView; tab: string; onAgentChanged: () => void }) {
  if (tab === "general") return <GeneralTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "runtime") return <RuntimeTab agent={agent} />;
  if (tab === "im") return <ImTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "access") return <AccessTab agent={agent} />;
  return <NotFoundPage />;
}

function GeneralTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const channel = agent.availability.dependencies.channel;
  const channelLabel = channel.provider ? titleCase(channel.provider) : undefined;
  const botDisplayName = channel.botDisplayName ?? agent.displayName;
  return (
    <div className="overview-stack">
      <section className="overview-section" aria-labelledby="use-agent-heading">
        <div className="overview-section-heading">
          <h3 id="use-agent-heading">Use this Agent</h3>
          <Link to={`/agents/${agent.id}/im`}>
            {agent.viewerCapabilities.canManage ? "Manage messaging" : "View messaging"}
          </Link>
        </div>
        {channel.state === "connected" && channelLabel ? (
          <div className="agent-use-panel">
            <div className="agent-use-copy">
              <span className="agent-use-channel">{channelLabel}</span>
              <h4>Message @{agent.name}</h4>
              <p>{agentUseInstruction(agent, channelLabel)}</p>
            </div>
            <div className="agent-use-identity">
              <span>{botDisplayName}</span>
              <small>{receiveModeLabel(agent.receiveMode)}</small>
            </div>
          </div>
        ) : channel.state === "not_connected" ? (
          <div className="agent-use-panel empty">
            <div className="agent-use-copy">
              <span className="agent-use-channel">Messaging</span>
              <h4>Connect Feishu or Slack</h4>
              <p>This Agent needs a messaging identity before teammates can send it work.</p>
            </div>
          </div>
        ) : (
          <div className="agent-use-panel empty">
            <div className="agent-use-copy">
              <span className="agent-use-channel">Messaging</span>
              <h4>Messaging status unavailable</h4>
              <p>The messaging identity could not be confirmed. Try again in a moment.</p>
            </div>
          </div>
        )}
      </section>
      <section className="overview-section" aria-labelledby="identity-access-heading">
        <div className="overview-section-heading">
          <h3 id="identity-access-heading">Identity &amp; access</h3>
          <Link to={`/agents/${agent.id}/access`}>Manage access</Link>
        </div>
        <DefinitionList
          rows={[
            ["Manager", agent.manager.displayName],
            ["Who can use", "Members"],
          ]}
        />
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
        {open ? "Close Agent settings" : "Edit Agent settings"}
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
      <Button variant="commit" type="submit">
        Save General settings
      </Button>
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

function RuntimeTab({ agent }: { agent: AgentDetailView }) {
  const state = useResource(
    () => (agent.viewerCapabilities.canManage ? browserApi.agentConfig(agent.id) : Promise.resolve(undefined)),
    `${agent.id}:${agent.viewerCapabilities.canManage}`,
  );
  return (
    <AsyncState state={state}>
      {(config) => (
        <>
          <DefinitionList
            rows={[
              ["Provider", agent.runtimeProvider],
              ["Computer", agent.computer.displayName],
            ]}
          />
          {config ? (
            <RuntimeConfigurationForm
              initialConfig={config}
              save={(input) => browserApi.updateAgent(config.id, input)}
            />
          ) : (
            <p className="muted">Runtime instructions and tuning are visible only to Admins.</p>
          )}
        </>
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
      {(setup) => {
        const connect = async (intent: "create" | "reauthorize" | "replace" = "create") => {
          setError(undefined);
          if (await setup.start(intent)) setReauthorizationNeeded(false);
        };
        return (
          <AsyncState state={state}>
            {(binding) => (
              <div className="im-stack">
                {binding ? (
                  <>
                    <section className="im-section" aria-labelledby="bot-connection-heading">
                      <div className="im-section-heading">
                        <h3 id="bot-connection-heading">Bot connection</h3>
                        <p>{agent.displayName} receives messages through this dedicated identity.</p>
                      </div>
                      <div className="binding-status">
                        <StatusIndicator
                          detail={
                            <>
                              <span>{titleCase(binding.provider)} · </span>
                              <span>{imBindingStateLabel(binding)}</span>
                            </>
                          }
                          label={binding.bot.displayName}
                          tone={imBindingTone(binding)}
                        />
                        <small>
                          {binding.lastConfirmedAt
                            ? `Confirmed ${formatDate(binding.lastConfirmedAt)}`
                            : "Unable to confirm"}
                        </small>
                      </div>
                      {(binding.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
                      binding.provider === "feishu" &&
                      agent.viewerCapabilities.canManage ? (
                        <div className="im-actions">
                          <Button onClick={() => void connect("reauthorize")}>Reauthorize Feishu</Button>
                        </div>
                      ) : null}
                      {(binding.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
                      binding.provider === "slack" ? (
                        <span className="notice">Slack reauthorization is not available in this release.</span>
                      ) : null}
                    </section>
                    <section className="im-section" aria-labelledby="message-policy-heading">
                      <div className="im-section-heading">
                        <h3 id="message-policy-heading">Message policy</h3>
                        <p>Choose which channel messages can start Agent work.</p>
                      </div>
                      <div className="message-policy">
                        <div className="message-policy-copy">
                          <strong>Receive mode</strong>
                          <p>Mentions only is the safer default and reduces unnecessary context.</p>
                        </div>
                        {agent.viewerCapabilities.canManage ? (
                          <div className="segmented-control">
                            {binding.receiveMode === "mention_only" ? (
                              <>
                                <span className="active">Mentions only</span>
                                <button type="button" onClick={() => void changeReceiveMode("all_message")}>
                                  Enable all messages
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" onClick={() => void changeReceiveMode("mention_only")}>
                                  Use mentions only
                                </button>
                                <span className="active">All messages</span>
                              </>
                            )}
                          </div>
                        ) : (
                          <strong>{receiveModeLabel(binding.receiveMode)}</strong>
                        )}
                      </div>
                    </section>
                    {agent.viewerCapabilities.canManage ? (
                      <section className="im-section" aria-labelledby="connection-actions-heading">
                        <div className="im-section-heading">
                          <h3 id="connection-actions-heading">Connection actions</h3>
                          <p>Changes here can temporarily stop new IM work.</p>
                        </div>
                        <div className="im-actions">
                          {binding.provider === "feishu" ? (
                            <Button variant="secondary" onClick={() => void connect("replace")}>
                              Replace with existing or new Feishu Bot
                            </Button>
                          ) : null}
                          <Button
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
                      </section>
                    ) : (
                      <p className="muted">IM setup is managed by Admins.</p>
                    )}
                  </>
                ) : (
                  <section className="im-section" aria-labelledby="bot-connection-heading">
                    <div className="im-section-heading">
                      <h3 id="bot-connection-heading">Bot connection</h3>
                      <p>Connect a supported IM bot when the Agent is ready.</p>
                    </div>
                    <EmptyState title="No IM binding">
                      This Agent does not have a Feishu or Slack identity yet.
                    </EmptyState>
                    {agent.viewerCapabilities.canManage ? (
                      <div className="im-actions">
                        <Button onClick={() => void connect()}>Connect existing or new Feishu Bot</Button>
                      </div>
                    ) : (
                      <p className="muted">IM setup is managed by Admins.</p>
                    )}
                  </section>
                )}
                {setup.feedback}
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
    </FeishuSetup>
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

function AccessTab({ agent }: { agent: AgentDetailView }) {
  return (
    <DefinitionList
      rows={[
        ["Safe read", "All active members"],
        ["Use", "All active members (fixed v0.1 policy)"],
        ["Manage", agent.viewerCapabilities.canManage ? "Admins (you can manage)" : "Admins"],
      ]}
    />
  );
}

function MembersPage() {
  const { me, membership, refreshMe } = useTeam();
  function focusInvitationPanel() {
    const panel = document.getElementById("member-invitations");
    panel?.scrollIntoView({ block: "nearest" });
    panel?.focus({ preventScroll: true });
  }
  return (
    <Page
      title="Members"
      description="Manage members, invitations, and roles."
      action={membership.role === "admin" ? <Button onClick={focusInvitationPanel}>Invite members</Button> : null}
    >
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
      <div className="settings-field-list">
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <strong>Email</strong>
            <p>Your sign-in email cannot be changed here.</p>
          </div>
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
        </div>
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <strong>Display name</strong>
            <p>This identity is used throughout OpenTag.</p>
          </div>
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
        </div>
      </div>
      {dirty ? (
        <div className="dirty-bar">
          <span>Unsaved changes</span>
          <div className="dirty-actions">
            <Button
              disabled={saving}
              variant="tertiary"
              onClick={() => {
                setDisplayName(user.displayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit" variant="commit">
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
      <section className="settings-readonly-panel">
        <div className="settings-readonly-heading">
          <div>
            <h2>Workspace profile</h2>
            <p>Only Workspace Admins can change these fields.</p>
          </div>
          <span className="settings-role-badge">Your role: {titleCase(membership.role)}</span>
        </div>
        <DefinitionList
          rows={[
            ["Workspace name", membership.teamDisplayName],
            ["CLI identifier", membership.teamName],
          ]}
        />
      </section>
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
    <form className="settings-profile-form" onSubmit={submit}>
      <h2 className="visually-hidden">Workspace profile fields</h2>
      <div className="settings-field-list">
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <strong>Workspace name</strong>
            <p>What people see in navigation and invitations.</p>
          </div>
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
        </div>
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <strong>CLI identifier</strong>
            <p>Created automatically for CLI commands. It stays the same when you rename the Workspace.</p>
          </div>
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
        </div>
      </div>
      {dirty ? (
        <div className="dirty-bar">
          <span>Unsaved changes</span>
          <div className="dirty-actions">
            <Button
              disabled={saving}
              variant="tertiary"
              onClick={() => {
                setTeamDisplayName(membership.teamDisplayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit" variant="commit">
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
          return (
            <>
              <header className="settings-subheader">
                <div>
                  <h2>Members</h2>
                  <p>
                    {value.members.length} {value.members.length === 1 ? "member" : "members"} · {adminCount}{" "}
                    {adminCount === 1 ? "admin" : "admins"}
                  </p>
                </div>
                {!canManage ? <span className="settings-role-badge">Read only</span> : null}
              </header>
              <table className="settings-member-table" aria-label="Members">
                <thead>
                  <tr className="settings-table-header">
                    <th scope="col">Member</th>
                    <th scope="col">Role</th>
                  </tr>
                </thead>
                <tbody>
                  {value.members.map((member: TeamMemberSummary) => (
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
                            className="ds-control"
                            disabled={pendingUserIds.has(member.userId)}
                            value={member.role}
                            onChange={(event) => void changeRole(member, event.currentTarget.value)}
                          >
                            {MembershipRoleSchema.options.map((role) => (
                              <option value={role} key={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="settings-value-badge">{member.role}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
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
      id={presentation === "panel" ? "member-invitations" : undefined}
      tabIndex={presentation === "panel" ? -1 : undefined}
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
            <Button disabled={busy} onClick={() => void createInvitation()}>
              {busy ? "Creating…" : "Create invite link"}
            </Button>
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

function ComputersSettings({ canManage, teamId }: { canManage: boolean; teamId: string }) {
  const [reload, setReload] = useState(0);
  const state = useResource(() => browserApi.computers(teamId), `${teamId}:${reload}`);
  return (
    <>
      {canManage ? <ComputerSetup teamId={teamId} onConnected={() => setReload((current) => current + 1)} /> : null}
      <AsyncState state={state}>
        {(value) => (
          <section className="settings-list-section">
            <header className="settings-subheader">
              <div>
                <h2>Computers</h2>
                <p>
                  {value.computers.length} {value.computers.length === 1 ? "computer" : "computers"} ·{" "}
                  {
                    value.computers.filter((computer: TeamComputerSummary) => computer.connectionStatus === "online")
                      .length
                  }{" "}
                  online
                </p>
              </div>
              {!canManage ? <span className="settings-role-badge">Read only</span> : null}
            </header>
            {value.computers.length === 0 ? (
              <div className="settings-compact-empty">
                <strong>No computers connected</strong>
                <p>{canManage ? "Use the connection flow above to add one." : "An Admin must connect a computer."}</p>
              </div>
            ) : (
              <table className="settings-computer-table" aria-label="Computers">
                <thead>
                  <tr className="settings-table-header">
                    <th scope="col">Computer</th>
                    <th scope="col">Owner &amp; system</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">Agents</th>
                  </tr>
                </thead>
                <tbody>
                  {value.computers.map((computer: TeamComputerSummary) => (
                    <tr className="settings-computer-row" key={computer.id}>
                      <th className="settings-computer-identity" scope="row">
                        <span className="settings-computer-icon" aria-hidden="true" />
                        <strong>{computer.displayName}</strong>
                      </th>
                      <td data-label="Owner & system">
                        <strong>{computer.ownerDisplayName}</strong>
                        <small>
                          {computer.platform === "darwin"
                            ? "macOS"
                            : computer.platform === "win32"
                              ? "Windows"
                              : "Linux"}
                        </small>
                      </td>
                      <td data-label="Status">
                        <StatusIndicator
                          label={titleCase(computer.connectionStatus)}
                          tone={computer.connectionStatus === "online" ? "success" : "neutral"}
                        />
                      </td>
                      <td data-label="Last seen">{formatDate(computer.lastSeenAt)}</td>
                      <td data-label="Agents">{computer.agentIds.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </AsyncState>
    </>
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
    general: "See how teammates use this Agent and who can access it.",
    runtime: "Inspect the bound Computer, provider, model, instructions, and execution limits.",
    im: "Manage the Agent's Feishu or Slack bot and message policy.",
    access: "Understand who can use, inspect, and manage this Agent.",
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
