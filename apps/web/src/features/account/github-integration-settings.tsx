import type { GitHubConnectionStatus, GitHubDiscoveredInstallation } from "@opentag/shared/browser";
import { useCallback, useEffect, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Badge, Banner, Button, SettingsList, SettingsRow, StatusIndicator, Text } from "../../ui/design-system.js";
import {
  type GitHubOAuthOutcome,
  githubOAuthOutcomeMessage,
  readGitHubOAuthOutcome,
} from "../integrations/github-oauth-outcome.js";

/**
 * The Account's GitHub connection, backed by the real management API.
 *
 * The Server authors every authorize URL; this surface only opens it and reports the bounded
 * outcome the callback redirected back with. An unavailable deployment is explained, never demoed.
 * Connection status, reauthorization, explicit replacement, and disconnect are all real state
 * transitions — the component never keeps a local copy of the connection.
 */

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable" }
  | { kind: "disconnected" }
  | { kind: "pending" }
  | { kind: "reauthorize"; connection: GitHubConnectionStatus }
  | { kind: "active"; connection: GitHubConnectionStatus; installations: GitHubDiscoveredInstallation[] };

function actionErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case "GITHUB_INTEGRATION_UNAVAILABLE":
        return m.integrations_github_unavailable_description();
      case "GITHUB_RATE_LIMITED":
        return m.integrations_github_error_rate_limited();
      case "GITHUB_UPSTREAM_UNAVAILABLE":
      case "GITHUB_UPSTREAM_ERROR":
        return m.integrations_github_error_upstream();
      case "GITHUB_AUTHORIZATION_VERSION_CONFLICT":
      case "GITHUB_CONNECTION_CONFLICT":
        return m.integrations_github_error_conflict();
      case "GITHUB_CONNECTION_NOT_FOUND":
      case "GITHUB_CONNECTION_STATE_INVALID":
        return m.integrations_github_error_state();
      default:
        break;
    }
  }
  return cause instanceof Error && cause.message ? cause.message : m.integrations_github_error_generic();
}

function statusTone(status: GitHubConnectionStatus["status"]): "success" | "warning" | "neutral" {
  if (status === "active") return "success";
  if (status === "pending" || status === "reauthorization_required") return "warning";
  return "neutral";
}

function statusLabel(status: GitHubConnectionStatus["status"]): string {
  switch (status) {
    case "active":
      return m.integrations_github_status_active();
    case "pending":
      return m.integrations_github_status_pending();
    case "reauthorization_required":
      return m.integrations_github_status_reauthorize();
    case "revoked":
      return m.integrations_github_status_disconnected();
    default:
      return m.integrations_github_status_superseded();
  }
}

