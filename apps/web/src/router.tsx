import type {
  AgentAdminConfig,
  AgentDetail,
  AgentSummary,
  AuthProvidersResponse,
  Computer,
  FeishuSetupIntent,
  MeMembership,
  TeamComputerSummary,
  TeamMemberSummary,
  UpdateAgentRuntimeConfig,
} from "@opentag/shared/browser";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, browserApi } from "./api.js";
import { FeishuSetupAttemptPanel, useFeishuSetup } from "./feishu-setup.js";
import { OnboardingPage } from "./onboarding/onboarding-page.js";
import { readTeamPreference, SELECTED_TEAM_STORAGE_KEY, TeamContext, useTeam } from "./team-context.js";
import {
  AsyncState,
  DefinitionList,
  EmptyState,
  formatDate,
  NotFoundPage,
  Page,
  titleCase,
  UnavailablePage,
  useResource,
} from "./ui.js";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invites/:token" element={<InvitePage />} />
      {/* Onboarding owns Team creation so the zero-Team path has a single destination. */}
      <Route path="/teams/new" element={<Navigate replace to="/onboarding" />} />
      <Route element={<AuthenticatedTeamGate />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate replace to="/agents" />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<NewAgentPage />} />
          <Route path="/agents/:agentId" element={<Navigate replace to="general" />} />
          <Route path="/agents/:agentId/:tab" element={<AgentDetailPage />} />
          <Route path="/settings" element={<Navigate replace to="team" />} />
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
  const navigate = useNavigate();
  const preview = useResource(() => browserApi.invitationPreview(token), token);
  const [error, setError] = useState<string>();
  async function join() {
    try {
      await browserApi.redeemInvitation(token);
      navigate("/agents");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        navigate(`/login?next=${encodeURIComponent(`/invites/${token}`)}`);
      } else setError(cause instanceof Error ? cause.message : "The invitation could not be redeemed");
    }
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
            <button className="button" type="button" onClick={join}>
              Join Team
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
        // A signed-in user with no Team cannot use any Team-scoped page. Onboarding
        // owns that state and creates the first Team, so it is the only destination.
        if (!membership && location.pathname !== "/onboarding") return <Navigate replace to="/onboarding" />;
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

function AppShell() {
  const { me, membership, selectTeam } = useTeam();
  return (
    <div className="shell">
      <aside aria-label="Primary navigation">
        <Link className="brand" to="/agents">
          OpenTag
        </Link>
        <label className="team-picker">
          <span>Team</span>
          <select value={membership.teamId} onChange={(event) => selectTeam(event.currentTarget.value)}>
            {me.memberships.map((item: MeMembership) => (
              <option value={item.teamId} key={item.teamId}>
                {item.teamDisplayName}
              </option>
            ))}
          </select>
        </label>
        <nav>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/settings/team">Settings</NavLink>
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <span>{membership.role === "admin" ? "Team Admin" : "Member · read only"}</span>
          <span>{me.user.displayName}</span>
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
      action={
        membership.role === "admin" ? (
          <Link className="button" to="/agents/new">
            Create Agent
          </Link>
        ) : undefined
      }
    >
      <AsyncState state={state}>
        {(value) =>
          value.agents.length === 0 ? (
            <EmptyState title="No Agents yet">A Team Admin can create the first Agent.</EmptyState>
          ) : (
            <div className="card-grid">
              {value.agents.map((agent: AgentSummary) => (
                <AgentCard agent={agent} key={agent.id} />
              ))}
            </div>
          )
        }
      </AsyncState>
    </Page>
  );
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <Link className="agent-card" to={`/agents/${agent.id}/general`}>
      <div>
        <strong>{agent.displayName}</strong>
        <small>{agent.name}</small>
      </div>
      <dl>
        <div>
          <dt>Provider</dt>
          <dd>{agent.runtimeProvider}</dd>
        </div>
        <div>
          <dt>Computer</dt>
          <dd>{agent.computer.displayName}</dd>
        </div>
        <div>
          <dt>IM policy</dt>
          <dd>{agent.receiveMode}</dd>
        </div>
      </dl>
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
    <Page title="Create Agent">
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

const agentTabs = ["general", "runtime", "im", "resources", "integrations", "access"] as const;

function AgentDetailPage() {
  const { agentId = "", tab = "general" } = useParams();
  const state = useResource(() => browserApi.agent(agentId), agentId);
  if (!agentTabs.includes(tab as (typeof agentTabs)[number])) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => (
        <Page title={agent.displayName} eyebrow={agent.name}>
          <nav className="tabs" aria-label="Agent settings">
            {agentTabs.map((item) => (
              <NavLink to={`/agents/${agentId}/${item}`} key={item}>
                {titleCase(item)}
              </NavLink>
            ))}
          </nav>
          <AgentTab agent={agent} tab={tab} />
        </Page>
      )}
    </AsyncState>
  );
}

