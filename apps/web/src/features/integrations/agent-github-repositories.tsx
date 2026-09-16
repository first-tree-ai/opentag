import {
  type AgentDetail,
  canonicalizeGitHubRepositoryBindings,
  GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS,
  GITHUB_AGENT_SCOPE_MAX_DELEGATED_SESSION_AGENTS,
  GitBranchRefSchema,
  type GitHubAgentScope,
  type GitHubAgentScopeTaskDelegation,
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
  | {
      kind: "ready";
      connection: GitHubConnectionStatus;
      installations: GitHubDiscoveredInstallation[];
      repositories: GitHubDiscoveredRepository[];
      nextCursor: string | null;
    };

interface Draft {
  repositoryId: string;
  installationId: string;
  fullNameDisplay: string;
  role: GitHubRepositoryRole;
  access: GitHubRepositoryAccess;
  publish: GitHubRepositoryPublishMode;
  branch: string;
  sessionAgents: string[];
  imSenders: { bindingId: string; senderId: string }[];
}

function draftFromScope(
  repository: { installationId: string; repositoryId: string; fullName: string },
  scope: GitHubAgentScope,
): Draft {
  return {
    repositoryId: repository.repositoryId,
    installationId: repository.installationId,
    fullNameDisplay: repository.fullName,
    role: scope.role,
    access: scope.access,
    publish: scope.publish ?? "pull_request",
    branch: scope.branch ?? "refs/heads/master",
    sessionAgents: scope.taskDelegation?.sessionAgents ?? [],
    imSenders: scope.taskDelegation?.imSenders ?? [],
  };
}

/** The existing scope this Agent holds on one discovered repository, if any. */
function existingScope(bindings: GitHubRepositoryBinding[], agentId: string, repositoryId: string) {
  for (const binding of bindings) {
    if (binding.repositoryId !== repositoryId) continue;
    const scope = binding.agentScopes.find((entry) => entry.agentId === agentId);
    if (scope) return { binding, scope };
  }
  return undefined;
}

function draftScope(draft: Draft, agentId: string): GitHubAgentScope {
  /*
   * An empty delegation is written as an omitted property, not an explicit empty object: the two
   * are semantically identical (execution denied), and omission keeps an untouched scope byte-equal
   * to what the Server already stored, so the editor's change detection stays honest.
   */
  const delegation: GitHubAgentScopeTaskDelegation | undefined =
    draft.imSenders.length === 0 && draft.sessionAgents.length === 0
      ? undefined
      : {
          imSenders: draft.imSenders.map((sender) => ({ ...sender })),
          sessionAgents: [...draft.sessionAgents],
        };
  if (draft.access === "read") {
    // A context_tree scope requires its branch even when the Agent only reads the Tree.
    const scope: GitHubAgentScope = {
      agentId,
      role: draft.role,
      access: "read",
      ...(delegation ? { taskDelegation: delegation } : {}),
    };
    if (draft.role === "context_tree") scope.branch = draft.branch;
    return scope;
  }
  const scope: GitHubAgentScope = {
    agentId,
    role: draft.role,
    access: "write",
    publish: draft.publish,
    ...(delegation ? { taskDelegation: delegation } : {}),
  };
  if (draft.role === "context_tree") scope.branch = draft.branch;
  return scope;
}

/**
 * Replaces exactly this Agent's scopes for the repositories the editor actually loaded, while
 * preserving every other Agent's configuration and this Agent's scopes on repositories outside the
 * loaded pages (they are not visible to toggle, so a save must not silently drop them).
 *
 * Binding identity is stable: when this Agent was the only scope holder of a binding, the edited
 * scope keeps that binding's ID instead of being written under a fresh one.
 */
function mergeBindings(
  existing: GitHubRepositoryBinding[],
  agentId: string,
  drafts: Draft[],
  managedRepositoryIds: ReadonlySet<string>,
  newBindingId: () => string,
): GitHubRepositoryBinding[] {
  const ownBindingIdByRepository = new Map<string, string>();
  for (const binding of existing) {
    if (binding.agentScopes.some((scope) => scope.agentId === agentId)) {
      ownBindingIdByRepository.set(binding.repositoryId, binding.bindingId);
    }
  }
  const remaining = existing
    .map((binding) => ({
      ...binding,
      agentScopes: managedRepositoryIds.has(binding.repositoryId)
        ? binding.agentScopes.filter((scope) => scope.agentId !== agentId)
        : binding.agentScopes,
    }))
    .filter((binding) => binding.agentScopes.length > 0);
  for (const draft of drafts) {
    const scope = draftScope(draft, agentId);
    const target = remaining.find((binding) => binding.repositoryId === draft.repositoryId);
    if (target) {
      target.agentScopes = [...target.agentScopes, scope];
      continue;
    }
    remaining.push({
      bindingId: ownBindingIdByRepository.get(draft.repositoryId) ?? newBindingId(),
      installationId: draft.installationId,
      repositoryId: draft.repositoryId,
      fullNameDisplay: draft.fullNameDisplay,
      agentScopes: [scope],
    });
  }
  return remaining;
}

/** A stable placeholder for a not-yet-created binding; it never survives to a real write. */
const NEW_BINDING_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

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
    const merged = mergeBindings(existing, agentId, drafts, managedRepositoryIds, () => NEW_BINDING_PLACEHOLDER_ID);
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
  drafts: Draft[];
}

