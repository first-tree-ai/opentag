import type { FeishuSetupAttempt, IntegrationDiagnostics, MeMembership } from "@opentag/shared/browser";
import QRCode from "qrcode";
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
  if (section === "agents") {
    const agentId = /^\/admin\/teams\/[^/]+\/agents\/([^/]+)$/.exec(window.location.pathname)?.[1];
    return agentId ? (
      <AgentDetailPage teamId={membership.teamId} agentId={decodeURIComponent(agentId)} />
    ) : (
      <AgentsPage teamId={membership.teamId} />
    );
  }
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
        {(value) =>
          value.agents.length === 0 ? (
            <div className="notice">No records in this snapshot.</div>
          ) : (
            <section className="card-grid">
              {value.agents.map((agent) => (
                <a className="team-card" href={`/admin/teams/${teamId}/agents/${agent.id}`} key={agent.id}>
                  <span className="status-dot" />
                  <strong>{agent.displayName}</strong>
                  <small>
                    {agent.runtimeProvider} · {agent.receiveMode}
                  </small>
                </a>
              ))}
            </section>
          )
        }
      </Resource>
    </>
  );
}

function AgentDetailPage({ teamId, agentId }: { teamId: string; agentId: string }) {
  const agent = useResource(() => browserApi.agent(agentId), agentId);
  const [integration, setIntegration] = useState<Awaited<ReturnType<typeof browserApi.integration>>>();
  const [loadedIntegration, setLoadedIntegration] = useState(false);
  const [attempt, setAttempt] = useState<FeishuSetupAttempt>();
  const [error, setError] = useState<string>();
  const [qrDataUrl, setQrDataUrl] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<IntegrationDiagnostics>();

  useEffect(() => {
    let active = true;
    browserApi.integration(agentId).then(
      (value) => {
        if (!active) return;
        setIntegration(value);
        setLoadedIntegration(true);
      },
      (caught: unknown) => active && setError(caught instanceof Error ? caught.message : String(caught)),
    );
    return () => {
      active = false;
    };
  }, [agentId]);

  useEffect(() => {
    if (!integration) {
      setDiagnostics(undefined);
      return;
    }
    let active = true;
    browserApi.integrationDiagnostics(integration.integration.id).then(
      (value) => active && setDiagnostics(value),
      (caught: unknown) => active && setError(caught instanceof Error ? caught.message : String(caught)),
    );
    return () => {
      active = false;
    };
  }, [integration]);

  useEffect(() => {
    if (!loadedIntegration || integration || attempt || error) return;
    browserApi
      .createFeishuSetupAttempt(agentId)
      .then(setAttempt, (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [agentId, attempt, error, integration, loadedIntegration]);

  useEffect(() => {
    if (!attempt?.qrUrl) {
      setQrDataUrl(undefined);
      return;
    }
    let active = true;
    QRCode.toDataURL(attempt.qrUrl, { errorCorrectionLevel: "M", margin: 1, width: 280 }).then(
      (value) => active && setQrDataUrl(value),
    );
    return () => {
      active = false;
    };
  }, [attempt?.qrUrl]);

  useEffect(() => {
    if (!attempt || !["awaiting_user", "validating"].includes(attempt.state)) return;
    const timer = window.setTimeout(() => {
      browserApi.feishuSetupAttempt(attempt.id).then(
        async (next) => {
          setAttempt(next);
          if (next.state === "succeeded") {
            setIntegration(await browserApi.integration(agentId));
            setAttempt(undefined);
          }
        },
        (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
      );
    }, 750);
    return () => window.clearTimeout(timer);
  }, [agentId, attempt]);

  function retry() {
    setError(undefined);
    setAttempt(undefined);
    setLoadedIntegration(true);
  }

  function reauthorize() {
    setError(undefined);
    setAttempt(undefined);
    browserApi
      .createFeishuSetupAttempt(agentId, "reauthorize")
      .then(setAttempt, (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }

  function disable() {
    if (!integration) return;
    browserApi.disableIntegration(integration.integration.id).then(
      async () => setIntegration(await browserApi.integration(agentId)),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }

  const setupStatus = attempt ? feishuSetupStatus(attempt) : "Preparing a secure Feishu QR code…";

  return (
    <>
      <a href={`/admin/teams/${teamId}/agents`}>← Agents</a>
      <Resource state={agent}>
        {(value) => (
          <PageHeader
            title={value.displayName}
            subtitle={`${value.runtimeProvider} · ${value.receiveMode} · revision ${value.revision}`}
          />
        )}
      </Resource>
      {error ? (
        <section className="panel">
          <div className="notice error">{error}</div>
          <button className="button" type="button" onClick={retry}>
            Try again
          </button>
        </section>
      ) : integration && !attempt ? (
        <section className="panel">
          <h2>{integration.integration.provider === "feishu" ? "Feishu Bot" : "Slack Bot"}</h2>
          <p>
            {integration.integration.disabledAt
              ? "Disabled"
              : integration.reauthorizationRequired
                ? "Reauthorization required"
                : diagnostics === undefined
                  ? "Checking readiness"
                  : !diagnostics.runtimeToolAvailable
                    ? "Provider connected; runtime message tool unavailable — not ready"
                    : diagnostics.ready
                      ? "Ready"
                      : "Validating"}{" "}
            {" as "}
            {integration.identity.provider === "feishu"
              ? integration.identity.botOpenId
              : integration.identity.botUserId}
            .
          </p>
          <p className="muted">
            Credential generation {integration.credentialGeneration} · Last inbound{" "}
            {integration.lastInboundAt ? formatDate(integration.lastInboundAt) : "not observed"}
          </p>
          <p className="muted">
            {diagnostics?.connection
              ? `Channel ${diagnostics.connection.state} (observed ${formatDate(diagnostics.connection.observedAt)})`
              : "Connection observation not available"}
          </p>
          <p className="muted">Granted capabilities: {integration.grantedCapabilities.join(", ")}</p>
          {integration.integration.provider === "feishu" ? (
            <>
              <p>
                {integration.integration.disabledAt
                  ? "Reauthorize to reconnect this Bot. Existing message history remains available."
                  : diagnostics?.ready
                    ? "Message the Bot directly, or add it to a group and mention its exact Feishu identity."
                    : "OpenTag will show working guidance only after the provider and controlled runtime message tool are ready."}
              </p>
              <div className="actions">
                <button className="button" type="button" onClick={reauthorize}>
                  Reauthorize
                </button>
                <button className="button secondary" type="button" onClick={disable}>
                  Disable
                </button>
              </div>
            </>
          ) : null}
        </section>
      ) : (
        <section className="panel">
          <h2>Connect Feishu</h2>
          <p>
            Scan once in Feishu. OpenTag creates the App, requests the visible permissions, and connects the Bot
            automatically.
          </p>
          {qrDataUrl ? (
            <img src={qrDataUrl} width="280" height="280" alt="Scan with Feishu to create this Agent Bot" />
          ) : null}
          <p className="muted">{setupStatus}</p>
          {attempt && ["failed", "expired", "canceled"].includes(attempt.state) ? (
            <button className="button" type="button" onClick={retry}>
              Scan again
            </button>
          ) : null}
        </section>
      )}
    </>
  );
}

function feishuSetupStatus(attempt: FeishuSetupAttempt): string {
  if (attempt.state === "awaiting_user") return "Waiting for visible Feishu consent…";
  if (attempt.state === "validating") return "Validating permissions, Bot identity, and Channel reachability…";
  if (attempt.state === "succeeded") return "Feishu Bot is ready.";
  const details: Record<string, string> = {
    FEISHU_SETUP_CANCELED: "The Feishu setup was canceled. You can scan again here.",
    FEISHU_SETUP_DENIED: "Feishu consent was declined. Review the visible permissions and scan again.",
    FEISHU_SETUP_EXPIRED: "The QR code expired. Generate a fresh code here.",
    FEISHU_SETUP_OWNER_RESTARTED: "The setup owner restarted. Your existing Bot was not changed; scan again here.",
    FEISHU_SCOPE_REAUTH_REQUIRED:
      "Feishu has not granted every requested permission yet. Approve the visible permissions and scan again here.",
    FEISHU_SCOPE_VALIDATION_FAILED:
      "OpenTag could not verify the granted Feishu permissions. Check the connection and retry here.",
  };
  return details[attempt.errorCode ?? ""] ?? "Feishu setup could not be completed. Your existing Bot was not changed.";
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
