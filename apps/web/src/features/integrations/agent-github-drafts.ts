import type {
  GitHubAgentScope,
  GitHubAgentScopeTaskDelegation,
  GitHubConnectionStatus,
  GitHubDiscoveredInstallation,
  GitHubDiscoveredRepository,
  GitHubRepositoryAccess,
  GitHubRepositoryBinding,
  GitHubRepositoryPublishMode,
  GitHubRepositoryRole,
} from "@opentag/shared/browser";
import { canonicalizeGitHubRepositoryBindings, GitHubAgentScopeSchema } from "@opentag/shared/browser";

export interface Draft {
  repositoryId: string;
  installationId: string;
  fullNameDisplay: string;
  role: GitHubRepositoryRole;
  access: GitHubRepositoryAccess;
  publish: GitHubRepositoryPublishMode;
  branch: string;
  sessionAgents: string[];
  imSenders: { bindingId: string; senderId: string }[];
  pendingSender: string;
  baselineRole: GitHubRepositoryRole | null;
}

export interface ReadyRepositoryView {
  kind: "ready";
  connection: GitHubConnectionStatus;
  installations: GitHubDiscoveredInstallation[];
  repositories: GitHubDiscoveredRepository[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface DraftState {
  baseline: ReadyRepositoryView | null;
  drafts: Draft[];
  disabled: Draft[];
  retainedIds: string[];
  conflictIds: string[];
  pending: ReadyRepositoryView | null;
}

export function emptyDraftState(): DraftState {
  return { baseline: null, drafts: [], disabled: [], retainedIds: [], conflictIds: [], pending: null };
}

/** Compare editable scope values even when a partially typed branch is not yet valid. */
function draftSignature(draft: Draft | undefined): string {
  if (!draft) return "disabled";
  return JSON.stringify({
    role: draft.role,
    access: draft.access,
    publish: draft.publish,
    branch: draft.branch,
    sessionAgents: [...draft.sessionAgents].sort(),
    imSenders: [...draft.imSenders].sort((a, b) =>
      `${a.bindingId}:${a.senderId}`.localeCompare(`${b.bindingId}:${b.senderId}`),
    ),
    pendingSender: draft.pendingSender,
  });
}

function heldDraft(
  view: ReadyRepositoryView,
  agentId: string,
  repository: GitHubDiscoveredRepository,
  role?: GitHubRepositoryRole | null,
): Draft | undefined {
  if (role === null) return undefined;
  const held = existingScope(view.connection.bindings, agentId.toLowerCase(), repository.repositoryId, role);
  return held ? draftFromScope(repository, held.scope) : undefined;
}

export function scopeConfiguration(scope: GitHubAgentScope): string {
  return canonicalizeGitHubRepositoryBindings([
    {
      bindingId: "00000000-0000-4000-8000-000000000001",
      installationId: "1",
      repositoryId: "1",
      fullNameDisplay: "comparison/repository",
      agentScopes: [scope],
    },
  ]);
}

function alignBaselineRole(
  draft: Draft,
  view: ReadyRepositoryView,
  agentId: string,
  repository: GitHubDiscoveredRepository,
): Draft {
  if (
    draft.baselineRole !== null &&
    existingScope(view.connection.bindings, agentId.toLowerCase(), repository.repositoryId, draft.baselineRole)
  )
    return draft;
  const saved = existingScope(view.connection.bindings, agentId.toLowerCase(), repository.repositoryId, draft.role);
  const scope = GitHubAgentScopeSchema.safeParse(draftScope(draft, agentId.toLowerCase()));
  return saved && scope.success && scopeConfiguration(saved.scope) === scopeConfiguration(scope.data)
    ? { ...draft, baselineRole: draft.role }
    : draft;
}

export function dirtyRepositoryIds(state: DraftState, agentId: string): Set<string> {
  if (!state.baseline) return new Set();
  return new Set(
    state.baseline.repositories
      .filter(
        (repository) =>
          draftSignature(state.drafts.find((draft) => draft.repositoryId === repository.repositoryId)) !==
          draftSignature(
            heldDraft(
              state.baseline as ReadyRepositoryView,
              agentId,
              repository,
              state.drafts.find((draft) => draft.repositoryId === repository.repositoryId)?.baselineRole,
            ),
          ),
      )
      .map((repository) => repository.repositoryId),
  );
}

function sameConnection(a: GitHubConnectionStatus, b: GitHubConnectionStatus): boolean {
  return (
    a.id === b.id &&
    a.accountId === b.accountId &&
    a.appId === b.appId &&
    a.githubHost === b.githubHost &&
    a.githubUserId === b.githubUserId
  );
}

export function mergeRepositoryPages(
  previous: GitHubDiscoveredRepository[],
  next: GitHubDiscoveredRepository[],
): GitHubDiscoveredRepository[] {
  const entries = new Map(previous.map((repository) => [repository.repositoryId, repository]));
  for (const repository of next) entries.set(repository.repositoryId, repository);
  return [...entries.values()];
}

/** Rebase untouched scopes, preserve every local edit (including explicit removals), and retain edited rows not yet rediscovered. */
export function reconcileDrafts(
  state: DraftState,
  next: ReadyRepositoryView,
  agentId: string,
  verifiedIds = new Set(next.repositories.map((repository) => repository.repositoryId)),
): DraftState {
  const dirtyIds = dirtyRepositoryIds(state, agentId);
  const previous = state.baseline;
  if (previous && !sameConnection(previous.connection, next.connection)) {
    if (dirtyIds.size > 0) return { ...state, pending: next };
    state = emptyDraftState();
  }
  const retained =
    previous?.repositories.filter(
      (repository) => dirtyIds.has(repository.repositoryId) && !verifiedIds.has(repository.repositoryId),
    ) ?? [];
  const repositories = mergeRepositoryPages(
    next.repositories.filter((repository) => verifiedIds.has(repository.repositoryId)),
    retained,
  );
  const baseline = { ...next, repositories };
  const drafts = repositories.flatMap((repository) => {
    const selected = dirtyIds.has(repository.repositoryId)
      ? state.drafts.find((draft) => draft.repositoryId === repository.repositoryId)
      : (heldDraft(
          baseline,
          agentId,
          repository,
          state.drafts.find((draft) => draft.repositoryId === repository.repositoryId)?.baselineRole,
        ) ?? heldDraft(baseline, agentId, repository));
    return selected
      ? [
          {
            ...alignBaselineRole(selected, baseline, agentId, repository),
            installationId: repository.installationId,
            fullNameDisplay: repository.fullName,
          },
        ]
      : [];
  });
  const conflicts = repositories
    .filter(
      (repository) =>
        dirtyIds.has(repository.repositoryId) &&
        previous &&
        savedScopeSignature(previous, agentId, repository) !== savedScopeSignature(next, agentId, repository),
    )
    .map((repository) => repository.repositoryId);
  const result: DraftState = {
    baseline,
    drafts,
    disabled: state.disabled,
    retainedIds: retained.map((repository) => repository.repositoryId),
    conflictIds: [...new Set([...state.conflictIds, ...conflicts])].filter((id) => dirtyIds.has(id)),
    pending: null,
  };
  const remainingDirty = dirtyRepositoryIds(result, agentId);
  return { ...result, conflictIds: result.conflictIds.filter((id) => remainingDirty.has(id)) };
}

function savedScopeSignature(
  view: ReadyRepositoryView,
  agentId: string,
  repository: GitHubDiscoveredRepository,
): string {
  return JSON.stringify(
    view.connection.bindings
      .filter((binding) => binding.repositoryId === repository.repositoryId)
      .flatMap((binding) => binding.agentScopes.filter((scope) => scope.agentId === agentId.toLowerCase()))
      .map((scope) => draftSignature(draftFromScope(repository, scope)))
      .sort(),
  );
}

/** Off/on is a reversible selection edit; it must not erase the fields already entered for a scope. */
export function toggleDraft(
  state: DraftState,
  repository: GitHubDiscoveredRepository,
  selected: boolean,
  agentId: string,
): DraftState {
  const current = state.drafts.find((draft) => draft.repositoryId === repository.repositoryId);
  if (!selected) {
    return {
      ...state,
      drafts: state.drafts.filter((draft) => draft.repositoryId !== repository.repositoryId),
      disabled: current
        ? [...state.disabled.filter((draft) => draft.repositoryId !== repository.repositoryId), current]
        : state.disabled,
    };
  }
  if (current) return state;
  const restored =
    state.disabled.find((draft) => draft.repositoryId === repository.repositoryId) ??
    (state.baseline ? heldDraft(state.baseline, agentId, repository) : undefined) ??
    emptyDraft(repository);
  return {
    ...state,
    drafts: [
      ...state.drafts,
      { ...restored, installationId: repository.installationId, fullNameDisplay: repository.fullName },
    ],
  };
}

export function blockedDraftIds(state: DraftState): string[] {
  const view = state.baseline;
  if (!view) return [];
  return state.drafts
    .filter((draft) => {
      const repository = view.repositories.find((entry) => entry.repositoryId === draft.repositoryId);
      return (
        state.retainedIds.includes(draft.repositoryId) ||
        !repository ||
        !repository.permissions.pull ||
        (draft.access === "write" && !repository.permissions.push) ||
        view.installations.some(
          (installation) => installation.installationId === draft.installationId && installation.suspended,
        )
      );
    })
    .map((draft) => draft.repositoryId);
}

export function draftFromScope(
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
    pendingSender: "",
    baselineRole: scope.role,
  };
}

/** The existing scope this Agent holds on one discovered repository, if any. */
export function existingScope(
  bindings: GitHubRepositoryBinding[],
  agentId: string,
  repositoryId: string,
  role?: GitHubRepositoryRole,
) {
  for (const binding of bindings) {
    if (binding.repositoryId !== repositoryId) continue;
    const scope = binding.agentScopes.find(
      (entry) => entry.agentId === agentId && (role === undefined || entry.role === role),
    );
    if (scope) return { binding, scope };
  }
  return undefined;
}

export function draftScope(draft: Draft, agentId: string): GitHubAgentScope {
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

export function emptyDraft(repository: GitHubDiscoveredRepository): Draft {
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
    pendingSender: "",
    baselineRole: null,
  };
}
