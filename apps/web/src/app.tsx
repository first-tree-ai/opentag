import type { Computer, MeMembership } from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "./api.js";

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
    loaderRef.current().then(
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

function Resource<T>({ state, children }: { state: LoadState<T>; children: (value: T) => ReactNode }) {
  if (state.kind === "loading") return <p className="muted">Loading current server state…</p>;
  if (state.kind === "error") {
    if (state.error instanceof ApiError && state.error.status === 401) {
      window.location.assign("/admin/login");
      return null;
    }
    return <div className="notice error">{state.error.message}</div>;
  }
  return children(state.value);
}

export function App() {
  const invite = /^\/invite\/([A-Za-z0-9_-]{32,512})$/.exec(window.location.pathname);
  if (invite?.[1]) return <InvitePage token={invite[1]} />;
  if (window.location.pathname === "/admin/login") return <LoginPage />;
  return <AdminApp />;
}

function LoginPage() {
  const providers = useResource(() => browserApi.authProviders(), "auth-providers");
  const rawNext = new URLSearchParams(window.location.search).get("next");
  const next = rawNext ?? "/admin";
  return (
    <main className="center-card">
      <span className="eyebrow">OpenTag</span>
      <h1>Admin sign in</h1>
      <p>Choose an available sign-in method. Team roles are checked from the server after sign-in.</p>
      <Resource state={providers}>
        {(value) => {
          const google = value.providers.find((provider) => provider.id === "google" && provider.enabled);
          const dev = value.providers.find((provider) => provider.id === "dev" && provider.enabled);
          const loopback = isLoopbackHostname(window.location.hostname);
          if (!google?.startUrl && !(dev?.startUrl && loopback)) {
            return <div className="notice error">No browser sign-in method is available.</div>;
          }
          return (
            <div className="actions">
              {google?.startUrl ? (
                <a className="button" href={`${google.startUrl}?next=${encodeURIComponent(next)}`}>
                  Continue with Google
                </a>
              ) : null}
              {dev?.startUrl && loopback ? (
                <a className="button secondary" href={`${dev.startUrl}?next=${encodeURIComponent(next)}`}>
                  Dev: bypass Google
                </a>
              ) : null}
            </div>
          );
        }}
      </Resource>
    </main>
  );
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") return true;
  const parts = hostname.split(".").map(Number);
  return (
    parts.length === 4 && parts[0] === 127 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  );
}

function InvitePage({ token }: { token: string }) {
  const preview = useResource(() => browserApi.invitationPreview(token), token);
  const [message, setMessage] = useState<string>();
  async function join() {
    try {
      await browserApi.redeemInvitation(token);
      window.location.assign("/admin");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        window.location.assign(`/admin/login?next=${encodeURIComponent(`/invite/${token}`)}`);
        return;
      }
      setMessage(error instanceof Error ? error.message : "The invitation could not be redeemed");
    }
  }
  return (
    <main className="center-card">
      <span className="eyebrow">Team invitation</span>
      <Resource state={preview}>
        {(value) => (
          <>
            <h1>Join {value.teamDisplayName}</h1>
            <p>
              This invitation grants the {value.role} role and expires {formatDate(value.expiresAt)}.
            </p>
            <button className="button" type="button" onClick={join}>
              Join Team
            </button>
          </>
        )}
      </Resource>
      {message ? <div className="notice error">{message}</div> : null}
    </main>
  );
}

function AdminApp() {
  const me = useResource(() => browserApi.me(), "me");
  return (
    <Resource state={me}>
      {(value) => {
        const teamId = /^\/admin\/teams\/([^/]+)/.exec(window.location.pathname)?.[1];
        if (!teamId) return <TeamSelector memberships={value.memberships} displayName={value.user.displayName} />;
        const membership = value.memberships.find((item) => item.teamId === decodeURIComponent(teamId));
        if (!membership) return <div className="notice error">This Team is not available to your account.</div>;
        if (membership.role !== "admin") return <Forbidden membership={membership} />;
        return <TeamShell membership={membership} viewerUserId={value.user.id} />;
      }}
    </Resource>
  );
}

