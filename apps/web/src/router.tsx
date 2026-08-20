import type {
  AgentAdminConfig,
  AgentDetail,
  AgentSummary,
  AuthProvidersResponse,
  Computer,
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
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, browserApi } from "./api.js";
import { ComputerSetup } from "./computer-setup.js";
import { CreateTeamForm } from "./create-team-form.js";
import { FeishuSetup } from "./im/feishu-setup.js";

type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };

function useResource<T>(loader: () => Promise<T>, key: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const loaderRef = useRef(loader);
  const keyRef = useRef(key);
  loaderRef.current = loader;
  keyRef.current = key;
  useEffect(() => {
    let active = true;
    const activeKey = key;
    setState({ kind: "loading" });
    void loaderRef.current().then(
      (value) => active && keyRef.current === activeKey && setState({ kind: "ready", value }),
      (error: unknown) =>
        active &&
        keyRef.current === activeKey &&
        setState({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      active = false;
    };
  }, [key]);
  return state;
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
                <small>{me.user.email}</small>
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
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function AgentsPage() {
  const { membership } = useTeam();
  const state = useResource(() => browserApi.agents(membership.teamId), membership.teamId);
  return (
    <Page
      title="Agents"
      description="Configure and monitor your team's long-lived Agent identities."
      action={
        membership.role === "admin" ? (
          <Link className="button" to="/agents/new">
            Create Agent
          </Link>
        ) : undefined
      }
    >
      <AsyncState state={state}>{(value) => <AgentsContent agents={value.agents} />}</AsyncState>
    </Page>
  );
}

function AgentsContent({ agents }: { agents: AgentSummary[] }) {
  return agents.length === 0 ? (
    <EmptyState title="No Agents yet">A Team Admin can create the first Agent.</EmptyState>
  ) : (
    <AgentList agents={agents} />
  );
}

function AgentList({ agents }: { agents: AgentSummary[] }) {
  return (
    <section className="agent-list-section" aria-labelledby="agent-list-title">
      <div className="list-heading">
        <h2 id="agent-list-title">Team Agents</h2>
        <span>{agents.length}</span>
      </div>
      <div className="agent-table">
        <div className="agent-table-header" aria-hidden="true">
          <span>Agent</span>
          <span>Runtime</span>
          <span>IM</span>
          <span>Computer</span>
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

function AgentRow({ agent }: { agent: AgentSummary }) {
  return (
    <Link className="agent-row" to={`/agents/${agent.id}/general`}>
      <span className="agent-identity">
        <span className="agent-avatar" aria-hidden="true">
          {initials(agent.displayName)}
        </span>
        <span>
          <strong>{agent.displayName}</strong>
          <small>{agent.name}</small>
          <span className={`status-chip ${agent.status}`}>{titleCase(agent.status)}</span>
        </span>
      </span>
      <span className="cell-stack" data-label="Runtime">
        <strong>{providerLabel(agent.runtimeProvider)}</strong>
        <small>Provider</small>
      </span>
      <span className="cell-stack" data-label="IM">
        <strong>{receiveModeLabel(agent.receiveMode)}</strong>
        <small>Receive mode</small>
      </span>
      <span className="cell-stack" data-label="Computer">
        <strong>{agent.computer.displayName}</strong>
        <small>{titleCase(agent.computer.platform)}</small>
      </span>
    </Link>
  );
}

function NewAgentPage() {
  const { membership } = useTeam();
  const navigate = useNavigate();
  const computers = useResource(() => browserApi.ownComputers(), membership.teamId);
  const [error, setError] = useState<string>();
  if (membership.role !== "admin") return <UnavailablePage title="Team Admin access required" />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const created = await browserApi.createAgent(membership.teamId, {
        name: String(data.get("name") ?? ""),
        displayName: String(data.get("displayName") ?? ""),
        runtimeProvider: String(data.get("runtimeProvider") ?? "codex") as "codex" | "claude-code",
        computerId: String(data.get("computerId") ?? ""),
      });
      navigate(`/agents/${created.id}/general`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent creation failed");
    }
  }
  return (
    <Page title="Create Agent" description="Create the identity first. Complete its setup from the Agent overview.">
      <AsyncState state={computers}>
        {(value) =>
          value.computers.length === 0 ? (
            <EmptyState title="Connect a Local Computer first">
              Open <Link to="/settings/computers">Computer settings</Link> to generate a connection command.
            </EmptyState>
          ) : (
            <form className="form-card" onSubmit={submit}>
              <label>
                Name
                <input name="name" required pattern="[a-z0-9][a-z0-9-]*" />
              </label>
              <label>
                Display name
                <input name="displayName" required />
              </label>
              <label>
                Provider
                <select name="runtimeProvider">
                  <option value="codex">Codex</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </label>
              <label>
                Computer
                <select name="computerId" required>
                  {value.computers.map((computer: Computer) => (
                    <option value={computer.id} key={computer.id}>
                      {computer.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">New Agents receive only direct mentions by default.</p>
              <button className="button" type="submit">
                Create Agent
              </button>
              {error ? (
                <div className="notice error" role="alert">
                  {error}
                </div>
              ) : null}
            </form>
          )
        }
      </AsyncState>
    </Page>
  );
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
  const state = useResource(() => browserApi.agent(agentId), `${agentId}:${refreshVersion}`);
  const currentSection = agentSections.find((section) => section.key === tab);
  if (!currentSection) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="object-page">
          <header className="object-header">
            <Link className="breadcrumb" to="/agents">
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
                    <span className="mono">{agent.name}</span>
                    <span>{providerLabel(agent.runtimeProvider)}</span>
                    <span>{agent.computer.displayName}</span>
                  </p>
                </div>
              </div>
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

function AgentTab({ agent, tab, onAgentChanged }: { agent: AgentDetail; tab: string; onAgentChanged: () => void }) {
  if (tab === "general") return <GeneralTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (tab === "runtime") return <RuntimeTab agent={agent} />;
  if (tab === "im") return <ImTab agent={agent} />;
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

function GeneralTab({ agent, onAgentChanged }: { agent: AgentDetail; onAgentChanged: () => void }) {
  return (
    <>
      <DefinitionList
        rows={[
          ["Display name", agent.displayName],
          ["Manager", agent.manager.displayName],
          ["Computer", agent.computer.displayName],
          ["Lifecycle", titleCase(agent.status)],
          ["Created", formatDate(agent.createdAt)],
        ]}
      />
      {agent.viewerCapabilities.canManage ? <GeneralAdminForm agent={agent} onAgentChanged={onAgentChanged} /> : null}
    </>
  );
}

function GeneralAdminForm({ agent, onAgentChanged }: { agent: AgentDetail; onAgentChanged: () => void }) {
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
      <button className="button" type="submit">
        Save General settings
      </button>
      <div className="actions">
        {config.status === "active" ? (
          <button type="button" onClick={() => void changeLifecycle("suspend")}>
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

function RuntimeTab({ agent }: { agent: AgentDetail }) {
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
      <button className="button" type="submit">
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

function ImTab({ agent }: { agent: AgentDetail }) {
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
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "IM_BINDING_SCOPE_REAUTH_REQUIRED") {
        setReauthorizationNeeded(true);
      }
      setError(cause instanceof Error ? cause.message : "Unable to change receive mode");
    }
  }
  return (
    <FeishuSetup agentId={agent.id} onSuccess={() => setReload((value) => value + 1)}>
      {(setup) => {
        const connect = async (intent: "create" | "reauthorize" | "replace" = "create") => {
          setError(undefined);
          if (await setup.start(intent)) setReauthorizationNeeded(false);
        };
        return (
          <AsyncState state={state}>
            {(binding) => (
              <>
                {binding ? (
                  <DefinitionList
                    rows={[
                      ["Provider", binding.provider],
                      [
                        "Binding state",
                        binding.bindingState === "reauthorization_required" && binding.provider === "feishu"
                          ? "Online · permissions update required"
                          : binding.bindingState,
                      ],
                      ["Receive mode", binding.receiveMode],
                      [
                        "Last confirmed",
                        binding.lastConfirmedAt ? formatDate(binding.lastConfirmedAt) : "Unable to confirm",
                      ],
                    ]}
                  />
                ) : (
                  <EmptyState title="No IM binding">Connect a supported IM bot when the Agent is ready.</EmptyState>
                )}
                {agent.viewerCapabilities.canManage ? (
                  <div className="actions">
                    {!binding ? (
                      <button className="button" type="button" onClick={() => void connect()}>
                        Connect existing or new Feishu Bot
                      </button>
                    ) : null}
                    {(binding?.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
                    binding?.provider === "feishu" ? (
                      <button className="button" type="button" onClick={() => void connect("reauthorize")}>
                        Reauthorize Feishu
                      </button>
                    ) : null}
                    {(binding?.bindingState === "reauthorization_required" || reauthorizationNeeded) &&
                    binding?.provider === "slack" ? (
                      <span className="notice">Slack reauthorization is not available in this release.</span>
                    ) : null}
                    {binding?.receiveMode === "mention_only" ? (
                      <button type="button" onClick={() => void changeReceiveMode("all_message")}>
                        Enable all messages
                      </button>
                    ) : binding ? (
                      <button type="button" onClick={() => void changeReceiveMode("mention_only")}>
                        Use mentions only
                      </button>
                    ) : null}
                    {binding?.provider === "feishu" ? (
                      <button type="button" onClick={() => void connect("replace")}>
                        Replace with existing or new Feishu Bot
                      </button>
                    ) : null}
                    {binding ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            !window.confirm(
                              "Disable this IM binding? New IM work will stop until another binding is connected.",
                            )
                          )
                            return;
                          void browserApi.disableImBinding(binding.id).then(
                            () => setReload((value) => value + 1),
                            (cause: unknown) =>
                              setError(cause instanceof Error ? cause.message : "Unable to disable IM binding"),
                          );
                        }}
                      >
                        Disable IM binding
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="muted">IM setup is managed by Team Admins.</p>
                )}
                {setup.feedback}
                {error ? (
                  <div className="notice error" role="alert">
                    {error}
                  </div>
                ) : null}
              </>
            )}
          </AsyncState>
        );
      }}
    </FeishuSetup>
  );
}

function AccessTab({ agent }: { agent: AgentDetail }) {
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
              refreshMe={refreshMe}
              teamId={membership.teamId}
            />
          ) : null}
          {section === "computers" ? (
            <ComputersSettings canManage={membership.role === "admin"} teamId={membership.teamId} />
          ) : null}
          {section === "resources" ? (
            <EmptyState title="Team Resources not enabled">No Resource records are created by this page.</EmptyState>
          ) : null}
          {section === "integrations" ? (
            <EmptyState title="Team Integrations not enabled">
              Agent-owned connections remain visible from each Agent's IM and Integrations sections.
            </EmptyState>
          ) : null}
          {section === "access" ? (
            <EmptyState title="Team access uses the current membership policy">
              Team Admins manage membership while Agent access stays visible on each Agent.
            </EmptyState>
          ) : null}
          {section === "usage" ? (
            <EmptyState title="Usage reporting not enabled">No inferred or estimated usage is shown.</EmptyState>
          ) : null}
          {section === "security" ? (
            <EmptyState title="Security overview">Sensitive credentials are never returned to the browser.</EmptyState>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AccountSettings({ refreshMe, user }: { refreshMe: () => void; user: MeResponse["user"] }) {
  const saveInFlight = useRef(false);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => setDisplayName(user.displayName), [user.displayName]);

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
    <form className="form-card" onSubmit={submit}>
      <h2>Account profile</h2>
      <label>
        Email
        <input name="email" readOnly type="email" value={user.email} />
      </label>
      <label>
        Display name
        <input
          maxLength={255}
          name="displayName"
          onChange={(event) => setDisplayName(event.currentTarget.value)}
          required
          value={displayName}
        />
      </label>
      <p className="muted">This name is shared across every Team you belong to.</p>
      <button className="button" disabled={saving} type="submit">
        {saving ? "Saving…" : "Save account profile"}
      </button>
      {message ? <p role="status">{message}</p> : null}
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
  if (membership.role !== "admin") {
    return (
      <DefinitionList
        rows={[
          ["Canonical name", membership.teamName],
          ["Display name", membership.teamDisplayName],
          ["Your role", membership.role],
        ]}
      />
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      setMessage(undefined);
      await browserApi.updateTeam(membership.teamId, {
        name: String(data.get("name") ?? ""),
        displayName: String(data.get("displayName") ?? ""),
      });
      refreshMe();
      setMessage("Team profile saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save the Team profile");
    }
  }
  return (
    <form className="form-card" key={`${membership.teamName}:${membership.teamDisplayName}`} onSubmit={submit}>
      <h2>Team profile</h2>
      <label>
        Canonical name
        <input defaultValue={membership.teamName} name="name" pattern="[A-Za-z0-9][A-Za-z0-9-]*" required />
      </label>
      <p className="muted">Changing this name immediately changes the CLI --team selector. The Team ID stays stable.</p>
      <label>
        Display name
        <input defaultValue={membership.teamDisplayName} name="displayName" required />
      </label>
      <button className="button" type="submit">
        Save Team profile
      </button>
      {message ? <p role="status">{message}</p> : null}
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
    <>
      {canManage ? <InvitationSettings teamId={teamId} /> : null}
      <section className="panel">
        <h2>Team members</h2>
        <AsyncState state={state}>
          {(value) => (
            <div className="list">
              {value.members.map((member: TeamMemberSummary) => (
                <div className="row" key={member.userId}>
                  <strong>{member.displayName}</strong>
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
                    <span>{member.role}</span>
                  )}
                </div>
              ))}
            </div>
          )}
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

function InvitationSettings({ teamId }: { teamId: string }) {
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
    setError(undefined);
    setMessage(undefined);
    try {
      setCurrent(await action());
      setMessage(successMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update the invitation link");
    } finally {
      setBusy(false);
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
    <section className="panel">
      <h2>Invite people</h2>
      <p>Anyone with the active link can join this Team as a member until the link expires.</p>
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
              <div className="actions">
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
          <div className="list">
            {value.computers.map((computer: TeamComputerSummary) => (
              <div className="row" key={computer.id}>
                <span>
                  <strong>{computer.displayName}</strong>
                  <small>
                    {computer.ownerDisplayName} ({computer.platform})
                  </small>
                </span>
                <span className="cell-stack align-end">
                  <strong>{titleCase(computer.connectionStatus)}</strong>
                  <small>Observed {formatDate(computer.observedAt)}</small>
                </span>
              </div>
            ))}
          </div>
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
    resources: "Review the Team Resources authorized for this Agent.",
    integrations: "Review external services available to this Agent's runtime.",
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
