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
  UpdateAgentRuntimeConfig,
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
  useOutletContext,
  useParams,
} from "react-router-dom";
import { ApiError, browserApi } from "./api.js";
import { ComputerSetup } from "./computer-setup.js";
import { CreateTeamForm } from "./create-team-form.js";
import { FeishuSetup } from "./im/feishu-setup.js";

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
      provider: "feishu" | "slack" | null;
      botDisplayName: string | null;
    };
  };
};

type AgentListItem = AgentSummary & { computerState: TeamComputerSummary | undefined };
type AgentDetailView = AgentDetail & { availability: AgentAvailability };

function projectAgentAvailability(
  agent: AgentSummary,
  computer: TeamComputerSummary | undefined,
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
  evidenceConfirmed: boolean,
): AgentAvailability {
  const computerReady = computer?.connectionStatus === "online";
  const handoffState = !evidenceConfirmed
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
  if (!evidenceConfirmed) {
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
    browserApi.computers(teamId).catch(() => ({ computers: [] })),
  ]);
  return {
    agents: agents.map((agent) => ({
      ...agent,
      computerState: computersResult.computers.find((computer) => computer.id === agent.computer.id),
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
      bindingResult.status === "fulfilled" && handoffResult.status === "fulfilled",
    ),
  };
}

function markAgentListUnconfirmed(value: { agents: AgentListItem[] }): { agents: AgentListItem[] } {
  return { agents: value.agents.map((agent) => ({ ...agent, computerState: undefined })) };
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

interface AppShellOutletContext {
  invitationMutationPending: boolean;
  invitationOpen: boolean;
  setInvitationMutationPending: (pending: boolean) => void;
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
      <Route path="/teams/new" element={<NewTeamPage />} />
      <Route element={<AuthenticatedTeamGate />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate replace to="/agents" />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<NewAgentPage />} />
          <Route path="/agents/:agentId" element={<Navigate replace to="general" />} />
          <Route path="/agents/:agentId/:tab" element={<AgentDetailPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/settings" element={<Navigate replace to="account" />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function LoginPage() {
  const providers = useResource(() => browserApi.authProviders(), "auth-providers");
  const next = new URLSearchParams(useLocation().search).get("next") ?? "/agents";
  return (
    <main className="center-card">
      <span className="eyebrow">OpenTag</span>
      <h1>Sign in</h1>
      <p>Choose an available sign-in method. Team permissions are checked by the server on every request.</p>
      <AsyncState state={providers}>
        {(value) => (
          <div className="actions">
            {value.providers
              .filter((provider: AuthProvidersResponse["providers"][number]) => provider.enabled && provider.startUrl)
              .map((provider: AuthProvidersResponse["providers"][number]) => (
                <a className="button" href={`${provider.startUrl}?next=${encodeURIComponent(next)}`} key={provider.id}>
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
            window.localStorage.setItem(SELECTED_TEAM_STORAGE_KEY, serverSelectedTeamId);
            navigate("/agents", { replace: true });
            return;
          }
        }
        const redemption = await browserApi.redeemInvitation(token);
        const me = await browserApi.me();
        if (!me.memberships.some((membership: MeMembership) => membership.teamId === redemption.membership.teamId)) {
          throw new Error("The invited Team is not available to the signed-in account");
        }
        clearPendingInvitation(token);
        window.localStorage.setItem(SELECTED_TEAM_STORAGE_KEY, redemption.membership.teamId);
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
    <main className="center-card">
      <AsyncState state={preview}>
        {(value) => (
          <>
            <span className="eyebrow">Team invitation</span>
            <h1>Join {value.teamDisplayName}</h1>
            <p>
              This invitation grants the {value.role} role and expires {formatDate(value.expiresAt)}.
            </p>
            <button className="button" disabled={joining} type="button" onClick={join}>
              {joining ? "Joining…" : "Join Team"}
            </button>
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
    <main className="center-card">
      <span className="eyebrow">OpenTag</span>
      <h1>Create your team</h1>
      <p>You can invite people and add Agents next.</p>
      <CreateTeamForm
        onCreated={(created) => {
          window.localStorage.setItem(SELECTED_TEAM_STORAGE_KEY, created.id);
          navigate("/agents");
        }}
        onUnauthenticated={() => navigate(`/login?next=${encodeURIComponent("/teams/new")}`)}
      />
    </main>
  );
}

function AuthenticatedTeamGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const [meRevision, setMeRevision] = useState(0);
  const state = useResource(() => browserApi.me(), `me:${meRevision}`);
  if (state.kind === "error" && state.error instanceof ApiError && state.error.status === 401) {
    const requested = location.pathname === "/" ? "/agents" : `${location.pathname}${location.search}`;
    return <Navigate replace to={`/login?next=${encodeURIComponent(requested)}`} />;
  }
  return (
    <AsyncState state={state}>
      {(me) => {
        const stored = readTeamPreference();
        const membership = me.memberships.find((item: MeMembership) => item.teamId === stored) ?? me.memberships[0];
        // Creating or joining a Team is the first onboarding step, so a Team-less session is sent there.
        if (!membership) return <Navigate replace to="/teams/new" />;
        const selectTeam = (teamId: string) => {
          if (!me.memberships.some((item: MeMembership) => item.teamId === teamId)) return;
          window.localStorage.setItem(SELECTED_TEAM_STORAGE_KEY, teamId);
          navigate(location.pathname, { replace: true });
          window.location.reload();
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

function readTeamPreference(): string | undefined {
  const value = window.localStorage.getItem(SELECTED_TEAM_STORAGE_KEY);
  return value && value.length <= 64 ? value : undefined;
}

function AppShell() {
  const { me, membership, selectTeam } = useTeam();
  const navigate = useNavigate();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<"team" | "account">();
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [invitationMutationPending, setInvitationMutationPending] = useState(false);
  const [teamQuery, setTeamQuery] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const teamMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const teamTriggerRef = useRef<HTMLButtonElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const filteredMemberships = me.memberships.filter((item) =>
    item.teamDisplayName.toLocaleLowerCase().includes(teamQuery.trim().toLocaleLowerCase()),
  );
  useEffect(() => {
    if (!openMenu) return;
    const menu = openMenu === "team" ? teamMenuRef.current : accountMenuRef.current;
    const initialFocus =
      openMenu === "team"
        ? (menu?.querySelector<HTMLInputElement>('input[type="search"]') ??
          menu?.querySelector<HTMLElement>('[aria-current="true"]') ??
          menu?.querySelector<HTMLElement>("button, a"))
        : menu?.querySelector<HTMLElement>('[role="menuitem"]');
    initialFocus?.focus();

    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const activeMenu = openMenu === "team" ? teamMenuRef.current : accountMenuRef.current;
      if (!activeMenu?.contains(target)) setOpenMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const trigger = openMenu === "team" ? teamTriggerRef.current : accountTriggerRef.current;
      setOpenMenu(undefined);
      trigger?.focus();
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
          <div className="team-menu" ref={teamMenuRef}>
            <button
              aria-controls="team-menu-popover"
              aria-expanded={openMenu === "team"}
              aria-haspopup="dialog"
              className="team-switcher"
              ref={teamTriggerRef}
              type="button"
              onClick={() => {
                setTeamQuery("");
                setOpenMenu((value) => (value === "team" ? undefined : "team"));
              }}
            >
              <span className="team-avatar" aria-hidden="true">
                {initials(membership.teamDisplayName)}
              </span>
              <span>{membership.teamDisplayName}</span>
              <span className="team-menu-chevron" aria-hidden="true">
                {openMenu === "team" ? "⌃" : "⌄"}
              </span>
            </button>
            {openMenu === "team" ? (
              <section aria-label="Switch Team" className="team-menu-popover" id="team-menu-popover" role="dialog">
                <span className="menu-label">Switch Team</span>
                {me.memberships.length > 6 ? (
                  <label className="team-search">
                    <span className="visually-hidden">Search Teams</span>
                    <input
                      placeholder="Search Teams"
                      type="search"
                      value={teamQuery}
                      onChange={(event) => setTeamQuery(event.currentTarget.value)}
                    />
                  </label>
                ) : null}
                <div className="team-menu-list">
                  {filteredMemberships.map((item: MeMembership) => {
                    const current = item.teamId === membership.teamId;
                    return (
                      <button
                        aria-current={current ? "true" : undefined}
                        className="team-menu-option"
                        key={item.teamId}
                        type="button"
                        onClick={() => {
                          setOpenMenu(undefined);
                          setNavigationOpen(false);
                          if (!current) selectTeam(item.teamId);
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
                            ✓
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                  {filteredMemberships.length === 0 ? <span className="team-menu-empty">No matching Teams</span> : null}
                </div>
                <div className="team-menu-actions">
                  {membership.role === "admin" ? (
                    <button
                      className="team-menu-action"
                      disabled={invitationMutationPending}
                      type="button"
                      onClick={() => {
                        if (invitationMutationPending) return;
                        setOpenMenu(undefined);
                        setNavigationOpen(false);
                        setInvitationOpen(true);
                      }}
                    >
                      <span aria-hidden="true">↗</span>
                      Invite people
                    </button>
                  ) : null}
                  <Link
                    className="team-menu-action"
                    to="/teams/new"
                    onClick={() => {
                      setOpenMenu(undefined);
                      setNavigationOpen(false);
                    }}
                  >
                    <span aria-hidden="true">＋</span>
                    Create Team
                  </Link>
                </div>
              </section>
            ) : null}
          </div>
          <nav aria-label="Workspace" className="primary-nav">
            <NavLink to="/agents" onClick={() => setNavigationOpen(false)}>
              Agents
            </NavLink>
            <span className="nav-placeholder" aria-disabled="true">
              Tasks
            </span>
            <NavLink to="/settings" onClick={() => setNavigationOpen(false)}>
              Settings
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
                ⋮
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
          <button className="secondary compact-button" type="button" onClick={() => setNavigationOpen(true)}>
            Menu
          </button>
        </header>
        <main className="content">
          <Outlet context={{ invitationMutationPending, invitationOpen, setInvitationMutationPending }} />
        </main>
      </div>
      {invitationOpen ? (
        <InvitationDialog
          mutationPending={invitationMutationPending}
          onMutationPendingChange={setInvitationMutationPending}
          returnFocusRef={teamTriggerRef}
          teamDisplayName={membership.teamDisplayName}
          teamId={membership.teamId}
          onClose={() => setInvitationOpen(false)}
        />
      ) : null}
    </div>
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
        description="Shared agents your team can use in Feishu or Slack."
        action={
          membership.role === "admin" ? (
            <button className="button" ref={createTriggerRef} type="button" onClick={() => setCreateOpen(true)}>
              New Agent
            </button>
          ) : undefined
        }
      >
        <AsyncState state={state}>{(value) => <AgentsContent agents={value.agents} />}</AsyncState>
      </Page>
      {createOpen ? <NewAgentDialog returnFocusRef={createTriggerRef} onClose={() => setCreateOpen(false)} /> : null}
    </>
  );
}

function AgentsContent({ agents }: { agents: AgentListItem[] }) {
  return agents.length === 0 ? (
    <EmptyState title="No Agents yet">A Team Admin can create the first Agent.</EmptyState>
  ) : (
    <AgentList agents={agents} />
  );
}

function AgentList({ agents }: { agents: AgentListItem[] }) {
  return (
    <section className="agent-list-section" aria-label="Team Agents">
      <div className="agent-summary-strip">
        <span>
          <strong>{agents.length}</strong> Agents
        </span>
      </div>
      <div className="agent-table">
        <div className="agent-table-header" aria-hidden="true">
          <span>Agent</span>
          <span>Status</span>
          <span>Runtime</span>
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
  const computerStatus = agent.computerState?.connectionStatus;
  const status =
    agent.status === "suspended"
      ? { label: "Suspended", reason: "Agent is suspended", tone: "suspended" }
      : computerStatus === "online"
        ? {
            label: "Computer online",
            reason: lastConfirmedLabel(agent.computerState?.lastSeenAt ?? null),
            tone: "ready",
          }
        : computerStatus === "offline"
          ? {
              label: "Computer offline",
              reason: lastConfirmedLabel(agent.computerState?.lastSeenAt ?? null),
              tone: "action-required",
            }
          : { label: "Unconfirmed", reason: "Unable to confirm Computer", tone: "unconfirmed" };
  return (
    <div className="agent-row">
      <Link aria-label={`Open ${agent.displayName}`} className="agent-row-link" to={`/agents/${agent.id}/general`} />
      <span className="agent-identity">
        <span className="agent-avatar" aria-hidden="true">
          {initials(agent.displayName)}
        </span>
        <span>
          <strong>{agent.displayName}</strong>
          <small>@{agent.name}</small>
        </span>
      </span>
      <span className="cell-stack availability-cell" data-label="Status">
        <strong>
          <i className={`availability-dot ${status.tone}`} aria-hidden="true" />
          {status.label}
        </strong>
        <small>{status.reason}</small>
      </span>
      <span className="cell-stack" data-label="Runtime">
        <strong>{providerLabel(agent.runtimeProvider)}</strong>
        <small>
          {agent.computer.displayName} · {titleCase(agent.computer.platform)}
        </small>
      </span>
      <span className="agent-row-action" aria-hidden="true">
        ›
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
  if (membership.role !== "admin") return <UnavailablePage title="Team Admin access required" />;
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(submitting);
  const onCloseRef = useRef(onClose);
  submittingRef.current = submitting;
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = dialog.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled])",
    );
    if (submitting) {
      if (!activeElement || !dialog.contains(activeElement) || activeElement.matches(":disabled")) {
        (target ?? dialog).focus();
      }
    } else if (activeElement === dialog) {
      target?.focus();
    }
  }, [submitting]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!submittingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!dialogRef.current?.contains(document.activeElement) || document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [returnFocusRef]);

  return (
    <div className="dialog-layer">
      <button
        aria-label="Dismiss new Agent dialog"
        className="dialog-backdrop"
        disabled={submitting}
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        aria-describedby="new-agent-dialog-description"
        aria-labelledby="new-agent-dialog-title"
        aria-modal="true"
        className="dialog-card new-agent-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow dialog-eyebrow">Create</span>
            <h2 id="new-agent-dialog-title">New Agent</h2>
          </div>
          <button
            aria-label="Close new Agent dialog"
            className="dialog-close"
            disabled={submitting}
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p className="dialog-description" id="new-agent-dialog-description">
          Give the Agent an identity and choose where it runs. You can finish its setup from the overview.
        </p>
        <AgentCreationContent
          computers={computers}
          presentation="dialog"
          teamId={membership.teamId}
          onCancel={onClose}
          onCreated={(agentId) => navigate(`/agents/${agentId}/general`)}
          onSubmittingChange={setSubmitting}
        />
      </div>
    </div>
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
    const input = {
      name: String(data.get("name") ?? ""),
      displayName: String(data.get("displayName") ?? ""),
      runtimeProvider: String(data.get("runtimeProvider") ?? "codex") as "codex" | "claude-code",
      computerId: String(data.get("computerId") ?? ""),
    };
    const fingerprint = JSON.stringify(input);
    if (creationIntentRef.current?.fingerprint !== fingerprint) {
      creationIntentRef.current = { fingerprint, id: crypto.randomUUID() };
    }
    inFlightRef.current = true;
    setError(undefined);
    setSubmitting(true);
    onSubmittingChange?.(true);
    try {
      const created = await browserApi.createAgent(teamId, {
        creationIntentId: creationIntentRef.current.id,
        ...input,
      });
      onCreated(created.id);
    } catch (cause) {
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
            Open <Link to="/settings/computers">Computer settings</Link> to generate a connection command.
          </EmptyState>
        ) : (
          <form className="form-card agent-create-form" onSubmit={submit}>
            <div className="agent-create-field">
              <label htmlFor="new-agent-display-name">Display name</label>
              <input
                aria-describedby="new-agent-display-name-hint"
                id="new-agent-display-name"
                ref={firstFieldRef}
                name="displayName"
                placeholder="Research Assistant"
                disabled={submitting}
                required
              />
              <span className="field-hint" id="new-agent-display-name-hint">
                How teammates will see this Agent in lists and conversations.
              </span>
            </div>
            <div className="agent-create-field">
              <label htmlFor="new-agent-name">Agent name</label>
              <span className="agent-name-input">
                <span aria-hidden="true">@</span>
                <input
                  aria-describedby="new-agent-name-hint"
                  id="new-agent-name"
                  name="name"
                  pattern="[a-z0-9][a-z0-9-]*"
                  placeholder="research-assistant"
                  disabled={submitting}
                  required
                />
              </span>
              <span className="field-hint" id="new-agent-name-hint">
                Used for mentions. Lowercase letters, numbers, and hyphens only.
              </span>
            </div>
            <div className="agent-create-grid">
              <div className="agent-create-field">
                <label htmlFor="new-agent-provider">Provider</label>
                <select
                  id="new-agent-provider"
                  name="runtimeProvider"
                  disabled={submitting}
                  value={runtimeProvider}
                  onChange={(event) => setRuntimeProvider(event.currentTarget.value as "codex" | "claude-code")}
                >
                  <option value="codex">Codex</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </div>
              <div className="agent-create-field">
                <label htmlFor="new-agent-computer">Computer</label>
                <select
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
              </div>
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
                <button className="secondary" disabled={submitting} type="button" onClick={onCancel}>
                  Cancel
                </button>
              ) : null}
              <button className="button" disabled={submitting} type="submit">
                {submitting ? "Creating…" : "Create Agent"}
              </button>
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
  { key: "im", label: "IM" },
  { key: "resources", label: "Resources" },
  { key: "integrations", label: "Integrations" },
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
              ← Agents
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
  const { me } = useTeam();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string>();
  async function logout() {
    setLoggingOut(true);
    setError(undefined);
    try {
      await browserApi.logout();
      navigate("/login", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign out");
      setLoggingOut(false);
    }
  }
  return (
    <Page title="Account" description="Review the identity used to access OpenTag.">
      <DefinitionList
        rows={[
          ["Display name", me.user.displayName],
          ["Email", me.user.email],
        ]}
      />
      <div className="account-page-actions">
        <button className="secondary" disabled={loggingOut} type="button" onClick={() => void logout()}>
          {loggingOut ? "Signing out…" : "Sign out"}
        </button>
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </Page>
  );
}

function AgentTab({ agent, tab, onAgentChanged }: { agent: AgentDetailView; tab: string; onAgentChanged: () => void }) {
  if (tab === "general") return <GeneralTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "runtime") return <RuntimeTab agent={agent} />;
  if (tab === "im") return <ImTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "resources")
    return (
      <EmptyState title="No Team Resources assigned">
        The Team Resource model is not enabled in this release.
      </EmptyState>
    );
  if (tab === "integrations")
    return (
      <EmptyState title="No Agent Integrations supported">
        IM bot connections are managed separately on the IM tab.
      </EmptyState>
    );
  if (tab === "access") return <AccessTab agent={agent} />;
  return <NotFoundPage />;
}

function GeneralTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  return (
    <div className="overview-stack">
      <section className="overview-section" aria-labelledby="availability-heading">
        <h3 id="availability-heading">Availability</h3>
        <p className="overview-section-copy">
          These dependencies jointly determine whether {agent.displayName} can receive work.
        </p>
        <div className="dependency-grid">
          <DependencyCard
            title="Computer"
            state={agent.availability.dependencies.computer.state}
            primary={agent.computer.displayName}
            secondary={lastConfirmedLabel(agent.availability.dependencies.computer.lastConfirmedAt)}
          />
          <DependencyCard
            title="Handoff"
            state={agent.availability.dependencies.handoff.state}
            primary={
              agent.availability.dependencies.channel.provider
                ? `${titleCase(agent.availability.dependencies.channel.provider)} · ${providerLabel(agent.runtimeProvider)}`
                : providerLabel(agent.runtimeProvider)
            }
            secondary={handoffDetailLabel(agent.availability.dependencies.handoff.state)}
          />
        </div>
      </section>
      <section className="overview-section" aria-labelledby="identity-access-heading">
        <div className="overview-section-heading">
          <h3 id="identity-access-heading">Identity &amp; access</h3>
          <Link to={`/agents/${agent.id}/access`}>Manage access</Link>
        </div>
        <DefinitionList
          rows={[
            ["Bot identity", agent.availability.dependencies.channel.botDisplayName ?? `@${agent.name}`],
            ["Manager", agent.manager.displayName],
            ["Who can use", "Team members"],
          ]}
        />
      </section>
      {agent.viewerCapabilities.canManage ? <AdminControls agent={agent} onAgentChanged={onAgentChanged} /> : null}
    </div>
  );
}

function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  return (
    <div className={`availability-action ${availabilityTone(agent.availability.state)}`}>
      <span>
        <strong>
          <i className={`availability-dot ${availabilityTone(agent.availability.state)}`} aria-hidden="true" />
          {availabilityStateLabel(agent.availability.state)}
        </strong>
        <small>{availabilityReasonLabel(agent.availability.reason)}</small>
      </span>
    </div>
  );
}

function DependencyCard({
  title,
  state,
  primary,
  secondary,
}: {
  title: string;
  state: AgentAvailability["dependencies"]["handoff"]["state"];
  primary: string;
  secondary: string;
}) {
  return (
    <article className="dependency-card">
      <span>{title}</span>
      <strong>
        <i className={`availability-dot ${availabilityTone(state)}`} aria-hidden="true" />
        {dependencyStateLabel(state)}
      </strong>
      <p>{primary}</p>
      <small>{secondary}</small>
    </article>
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
      <label>
        Display name
        <input defaultValue={config.displayName} key={config.revision} name="displayName" required />
      </label>
      <button className="button commit" type="submit">
        Save General settings
      </button>
      <div className="actions">
        {config.status === "active" ? (
          <button className="secondary" type="button" onClick={() => void changeLifecycle("suspend")}>
            Suspend Agent
          </button>
        ) : (
          <>
            <button className="button" type="button" onClick={() => void changeLifecycle("reactivate")}>
              Reactivate Agent
            </button>
            <button className="danger" type="button" onClick={() => void deleteAgent()}>
              Delete Agent permanently
            </button>
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
            <RuntimeConfigForm initialConfig={config} />
          ) : (
            <p className="muted">Runtime instructions and tuning are visible only to Team Admins.</p>
          )}
        </>
      )}
    </AsyncState>
  );
}

function RuntimeConfigForm({ initialConfig }: { initialConfig: AgentAdminConfig }) {
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const maxDuration = String(data.get("maxDurationMs") ?? "").trim();
    const runtimeConfig: UpdateAgentRuntimeConfig = {
      model: nullableText(data.get("model")),
      reasoningEffort: nullableText(data.get("reasoningEffort")),
      instructions: String(data.get("instructions") ?? ""),
      maxDurationMs: maxDuration ? Number(maxDuration) : null,
    };
    try {
      const updated = await browserApi.updateAgent(config.id, {
        expectedRevision: config.revision,
        runtimeConfig,
      });
      setConfig(updated);
      setMessage("Runtime configuration saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save Runtime configuration");
    }
  }
  return (
    <form className="form-card" key={config.revision} onSubmit={submit}>
      <h2>Admin configuration</h2>
      <label>
        Model
        <input defaultValue={config.runtimeConfig.model ?? ""} name="model" placeholder="Provider default" />
      </label>
      <label>
        Reasoning effort
        <input
          defaultValue={config.runtimeConfig.reasoningEffort ?? ""}
          name="reasoningEffort"
          placeholder="Provider default"
        />
      </label>
      <label>
        Instructions
        <textarea defaultValue={config.runtimeConfig.instructions} name="instructions" rows={10} />
      </label>
      <label>
        Maximum duration (ms)
        <input defaultValue={config.runtimeConfig.maxDurationMs ?? ""} min="1" name="maxDurationMs" type="number" />
      </label>
      <p className="muted">Allowed message tools: {config.runtimeConfig.allowedTools.join(", ") || "None"}</p>
      <button className="button commit" type="submit">
        Save Runtime settings
      </button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

function nullableText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text || null;
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
                        <div className="binding-status-main">
                          <span>
                            <strong>{binding.bot.displayName}</strong>
                            <small>
                              <span>{titleCase(binding.provider)} · </span>
                              <span>{imBindingStateLabel(binding)}</span>
                            </small>
                          </span>
                        </div>
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
                          <button className="button" type="button" onClick={() => void connect("reauthorize")}>
                            Reauthorize Feishu
                          </button>
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
                            <button className="secondary" type="button" onClick={() => void connect("replace")}>
                              Replace with existing or new Feishu Bot
                            </button>
                          ) : null}
                          <button
                            className="danger-text"
                            type="button"
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
                          </button>
                        </div>
                      </section>
                    ) : (
                      <p className="muted">IM setup is managed by Team Admins.</p>
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
                        <button className="button" type="button" onClick={() => void connect()}>
                          Connect existing or new Feishu Bot
                        </button>
                      </div>
                    ) : (
                      <p className="muted">IM setup is managed by Team Admins.</p>
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

function AccessTab({ agent }: { agent: AgentDetailView }) {
  return (
    <DefinitionList
      rows={[
        ["Safe read", "All active Team members"],
        ["Use", "All active Team members (fixed v0.1 policy)"],
        ["Manage", agent.viewerCapabilities.canManage ? "Team Admins (you can manage)" : "Team Admins"],
      ]}
    />
  );
}

const settingsSections = [
  { key: "account", label: "Account" },
  { key: "team", label: "General" },
  { key: "members", label: "Members" },
  { key: "computers", label: "Computers" },
  { key: "resources", label: "Resources" },
  { key: "integrations", label: "Integrations" },
  { key: "access", label: "Access" },
  { key: "usage", label: "Usage" },
  { key: "security", label: "Security" },
] as const;

function SettingsPage() {
  const { section = "team" } = useParams();
  const { invitationOpen, setInvitationMutationPending } = useOutletContext<AppShellOutletContext>();
  const navigate = useNavigate();
  const { me, membership, refreshMe } = useTeam();
  const currentSection = settingsSections.find((item) => item.key === section);
  if (!currentSection) return <NotFoundPage />;
  return (
    <section className="settings-page">
      <header className="settings-title">
        <h1>Settings</h1>
        <p>Manage your account and the current Team's identity, infrastructure, access, and security.</p>
      </header>
      <label className="local-nav-select">
        <span>Settings section</span>
        <select value={section} onChange={(event) => navigate(`/settings/${event.currentTarget.value}`)}>
          {settingsSections.map((item) => (
            <option value={item.key} key={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <div className="settings-layout">
        <nav className="local-nav" aria-label="Settings">
          {settingsSections.map((item) => (
            <NavLink to={`/settings/${item.key}`} key={item.key}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="settings-content">
          <header className="section-header">
            <h2>{currentSection.label}</h2>
            <p>{settingsSectionDescription(currentSection.key)}</p>
          </header>
          {section === "account" ? <AccountSettings refreshMe={refreshMe} user={me.user} /> : null}
          {section === "team" ? <TeamSettings membership={membership} refreshMe={refreshMe} /> : null}
          {section === "members" ? (
            <MembersSettings
              canManage={membership.role === "admin"}
              currentUserId={me.user.id}
              invitationDialogOpen={invitationOpen}
              onInvitationMutationPendingChange={setInvitationMutationPending}
              refreshMe={refreshMe}
              teamId={membership.teamId}
            />
          ) : null}
          {section === "computers" ? (
            <ComputersSettings canManage={membership.role === "admin"} teamId={membership.teamId} />
          ) : null}
          {section === "resources" ? (
            <SettingsUnavailable
              details={[
                "This page does not create or infer Team Resource records.",
                "No Resource assignment projection is exposed by the current API.",
              ]}
              title="Team Resources are not enabled"
            >
              Repositories, skills, tools, and prompts will appear here only after OpenTag has an authoritative Team
              Resource model.
            </SettingsUnavailable>
          ) : null}
          {section === "integrations" ? (
            <SettingsUnavailable
              action={{ label: "Open Agents", to: "/agents" }}
              details={[
                "Supported bot connections remain owned by individual Agents.",
                "Open an Agent's IM tab to review its current Feishu or Slack connection state.",
              ]}
              title="Team Integrations are not enabled"
            >
              OpenTag does not promote Agent credentials into shared Team connections or imply that a provider is
              available Team-wide.
            </SettingsUnavailable>
          ) : null}
          {section === "access" ? <AccessSettings membership={membership} /> : null}
          {section === "usage" ? (
            <SettingsUnavailable
              details={[
                "Task, Turn, and provider totals are not estimated from partial activity.",
                "Cost reporting will require authoritative provider billing metadata.",
              ]}
              title="Usage reporting is not enabled"
            >
              This page will stay intentionally empty until OpenTag can report complete, measured Team activity.
            </SettingsUnavailable>
          ) : null}
          {section === "security" ? (
            <SettingsUnavailable
              details={[
                "Sensitive credentials are never returned to the browser.",
                "Team administration remains limited to active Admin memberships.",
                "Browser sessions and audit events are not available in this version.",
              ]}
              status="Current safeguards"
              title="Security data is intentionally limited"
            >
              OpenTag only reports security state that the server can verify. It does not show inferred checks or an
              unsupported all-clear status.
            </SettingsUnavailable>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SettingsUnavailable({
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
          {action.label} <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </section>
  );
}

function AccessSettings({ membership }: { membership: MeMembership }) {
  return (
    <div className="settings-policy-stack">
      <section className="settings-policy-banner">
        <div>
          <span className="settings-state-label">Server-returned membership</span>
          <h2>Authorization follows your active Team membership</h2>
          <p>OpenTag checks authorization on every request. This page only reports facts exposed by the API.</p>
        </div>
        <span className="settings-role-badge">Your role: {titleCase(membership.role)}</span>
      </section>
      <section className="settings-list-section">
        <header className="settings-subheader">
          <div>
            <h2>Available policy detail</h2>
            <p>The current API does not publish a complete Team capability matrix.</p>
          </div>
        </header>
        <DefinitionList
          rows={[
            ["Selected Team role", titleCase(membership.role)],
            ["Custom roles", "Not enabled"],
            ["Per-resource policies", "Not exposed by the API"],
          ]}
        />
        <p className="settings-footnote">
          Management controls use server-returned capabilities where available; the server remains authoritative for
          every operation.
        </p>
      </section>
    </div>
  );
}

function AccountSettings({ refreshMe, user }: { refreshMe: () => void; user: MeResponse["user"] }) {
  const saveInFlight = useRef(false);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const dirty = displayName !== user.displayName;

  useEffect(() => {
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
          <div className="settings-readonly-value">
            <input aria-label="Email" name="email" readOnly type="email" value={user.email} />
            <small>Read only</small>
          </div>
        </div>
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <strong>Display name</strong>
            <p>This identity is shared across every Team you belong to.</p>
          </div>
          <label>
            Display name
            <input
              autoComplete="name"
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
          </label>
        </div>
      </div>
      {dirty ? (
        <div className="dirty-bar">
          <span>Unsaved changes</span>
          <div className="dirty-actions">
            <button
              className="tertiary"
              disabled={saving}
              type="button"
              onClick={() => {
                setDisplayName(user.displayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              Discard
            </button>
            <button className="button commit" disabled={saving} type="submit">
              {saving ? "Saving…" : "Save account profile"}
            </button>
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

function TeamSettings({ membership, refreshMe }: { membership: MeMembership; refreshMe: () => void }) {
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [teamName, setTeamName] = useState(membership.teamName);
  const [teamDisplayName, setTeamDisplayName] = useState(membership.teamDisplayName);
  const dirty = teamName !== membership.teamName || teamDisplayName !== membership.teamDisplayName;

  useEffect(() => {
    setTeamName(membership.teamName);
    setTeamDisplayName(membership.teamDisplayName);
  }, [membership.teamDisplayName, membership.teamName]);

  if (membership.role !== "admin") {
    return (
      <section className="settings-readonly-panel">
        <div className="settings-readonly-heading">
          <div>
            <h2>Team profile</h2>
            <p>Only Team Admins can change these fields.</p>
          </div>
          <span className="settings-role-badge">Your role: {titleCase(membership.role)}</span>
        </div>
        <DefinitionList
          rows={[
            ["Canonical name", membership.teamName],
            ["Display name", membership.teamDisplayName],
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
        name: teamName,
        displayName: teamDisplayName,
      });
      refreshMe();
      setMessage("Team profile saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the Team profile");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="settings-profile-form" onSubmit={submit}>
      <h2>Team profile</h2>
      <div className="settings-field-list">
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <strong>Canonical name</strong>
            <p>Changing this immediately changes the CLI --team selector. The Team ID stays stable.</p>
          </div>
          <label>
            Canonical name
            <input
              aria-label="Canonical name"
              name="name"
              pattern="[A-Za-z0-9][A-Za-z0-9-]*"
              required
              value={teamName}
              onChange={(event) => {
                setTeamName(event.currentTarget.value);
                setMessage(undefined);
                setError(undefined);
              }}
            />
            <small className="settings-field-hint">
              CLI selector: <code>--team {teamName.toLocaleLowerCase() || "team-name"}</code>
            </small>
          </label>
        </div>
        <div className="settings-field-row">
          <div className="settings-field-copy">
            <strong>Display name</strong>
            <p>The human-readable Team name shown in navigation and invitations.</p>
          </div>
          <label>
            Display name
            <input
              name="displayName"
              required
              value={teamDisplayName}
              onChange={(event) => {
                setTeamDisplayName(event.currentTarget.value);
                setMessage(undefined);
                setError(undefined);
              }}
            />
          </label>
        </div>
      </div>
      {dirty ? (
        <div className="dirty-bar">
          <span>Unsaved changes</span>
          <div className="dirty-actions">
            <button
              className="tertiary"
              disabled={saving}
              type="button"
              onClick={() => {
                setTeamName(membership.teamName);
                setTeamDisplayName(membership.teamDisplayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              Discard
            </button>
            <button className="button commit" disabled={saving} type="submit">
              {saving ? "Saving…" : "Save Team profile"}
            </button>
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
  invitationDialogOpen,
  onInvitationMutationPendingChange,
  refreshMe,
  teamId,
}: {
  canManage: boolean;
  currentUserId: string;
  invitationDialogOpen: boolean;
  onInvitationMutationPendingChange: (pending: boolean) => void;
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
    <>
      {canManage && !invitationDialogOpen ? (
        <InvitationSettings teamId={teamId} onMutationPendingChange={onInvitationMutationPendingChange} />
      ) : null}
      <section className="settings-list-section">
        <AsyncState state={state}>
          {(value) => {
            const adminCount = value.members.filter((member: TeamMemberSummary) => member.role === "admin").length;
            return (
              <>
                <header className="settings-subheader">
                  <div>
                    <h2>Team members</h2>
                    <p>
                      {value.members.length} {value.members.length === 1 ? "member" : "members"} · {adminCount}{" "}
                      {adminCount === 1 ? "admin" : "admins"}
                    </p>
                  </div>
                  {!canManage ? <span className="settings-role-badge">Read only</span> : null}
                </header>
                <table className="settings-member-table" aria-label="Team members">
                  <thead>
                    <tr className="settings-table-header">
                      <th scope="col">Team member</th>
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
      </section>
    </>
  );
}

function InvitationDialog({
  mutationPending,
  onClose,
  onMutationPendingChange,
  returnFocusRef,
  teamDisplayName,
  teamId,
}: {
  mutationPending: boolean;
  onClose: () => void;
  onMutationPendingChange: (pending: boolean) => void;
  returnFocusRef: { current: HTMLButtonElement | null };
  teamDisplayName: string;
  teamId: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mutationPendingRef = useRef(mutationPending);
  const onCloseRef = useRef(onClose);
  mutationPendingRef.current = mutationPending;
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const target = dialog?.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled])",
    );
    if (mutationPending) {
      if (!dialog.contains(document.activeElement)) (target ?? dialog).focus();
    } else if (document.activeElement === dialog) {
      target?.focus();
    }
  }, [mutationPending]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (mutationPendingRef.current) return;
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!dialogRef.current?.contains(document.activeElement) || document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [returnFocusRef]);

  return (
    <div className="dialog-layer">
      <button
        aria-label="Dismiss invitation dialog"
        className="dialog-backdrop"
        disabled={mutationPending}
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        aria-describedby="invitation-dialog-description"
        aria-labelledby="invitation-dialog-title"
        aria-modal="true"
        className="dialog-card invitation-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow dialog-eyebrow">{teamDisplayName}</span>
            <h2 id="invitation-dialog-title">Invite people</h2>
          </div>
          <button
            aria-label="Close invitation dialog"
            className="dialog-close"
            disabled={mutationPending}
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p className="dialog-description" id="invitation-dialog-description">
          Anyone with the active link can join this Team as a member until the link expires.
        </p>
        <InvitationSettings presentation="dialog" teamId={teamId} onMutationPendingChange={onMutationPendingChange} />
      </div>
    </div>
  );
}

function InvitationSettings({
  onMutationPendingChange,
  presentation = "panel",
  teamId,
}: {
  onMutationPendingChange: (pending: boolean) => void;
  presentation?: "dialog" | "panel";
  teamId: string;
}) {
  const state = useResource(() => browserApi.invitation(teamId), teamId);
  const [current, setCurrent] = useState<Awaited<ReturnType<typeof browserApi.invitation>>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  async function createInvitation() {
    await mutateInvitation(() => browserApi.createInvitation(teamId), "Invitation link created.");
  }

  async function rotateInvitation() {
    if (!window.confirm("Rotate this invitation link? The current link will stop working immediately.")) return;
    await mutateInvitation(() => browserApi.rotateInvitation(teamId), "Invitation link rotated.");
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
      setError(cause instanceof Error ? cause.message : "Unable to update the invitation link");
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
      setMessage("Invitation link copied.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to copy the invitation link");
    }
  }

  return (
    <section className={presentation === "dialog" ? "invitation-dialog-content" : "settings-invitation-panel"}>
      {presentation === "panel" ? (
        <>
          <h2>Invite people</h2>
          <p>Anyone with the active link can join this Team as a member until the link expires.</p>
        </>
      ) : null}
      <AsyncState state={state}>
        {(loaded) => {
          const invitation = current ?? loaded;
          return invitation ? (
            <>
              <label className="invite-link">
                Invitation link
                <input aria-label="Invitation link" readOnly type="url" value={invitation.inviteUrl} />
              </label>
              <p className="muted">Expires {formatDate(invitation.expiresAt)}.</p>
              <div className={presentation === "dialog" ? "actions dialog-actions" : "actions"}>
                <button type="button" onClick={() => void copyInvitation(invitation.inviteUrl)}>
                  Copy invitation link
                </button>
                <button className="secondary" disabled={busy} type="button" onClick={() => void rotateInvitation()}>
                  {busy ? "Rotating…" : "Rotate invitation link"}
                </button>
              </div>
            </>
          ) : (
            <button className="button" disabled={busy} type="button" onClick={() => void createInvitation()}>
              {busy ? "Creating…" : "Create invitation link"}
            </button>
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
                <h2>Team computers</h2>
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
                <p>
                  {canManage ? "Use the connection flow above to add one." : "A Team Admin must connect a computer."}
                </p>
              </div>
            ) : (
              <table className="settings-computer-table" aria-label="Team computers">
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
                        <span className="settings-status">
                          <span className={`settings-status-dot ${computer.connectionStatus}`} aria-hidden="true" />
                          {titleCase(computer.connectionStatus)}
                        </span>
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

function OnboardingPage() {
  const { membership } = useTeam();
  return (
    <Page title="Set up OpenTag" description="Connect the runtime path before inviting the Team to mention an Agent.">
      {membership.role === "admin" ? (
        <>
          <ol className="steps">
            <li>Team: {membership.teamDisplayName}</li>
            <li>Connect a Local Computer</li>
            <li>Confirm the provider CLI</li>
            <li>Create an Agent</li>
            <li>Connect IM</li>
          </ol>
          <Link className="button" to="/settings/computers">
            Start with a Computer
          </Link>
        </>
      ) : (
        <EmptyState title="Team Admin setup required">
          You can browse the Team after an Admin completes setup.
        </EmptyState>
      )}
    </Page>
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
    <main className="center-card">
      <h1>{title}</h1>
      <p>This capability is not available in the current release.</p>
      <Link to="/agents">Back to Agents</Link>
    </main>
  );
}

function NotFoundPage() {
  return (
    <main className="center-card">
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

function availabilityTone(state: AgentAvailability["state"]): string {
  if (state === "ready") return "ready";
  if (state === "setting_up") return "setting-up";
  if (state === "suspended") return "suspended";
  if (state === "not_connected") return "not-connected";
  if (state === "unconfirmed") return "unconfirmed";
  return "action-required";
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

function dependencyStateLabel(state: AgentAvailability["dependencies"]["handoff"]["state"]): string {
  const labels = {
    ready: "Ready",
    action_required: "Needs attention",
    setting_up: "Setting up",
    not_connected: "Not connected",
    unconfirmed: "Unable to confirm",
  } satisfies Record<AgentAvailability["dependencies"]["handoff"]["state"], string>;
  return labels[state];
}

function handoffDetailLabel(state: AgentAvailability["dependencies"]["handoff"]["state"]): string {
  const labels = {
    ready: "Ready to receive work",
    action_required: "Handoff needs attention",
    setting_up: "IM setup in progress",
    not_connected: "No IM binding",
    unconfirmed: "Unable to confirm handoff",
  } satisfies Record<AgentAvailability["dependencies"]["handoff"]["state"], string>;
  return labels[state];
}

function availabilityReasonLabel(reason: AgentAvailability["reason"]): string {
  if (!reason) return "All dependencies healthy";
  const labels = {
    agent_suspended: "Agent is suspended",
    agent_unconfirmed: "Unable to refresh Agent status",
    computer_offline: "Computer is offline",
    runtime_unavailable: "Runtime message tools unavailable",
    im_not_connected: "Connect Feishu or Slack",
    im_provisioning: "IM connection is being prepared",
    im_reauthorization_required: "IM permissions need updating",
    im_error: "IM connection needs attention",
    handoff_unavailable: "Handoff needs attention",
    computer_unconfirmed: "Unable to confirm Computer",
    handoff_unconfirmed: "Unable to confirm handoff",
  } satisfies Record<NonNullable<AgentAvailability["reason"]>, string>;
  return labels[reason];
}

function lastConfirmedLabel(value: string | null): string {
  if (!value) return "Not yet confirmed";
  const elapsedSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(elapsedSeconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absoluteSeconds < 60) return `Confirmed ${formatter.format(elapsedSeconds, "second")}`;
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return `Confirmed ${formatter.format(elapsedMinutes, "minute")}`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return `Confirmed ${formatter.format(elapsedHours, "hour")}`;
  return `Confirmed ${formatter.format(Math.round(elapsedHours / 24), "day")}`;
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
    general: "Review identity, readiness dependencies, and the configuration that needs attention.",
    runtime: "Inspect the bound Computer, provider, model, instructions, and execution limits.",
    im: "Manage the Agent-owned Feishu or Slack bot connection and receive policy.",
    resources: "Team Resources are not enabled for Agents in this release.",
    integrations: "Agent Integrations are not enabled; supported bot connections are managed on the IM tab.",
    access: "Understand who can use, inspect, and manage this Agent.",
  } satisfies Record<(typeof agentSections)[number]["key"], string>;
  return descriptions[section];
}

function settingsSectionDescription(section: (typeof settingsSections)[number]["key"]): string {
  const descriptions = {
    account: "Manage the display identity shared across every Team you belong to.",
    team: "Manage the current Team's stable identity and display name.",
    members: "Invite people and review the Team membership visible to you.",
    computers: "Connect and inspect the Computers available to the current Team.",
    resources: "Review reusable repositories, skills, tools, and prompts.",
    integrations: "Review supported Team and Agent connection surfaces.",
    access: "Review Team-wide access and administration boundaries.",
    usage: "Review measured Task, Turn, and provider usage when available.",
    security: "Review authorization health without exposing credentials.",
  } satisfies Record<(typeof settingsSections)[number]["key"], string>;
  return descriptions[section];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