export function GitHubIntegrationSettings() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [outcome, setOutcome] = useState<GitHubOAuthOutcome | undefined>(() => readGitHubOAuthOutcome());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setView(await resolveAccountGitHubView());
    } catch (cause) {
      setView({ kind: "error", message: actionErrorMessage(cause) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(actionErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function connect(intent: "create" | "reauthorize" | "replace"): void {
    void run(async () => {
      const started = await browserApi.startGitHubAuthorization({
        intent,
        returnSurface: "account-integrations",
        agentId: null,
      });
      window.location.assign(started.authorizationUrl);
    });
  }

  function disconnect(): void {
    void run(async () => {
      await browserApi.disconnectGitHub();
      setOutcome(undefined);
      setMessage(m.integrations_github_disconnected_message());
      await load();
    });
  }

  const busyLabel = busy ? m.integrations_github_working() : undefined;

  return (
    <section className="grid gap-4" aria-labelledby="account-github-title" data-ui="account-github">
      <div className="grid gap-1">
        <Text as="h2" id="account-github-title" variant="heading">
          {m.integrations_github_account_title()}
        </Text>
        <Text as="p" variant="secondary">
          {m.integrations_github_account_description()}
        </Text>
      </div>

      {outcome ? (
        <Banner
          data-ui="account-github-outcome"
          role="status"
          title={githubOAuthOutcomeMessage(outcome)}
          variant={outcome.kind === "success" ? "default" : "alert"}
        />
      ) : null}

      <AccountGitHubBody
        busy={busy}
        busyLabel={busyLabel}
        onConnect={connect}
        onDisconnect={disconnect}
        onRetry={() => void load()}
        view={view}
      />

      {message ? (
        <p className="text-sm text-kumo-success" data-ui="account-github-message" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kumo-danger" data-ui="account-github-action-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The Account overview resolved to one view state; the Server is the only source of truth. */
async function resolveAccountGitHubView(): Promise<View> {
  const overview = await browserApi.githubIntegration();
  if (!overview.availability.available) return { kind: "unavailable" };
  const connection = overview.connection;
  if (connection === null) return { kind: "disconnected" };
  if (connection.status === "pending") return { kind: "pending" };
  if (connection.status !== "active") return { kind: "reauthorize", connection };
  const discovery = await browserApi.githubRepositories();
  return { kind: "active", connection, installations: discovery.installations };
}

/** Everything below the Account GitHub heading: one mutually exclusive connection state. */
function AccountGitHubBody({
  busy,
  busyLabel,
  onConnect,
  onDisconnect,
  onRetry,
  view,
}: {
  busy: boolean;
  busyLabel: string | undefined;
  onConnect: (intent: "create" | "reauthorize" | "replace") => void;
  onDisconnect: () => void;
  onRetry: () => void;
  view: View;
}) {
  if (view.kind === "loading") {
    return (
      <Text as="p" data-ui="account-github-loading" variant="secondary">
        {m.integrations_github_loading()}
      </Text>
    );
  }
  if (view.kind === "error") {
    return (
      <Banner
        action={<Banner.Action onClick={onRetry}>{m.common_try_again()}</Banner.Action>}
        data-ui="account-github-error"
        role="alert"
        title={view.message}
        variant="alert"
      />
    );
  }
  if (view.kind === "unavailable") {
    return (
      <SettingsList>
        <SettingsRow
          description={m.integrations_github_unavailable_description()}
          label={m.integrations_github_unavailable_title()}
        >
          <Badge variant="secondary">{m.integrations_github_unavailable_badge()}</Badge>
        </SettingsRow>
      </SettingsList>
    );
  }
  if (view.kind === "disconnected") {
    return (
      <SettingsList>
        <SettingsRow
          description={m.integrations_github_disconnected_description()}
          label={m.integrations_github_connection_label()}
        >
          <Button disabled={busy} onClick={() => onConnect("create")} type="button">
            {busyLabel ?? m.integrations_github_connect()}
          </Button>
        </SettingsRow>
      </SettingsList>
    );
  }
  if (view.kind === "pending") {
    return (
      <SettingsList>
        <SettingsRow
          description={m.integrations_github_pending_description()}
          label={<ConnectionLabel status="pending" />}
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={busy} onClick={() => onConnect("create")} type="button">
              {busyLabel ?? m.integrations_github_finish_connect()}
            </Button>
            <Button disabled={busy} onClick={onDisconnect} type="button" variant="ghost">
              {m.integrations_github_cancel()}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>
    );
  }
  return (
    <ConnectionDetails
      busy={busy}
      busyLabel={busyLabel}
      connection={view.connection}
      installations={view.kind === "active" ? view.installations : []}
      onDisconnect={onDisconnect}
      onReauthorize={() => onConnect("reauthorize")}
      onReplace={() => onConnect("replace")}
    />
  );
}

/** The connection row's label plus its live state badge; shared by every connection view. */
function ConnectionLabel({ status }: { status: GitHubConnectionStatus["status"] }) {
  return (
    <span className="flex items-center gap-2">
      {m.integrations_github_connection_label()}
      <StatusIndicator label={statusLabel(status)} tone={statusTone(status)} />
    </span>
  );
}

function ConnectionDetails({
  busy,
  busyLabel,
  connection,
  installations,
  onDisconnect,
  onReauthorize,
  onReplace,
}: {
  busy: boolean;
  busyLabel: string | undefined;
  connection: GitHubConnectionStatus;
  installations: GitHubDiscoveredInstallation[];
  onDisconnect: () => void;
  onReauthorize: () => void;
  onReplace: () => void;
}) {
  const boundRepositories = connection.bindings.length;
  return (
    <SettingsList>
      <SettingsRow
        description={
          connection.githubLogin
            ? m.integrations_github_connected_as({ login: connection.githubLogin })
            : m.integrations_github_connected()
        }
        label={<ConnectionLabel status={connection.status} />}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={onReauthorize} type="button" variant="secondary">
            {busyLabel ?? m.integrations_github_reconnect()}
          </Button>
          <Button disabled={busy} onClick={onReplace} type="button" variant="ghost">
            {m.integrations_github_use_another_account()}
          </Button>
          <Button disabled={busy} onClick={onDisconnect} type="button" variant="ghost">
            {m.integrations_github_disconnect()}
          </Button>
        </div>
      </SettingsRow>

      {connection.status === "reauthorization_required" ? (
        <SettingsRow
          description={m.integrations_github_reauth_description()}
          label={m.integrations_github_reauth_title()}
        >
          <Button disabled={busy} onClick={onReauthorize} type="button">
            {busyLabel ?? m.integrations_github_reconnect()}
          </Button>
        </SettingsRow>
      ) : null}

      <SettingsRow
        description={m.integrations_github_installations_description()}
        label={m.integrations_github_installations_title()}
      >
        {installations.length === 0 ? (
          <Text as="span" data-ui="account-github-no-installations" variant="secondary">
            {m.integrations_github_no_installations()}
          </Text>
        ) : (
          <ul className="flex flex-wrap justify-end gap-2" data-ui="account-github-installations">
            {installations.map((entry) => (
              <li key={entry.installationId}>
                <Badge variant={entry.suspended ? "secondary" : "neutral"}>
                  {entry.suspended
                    ? m.integrations_github_installation_suspended({ account: entry.accountLogin })
                    : entry.accountLogin}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>

      <SettingsRow
        description={m.integrations_github_bound_repositories_description()}
        label={m.integrations_github_bound_repositories_title({ count: String(boundRepositories) })}
      >
        {boundRepositories === 0 ? (
          <Text as="span" data-ui="account-github-no-bindings" variant="secondary">
            {m.integrations_github_no_bound_repositories()}
          </Text>
        ) : (
          <ul className="grid justify-end gap-1 text-right" data-ui="account-github-bindings">
            {connection.bindings.map((binding) => (
              <li key={binding.bindingId}>{binding.fullNameDisplay}</li>
            ))}
          </ul>
        )}
      </SettingsRow>
    </SettingsList>
  );
}
