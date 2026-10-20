import { GITHUB_INTEGRATION_INSTALLATION_PATH, type GitHubConnectionStatus } from "@opentag/shared/browser";
import { ArrowUpRight, DotsThree, Question } from "@phosphor-icons/react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog, DropdownMenu, SettingsList, SettingsRow, Text } from "../../ui/design-system.js";
import { useGitHubActionFocus } from "../integrations/github-action-focus.js";
import {
  type GitHubOAuthOutcome,
  githubOAuthOutcomeMessage,
  readGitHubOAuthOutcome,
} from "../integrations/github-oauth-outcome.js";

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "account"; connection: GitHubConnectionStatus };

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
  const [action, setAction] = useState<"authorize" | "remove" | "retry" | null>(null);
  const inFlight = useRef(false);
  const busy = action !== null;
  const { resultRef, captureFocus } = useGitHubActionFocus(busy);
  const menuRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

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

  function authorize(intent: "create" | "reauthorize" | "replace"): void {
    void run("authorize", async () => {
      beforeAuthorize?.();
      const started = await browserApi.startGitHubAuthorization({
        intent,
        returnSurface: "account-integrations",
        agentId: null,
      });
      // Capture edits made while the authorization request was in flight, too.
      beforeAuthorize?.();
      window.location.assign(started.authorizationUrl);
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

  const connection = view.kind === "account" ? view.connection : undefined;
  const busyLabel = action === "authorize" ? m.integrations_github_working() : undefined;
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
        view={view}
        busy={busy}
        busyLabel={busyLabel}
        menuRef={menuRef}
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
      />
      <p
        className="text-sm text-kumo-subtle"
        data-ui="account-github-message"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        ref={resultRef}
        tabIndex={-1}
      >
        {message}
      </p>
      {error && !confirming ? (
        <p className="text-sm text-kumo-danger" role="alert">
          {error}
        </p>
      ) : null}
      {connection ? (
        <Dialog
          open={confirming}
          busy={busy}
          title={m.integrations_github_remove_title()}
          onClose={() => setConfirming(false)}
          initialFocusRef={cancelRef}
          returnFocusRef={menuRef}
          description={m.integrations_github_remove_description({
            account: connection.githubLogin ? `@${connection.githubLogin}` : m.integrations_github_account_unknown(),
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
              <Button ref={cancelRef} disabled={busy} variant="ghost" onClick={() => setConfirming(false)}>
                {m.common_cancel()}
              </Button>
              <Button disabled={busy} variant="danger" onClick={remove}>
                {action === "remove" ? m.integrations_github_removing() : m.integrations_github_remove_account()}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function AccountGitHubBody({
  view,
  busy,
  busyLabel,
  menuRef,
  onAuthorize,
  onRetry,
  onRemove,
}: {
  view: View;
  busy: boolean;
  busyLabel: string | undefined;
  menuRef: RefObject<HTMLButtonElement | null>;
  onAuthorize: (intent: "create" | "reauthorize" | "replace") => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const connection = view.kind === "account" ? view.connection : undefined;
  return (
    <>
      {view.kind === "loading" ? (
        <Text as="p" variant="secondary">
          {m.integrations_github_loading()}
        </Text>
      ) : null}
      {view.kind === "error" ? (
        <Banner
          action={
            <Banner.Action disabled={busy} onClick={onRetry}>
              {m.common_try_again()}
            </Banner.Action>
          }
          role="alert"
          title={view.message}
          variant="alert"
        />
      ) : null}
      {view.kind === "unavailable" ? (
        <SettingsList>
          <SettingsRow
            label={m.integrations_github_unavailable_title()}
            description={m.integrations_github_unavailable_description()}
          >
            {null}
          </SettingsRow>
        </SettingsList>
      ) : null}
      {view.kind === "empty" ? (
        <SettingsList>
          <SettingsRow label={m.integrations_github_account_label()}>
            <Button disabled={busy} onClick={() => onAuthorize("create")} type="button">
              {busyLabel ?? m.integrations_github_authorize()}
            </Button>
          </SettingsRow>
        </SettingsList>
      ) : null}
      {connection ? (
        <>
          <SettingsList>
            <SettingsRow label={m.integrations_github_account_label()}>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 break-all text-sm text-kumo-strong">
                  {connection.githubLogin ? `@${connection.githubLogin}` : m.integrations_github_account_unknown()}
                </span>
                <DropdownMenu>
                  <DropdownMenu.Trigger
                    render={
                      <Button
                        ref={menuRef}
                        aria-label={m.integrations_github_account_actions()}
                        disabled={busy}
                        variant="ghost"
                        shape="square"
                        size="compact"
                      />
                    }
                  >
                    <DotsThree aria-hidden className="size-5" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="end">
                    <DropdownMenu.Item onClick={() => onAuthorize("replace")}>
                      {m.integrations_github_change_account()}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onClick={onRemove}>{m.integrations_github_remove_account()}</DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu>
              </div>
            </SettingsRow>
            <SettingsRow
              label={
                <span className="inline-flex items-center gap-1">
                  {m.integrations_github_repository_access()}
                  <Button
                    aria-label={m.integrations_github_repository_help_label()}
                    aria-expanded={helpOpen}
                    aria-controls="account-github-repository-help"
                    onClick={() => setHelpOpen(!helpOpen)}
                    variant="ghost"
                    shape="square"
                    size="compact"
                    type="button"
                  >
                    <Question aria-hidden className="size-4" />
                  </Button>
                </span>
              }
            >
              <a
                className="inline-flex w-fit items-center gap-1 text-sm text-kumo-link hover:underline"
                href={GITHUB_INTEGRATION_INSTALLATION_PATH}
                target="_blank"
                rel="noopener noreferrer"
              >
                {m.integrations_github_manage_on_github()}
                <ArrowUpRight aria-hidden className="size-4" />
              </a>
            </SettingsRow>
          </SettingsList>
          {helpOpen ? (
            <div id="account-github-repository-help" className="flex flex-col gap-2">
              <Text as="p" variant="secondary">
                {m.integrations_github_repository_help()}
              </Text>
              <Text as="p" variant="secondary">
                {m.integrations_github_repository_help_organization()}
              </Text>
            </div>
          ) : null}
          {connection.status === "reauthorization_required" ? (
            <Banner
              role="alert"
              title={m.integrations_github_reauthorize_description()}
              variant="alert"
              action={
                <Banner.Action disabled={busy} onClick={() => onAuthorize("reauthorize")}>
                  {busyLabel ?? m.integrations_github_reauthorize()}
                </Banner.Action>
              }
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
