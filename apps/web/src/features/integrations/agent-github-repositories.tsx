import {
  type AgentDetail,
  canonicalizeGitHubRepositoryBindings,
  GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS,
  GITHUB_AGENT_SCOPE_MAX_DELEGATED_SESSION_AGENTS,
  GitBranchRefSchema,
  type GitHubConnectionStatus,
  type GitHubDiscoveredInstallation,
  type GitHubDiscoveredRepository,
  type GitHubRepositoryAccess,
  type GitHubRepositoryBinding,
  type GitHubRepositoryPublishMode,
  type GitHubRepositoryRole,
} from "@opentag/shared/browser";
import { useCallback, useEffect, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Field,
  KumoInputControl,
  KumoSelectControl,
  Text,
} from "../../ui/design-system.js";
import {
  blockedDraftIds,
  type Draft,
  type DraftState,
  dirtyRepositoryIds,
  draftScope,
  emptyDraftState,
  existingScope,
  mergeRepositoryPages,
  type ReadyRepositoryView,
  reconcileDrafts,
  scopeConfiguration,
  toggleDraft,
} from "./agent-github-drafts.js";
import { useGitHubActionFocus } from "./github-action-focus.js";
import { GitHubInstallationActions } from "./github-installation-actions.js";
import { type GitHubOAuthOutcome, githubOAuthOutcomeMessage, readGitHubOAuthOutcome } from "./github-oauth-outcome.js";

/**
 * One Agent's GitHub repository access, backed by the real management API.
 *
 * The page discovers the repositories the connected GitHub account can actually reach — with the
 * connected user's own permissions — and writes exactly this Agent's scopes back through the
 * version-fenced bindings update. Every scope carries the owner's explicit task delegation; a
 * repository without one stays unavailable for tasks, so the editor asks for it directly.
 */

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable" }
  | { kind: "needs-connection"; connection: GitHubConnectionStatus | null }
  | ReadyRepositoryView;

type EditorState = DraftState & { view: View };

function applyReadyView(
  current: EditorState,
  next: ReadyRepositoryView,
  agentId: string,
  verifiedIds?: Set<string>,
): EditorState {
  const state = reconcileDrafts(current, next, agentId, verifiedIds);
  return { ...state, view: state.baseline ?? next };
}

function editorResultMessage(
  editor: EditorState,
  completed: "refresh" | "load-more" | "save" | null,
  message: string | undefined,
  dirty: boolean,
): string | undefined {
  if (editor.pending) return m.integrations_agent_github_draft_connection_changed();
  if (completed === "save")
    return dirty ? m.integrations_agent_github_saved_with_drafts() : m.integrations_agent_github_saved();
  if (completed === null) return message;
  if (editor.view.kind !== "ready") return m.integrations_github_connection_changed();
  if (completed === "load-more")
    return m.integrations_agent_github_loaded_more({ count: String(editor.view.repositories.length) });
  return m.integrations_agent_github_refreshed({
    installations: String(editor.view.installations.length),
    repositories: String(editor.view.repositories.length),
  });
}

