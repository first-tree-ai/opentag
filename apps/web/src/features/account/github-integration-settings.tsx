import type { GitHubConnectionStatus } from "@opentag/shared/browser";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, Loader, SettingsList, SettingsRow, Text } from "../../ui/design-system.js";
import { useGitHubActionFocus } from "../integrations/github-action-focus.js";
import {
  type GitHubOAuthOutcome,
  githubOAuthOutcomeMessage,
  readGitHubOAuthOutcome,
} from "../integrations/github-oauth-outcome.js";

import { GitHubRepositoryAccess } from "./github-repository-access.js";
import { clearProfileNavigationDraft } from "./profile-navigation-draft.js";

type GitHubAuthorizationIntent = "create" | "reauthorize" | "replace";
type GitHubAction = GitHubAuthorizationIntent | "remove" | "retry";

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "account"; connection: GitHubConnectionStatus };

function githubAccountLabel(connection: GitHubConnectionStatus): string {
  return connection.githubLogin ? `@${connection.githubLogin}` : m.integrations_github_account_unknown();
}

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

/** Account identity is independent of repository discovery and its upstream availability. */
async function resolveAccountGitHubView(): Promise<View> {
  const overview = await browserApi.githubIntegration();
  if (!overview.availability.available) return { kind: "unavailable" };
  const connection = overview.connection;
  if (connection === null || ["pending", "revoked", "superseded"].includes(connection.status)) return { kind: "empty" };
  return { kind: "account", connection };
}

export function GitHubIntegrationSettings({ beforeAuthorize }: { beforeAuthorize?: () => void }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [outcome, setOutcome] = useState<GitHubOAuthOutcome | undefined>(() => readGitHubOAuthOutcome());
  const [action, setAction] = useState<GitHubAction | null>(null);
  const inFlight = useRef(false);
  const busy = action !== null;
  const { resultRef, captureFocus } = useGitHubActionFocus(busy);
  const removeRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const sectionRef = useRef<HTMLElement>(null);

  const reconcileConnection = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await resolveAccountGitHubView();
        if (signal.aborted) return;
        setView(next);
        setOutcome(undefined);
        setError(undefined);
        setMessage(m.integrations_github_details_updated());
        requestAnimationFrame(() => {
          if (document.activeElement?.closest('[role="dialog"]')) return;
          const authorize = sectionRef.current?.querySelector<HTMLButtonElement>(
            '[data-ui="github-account-authorize"]',
          );
          (authorize ?? resultRef.current)?.focus();
        });
      } catch (cause) {
        if (!signal.aborted) setError(actionErrorMessage(cause));
      }
    },
    [resultRef],
  );

  const load = useCallback(async () => {
    try {
      setView(await resolveAccountGitHubView());
      return true;
    } catch (cause) {
      setView({ kind: "error", message: actionErrorMessage(cause) });
      return false;
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(kind: Exclude<typeof action, null>, perform: () => Promise<void>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    captureFocus();
    setAction(kind);
    setOutcome(undefined);
    setMessage(undefined);
    setError(undefined);
    try {
      await perform();
    } catch (cause) {
      setError(actionErrorMessage(cause));
    } finally {
      inFlight.current = false;
      setAction(null);
    }
  }

  function authorize(intent: GitHubAuthorizationIntent): void {
    void run(intent, async () => {
      try {
        beforeAuthorize?.();
        const started = await browserApi.startGitHubAuthorization({
          intent,
          returnSurface: "account-integrations",
          agentId: null,
        });
        // Capture edits made while the authorization request was in flight, too.
        beforeAuthorize?.();
        window.location.assign(started.authorizationUrl);
      } catch (cause) {
        clearProfileNavigationDraft();
        throw cause;
      }
    });
  }
  function remove(): void {
    void run("remove", async () => {
      await browserApi.disconnectGitHub();
      // A confirmed mutation is authoritative even if a subsequent read would fail.
      setView({ kind: "empty" });
      setConfirming(false);
      setOutcome(undefined);
      setMessage(m.integrations_github_removed());
      requestAnimationFrame(() => resultRef.current?.focus());
    });
  }

  function closeRemoval(): void {
    setConfirming(false);
    setError(undefined);
  }

  const connection = view.kind === "account" ? view.connection : undefined;
  const busyLabel =
    action && ["create", "reauthorize", "replace"].includes(action) ? m.integrations_github_authorizing() : undefined;
  const feedbackError = confirming ? undefined : error;
  return (
    <section ref={sectionRef} className="grid gap-4" aria-labelledby="account-github-title" data-ui="account-github">
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
          className={outcome.kind === "error" ? "text-kumo-strong" : undefined}
          role={outcome.kind === "success" ? "status" : "alert"}
          title={githubOAuthOutcomeMessage(outcome)}
          variant={outcome.kind === "success" ? "default" : "alert"}
        />
      ) : null}
      <AccountGitHubBody
        view={view}
        action={action}
        busy={busy}
        busyLabel={busyLabel}
        removeRef={removeRef}
        onAuthorize={authorize}
        onRetry={() =>
          void run("retry", async () => {
            if (await load()) setMessage(m.integrations_github_details_updated());
          })
        }
        onRemove={() => {
          setError(undefined);
          setConfirming(true);
        }}
        onConnectionInvalid={reconcileConnection}
      />
      <GitHubActionFeedback message={message} error={feedbackError} resultRef={resultRef} />
      {connection ? (
        <GitHubRemovalConfirmation
          connection={connection}
          open={confirming}
          busy={busy}
          error={error}
          removeRef={removeRef}
          onClose={closeRemoval}
          onRemove={remove}
        />
      ) : null}
    </section>
  );
}

