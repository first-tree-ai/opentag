import type { GitHubConnectionStatus } from "@opentag/shared/browser";
import { ArrowClockwise, ArrowUpRight, Question } from "@phosphor-icons/react";
import { type RefObject, useRef, useState } from "react";
import * as m from "../../paraglide/messages.js";
import { Button, Dialog, KumoInputControl, Loader, Popover, SettingsRow, Text } from "../../ui/design-system.js";
import { catalogHasMore, catalogIsPartial, type RepositoryCatalog } from "./github-repository-discovery.js";
import { useGitHubRepositories } from "./use-github-repositories.js";
import "./github-repository-access.css";

function GitHubConfigurationLink({ onClick }: { onClick?: () => void }) {
  return (
    <a
      className="inline-flex min-h-11 w-fit items-center gap-1 text-sm text-kumo-link hover:underline"
      href="https://github.com/settings/applications"
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
    >
      {m.integrations_github_manage_on_github()}
      <ArrowUpRight aria-hidden className="size-4" />
    </a>
  );
}

export function GitHubRepositoryHelp({ scope = false }: { scope?: boolean }) {
  const label = scope ? m.integrations_github_repositories_help_label() : m.integrations_github_repository_help_label();
  return (
    <Popover>
      <Popover.Trigger
        render={<Button aria-label={label} variant="ghost" shape="square" size="compact" type="button" />}
      >
        <Question aria-hidden className="size-4" />
      </Popover.Trigger>
      <Popover.Content align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <Popover.Title className="sr-only">{label}</Popover.Title>
        <Popover.Description render={<div className="grid gap-2" />}>
          <Text as="p" variant="secondary">
            {scope ? m.integrations_github_repositories_help() : m.integrations_github_repository_help()}
          </Text>
          <Text as="p" variant="secondary">
            {scope
              ? m.integrations_github_repositories_operations()
              : m.integrations_github_repository_help_organization()}
          </Text>
        </Popover.Description>
      </Popover.Content>
    </Popover>
  );
}