/** Everything the page needs for one Agent, in one trip: identity, connection, discovery, delegation. */
async function resolveAgentGitHub(agentId: string): Promise<AgentGitHubLoaded> {
  const [agent, overview] = await Promise.all([browserApi.agent(agentId), browserApi.githubIntegration()]);
  const empty: Omit<AgentGitHubLoaded, "view"> = {
    agent,
    workspaceAgents: [],
    imBindingId: undefined,
    drafts: [],
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
    },
    workspaceAgents: agentsResponse.agents
      .filter((entry) => entry.id !== agentId)
      .map((entry) => ({ id: entry.id, displayName: entry.displayName })),
    imBindingId: binding?.id,
    drafts: page.repositories.flatMap((repository) => {
      const held = existingScope(connection.bindings, agentId.toLowerCase(), repository.repositoryId);
      return held ? [draftFromScope(repository, held.scope)] : [];
    }),
  };
}

export function AgentGitHubRepositories({ agentId }: { agentId: string }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [outcome] = useState<GitHubOAuthOutcome | undefined>(() => readGitHubOAuthOutcome());
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [imBindingId, setImBindingId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const loaded = await resolveAgentGitHub(agentId);
      setAgent(loaded.agent);
      setView(loaded.view);
      setWorkspaceAgents(loaded.workspaceAgents);
      setImBindingId(loaded.imBindingId);
      setDrafts(loaded.drafts);
    } catch (cause) {
      setView({ kind: "error", message: errorMessage(cause, m.integrations_github_error_generic()) });
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (view.kind !== "ready" || view.nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await browserApi.githubRepositories(view.nextCursor);
      setView({
        ...view,
        installations: page.installations,
        repositories: [...view.repositories, ...page.repositories],
        nextCursor: page.nextCursor,
      });
    } catch (cause) {
      setError(errorMessage(cause, m.integrations_github_error_generic()));
    } finally {
      setLoadingMore(false);
    }
  }

  function updateDraft(repositoryId: string, update: (draft: Draft) => Draft): void {
    setMessage(undefined);
    setDrafts((current) => current.map((draft) => (draft.repositoryId === repositoryId ? update(draft) : draft)));
  }

  function toggleRepository(repository: GitHubDiscoveredRepository, selected: boolean): void {
    setMessage(undefined);
    setDrafts((current) => {
      if (!selected) return current.filter((draft) => draft.repositoryId !== repository.repositoryId);
      if (current.some((draft) => draft.repositoryId === repository.repositoryId)) return current;
      return [...current, emptyDraft(repository)];
    });
  }

  async function save(): Promise<void> {
    if (view.kind !== "ready" || busy) return;
    setBusy(true);
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
      setView({ ...view, connection: updated });
      setMessage(m.integrations_agent_github_saved());
    } catch (cause) {
      setError(errorMessage(cause, m.integrations_agent_github_error()));
    } finally {
      setBusy(false);
    }
  }

  function connect(intent: "create" | "reauthorize" | "replace"): void {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void browserApi
      .startGitHubAuthorization({ intent, returnSurface: "agent-integrations", agentId })
      .then((started) => window.location.assign(started.authorizationUrl))
      .catch((cause) => {
        setError(errorMessage(cause, m.integrations_github_error_generic()));
        setBusy(false);
      });
  }

  const agentName = agent?.displayName ?? m.integrations_agent_github_agent_unknown();
  const managedRepositoryIds =
    view.kind === "ready" ? new Set(view.repositories.map((repository) => repository.repositoryId)) : new Set<string>();
  const saveDisabled =
    view.kind !== "ready" ||
    !bindingConfigurationChanged(view.connection.bindings, agentId.toLowerCase(), drafts, managedRepositoryIds);

  return (
    <section className="grid gap-4" aria-labelledby="agent-github-title" data-ui="agent-github-repositories">
      <div className="grid gap-1">
        <Text as="h2" id="agent-github-title" variant="heading">
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

      <AgentGitHubNotice busy={busy} onConnect={connect} onRetry={() => void load()} view={view} />

      {view.kind === "ready" ? (
        <ReadyRepositories
          agentName={agentName}
          busy={busy}
          drafts={drafts}
          imBindingId={imBindingId}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
          onSave={() => void save()}
          onToggleRepository={toggleRepository}
          onUpdateDraft={updateDraft}
          saveDisabled={saveDisabled}
          view={view}
          workspaceAgents={workspaceAgents}
        />
      ) : null}

      {message ? (
        <p className="text-sm text-kumo-success" data-ui="agent-github-message" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kumo-danger" data-ui="agent-github-action-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function emptyDraft(repository: GitHubDiscoveredRepository): Draft {
  return {
    repositoryId: repository.repositoryId,
    installationId: repository.installationId,
    fullNameDisplay: repository.fullName,
    role: "code",
    access: "read",
    publish: "pull_request",
    branch: "refs/heads/master",
    sessionAgents: [],
    imSenders: [],
  };
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
          <Button onClick={onRetry} type="button" variant="secondary">
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
  onLoadMore,
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
  onLoadMore: () => void;
  onSave: () => void;
  onToggleRepository: (repository: GitHubDiscoveredRepository, selected: boolean) => void;
  onUpdateDraft: (repositoryId: string, update: (draft: Draft) => Draft) => void;
  saveDisabled: boolean;
  view: Extract<View, { kind: "ready" }>;
  workspaceAgents: { id: string; displayName: string }[];
}) {
  return (
    <>
      <InstallationSummary installations={view.installations} repositories={view.repositories} />
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
              key={`${repository.installationId}:${repository.repositoryId}`}
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
          <Button disabled={loadingMore} onClick={onLoadMore} type="button" variant="secondary">
            {loadingMore ? m.integrations_agent_github_loading_more() : m.integrations_agent_github_load_more()}
          </Button>
        )}
        <Button disabled={busy || saveDisabled} onClick={onSave} type="button">
          {busy ? m.integrations_agent_github_saving() : m.integrations_agent_github_save()}
        </Button>
      </div>
    </>
  );
}