function AgentTab({ agent, tab }: { agent: AgentDetail; tab: string }) {
  if (tab === "general") return <GeneralTab agent={agent} />;
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

function GeneralTab({ agent }: { agent: AgentDetail }) {
  return (
    <>
      <DefinitionList
        rows={[
          ["Display name", agent.displayName],
          ["Manager", agent.manager.displayName],
          ["Computer", agent.computer.displayName],
          ["Created", formatDate(agent.createdAt)],
        ]}
      />
      {agent.viewerCapabilities.canManage ? <GeneralAdminForm agent={agent} /> : null}
    </>
  );
}

function GeneralAdminForm({ agent }: { agent: AgentDetail }) {
  const configState = useResource(() => browserApi.agentConfig(agent.id), agent.id);
  return <AsyncState state={configState}>{(config) => <GeneralConfigForm initialConfig={config} />}</AsyncState>;
}

function GeneralConfigForm({ initialConfig }: { initialConfig: AgentAdminConfig }) {
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "");
    try {
      setConfig(await browserApi.updateAgent(config.id, { expectedRevision: config.revision, displayName }));
      setMessage("General settings saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save General settings");
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
  const onSucceeded = useCallback(() => setReload((value) => value + 1), []);
  const setup = useFeishuSetup(agent.id, onSucceeded);
  const startSetup = setup.start;
  const connect = useCallback(
    async (intent: FeishuSetupIntent = "create") => {
      setError(undefined);
      // Only a started attempt clears the pending reauthorization; a failed one must
      // leave the retry affordance in place.
      if (await startSetup(intent)) setReauthorizationNeeded(false);
    },
    [startSetup],
  );
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
    <AsyncState state={state}>
      {(binding) => (
        <>
          {binding ? (
            <DefinitionList
              rows={[
                ["Provider", binding.provider],
                ["Binding state", binding.bindingState],
                ["Receive mode", binding.receiveMode],
                ["Last confirmed", binding.lastConfirmedAt ? formatDate(binding.lastConfirmedAt) : "Unable to confirm"],
              ]}
            />
          ) : (
            <EmptyState title="No IM binding">Connect a supported IM bot when the Agent is ready.</EmptyState>
          )}
          {agent.viewerCapabilities.canManage ? (
            <div className="actions">
              {!binding ? (
                <button className="button" type="button" onClick={() => void connect()}>
                  Connect Feishu
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
          {setup.attempt ? (
            <FeishuSetupAttemptPanel attempt={setup.attempt} onRetry={(intent) => void connect(intent)} />
          ) : null}
          {(error ?? setup.error) ? (
            <div className="notice error" role="alert">
              {error ?? setup.error}
            </div>
          ) : null}
        </>
      )}
    </AsyncState>
  );
}

function AccessTab({ agent }: { agent: AgentDetail }) {
  return (
    <DefinitionList
      rows={[
        ["Safe read", "All active Team members"],
        ["Use", "All active Team members (fixed v0.1 policy)"],
        ["Manage", agent.viewerCapabilities.canManage ? "Team Admins · you can manage" : "Team Admins"],
      ]}
    />
  );
}

function SettingsPage() {
  const { section = "team" } = useParams();
  const { membership, refreshMe } = useTeam();
  const allowed = ["team", "computers", "resources", "members", "security"];
  if (!allowed.includes(section)) return <NotFoundPage />;
  return (
    <Page title="Settings">
      <nav className="tabs" aria-label="Team settings">
        {allowed.map((item) => (
          <NavLink to={`/settings/${item}`} key={item}>
            {titleCase(item)}
          </NavLink>
        ))}
      </nav>
      {section === "team" ? <TeamSettings membership={membership} refreshMe={refreshMe} /> : null}
      {section === "members" ? <MembersSettings teamId={membership.teamId} /> : null}
      {section === "computers" ? (
        <ComputersSettings canManage={membership.role === "admin"} teamId={membership.teamId} />
      ) : null}
      {section === "resources" ? (
        <EmptyState title="Team Resources not enabled">No Resource records are created by this page.</EmptyState>
      ) : null}
      {section === "security" ? (
        <EmptyState title="Security overview">Sensitive credentials are never returned to the browser.</EmptyState>
      ) : null}
    </Page>
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

function MembersSettings({ teamId }: { teamId: string }) {
  const state = useResource(() => browserApi.members(teamId), teamId);
  return (
    <AsyncState state={state}>
      {(value) => (
        <div className="list">
          {value.members.map((member: TeamMemberSummary) => (
            <div className="row" key={member.userId}>
              <strong>{member.displayName}</strong>
              <span>{member.role}</span>
            </div>
          ))}
        </div>
      )}
    </AsyncState>
  );
}

function ComputersSettings({ canManage, teamId }: { canManage: boolean; teamId: string }) {
  const [reload, setReload] = useState(0);
  const state = useResource(() => browserApi.computers(teamId), `${teamId}:${reload}`);
  const [bootstrapCommand, setBootstrapCommand] = useState<string>();
  const [error, setError] = useState<string>();
  const [waitingForComputer, setWaitingForComputer] = useState(false);
  const baselineComputers = useRef<Map<string, string>>(new Map());
  async function connectComputer() {
    try {
      setError(undefined);
      baselineComputers.current = new Map(
        (await browserApi.ownComputers()).computers.map((computer: Computer) => [computer.id, computer.lastSeenAt]),
      );
      const issued = await browserApi.issueConnectCode(teamId);
      setBootstrapCommand(issued.bootstrapCommand);
      setWaitingForComputer(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create a Computer connection command");
    }
  }
  useEffect(() => {
    if (!waitingForComputer) return;
    const timer = window.setInterval(() => {
      void browserApi.ownComputers().then(
        (value) => {
          if (
            value.computers.some(
              (computer: Computer) => baselineComputers.current.get(computer.id) !== computer.lastSeenAt,
            )
          ) {
            setWaitingForComputer(false);
            setReload((current) => current + 1);
          }
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to refresh Computers"),
      );
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [waitingForComputer]);
  return (
    <>
      {canManage ? (
        <section className="panel">
          <h2>Connect a Local Computer</h2>
          <p>Generate a short-lived command, then run it in a terminal on the Computer.</p>
          <button className="button" type="button" onClick={() => void connectComputer()}>
            Generate connection command
          </button>
          {bootstrapCommand ? (
            <>
              <pre>
                <code>{bootstrapCommand}</code>
              </pre>
              <p role="status">{waitingForComputer ? "Waiting for the Computer to connect…" : "Computer connected."}</p>
            </>
          ) : null}
          {error ? (
            <div className="notice error" role="alert">
              {error}
            </div>
          ) : null}
        </section>
      ) : null}
      <AsyncState state={state}>
        {(value) => (
          <div className="list">
            {value.computers.map((computer: TeamComputerSummary) => (
              <div className="row" key={computer.id}>
                <span>
                  <strong>{computer.displayName}</strong>
                  <small>
                    {computer.ownerDisplayName} · {computer.platform}
                  </small>
                </span>
                <span>
                  {computer.connectionStatus} · observed {formatDate(computer.observedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </AsyncState>
    </>
  );
}