function TeamSelector({ memberships, displayName }: { memberships: MeMembership[]; displayName: string }) {
  return (
    <main className="page">
      <header className="hero">
        <span className="eyebrow">OpenTag Admin</span>
        <h1>Welcome, {displayName}</h1>
        <p>
          Select a Team. The selection changes only this page; the server checks your current role on every request.
        </p>
        <ConnectComputerAction />
      </header>
      <section className="card-grid">
        {memberships.map((membership) => (
          <a className="team-card" href={`/admin/teams/${membership.teamId}`} key={membership.teamId}>
            <span className="status-dot" />
            <strong>{membership.teamDisplayName}</strong>
            <small>{membership.role}</small>
          </a>
        ))}
      </section>
    </main>
  );
}

function ConnectComputerAction({ onConnected }: { onConnected?: (computer: Computer) => void } = {}) {
  const [showConnect, setShowConnect] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setShowConnect(true)}>
        Connect computer
      </button>
      {showConnect ? <ConnectComputerDialog onClose={() => setShowConnect(false)} onConnected={onConnected} /> : null}
    </>
  );
}

function Forbidden({ membership }: { membership: MeMembership }) {
  return (
    <main className="center-card">
      <span className="eyebrow">{membership.teamDisplayName}</span>
      <h1>Admin access required</h1>
      <p>Your current Team role is {membership.role}. Ask a Team admin if you need diagnostic access.</p>
      <a href="/admin">Choose another Team</a>
    </main>
  );
}