function GitHubActionFeedback({
  message,
  error,
  resultRef,
}: {
  message: string | undefined;
  error: string | undefined;
  resultRef: RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <p
      className={error ? "text-sm text-kumo-danger" : message ? "text-sm text-kumo-subtle" : "sr-only"}
      data-ui="account-github-message"
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
      aria-atomic="true"
      ref={resultRef}
      tabIndex={-1}
    >
      {error ?? message}
    </p>
  );
}

function GitHubRemovalConfirmation({
  connection,
  open,
  busy,
  error,
  removeRef,
  onClose,
  onRemove,
}: {
  connection: GitHubConnectionStatus;
  open: boolean;
  busy: boolean;
  error: string | undefined;
  removeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onRemove: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const removeLabel = busy ? m.integrations_github_removing() : m.integrations_github_remove_account();
  return (
    <Dialog
      open={open}
      busy={busy}
      title={m.integrations_github_remove_title()}
      onClose={onClose}
      initialFocusRef={cancelRef}
      returnFocusRef={removeRef}
      description={m.integrations_github_remove_description({
        account: githubAccountLabel(connection),
      })}
    >
      <div className="grid gap-4">
        <Text as="p" variant="secondary">
          {m.integrations_github_remove_scope()}
        </Text>
        {error ? (
          <p className="text-sm text-kumo-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button ref={cancelRef} disabled={busy} variant="ghost" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button
            disabled={busy}
            aria-busy={busy}
            aria-label={removeLabel}
            icon={
              busy ? (
                <span className="inline-flex" aria-hidden="true">
                  <Loader size="sm" />
                </span>
              ) : undefined
            }
            variant="danger"
            onClick={onRemove}
          >
            {removeLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function GitHubAuthorizationButton({
  intent,
  action,
  busyLabel,
  onAuthorize,
}: {
  intent: GitHubAuthorizationIntent;
  action: GitHubAction | null;
  busyLabel: string | undefined;
  onAuthorize: (intent: GitHubAuthorizationIntent) => void;
}) {
  const active = action === intent;
  const label =
    intent === "create"
      ? m.integrations_github_add_account()
      : intent === "replace"
        ? m.integrations_github_change()
        : m.integrations_github_reauthorize();
  const accessibleLabel = intent === "replace" ? m.integrations_github_change_account() : label;
  return (
    <Button
      data-ui="github-account-authorize"
      disabled={action !== null}
      size={intent === "create" ? undefined : "compact"}
      variant={intent === "replace" ? "ghost" : "primary"}
      aria-label={active ? busyLabel : accessibleLabel}
      aria-busy={active}
      aria-describedby={intent === "reauthorize" ? "account-github-reauthorize-description" : undefined}
      icon={
        active ? (
          <span className="inline-flex" aria-hidden="true">
            <Loader size="sm" />
          </span>
        ) : undefined
      }
      onClick={() => onAuthorize(intent)}
      type="button"
    >
      {active && intent === "create" ? busyLabel : label}
    </Button>
  );
}

function GitHubAccountIdentity({
  connection,
  action,
  busyLabel,
  removeRef,
  onAuthorize,
  onRemove,
}: {
  connection: GitHubConnectionStatus;
  action: GitHubAction | null;
  busyLabel: string | undefined;
  removeRef: RefObject<HTMLButtonElement | null>;
  onAuthorize: (intent: GitHubAuthorizationIntent) => void;
  onRemove: () => void;
}) {
  const reauthorizationRequired = connection.status === "reauthorization_required";
  return (
    <div className="grid gap-2" data-ui="github-account-identity">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="min-w-0 break-all text-sm font-medium text-kumo-strong">
            {githubAccountLabel(connection)}
          </span>
          {reauthorizationRequired ? (
            <GitHubAuthorizationButton
              intent="reauthorize"
              action={action}
              busyLabel={busyLabel}
              onAuthorize={onAuthorize}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <GitHubAuthorizationButton intent="replace" action={action} busyLabel={busyLabel} onAuthorize={onAuthorize} />
          <Button
            ref={removeRef}
            disabled={action !== null}
            variant="ghost"
            size="compact"
            aria-label={m.integrations_github_remove_account()}
            onClick={onRemove}
            type="button"
          >
            {m.integrations_github_remove()}
          </Button>
        </div>
      </div>
      {reauthorizationRequired ? (
        <p id="account-github-reauthorize-description" className="text-sm text-kumo-subtle" role="alert">
          {m.integrations_github_reauthorize_description()}
        </p>
      ) : null}
    </div>
  );
}

function AccountGitHubBody({
  view,
  action,
  busy,
  busyLabel,
  removeRef,
  onAuthorize,
  onRetry,
  onRemove,
  onConnectionInvalid,
}: {
  view: View;
  action: GitHubAction | null;
  busy: boolean;
  busyLabel: string | undefined;
  removeRef: RefObject<HTMLButtonElement | null>;
  onAuthorize: (intent: GitHubAuthorizationIntent) => void;
  onRetry: () => void;
  onRemove: () => void;
  onConnectionInvalid: (signal: AbortSignal) => Promise<void>;
}) {
  if (view.kind === "loading")
    return (
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        <span className="inline-flex" aria-hidden="true">
          <Loader size="sm" />
        </span>
        <Text as="p" variant="secondary">
          {m.integrations_github_loading()}
        </Text>
      </div>
    );
  if (view.kind === "error")
    return (
      <Banner
        className="text-kumo-strong"
        action={
          <Button disabled={busy} size="compact" variant="secondary" onClick={onRetry}>
            {m.common_try_again()}
          </Button>
        }
        role="alert"
        title={view.message}
        variant="alert"
      />
    );
  if (view.kind === "unavailable")
    return (
      <div className="grid gap-1">
        <Text as="p">{m.integrations_github_unavailable_title()}</Text>
        <Text as="p" variant="secondary">
          {m.integrations_github_unavailable_description()}
        </Text>
      </div>
    );
  const connection = view.kind === "account" ? view.connection : undefined;
  return (
    <SettingsList className="github-settings-list">
      {connection ? (
        <div className="grid gap-3 p-4">
          <strong className="text-sm font-medium text-kumo-strong">{m.integrations_github_authorize_account()}</strong>
          <GitHubAccountIdentity
            connection={connection}
            action={action}
            busyLabel={busyLabel}
            removeRef={removeRef}
            onAuthorize={onAuthorize}
            onRemove={onRemove}
          />
        </div>
      ) : (
        <SettingsRow label={m.integrations_github_authorize_account()}>
          <GitHubAuthorizationButton intent="create" action={action} busyLabel={busyLabel} onAuthorize={onAuthorize} />
        </SettingsRow>
      )}
      <GitHubRepositoryAccess
        key={connection ? `${connection.id}/${connection.authorizationVersion}/${connection.status}` : "empty"}
        connection={connection}
        busy={busy}
        onConnectionInvalid={onConnectionInvalid}
      />
    </SettingsList>
  );
}
