import type { MeMembership } from "@opentag/shared/browser";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
  return (
    <main className="center-card">
      <span className="eyebrow">OpenTag</span>
      <h1>Admin sign in</h1>
      <p>Use your configured Google identity. Team roles are checked from the server after sign-in.</p>
      <a className="button" href="/api/v1/auth/google/start?next=%2Fadmin">
        Continue with Google
      </a>
    </main>
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
        window.location.assign(`/api/v1/auth/google/start?next=${encodeURIComponent(`/invite/${token}`)}`);
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
        return <TeamShell membership={membership} />;
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

function TeamShell({ membership }: { membership: MeMembership }) {
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
        <TeamPage section={section} membership={membership} />
      </main>
    </div>
  );
}

function TeamPage({ section, membership }: { section: string; membership: MeMembership }) {
  if (section === "members") return <MembersPage teamId={membership.teamId} />;
  if (section === "agents") return <AgentsPage teamId={membership.teamId} />;
  if (section === "computers") return <ComputersPage teamId={membership.teamId} />;
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

function ComputersPage({ teamId }: { teamId: string }) {
  const state = useResource(() => browserApi.computers(teamId), teamId);
  return (
    <>
      <PageHeader title="Computers" subtitle="Only Computers referenced by active Team Agents" />
      <Resource state={state}>
        {(value) => (
          <Table
            headers={["Computer", "Owner", "Platform", "Connection snapshot", "Last seen", "Observed"]}
            rows={value.computers.map((computer) => [
              computer.displayName,
              computer.ownerDisplayName,
              `${computer.platform}/${computer.arch} · ${computer.clientVersion}`,
              computer.connectionStatus,
              formatDate(computer.lastSeenAt),
              formatDate(computer.observedAt),
            ])}
          />
        )}
      </Resource>
    </>
  );
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

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return <div className="notice">No records in this snapshot.</div>;
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
