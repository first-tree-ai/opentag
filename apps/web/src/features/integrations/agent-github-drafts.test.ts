import type { GitHubAgentScope, GitHubConnectionStatus } from "@opentag/shared/browser";
import { expect, it } from "vitest";
import {
  blockedDraftIds,
  type Draft,
  type DraftState,
  dirtyRepositoryIds,
  draftScope,
  emptyDraftState,
  mergeRepositoryPages,
  type ReadyRepositoryView,
  reconcileDrafts,
  toggleDraft,
} from "./agent-github-drafts.js";

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const connection: GitHubConnectionStatus = {
  id: "3c63a21e-f6c7-4474-91ea-4dabf0566a24",
  accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  githubHost: "github.com",
  appId: "871235",
  githubUserId: "42",
  githubLogin: "octocat",
  status: "active",
  bindingsSchemaVersion: 1,
  bindings: [],
  authorizationVersion: "2",
  credentialGeneration: "1",
  accessExpiresAt: "2026-10-13T16:00:00.000Z",
  refreshExpiresAt: "2027-03-16T00:00:00.000Z",
  recheckRequired: false,
  nextRecheckAt: null,
  lastVerifiedAt: "2026-10-13T00:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};
const installation = {
  installationId: "55123456",
  accountLogin: "octocat",
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
} as const;
const repository = {
  installationId: installation.installationId,
  repositoryId: "987654321",
  fullName: "octocat/hello-world",
  private: true,
  defaultBranch: "main",
  permissions: { pull: true, push: true },
};
const page = { installations: [installation], repositories: [repository], nextCursor: null };

function ready(
  scope: Partial<GitHubAgentScope> = {},
  overrides: Partial<ReadyRepositoryView> = {},
): ReadyRepositoryView {
  return {
    kind: "ready",
    ...page,
    truncated: false,
    connection: {
      ...connection,
      bindings: [
        {
          bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000001",
          installationId: installation.installationId,
          repositoryId: repository.repositoryId,
          fullNameDisplay: repository.fullName,
          agentScopes: [{ agentId: AGENT_ID, role: "code", access: "read", ...scope }],
        },
      ],
    },
    ...overrides,
  };
}
function initial(view = ready()) {
  return reconcileDrafts(emptyDraftState(), view, AGENT_ID);
}
function edit(state: DraftState, fields: Partial<Draft>): DraftState {
  return { ...state, drafts: state.drafts.map((draft) => ({ ...draft, ...fields })) };
}

it("has no phantom dirty or blocked repositories before discovery", () => {
  expect([...dirtyRepositoryIds(emptyDraftState(), AGENT_ID)]).toEqual([]);
  expect(blockedDraftIds(emptyDraftState())).toEqual([]);
});

it.each([
  ["branch", "refs/heads/local"],
  ["publish", "direct"],
] as const)("preserves an inactive %s field instead of erasing it on refresh", (field, value) => {
  const state = edit(initial(), { [field]: value });
  expect([...dirtyRepositoryIds(state, AGENT_ID)]).toEqual([repository.repositoryId]);
  const refreshed = reconcileDrafts(state, ready(), AGENT_ID);
  expect(refreshed.drafts[0]?.[field]).toBe(value);
});

it("keeps an incomplete branch as a dirty draft", () => {
  const state = edit(initial(ready({ role: "context_tree", branch: "refs/heads/main" })), { branch: "still-typing" });
  expect(
    reconcileDrafts(state, ready({ role: "context_tree", branch: "refs/heads/main" }), AGENT_ID).drafts[0]?.branch,
  ).toBe("still-typing");
});

it("adopts fresh persisted fields when the local scope has not changed", () => {
  const state = initial();
  const refreshed = reconcileDrafts(state, ready({ access: "write", publish: "direct" }), AGENT_ID);
  expect(refreshed.drafts[0]).toMatchObject({ access: "write", publish: "direct" });
  expect([...dirtyRepositoryIds(refreshed, AGENT_ID)]).toEqual([]);
});

it("compares delegation sets without mutating stored arrays or treating order as a local edit", () => {
  const scope = {
    taskDelegation: {
      sessionAgents: [AGENT_ID, connection.accountId],
      imSenders: [
        { bindingId: connection.id, senderId: "ou_b" },
        { bindingId: connection.id, senderId: "ou_a" },
      ],
    },
  };
  const state = initial(ready(scope));
  const original = structuredClone(state);
  const changedOrder = edit(state, {
    sessionAgents: [...scope.taskDelegation.sessionAgents].reverse(),
    imSenders: [...scope.taskDelegation.imSenders].reverse(),
  });
  expect([...dirtyRepositoryIds(changedOrder, AGENT_ID)]).toEqual([]);
  expect(state).toEqual(original);
});

it("retains explicit removal of an undiscovered scope without requiring access to grant it again", () => {
  const state = toggleDraft(initial(), repository, false, AGENT_ID);
  const refreshed = reconcileDrafts(state, ready({}, { repositories: [] }), AGENT_ID);
  expect(refreshed.retainedIds).toEqual([repository.repositoryId]);
  expect(refreshed.drafts).toEqual([]);
  expect(blockedDraftIds(refreshed)).toEqual([]);
});

it("keeps a selected missing draft blocked until a later page verifies it", () => {
  const state = edit(initial(), { branch: "refs/heads/local" });
  const retained = reconcileDrafts(state, ready({}, { repositories: [], nextCursor: "next" }), AGENT_ID);
  expect(blockedDraftIds(retained)).toEqual([repository.repositoryId]);
  const restored = reconcileDrafts(retained, ready(), AGENT_ID, new Set([repository.repositoryId]));
  expect(restored.retainedIds).toEqual([]);
  expect(restored.drafts[0]?.branch).toBe("refs/heads/local");
  expect(blockedDraftIds(restored)).toEqual([]);
});

it.each([
  { id: "4c63a21e-f6c7-4474-91ea-4dabf0566a24" },
  { accountId: "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e" },
  { appId: "871236" },
  { githubUserId: "43" },
  { githubHost: "other.example" },
])("holds dirty drafts apart from a changed identity %j", (identity) => {
  const state = edit(initial(), { pendingSender: "ou_unsaved" });
  const next = ready({}, { connection: { ...connection, ...identity } });
  const held = reconcileDrafts(state, next, AGENT_ID);
  expect(held.pending).toBe(next);
  expect(held.baseline).toBe(state.baseline);
  expect(held.drafts[0]?.pendingSender).toBe("ou_unsaved");
});

it("switches a clean editor to a replacement identity and clears cached scopes from the old identity", () => {
  let state = initial();
  state = toggleDraft(state, repository, false, AGENT_ID);
  state = toggleDraft(state, repository, true, AGENT_ID);
  const next = ready({}, { connection: { ...connection, id: "4c63a21e-f6c7-4474-91ea-4dabf0566a24" } });
  const switched = reconcileDrafts(state, next, AGENT_ID);
  expect(switched.pending).toBeNull();
  expect(switched.baseline?.connection.id).toBe(next.connection.id);
  expect(switched.drafts).toEqual([]);
  expect(switched.disabled).toEqual([]);
});

it.each(["pull", "push"] as const)("blocks unsupported %s access without rewriting the draft", (permission) => {
  const state = edit(initial(), { access: "write" });
  const updated = ready(
    {},
    { repositories: [{ ...repository, permissions: { pull: permission !== "pull", push: permission !== "push" } }] },
  );
  const refreshed = reconcileDrafts(state, updated, AGENT_ID);
  expect(blockedDraftIds(refreshed)).toEqual([repository.repositoryId]);
  expect(refreshed.drafts[0]?.access).toBe("write");
});

it("deduplicates paginated repositories and prefers fresh identity metadata", () => {
  const renamed = { ...repository, fullName: "another/name" };
  expect(mergeRepositoryPages([repository], [renamed, renamed])).toEqual([renamed]);
});

it("never serializes pending sender text as an authorized sender", () => {
  const state = edit(initial(), { pendingSender: "ou_not_added" });
  const draft = state.drafts[0];
  if (!draft) throw new Error("Expected a selected draft");
  expect(draftScope(draft, AGENT_ID)).toEqual({ agentId: AGENT_ID, role: "code", access: "read" });
});

it("recognizes a new selection already persisted by a later server response", () => {
  const initialView = ready({}, { connection });
  const selected = toggleDraft(initial(initialView), repository, true, AGENT_ID);
  const updated = reconcileDrafts(selected, ready(), AGENT_ID);
  expect(updated.drafts[0]?.baselineRole).toBe("code");
  expect([...dirtyRepositoryIds(updated, AGENT_ID)]).toEqual([]);
  expect(updated.conflictIds).toEqual([]);
});

it.each([false, true])(
  "tracks a converted role without deleting an existing source role (source still present=%s)",
  (present) => {
    const edited = edit(initial(), { role: "context_tree", branch: "refs/heads/local" });
    const next = ready({ role: "context_tree", branch: "refs/heads/local" });
    if (present) next.connection.bindings[0]?.agentScopes.push({ agentId: AGENT_ID, role: "code", access: "read" });
    const updated = reconcileDrafts(edited, next, AGENT_ID);
    expect(updated.drafts[0]?.baselineRole).toBe(present ? "code" : "context_tree");
    expect(dirtyRepositoryIds(updated, AGENT_ID).size).toBe(present ? 1 : 0);
  },
);

it("keeps the represented role when the server reorders multiple grants", () => {
  const original = ready({ role: "context_tree", branch: "refs/heads/main" });
  original.connection.bindings[0]?.agentScopes.push({ agentId: AGENT_ID, role: "code", access: "read" });
  const next = structuredClone(original);
  next.connection.bindings[0]?.agentScopes.reverse();
  const updated = reconcileDrafts(initial(original), next, AGENT_ID);
  expect(updated.drafts[0]?.role).toBe("context_tree");
  expect(dirtyRepositoryIds(updated, AGENT_ID).size).toBe(0);
});