function InstallationSummary({
  installations,
  repositories,
}: {
  installations: GitHubDiscoveredInstallation[];
  repositories: GitHubDiscoveredRepository[];
}) {
  if (installations.length === 0) {
    return (
      <Text as="p" data-ui="agent-github-no-installations" variant="secondary">
        {m.integrations_github_no_installations()}
      </Text>
    );
  }
  return (
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
    <li className="grid gap-3 rounded-lg border border-kumo-line p-4" data-ui="agent-github-repository">
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
            onChange={(event) =>
              onChange((current) => ({ ...current, role: event.currentTarget.value as GitHubRepositoryRole }))
            }
          >
            <option value="code">{m.integrations_agent_github_role_code()}</option>
            <option value="context_tree">{m.integrations_agent_github_role_tree()}</option>
          </KumoSelectControl>
        </Field>
        <Field htmlFor={`access-${repositoryId}`} label={m.integrations_agent_github_access()}>
          <KumoSelectControl
            id={`access-${repositoryId}`}
            value={draft.access}
            onChange={(event) =>
              onChange((current) => ({ ...current, access: event.currentTarget.value as GitHubRepositoryAccess }))
            }
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
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  publish: event.currentTarget.value as GitHubRepositoryPublishMode,
                }))
              }
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
              onChange={(event) => onChange((current) => ({ ...current, branch: event.currentTarget.value }))}
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

      <fieldset className="grid gap-1">
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
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{m.integrations_agent_github_delegation_senders()}</legend>
        {imBindingId === undefined ? (
          <Text as="p" variant="secondary">
            {m.integrations_agent_github_delegation_needs_binding()}
          </Text>
        ) : (
          <DelegatedSenders draft={draft} imBindingId={imBindingId} onChange={onChange} repositoryId={repositoryId} />
        )}
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
  imBindingId: string;
  onChange: (update: (draft: Draft) => Draft) => void;
  repositoryId: string;
}) {
  // Each repository row owns its input; a value typed for one scope never appears in another.
  const [senderDraft, setSenderDraft] = useState("");
  const alreadyDelegated = draft.imSenders.some(
    (sender) => sender.bindingId === imBindingId && sender.senderId === senderDraft,
  );
  const senderValid =
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
            <li key={`${sender.bindingId}:${sender.senderId}`}>
              <Button
                aria-label={m.integrations_agent_github_delegation_remove_sender({ sender: sender.senderId })}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    imSenders: current.imSenders.filter(
                      (entry) => entry.bindingId !== sender.bindingId || entry.senderId !== sender.senderId,
                    ),
                  }))
                }
                size="compact"
                type="button"
                variant="ghost"
              >
                {`${sender.senderId} ×`}
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
            onChange={(event) => setSenderDraft(event.currentTarget.value)}
          />
        </Field>
        <Button
          disabled={!senderValid}
          onClick={() => {
            onChange((current) => ({
              ...current,
              imSenders: [...current.imSenders, { bindingId: imBindingId, senderId: senderDraft }],
            }));
            setSenderDraft("");
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