export function GitHubRepositoryAccess({
  connection,
  busy,
  onConnectionInvalid,
}: {
  connection?: GitHubConnectionStatus;
  busy: boolean;
  onConnectionInvalid?: (signal: AbortSignal) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const available = connection?.status === "active";
  const description = available
    ? m.integrations_github_repository_access_description()
    : connection
      ? m.integrations_github_repositories_reauthorize()
      : undefined;
  return (
    <>
      <SettingsRow
        label={
          <span className="inline-flex items-center gap-1">
            {m.integrations_github_repository_access()}
            <GitHubRepositoryHelp />
          </span>
        }
        description={description}
      >
        <div className="github-repository-actions">
          {available ? (
            <Button ref={trigger} variant="secondary" disabled={busy} onClick={() => setOpen(true)}>
              {m.integrations_github_repositories_view()}
            </Button>
          ) : null}
          <GitHubConfigurationLink />
        </div>
      </SettingsRow>
      {available && connection ? (
        <GitHubRepositoryDialog
          connection={connection}
          open={open}
          onClose={() => setOpen(false)}
          returnFocusRef={trigger}
          onConnectionInvalid={onConnectionInvalid}
        />
      ) : null}
    </>
  );
}

function GitHubRepositoryDialog({
  connection,
  open,
  onClose,
  returnFocusRef,
  onConnectionInvalid,
}: {
  connection: GitHubConnectionStatus;
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onConnectionInvalid?: (signal: AbortSignal) => Promise<void>;
}) {
  const state = useGitHubRepositories(open, connection, onConnectionInvalid);
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const visible = state.catalog?.repositories.slice(0, state.catalog.visibleCount) ?? [];
  const matches = visible.filter((repository) =>
    repository.fullName.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const hasRows = visible.length > 0;
  return (
    <Dialog
      open={open}
      onClose={() => {
        setFilter("");
        onClose();
      }}
      className="github-repositories-dialog"
      title={m.integrations_github_repositories_title()}
      closeLabel={m.integrations_github_repositories_close()}
      returnFocusRef={returnFocusRef}
      initialFocusRef={input}
      description={hasRows ? m.integrations_github_repositories_description() : undefined}
      headerActions={
        <>
          <GitHubRepositoryHelp scope />
          <Button
            variant="ghost"
            shape="square"
            size="compact"
            aria-label={m.integrations_github_repositories_refresh()}
            disabled={Boolean(state.pending)}
            aria-busy={Boolean(state.pending)}
            onClick={state.refresh}
          >
            <ArrowClockwise aria-hidden className="size-4" />
          </Button>
        </>
      }
    >
      <div className="github-repositories-body">
        {hasRows ? (
          <KumoInputControl
            ref={input}
            type="search"
            value={filter}
            aria-label={m.integrations_github_repositories_filter()}
            placeholder={m.integrations_github_repositories_filter()}
            onChange={(event) => setFilter(event.target.value)}
          />
        ) : null}
        <div aria-live="polite" aria-busy={Boolean(state.pending)}>
          {state.pending ? <RepositoryLoading /> : null}
          {hasRows ? (
            <RepositoryRows matches={matches} partial={Boolean(state.catalog && catalogIsPartial(state.catalog))} />
          ) : null}
          {!hasRows && state.catalog && !state.pending && !state.failure ? (
            <RepositoryEmpty catalog={state.catalog} />
          ) : null}
          {!state.catalog && !state.pending && !state.failure ? <RepositoryLoading /> : null}
          {state.failure ? (
            <RepositoryFailure refresh={state.failure.kind === "refresh"} hasRows={hasRows} onRetry={state.retry} />
          ) : null}
          {state.catalog && !state.pending && !state.failure ? <RepositoryNotices catalog={state.catalog} /> : null}
        </div>
        {state.catalog && catalogHasMore(state.catalog) && !state.failure ? (
          <div className="flex justify-center border-t border-kumo-line pt-2">
            <Button variant="ghost" disabled={Boolean(state.pending)} onClick={state.loadMore}>
              {m.integrations_github_repositories_more()}
            </Button>
          </div>
        ) : null}
      </div>
      <footer className="github-repositories-footer">
        <GitHubConfigurationLink onClick={state.configure} />
      </footer>
    </Dialog>
  );
}

function RepositoryLoading() {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-kumo-subtle" role="status">
      <span aria-hidden>
        <Loader size="sm" />
      </span>
      {m.integrations_github_repositories_loading()}
    </div>
  );
}

function RepositoryRows({ matches, partial }: { matches: RepositoryCatalog["repositories"]; partial: boolean }) {
  if (!matches.length)
    return (
      <p className="py-4 text-sm text-kumo-subtle">
        {partial ? m.integrations_github_repositories_partial_match() : m.integrations_github_repositories_no_match()}
      </p>
    );
  return (
    <ul className="divide-y divide-kumo-line" aria-label={m.integrations_github_repositories_title()}>
      {matches.map((repository) => (
        <li key={repository.repositoryId} className="break-all py-3 text-sm text-kumo-strong">
          {repository.fullName}
        </li>
      ))}
    </ul>
  );
}

function RepositoryEmpty({ catalog }: { catalog: RepositoryCatalog }) {
  if (catalogIsPartial(catalog)) return null;
  return (
    <div className="grid gap-2 py-4 text-sm text-kumo-subtle" data-ui="github-repositories-empty">
      <p>{m.integrations_github_repositories_empty()}</p>
      <p>{m.integrations_github_repositories_organization()}</p>
    </div>
  );
}

function RepositoryFailure({ refresh, hasRows, onRetry }: { refresh: boolean; hasRows: boolean; onRetry: () => void }) {
  const message =
    refresh && hasRows
      ? m.integrations_github_repositories_refresh_error()
      : hasRows
        ? m.integrations_github_repositories_partial_error()
        : m.integrations_github_repositories_error();
  return (
    <div className="grid justify-items-start gap-2 py-4" role="alert">
      <Text as="p" variant="secondary">
        {message}
      </Text>
      <Button variant="secondary" onClick={onRetry}>
        {m.common_try_again()}
      </Button>
    </div>
  );
}

function RepositoryNotices({ catalog }: { catalog: RepositoryCatalog }) {
  return (
    <div className="grid gap-2 text-sm text-kumo-subtle">
      {catalog.incomplete ? <p className="py-2">{m.integrations_github_repositories_incomplete()}</p> : null}
      {!catalog.incomplete && !catalog.repositories.length && catalogHasMore(catalog) ? (
        <p className="py-2">{m.integrations_github_repositories_incomplete()}</p>
      ) : null}
    </div>
  );
}