function TeamShell({ membership, viewerUserId }: { membership: MeMembership; viewerUserId: string }) {
  const section = window.location.pathname.split("/")[4] || "overview";
  const base = `/admin/teams/${membership.teamId}`;
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/admin">
          OpenTag
        </a>
        <strong>{membership.teamDisplayName}</strong>
        <nav>
          {[
            ["overview", "Overview"],
            ["members", "Members"],
            ["agents", "Agents"],
            ["computers", "Computers"],
            ["diagnostics", "Diagnostics"],
          ].map(([path, label]) => (
            <a
              className={section === path ? "active" : ""}
              href={path === "overview" ? base : `${base}/${path}`}
              key={path}
            >
              {label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="content">
        <TeamPage section={section} membership={membership} viewerUserId={viewerUserId} />
      </main>
    </div>
  );
}

function TeamPage({
  section,
  membership,
  viewerUserId,
}: {
  section: string;
  membership: MeMembership;
  viewerUserId: string;
}) {
  if (section === "members") return <MembersPage teamId={membership.teamId} />;
  if (section === "agents") return <AgentsPage teamId={membership.teamId} />;
  if (section === "computers") return <ComputersPage teamId={membership.teamId} viewerUserId={viewerUserId} />;
  if (section === "diagnostics") return <DiagnosticsPage />;
  return <OverviewPage membership={membership} />;
}

function OverviewPage({ membership }: { membership: MeMembership }) {
  const snapshot = useResource(async () => {
    const [members, agents, computers, invitation] = await Promise.all([
      browserApi.members(membership.teamId),
      browserApi.agents(membership.teamId),
      browserApi.computers(membership.teamId),
      browserApi.invitation(membership.teamId),
    ]);
    return { members, agents, computers, invitation, observedAt: new Date().toISOString() };
  }, membership.teamId);
  return (
    <>
      <PageHeader title={membership.teamDisplayName} subtitle={`Read-only snapshot · ${membership.role}`} />
      <Resource state={snapshot}>
        {(value) => (
          <>
            <section className="metrics">
              <Metric label="Members" value={value.members.members.length} />
              <Metric label="Agents" value={value.agents.agents.length} />
              <Metric label="Computers" value={value.computers.computers.length} />
            </section>
            <section className="panel">
              <h2>Current invitation</h2>
              <code>{value.invitation.inviteUrl}</code>
              <button
                type="button"
                className="secondary"
                onClick={() => navigator.clipboard.writeText(value.invitation.inviteUrl)}
              >
                Copy link
              </button>
              <p className="muted">
                Expires {formatDate(value.invitation.expiresAt)}. Rotation remains a CLI-only admin action.
              </p>
            </section>
            <p className="timestamp">Observed {formatDate(value.observedAt)}</p>
          </>
        )}
      </Resource>
    </>
  );
}

function MembersPage({ teamId }: { teamId: string }) {
  const state = useResource(() => browserApi.members(teamId), teamId);
  return (
    <>
      <PageHeader title="Members" subtitle="Current membership authority from the server" />
      <Resource state={state}>
        {(value) => (
          <Table
            headers={["Name", "Email", "Role", "Status", "Updated"]}
            rows={value.members.map((member) => [
              member.displayName,
              member.email,
              member.role,
              member.status,
              formatDate(member.updatedAt),
            ])}
          />
        )}
      </Resource>
    </>
  );
}

function AgentsPage({ teamId }: { teamId: string }) {
  const state = useResource(() => browserApi.agents(teamId), teamId);
  return (
    <>
      <PageHeader title="Agents" subtitle="Team-owned Agent registry" />
      <Resource state={state}>
        {(value) => (
          <Table
            headers={["Name", "Provider", "Manager", "Computer", "Revision"]}
            rows={value.agents.map((agent) => [
              agent.displayName,
              agent.runtimeProvider,
              agent.managerUserId,
              agent.computerId,
              String(agent.revision),
            ])}
          />
        )}
      </Resource>
    </>
  );
}

function ComputersPage({ teamId, viewerUserId }: { teamId: string; viewerUserId: string }) {
  const [ownComputersRevision, setOwnComputersRevision] = useState(0);
  const ownComputers = useResource(() => browserApi.ownComputers(), `own-computers:${ownComputersRevision}`);
  const teamComputers = useResource(() => browserApi.computers(teamId), `team-computers:${teamId}`);
  const refreshOwnComputers = useCallback(() => setOwnComputersRevision((revision) => revision + 1), []);
  return (
    <>
      <div className="page-heading-row">
        <PageHeader title="Computers" subtitle="Your connections and this Team's member computers" />
        <ConnectComputerAction onConnected={refreshOwnComputers} />
      </div>
      <section aria-labelledby="your-computers-title" className="computer-section">
        <h2 id="your-computers-title">Your computers</h2>
        <p className="muted">All computers connected to your account, whether or not an Agent uses them yet.</p>
        <Resource state={ownComputers}>
          {(value) => (
            <Table
              emptyMessage="No computers connected to your account."
              headers={["Computer", "Platform", "Connection", "Last seen"]}
              rows={value.computers.map((computer) => [
                computer.displayName,
                `${computer.platform}/${computer.arch} · ${computer.clientVersion}`,
                computer.connectionStatus,
                formatDate(computer.lastSeenAt),
              ])}
            />
          )}
        </Resource>
      </section>
      <section aria-labelledby="team-computers-title" className="computer-section">
        <h2 id="team-computers-title">Team computers</h2>
        <p className="muted">Computers owned by other active Team members; Agent bindings are shown separately.</p>
        <Resource state={teamComputers}>
          {(value) => (
            <Table
              emptyMessage="No other active Team members have connected computers."
              headers={["Computer", "Owner", "Platform", "Connection snapshot", "Agents", "Last seen", "Observed"]}
              rows={value.computers
                .filter((computer) => computer.ownerUserId !== viewerUserId)
                .map((computer) => [
                  computer.displayName,
                  computer.ownerDisplayName,
                  `${computer.platform}/${computer.arch} · ${computer.clientVersion}`,
                  computer.connectionStatus,
                  String(computer.agentIds.length),
                  formatDate(computer.lastSeenAt),
                  formatDate(computer.observedAt),
                ])}
            />
          )}
        </Resource>
      </section>
    </>
  );
}

type ConnectDialogState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; bootstrapCommand: string; expiresAtMs: number; issuedAtMs: number }
  | { kind: "expired" }
  | { kind: "success"; computer: Computer };

function ConnectComputerDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected?: (computer: Computer) => void;
}) {
  const [state, setState] = useState<ConnectDialogState>({ kind: "loading" });
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const generation = useRef(0);
  const baseline = useRef(new Map<string, string | null>());

  const mint = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setState({ kind: "loading" });
    setCopyStatus("idle");
    try {
      const existing = await browserApi.ownComputers();
      if (generation.current !== currentGeneration) return;
      const issued = await browserApi.issueConnectCode();
      if (generation.current !== currentGeneration) return;
      baseline.current = new Map(existing.computers.map((computer) => [computer.id, computer.connectedAt]));
      setRemainingSeconds(issued.expiresIn);
      setState({
        kind: "ready",
        bootstrapCommand: issued.bootstrapCommand,
        expiresAtMs: Date.now() + issued.expiresIn * 1000,
        issuedAtMs: Date.parse(issued.issuedAt),
      });
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "The connection command could not be generated",
      });
    }
  }, []);

  useEffect(() => {
    void mint();
    return () => {
      generation.current += 1;
    };
  }, [mint]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const currentGeneration = generation.current;
    const updateRemaining = () => {
      if (generation.current !== currentGeneration) return;
      const next = Math.max(0, Math.ceil((state.expiresAtMs - Date.now()) / 1000));
      setRemainingSeconds(next);
      if (next === 0) setState({ kind: "expired" });
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const currentGeneration = generation.current;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const current = await browserApi.ownComputers();
        if (generation.current !== currentGeneration) return;
        const connected = current.computers.find(
          (computer) =>
            computer.connectionStatus === "online" &&
            computer.connectedAt !== null &&
            Date.parse(computer.connectedAt) >= state.issuedAtMs &&
            baseline.current.get(computer.id) !== computer.connectedAt,
        );
        if (connected) {
          onConnected?.(connected);
          setState({ kind: "success", computer: connected });
        }
      } catch {
        // A transient poll failure does not invalidate the already-issued command.
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => window.clearInterval(timer);
  }, [onConnected, state]);

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section aria-labelledby="connect-computer-title" aria-modal="true" className="dialog" role="dialog">
        <div className="dialog-title-row">
          <div>
            <span className="eyebrow">New connection</span>
            <h2 id="connect-computer-title">Connect computer</h2>
          </div>
          <button aria-label="Close" className="icon-button" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <p>Run this command in a terminal on the computer you want OpenTag to use.</p>
        {state.kind === "loading" ? <div className="notice">Generating a short-lived command…</div> : null}
        {state.kind === "error" ? (
          <div className="notice error">
            <p>{state.message}</p>
            <button type="button" onClick={() => void mint()}>
              Try again
            </button>
          </div>
        ) : null}
        {state.kind === "ready" ? (
          <>
            <pre className="command-block">
              <code>{state.bootstrapCommand}</code>
            </pre>
            <div className="dialog-actions">
              <button type="button" onClick={() => void copyCommand(state.bootstrapCommand)}>
                {copyStatus === "copied" ? "Copied" : "Copy command"}
              </button>
              <span className={copyStatus === "error" ? "copy-error" : "muted"}>
                {copyStatus === "error"
                  ? "Copy failed. Select the command manually."
                  : `Expires in ${formatDuration(remainingSeconds)}`}
              </span>
            </div>
            <p className="muted">Waiting for this computer to connect…</p>
          </>
        ) : null}
        {state.kind === "expired" ? (
          <div className="notice">
            <p>This command has expired.</p>
            <button type="button" onClick={() => void mint()}>
              Generate new command
            </button>
          </div>
        ) : null}
        {state.kind === "success" ? (
          <div className="notice success" role="status">
            <strong>{state.computer.displayName} connected.</strong>
            <p>You can close this window. The daemon is running on the computer.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function DiagnosticsPage() {
  const state = useResource(
    async () => ({ health: await browserApi.health("/healthz"), readiness: await browserApi.health("/readyz") }),
    "diagnostics",
  );
  return (
    <>
      <PageHeader
        title="Diagnostics"
        subtitle="Observation only; these values do not control routing or reachability"
      />
      <Resource state={state}>
        {(value) => (
          <section className="metrics">
            <Metric label="Health" value={`${value.health.status} · ${value.health.latencyMs} ms`} />
            <Metric label="Readiness" value={`${value.readiness.status} · ${value.readiness.latencyMs} ms`} />
            <Metric label="Observed" value={formatDate(value.health.observedAt)} />
          </section>
        )}
      </Resource>
    </>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="page-header">
      <span className="eyebrow">Admin snapshot</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <article className="metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}

function Table({
  headers,
  rows,
  emptyMessage = "No records in this snapshot.",
}: {
  headers: string[];
  rows: string[][];
  emptyMessage?: string;
}) {
  if (rows.length === 0) return <div className="notice">{emptyMessage}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join("|")}>
              {headers.map((header, index) => (
                <td key={header}>{row[index]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}