function DraftWarnings({
  editor,
  dirtyIds,
  onDiscard,
  onRetry,
  busy,
}: {
  editor: EditorState;
  dirtyIds: Set<string>;
  onDiscard: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  if (editor.pending)
    return (
      <Banner
        role="alert"
        variant="alert"
        title={m.integrations_agent_github_draft_connection_changed()}
        action={
          <Banner.Action disabled={busy} onClick={onDiscard}>
            {m.integrations_agent_github_discard_drafts()}
          </Banner.Action>
        }
      />
    );
  if (editor.view.kind !== "ready" && dirtyIds.size > 0)
    return (
      <Banner
        role="alert"
        variant="alert"
        title={m.integrations_agent_github_drafts_connection_unavailable()}
        action={
          <Banner.Action disabled={busy} onClick={onRetry}>
            {m.integrations_github_refresh()}
          </Banner.Action>
        }
      />
    );
  const blocked = blockedDraftIds(editor);
  const conflicts = editor.conflictIds.filter((id) => dirtyIds.has(id));
  const names = (ids: string[]) =>
    editor.baseline?.repositories
      .filter((repository) => ids.includes(repository.repositoryId))
      .map((repository) => repository.fullName)
      .join(", ") ?? "";
  return (
    <>
      {blocked.length > 0 ? (
        <Banner
          role="alert"
          variant="alert"
          title={m.integrations_agent_github_drafts_unavailable({ repositories: names(blocked) })}
        />
      ) : null}
      {conflicts.length > 0 ? (
        <Banner
          role="alert"
          variant="alert"
          title={m.integrations_agent_github_drafts_conflict({ repositories: names(conflicts) })}
        />
      ) : null}
    </>
  );
}

/**
 * Replaces exactly this Agent's scopes for the repositories the editor actually loaded, while
 * preserving every other Agent's configuration and this Agent's scopes on repositories outside the
 * loaded pages (they are not visible to toggle, so a save must not silently drop them).
 *
 * Binding identity is stable: when this Agent was the only scope holder of a binding, the edited
 * scope keeps that binding's ID for the same installation; a different installation gets a new ID.
 */
function mergeBindings(
  existing: GitHubRepositoryBinding[],
  agentId: string,
  drafts: Draft[],
  managedRepositoryIds: ReadonlySet<string>,
  newBindingId: () => string,
): GitHubRepositoryBinding[] {
  const changed = editedRepositoryIds(existing, agentId, drafts, managedRepositoryIds);
  const selected = new Map(drafts.map((draft) => [draft.repositoryId, draft]));
  const originalRoles = new Map([...changed].map((id) => [id, selected.get(id)?.baselineRole]));
  const ownBindingIdByRepository = new Map<string, string>();
  for (const binding of existing) {
    if (binding.agentScopes.some((scope) => scope.agentId === agentId)) {
      ownBindingIdByRepository.set(`${binding.installationId}:${binding.repositoryId}`, binding.bindingId);
    }
  }
  const remaining = existing
    .map((binding) => ({
      ...binding,
      agentScopes: changed.has(binding.repositoryId)
        ? binding.agentScopes.filter(
            (scope) =>
              scope.agentId !== agentId ||
              (selected.has(binding.repositoryId) &&
                scope.role !== originalRoles.get(binding.repositoryId) &&
                scope.role !== selected.get(binding.repositoryId)?.role),
          )
        : binding.agentScopes,
    }))
    .filter((binding) => binding.agentScopes.length > 0);
  for (const draft of drafts) {
    if (!changed.has(draft.repositoryId)) continue;
    const scope = draftScope(draft, agentId);
    const target = remaining.find(
      (binding) => binding.repositoryId === draft.repositoryId && binding.installationId === draft.installationId,
    );
    if (target) {
      target.fullNameDisplay = draft.fullNameDisplay;
      target.agentScopes = [...target.agentScopes, scope];
      continue;
    }
    remaining.push({
      bindingId: ownBindingIdByRepository.get(`${draft.installationId}:${draft.repositoryId}`) ?? newBindingId(),
      installationId: draft.installationId,
      repositoryId: draft.repositoryId,
      fullNameDisplay: draft.fullNameDisplay,
      agentScopes: [scope],
    });
  }
  return remaining;
}

function editedRepositoryIds(
  existing: GitHubRepositoryBinding[],
  agentId: string,
  drafts: Draft[],
  managed: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(drafts.map((draft) => [draft.repositoryId, draft]));
  return new Set(
    [...managed].filter((id) => {
      const draft = byId.get(id);
      const before =
        draft?.baselineRole === null ? undefined : existingScope(existing, agentId, id, draft?.baselineRole);
      if (!before) return draft !== undefined;
      if (!draft || before.binding.installationId !== draft.installationId) return true;
      return scopeConfiguration(before.scope) !== scopeConfiguration(draftScope(draft, agentId));
    }),
  );
}

/** Stable, distinct comparison-only IDs; they never survive to a real write. */
function bindingPlaceholderIds(existing: GitHubRepositoryBinding[]) {
  const occupied = new Set(existing.map((binding) => binding.bindingId));
  let sequence = 0;
  return () => {
    let id: string;
    do {
      id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    } while (occupied.has(id));
    occupied.add(id);
    return id;
  };
}

/**
 * Whether the current draft would change the stored configuration at all. Compared on the canonical
 * form the Server hashes, so an untouched scope with a different key order is not reported as a
 * change — and an empty selection that removes the Agent's last loaded scope is a real change.
 */
function bindingConfigurationChanged(
  existing: GitHubRepositoryBinding[],
  agentId: string,
  drafts: Draft[],
  managedRepositoryIds: ReadonlySet<string>,
): boolean {
  try {
    const merged = mergeBindings(existing, agentId, drafts, managedRepositoryIds, bindingPlaceholderIds(existing));
    return canonicalizeGitHubRepositoryBindings(merged) !== canonicalizeGitHubRepositoryBindings(existing);
  } catch {
    // An incomplete draft cannot be canonicalized; the save stays unavailable until it is valid.
    return false;
  }
}

/** Server-controlled GitHub failures mapped to product language; unknown ones fall back. */
const GITHUB_ERROR_MESSAGES: Readonly<Record<string, () => string>> = {
  GITHUB_AUTHORIZATION_VERSION_CONFLICT: () => m.integrations_agent_github_conflict(),
  GITHUB_CONNECTION_CONFLICT: () => m.integrations_agent_github_conflict(),
  GITHUB_INTEGRATION_UNAVAILABLE: () => m.integrations_github_unavailable_description(),
  GITHUB_ADMISSION_INSTALLATION_MISSING: () => m.integrations_agent_github_no_repositories(),
  GITHUB_ADMISSION_REPOSITORY_MISSING: () => m.integrations_agent_github_no_repositories(),
  GITHUB_ADMISSION_PERMISSION_INSUFFICIENT: () => m.integrations_agent_github_read_only_note(),
  GITHUB_TOKEN_LIFETIME_UNSUPPORTED: () => m.integrations_github_error_token_lifetime(),
  GITHUB_IDENTITY_MISMATCH: () => m.integrations_github_error_identity_mismatch(),
};

function errorMessage(cause: unknown, fallback: string): string {
  const mapped = cause instanceof ApiError && cause.code ? GITHUB_ERROR_MESSAGES[cause.code] : undefined;
  if (mapped) return mapped();
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

interface AgentGitHubLoaded {
  agent: AgentDetail;
  view: View;
  workspaceAgents: { id: string; displayName: string }[];
  imBindingId: string | undefined;
}

/** Everything the page needs for one Agent, in one trip: identity, connection, discovery, delegation. */
async function resolveAgentGitHub(agentId: string): Promise<AgentGitHubLoaded> {
  const [agent, overview] = await Promise.all([browserApi.agent(agentId), browserApi.githubIntegration()]);
  const empty: Omit<AgentGitHubLoaded, "view"> = {
    agent,
    workspaceAgents: [],
    imBindingId: undefined,
  };
  if (!overview.availability.available) return { ...empty, view: { kind: "unavailable" } };
  const connection = overview.connection;
  if (connection === null || connection.status !== "active") {
    return { ...empty, view: { kind: "needs-connection", connection } };
  }
  const [page, agentsResponse, binding] = await Promise.all([
    browserApi.githubRepositories(),
    browserApi.agents(),
    browserApi.imBinding(agentId).catch(() => undefined),
  ]);
  return {
    agent,
    view: {
      kind: "ready",
      connection,
      installations: page.installations,
      repositories: page.repositories,
      nextCursor: page.nextCursor,
      truncated: (page.truncatedInstallations?.length ?? 0) > 0,
    },
    workspaceAgents: agentsResponse.agents
      .filter((entry) => entry.id !== agentId)
      .map((entry) => ({ id: entry.id, displayName: entry.displayName })),
    imBindingId: binding?.id,
  };
}

export function AgentGitHubRepositories({ agentId }: { agentId: string }) {
  return <AgentGitHubRepositoryEditor agentId={agentId} key={agentId.toLowerCase()} />;
}

function AgentGitHubRepositoryEditor({ agentId }: { agentId: string }) {
  const [editor, setEditor] = useState<EditorState>(() => ({ ...emptyDraftState(), view: { kind: "loading" } }));
  const { view, drafts } = editor;
  const [outcome] = useState<GitHubOAuthOutcome | undefined>(() => readGitHubOAuthOutcome());
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [workspaceAgents, setWorkspaceAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [imBindingId, setImBindingId] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<"authorize" | "save" | "refresh" | "load-more" | null>(null);
  const busy = action !== null;
  const { resultRef, captureFocus } = useGitHubActionFocus(busy);
  const [message, setMessage] = useState<string>();
  const [completed, setCompleted] = useState<"refresh" | "load-more" | "save" | null>(null);
  const [error, setError] = useState<string>();

  const applyLoaded = useCallback(
    (loaded: AgentGitHubLoaded) => {
      setAgent(loaded.agent);
      setEditor((current) =>
        loaded.view.kind === "ready"
          ? applyReadyView(current, loaded.view, agentId)
          : { ...current, view: loaded.view, pending: null },
      );
      setWorkspaceAgents(loaded.workspaceAgents);
      setImBindingId(loaded.imBindingId);
    },
    [agentId],
  );

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const loaded = await resolveAgentGitHub(agentId);
      applyLoaded(loaded);
    } catch (cause) {
      setEditor((current) => ({
        ...current,
        view: { kind: "error", message: errorMessage(cause, m.integrations_github_error_generic()) },
      }));
    }
  }, [agentId, applyLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (view.kind !== "ready" || view.nextCursor === null || busy) return;
    captureFocus();
    setAction("load-more");
    setCompleted(null);
    setMessage(m.integrations_agent_github_loading_more());
    setError(undefined);
    try {
      const page = await browserApi.githubRepositories(view.nextCursor);
      setEditor((current) => {
        if (current.view.kind !== "ready") return current;
        const next = {
          ...current.view,
          installations: page.installations,
          repositories: mergeRepositoryPages(current.view.repositories, page.repositories),
          nextCursor: page.nextCursor,
          truncated: current.view.truncated || (page.truncatedInstallations?.length ?? 0) > 0,
        };
        const verifiedIds = new Set([
          ...current.view.repositories
            .filter((repository) => !current.retainedIds.includes(repository.repositoryId))
            .map((repository) => repository.repositoryId),
          ...page.repositories.map((repository) => repository.repositoryId),
        ]);
        return applyReadyView(current, next, agentId, verifiedIds);
      });
      setCompleted("load-more");
    } catch (cause) {
      setMessage(undefined);
      setError(errorMessage(cause, m.integrations_github_error_generic()));
    } finally {
      setAction(null);
    }
  }

  async function refresh(): Promise<void> {
    if (busy) return;
    captureFocus();
    setAction("refresh");
    setCompleted(null);
    setError(undefined);
    setMessage(m.integrations_github_refreshing());
    try {
      const loaded = await resolveAgentGitHub(agentId);
      applyLoaded(loaded);
      setCompleted("refresh");
    } catch (cause) {
      setMessage(undefined);
      setError(errorMessage(cause, m.integrations_github_error_generic()));
    } finally {
      setAction(null);
    }
  }

  function updateDraft(repositoryId: string, update: (draft: Draft) => Draft): void {
    setMessage(undefined);
    setCompleted(null);
    setEditor((current) => ({
      ...current,
      drafts: current.drafts.map((draft) => (draft.repositoryId === repositoryId ? update(draft) : draft)),
      conflictIds: current.conflictIds.filter((id) => id !== repositoryId),
    }));
  }

  function toggleRepository(repository: GitHubDiscoveredRepository, selected: boolean): void {
    setMessage(undefined);
    setCompleted(null);
    setEditor((current) => ({
      ...current,
      ...toggleDraft(current, repository, selected, agentId),
      conflictIds: current.conflictIds.filter((id) => id !== repository.repositoryId),
    }));
  }

  async function save(): Promise<void> {
    if (view.kind !== "ready" || busy || saveDisabled) return;
    captureFocus();
    setAction("save");
    setCompleted(null);
    setMessage(undefined);
    setError(undefined);
    try {
      const bindings = mergeBindings(
        view.connection.bindings,
        agentId.toLowerCase(),
        drafts,
        new Set(view.repositories.map((repository) => repository.repositoryId)),
        () => crypto.randomUUID(),
      );
      const updated = await browserApi.updateGitHubBindings({
        expectedAuthorizationVersion: view.connection.authorizationVersion,
        bindings,
      });
      const submittedRoles = new Map(drafts.map((draft) => [draft.repositoryId, draft.role]));
      setEditor((current) =>
        current.view.kind === "ready"
          ? {
              ...current,
              view: { ...current.view, connection: updated },
              baseline: { ...current.view, connection: updated },
              conflictIds: [],
              drafts: current.drafts.map((draft) => ({
                ...draft,
                baselineRole: submittedRoles.get(draft.repositoryId) ?? null,
              })),
              disabled: current.disabled.map((draft) => ({
                ...draft,
                baselineRole: submittedRoles.get(draft.repositoryId) ?? null,
              })),
            }
          : current,
      );
      setCompleted("save");
    } catch (cause) {
      setError(errorMessage(cause, m.integrations_agent_github_error()));
    } finally {
      setAction(null);
    }
  }

  function connect(intent: "create" | "reauthorize" | "replace"): void {
    if (busy) return;
    captureFocus();
    setAction("authorize");
    setCompleted(null);
    setMessage(undefined);
    setError(undefined);
    void browserApi
      .startGitHubAuthorization({ intent, returnSurface: "agent-integrations", agentId })
      .then((started) => window.location.assign(started.authorizationUrl))
      .catch((cause) => {
        setError(errorMessage(cause, m.integrations_github_error_generic()));
        setAction(null);
      });
  }

  const agentName = agent?.displayName ?? m.integrations_agent_github_agent_unknown();
  const managedRepositoryIds =
    view.kind === "ready" ? new Set(view.repositories.map((repository) => repository.repositoryId)) : new Set<string>();
  const saveDisabled =
    view.kind !== "ready" ||
    editor.pending !== null ||
    blockedDraftIds(editor).length > 0 ||
    !bindingConfigurationChanged(view.connection.bindings, agentId.toLowerCase(), drafts, managedRepositoryIds);
  const dirtyIds = dirtyRepositoryIds(editor, agentId);
  const resultMessage = editorResultMessage(editor, completed, message, dirtyIds.size > 0);

  function discardForNewConnection() {
    if (busy || !editor.pending) return;
    const next = editor.pending;
    setEditor(applyReadyView({ ...emptyDraftState(), view: next }, next, agentId));
    setCompleted(null);
    setMessage(m.integrations_github_connection_changed());
    resultRef.current?.focus();
  }

  return (
    <section className="grid gap-4" aria-labelledby="agent-github-title" data-ui="agent-github-repositories">
      <div className="grid gap-1">
        <Text as="h1" id="agent-github-title" variant="heading">
          {m.integrations_agent_github_title()}
        </Text>
        <Text as="p" variant="secondary">
          {m.integrations_agent_github_description({ agent: agentName })}
        </Text>
      </div>

      {outcome ? (
        <Banner
          data-ui="agent-github-outcome"
          role="status"
          title={githubOAuthOutcomeMessage(outcome)}
          variant={outcome.kind === "success" ? "default" : "alert"}
        />
      ) : null}

      <AgentGitHubNotice busy={busy} onConnect={connect} onRetry={() => void refresh()} view={view} />

      <DraftWarnings
        editor={editor}
        dirtyIds={dirtyIds}
        onDiscard={discardForNewConnection}
        onRetry={() => void refresh()}
        busy={busy}
      />

      {view.kind === "ready" ? (
        <ReadyRepositories
          agentName={agentName}
          busy={busy}
          drafts={drafts}
          imBindingId={imBindingId}
          loadingMore={action === "load-more"}
          refreshing={action === "refresh"}
          saving={action === "save"}
          onLoadMore={() => void loadMore()}
          onRefresh={() => void refresh()}
          onSave={() => void save()}
          onToggleRepository={toggleRepository}
          onUpdateDraft={updateDraft}
          saveDisabled={saveDisabled}
          view={view}
          workspaceAgents={workspaceAgents}
        />
      ) : null}

      <p
        className="text-sm text-kumo-subtle"
        data-ui="agent-github-message"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        ref={resultRef}
        tabIndex={-1}
      >
        {resultMessage}
      </p>
      {error ? (
        <p className="text-sm text-kumo-danger" data-ui="agent-github-action-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The loading/error/unavailable/connect states that precede a ready repository list. */
function AgentGitHubNotice({
  busy,
  onConnect,
  onRetry,
  view,
}: {
  busy: boolean;
  onConnect: (intent: "create" | "reauthorize") => void;
  onRetry: () => void;
  view: View;
}) {
  if (view.kind === "loading") {
    return (
      <Text as="p" data-ui="agent-github-loading" variant="secondary">
        {m.integrations_agent_github_loading()}
      </Text>
    );
  }
  if (view.kind === "error") {
    return (
      <div className="grid gap-2" data-ui="agent-github-load-error">
        <Text as="p" variant="secondary">
          {view.message}
        </Text>
        <div>
          <Button disabled={busy} onClick={onRetry} type="button" variant="secondary">
            {m.common_try_again()}
          </Button>
        </div>
      </div>
    );
  }
  if (view.kind === "unavailable") {
    return (
      <div className="grid gap-1" data-ui="agent-github-unavailable">
        <Text as="p">
          <strong>{m.integrations_github_unavailable_title()}</strong>
        </Text>
        <Text as="p" variant="secondary">
          {m.integrations_github_unavailable_description()}
        </Text>
      </div>
    );
  }
  if (view.kind !== "needs-connection") return null;
  const connectPrompt =
    view.connection === null
      ? m.integrations_agent_github_connect_prompt()
      : view.connection.status === "pending"
        ? m.integrations_agent_github_pending_prompt()
        : m.integrations_agent_github_reauth_prompt();
  return (
    <div className="grid gap-2" data-ui="agent-github-needs-connection">
      <Text as="p" variant="secondary">
        {connectPrompt}
      </Text>
      <div>
        <Button
          disabled={busy}
          onClick={() => onConnect(view.connection === null ? "create" : "reauthorize")}
          type="button"
        >
          {view.connection === null ? m.integrations_github_connect() : m.integrations_github_reconnect()}
        </Button>
      </div>
    </div>
  );
}

/** The discovered repositories with their per-Agent scope editors and the save/pagination actions. */
function ReadyRepositories({
  agentName,
  busy,
  drafts,
  imBindingId,
  loadingMore,
  refreshing,
  saving,
  onLoadMore,
  onRefresh,
  onSave,
  onToggleRepository,
  onUpdateDraft,
  saveDisabled,
  view,
  workspaceAgents,
}: {
  agentName: string;
  busy: boolean;
  drafts: Draft[];
  imBindingId: string | undefined;
  loadingMore: boolean;
  refreshing: boolean;
  saving: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
  onSave: () => void;
  onToggleRepository: (repository: GitHubDiscoveredRepository, selected: boolean) => void;
  onUpdateDraft: (repositoryId: string, update: (draft: Draft) => Draft) => void;
  saveDisabled: boolean;
  view: Extract<View, { kind: "ready" }>;
  workspaceAgents: { id: string; displayName: string }[];
}) {
  return (
    <>
      <InstallationSummary
        busy={busy}
        refreshing={refreshing}
        installations={view.installations}
        onRefresh={onRefresh}
        repositories={view.repositories}
      />
      {view.truncated ? (
        <Banner role="status" title={m.integrations_agent_github_discovery_truncated()} variant="alert" />
      ) : null}
      {view.repositories.length === 0 ? (
        <Text as="p" data-ui="agent-github-no-repositories" variant="secondary">
          {m.integrations_agent_github_no_repositories()}
        </Text>
      ) : (
        <ul className="grid gap-3" data-ui="agent-github-repositories-list">
          {view.repositories.map((repository) => (
            <RepositoryRow
              agentName={agentName}
              draft={drafts.find((draft) => draft.repositoryId === repository.repositoryId)}
              imBindingId={imBindingId}
              installations={view.installations}
              key={repository.repositoryId}
              onChange={(update) => onUpdateDraft(repository.repositoryId, update)}
              onToggle={(selected) => onToggleRepository(repository, selected)}
              repository={repository}
              workspaceAgents={workspaceAgents}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {view.nextCursor === null ? null : (
          <Button disabled={busy} onClick={onLoadMore} type="button" variant="secondary">
            {loadingMore ? m.integrations_agent_github_loading_more() : m.integrations_agent_github_load_more()}
          </Button>
        )}
        <Button disabled={busy || saveDisabled} onClick={onSave} type="button">
          {saving ? m.integrations_agent_github_saving() : m.integrations_agent_github_save()}
        </Button>
      </div>
    </>
  );
}

function InstallationSummary({
  busy,
  refreshing,
  installations,
  onRefresh,
  repositories,
}: {
  busy: boolean;
  refreshing: boolean;
  installations: GitHubDiscoveredInstallation[];
  onRefresh: () => void;
  repositories: GitHubDiscoveredRepository[];
}) {
  return (
    <div className="grid gap-2">
      {installations.length === 0 ? (
        <Text as="p" data-ui="agent-github-no-installations" variant="secondary">
          {m.integrations_github_no_installations()}
        </Text>
      ) : (
        <ul className="flex flex-wrap gap-2" data-ui="agent-github-installations">
          {installations.map((installation) => {
            const count = repositories.filter((entry) => entry.installationId === installation.installationId).length;
            return (
              <li key={installation.installationId}>
                <Badge variant={installation.suspended ? "warning" : "neutral"}>
                  {installation.suspended
                    ? m.integrations_github_installation_suspended({ account: installation.accountLogin })
                    : m.integrations_agent_github_installation_label({
                        account: installation.accountLogin,
                      })}
                  {` · ${String(count)}`}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
      <GitHubInstallationActions busy={busy} refreshing={refreshing} onRefresh={onRefresh} />
    </div>
  );
}

function RepositoryRow({
  agentName,
  draft,
  imBindingId,
  installations,
  repository,
  workspaceAgents,
  onChange,
  onToggle,
}: {
  agentName: string;
  draft: Draft | undefined;
  imBindingId: string | undefined;
  installations: GitHubDiscoveredInstallation[];
  repository: GitHubDiscoveredRepository;
  workspaceAgents: { id: string; displayName: string }[];
  onChange: (update: (draft: Draft) => Draft) => void;
  onToggle: (selected: boolean) => void;
}) {
  const installation = installations.find((entry) => entry.installationId === repository.installationId);
  const canWrite = repository.permissions.push;

  return (
    <li className="ui-surface grid gap-3 bg-kumo-base p-4" data-ui="agent-github-repository">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Text as="span">
            <strong>{repository.fullName}</strong>
            {repository.private ? (
              <Badge className="ml-2" variant="secondary">
                {m.integrations_agent_github_private()}
              </Badge>
            ) : null}
          </Text>
          <Text as="span" variant="secondary">
            {installation
              ? m.integrations_agent_github_installation_label({ account: installation.accountLogin })
              : repository.installationId}
            {` · ${m.integrations_agent_github_permissions({
              level: canWrite
                ? m.integrations_agent_github_access_level_write()
                : m.integrations_agent_github_access_level_read(),
            })}`}
          </Text>
        </div>
        <Checkbox
          checked={draft !== undefined}
          data-ui="agent-github-repository-enable"
          label={m.integrations_agent_github_repository_use()}
          onCheckedChange={(checked) => onToggle(checked === true)}
        />
      </div>

      {draft ? (
        <ScopeEditor
          agentName={agentName}
          canWrite={canWrite}
          draft={draft}
          imBindingId={imBindingId}
          onChange={onChange}
          repositoryId={repository.repositoryId}
          workspaceAgents={workspaceAgents}
        />
      ) : null}
    </li>
  );
}

/** The exact rights one Agent gets on one repository. */
function ScopeEditor({
  agentName,
  canWrite,
  draft,
  imBindingId,
  onChange,
  repositoryId,
  workspaceAgents,
}: {
  agentName: string;
  canWrite: boolean;
  draft: Draft;
  imBindingId: string | undefined;
  onChange: (update: (draft: Draft) => Draft) => void;
  repositoryId: string;
  workspaceAgents: { id: string; displayName: string }[];
}) {
  const branchValid = draft.role !== "context_tree" || GitBranchRefSchema.safeParse(draft.branch).success;
  return (
    <div className="grid gap-3 border-t border-kumo-line pt-3" data-ui="agent-github-scope">
      <div className="grid gap-3 @min-[44rem]/content:grid-cols-3">
        <Field htmlFor={`role-${repositoryId}`} label={m.integrations_agent_github_role()}>
          <KumoSelectControl
            id={`role-${repositoryId}`}
            value={draft.role}
            onChange={(event) => {
              const role = event.currentTarget.value as GitHubRepositoryRole;
              onChange((current) => ({ ...current, role }));
            }}
          >
            <option value="code">{m.integrations_agent_github_role_code()}</option>
            <option value="context_tree">{m.integrations_agent_github_role_tree()}</option>
          </KumoSelectControl>
        </Field>
        <Field htmlFor={`access-${repositoryId}`} label={m.integrations_agent_github_access()}>
          <KumoSelectControl
            id={`access-${repositoryId}`}
            value={draft.access}
            onChange={(event) => {
              const access = event.currentTarget.value as GitHubRepositoryAccess;
              onChange((current) => ({ ...current, access }));
            }}
          >
            <option value="read">{m.integrations_agent_github_access_read()}</option>
            <option disabled={!canWrite} value="write">
              {m.integrations_agent_github_access_write()}
            </option>
          </KumoSelectControl>
        </Field>
        {draft.access === "write" ? (
          <Field htmlFor={`publish-${repositoryId}`} label={m.integrations_agent_github_publish()}>
            <KumoSelectControl
              id={`publish-${repositoryId}`}
              value={draft.publish}
              onChange={(event) => {
                const publish = event.currentTarget.value as GitHubRepositoryPublishMode;
                onChange((current) => ({ ...current, publish }));
              }}
            >
              <option value="pull_request">{m.integrations_agent_github_publish_pr()}</option>
              <option value="direct">{m.integrations_agent_github_publish_direct()}</option>
            </KumoSelectControl>
          </Field>
        ) : null}
        {draft.role === "context_tree" ? (
          <Field
            error={branchValid ? undefined : m.integrations_agent_github_branch_placeholder()}
            htmlFor={`branch-${repositoryId}`}
            label={m.integrations_agent_github_branch()}
          >
            <KumoInputControl
              id={`branch-${repositoryId}`}
              placeholder={m.integrations_agent_github_branch_placeholder()}
              value={draft.branch}
              onChange={(event) => {
                const branch = event.currentTarget.value;
                onChange((current) => ({ ...current, branch }));
              }}
            />
          </Field>
        ) : null}
      </div>
      {canWrite ? null : (
        <Text as="p" variant="secondary">
          {m.integrations_agent_github_read_only_note()}
        </Text>
      )}

      <DelegationEditor
        agentName={agentName}
        draft={draft}
        imBindingId={imBindingId}
        onChange={onChange}
        repositoryId={repositoryId}
        workspaceAgents={workspaceAgents}
      />
    </div>
  );
}

/** The owner's explicit "who may ask this Agent" list for one repository scope. */
function DelegationEditor({
  agentName,
  draft,
  imBindingId,
  onChange,
  repositoryId,
  workspaceAgents,
}: {
  agentName: string;
  draft: Draft;
  imBindingId: string | undefined;
  onChange: (update: (draft: Draft) => Draft) => void;
  repositoryId: string;
  workspaceAgents: { id: string; displayName: string }[];
}) {
  return (
    <div className="grid gap-2" data-ui="agent-github-delegation">
      <Text as="h3">{m.integrations_agent_github_delegation_title({ agent: agentName })}</Text>
      <Text as="p" variant="secondary">
        {m.integrations_agent_github_delegation_description({ agent: agentName })}
      </Text>
      {draft.sessionAgents.length === 0 && draft.imSenders.length === 0 ? (
        <Text as="p" variant="secondary">
          {m.integrations_agent_github_delegation_empty()}
        </Text>
      ) : null}

      <fieldset className="grid min-w-0 grid-cols-1 gap-1">
        <legend className="text-sm font-medium">{m.integrations_agent_github_delegation_agents()}</legend>
        {workspaceAgents.length === 0 ? (
          <Text as="p" variant="secondary">
            {m.integrations_agent_github_delegation_no_agents()}
          </Text>
        ) : (
          workspaceAgents.map((workspaceAgent) => (
            <Checkbox
              checked={draft.sessionAgents.includes(workspaceAgent.id)}
              data-ui="agent-github-delegation-agent"
              disabled={
                !draft.sessionAgents.includes(workspaceAgent.id) &&
                draft.sessionAgents.length >= GITHUB_AGENT_SCOPE_MAX_DELEGATED_SESSION_AGENTS
              }
              key={workspaceAgent.id}
              label={workspaceAgent.displayName}
              onCheckedChange={(checked) =>
                onChange((current) => ({
                  ...current,
                  sessionAgents:
                    checked === true
                      ? [...current.sessionAgents, workspaceAgent.id]
                      : current.sessionAgents.filter((id) => id !== workspaceAgent.id),
                }))
              }
            />
          ))
        )}
        {draft.sessionAgents
          .filter((id) => !workspaceAgents.some((agent) => agent.id === id))
          .map((id) => (
            <Checkbox
              key={id}
              checked
              label={m.integrations_agent_github_delegation_unavailable_agent({ id })}
              onCheckedChange={(checked) => {
                if (checked !== true) {
                  onChange((current) => ({
                    ...current,
                    sessionAgents: current.sessionAgents.filter((entry) => entry !== id),
                  }));
                  document
                    .querySelector<HTMLButtonElement>(`[role="combobox"][aria-labelledby="role-${repositoryId}-label"]`)
                    ?.focus();
                }
              }}
            />
          ))}
      </fieldset>

      <fieldset className="grid min-w-0 grid-cols-1 gap-2">
        <legend className="text-sm font-medium">{m.integrations_agent_github_delegation_senders()}</legend>
        {imBindingId === undefined ? (
          <Text as="p" variant="secondary">
            {m.integrations_agent_github_delegation_needs_binding()}
          </Text>
        ) : null}
        <DelegatedSenders draft={draft} imBindingId={imBindingId} onChange={onChange} repositoryId={repositoryId} />
      </fieldset>
    </div>
  );
}

function DelegatedSenders({
  draft,
  imBindingId,
  onChange,
  repositoryId,
}: {
  draft: Draft;
  imBindingId: string | undefined;
  onChange: (update: (draft: Draft) => Draft) => void;
  repositoryId: string;
}) {
  // Pending text belongs to the repository draft so refresh and off/on cannot erase it.
  const senderDraft = draft.pendingSender;
  const alreadyDelegated = draft.imSenders.some(
    (sender) => sender.bindingId === imBindingId && sender.senderId === senderDraft,
  );
  const senderValid =
    imBindingId !== undefined &&
    /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,254}$/.test(senderDraft) &&
    !alreadyDelegated &&
    draft.imSenders.length < GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS;
  return (
    <>
      <Text as="p" variant="secondary">
        {m.integrations_agent_github_delegation_senders_description()}
      </Text>
      {draft.imSenders.length > 0 ? (
        <ul className="flex flex-wrap gap-2" data-ui="agent-github-delegation-senders">
          {draft.imSenders.map((sender) => (
            <li className="min-w-0 max-w-full" key={`${sender.bindingId}:${sender.senderId}`}>
              <Button
                aria-label={m.integrations_agent_github_delegation_remove_sender({ sender: sender.senderId })}
                className="max-w-full"
                onClick={() => {
                  onChange((current) => ({
                    ...current,
                    imSenders: current.imSenders.filter(
                      (entry) => entry.bindingId !== sender.bindingId || entry.senderId !== sender.senderId,
                    ),
                  }));
                  document.getElementById(`sender-${repositoryId}`)?.focus();
                }}
                size="compact"
                type="button"
                variant="ghost"
              >
                <span className="min-w-0 truncate" title={sender.senderId}>{`${sender.senderId} ×`}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Field hideLabel htmlFor={`sender-${repositoryId}`} label={m.integrations_agent_github_delegation_senders()}>
          <KumoInputControl
            id={`sender-${repositoryId}`}
            placeholder={m.integrations_agent_github_delegation_sender_placeholder()}
            value={senderDraft}
            onChange={(event) => {
              const pendingSender = event.currentTarget.value;
              onChange((current) => ({ ...current, pendingSender }));
            }}
          />
        </Field>
        <Button
          disabled={!senderValid}
          onClick={() => {
            if (imBindingId === undefined) return;
            onChange((current) => ({
              ...current,
              imSenders: [...current.imSenders, { bindingId: imBindingId, senderId: senderDraft }],
              pendingSender: "",
            }));
          }}
          size="compact"
          type="button"
          variant="secondary"
        >
          {m.integrations_agent_github_delegation_add_sender()}
        </Button>
      </div>
    </>
  );
}
