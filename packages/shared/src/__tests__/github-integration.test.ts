import { describe, expect, it } from "vitest";
import {
  BeginGitHubAuthorizationRequestSchema,
  CreateGitHubConnectionRequestSchema,
  canonicalizeGitHubRepositoryBindings,
  GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS,
  GITHUB_AGENT_SCOPE_MAX_DELEGATED_SESSION_AGENTS,
  GITHUB_REPOSITORY_BINDINGS_MAX_AGENT_SCOPES,
  GITHUB_REPOSITORY_BINDINGS_MAX_BYTES,
  GITHUB_REPOSITORY_BINDINGS_MAX_REPOSITORIES,
  GitBranchRefSchema,
  GitHubAgentScopeSchema,
  GitHubAgentScopeTaskDelegationSchema,
  GitHubConnectionStatusSchema,
  GitHubDecimalIdSchema,
  GitHubDelegatedImSenderIdSchema,
  GitHubOAuthContextSchema,
  GitHubRepositoryBindingSchema,
  GitHubRepositoryBindingsSchema,
  GitHubVersionStringSchema,
  githubAgentScopeAllowsTaskDelegation,
  isValidGitRefName,
  UpdateGitHubConnectionBindingsRequestSchema,
} from "../github-integration.js";

const AGENT_ONE = "3f6c8f8e-2f4c-4b7e-9f9d-9a3f4f0a0001";
const AGENT_TWO = "3f6c8f8e-2f4c-4b7e-9f9d-9a3f4f0a0002";
const BINDING_ONE = "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000001";
const BINDING_TWO = "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000002";

function codeBinding(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000001",
    installationId: "12345",
    repositoryId: "67890",
    fullNameDisplay: "team/service",
    agentScopes: [{ agentId: AGENT_ONE, role: "code", access: "write", publish: "pull_request" }],
    ...overrides,
  };
}

function treeScope(agentId: string) {
  return { agentId, role: "context_tree", access: "write", publish: "direct", branch: "refs/heads/master" };
}

describe("GitHubDecimalIdSchema", () => {
  it("accepts positive decimal strings inside the PostgreSQL bigint range", () => {
    expect(GitHubDecimalIdSchema.parse("1")).toBe("1");
    expect(GitHubDecimalIdSchema.parse("9223372036854775807")).toBe("9223372036854775807");
  });

  it.each(["0", "-1", "01", "1.5", "abc", "", "1e3", "9223372036854775808", "12345678901234567890123456790"])(
    "rejects %j",
    (value) => {
      expect(GitHubDecimalIdSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("GitHubVersionStringSchema", () => {
  it("accepts zero and positive versions inside the bigint range", () => {
    expect(GitHubVersionStringSchema.parse("0")).toBe("0");
    expect(GitHubVersionStringSchema.parse("9223372036854775807")).toBe("9223372036854775807");
  });

  it.each(["-1", "00", " 1", "1 ", "9223372036854775808", 5, null])("rejects %j", (value) => {
    expect(GitHubVersionStringSchema.safeParse(value).success).toBe(false);
  });
});

describe("isValidGitRefName", () => {
  it.each(["refs/heads/master", "refs/heads/feature/tree-sync", "refs/tags/v1.2.3", "a"])("accepts %j", (ref) => {
    expect(isValidGitRefName(ref)).toBe(true);
  });

  it.each([
    "",
    "refs//heads",
    "refs/heads/",
    "/refs/heads/master",
    "refs/heads/master/",
    "refs/heads/mas..ter",
    "refs/heads/master.lock",
    "refs/heads/.hidden",
    "refs/.heads/master",
    "refs/heads/mas ter",
    "refs/heads/mas~ter",
    "refs/heads/mas^ter",
    "refs/heads/mas:ter",
    "refs/heads/mas?ter",
    "refs/heads/mas*ter",
    "refs/heads/mas[ter",
    "refs/heads/mas\\ter",
    "refs/heads/master.",
    "@",
    "refs/heads/@{1}",
    "refs/heads/master",
  ])("rejects %j", (ref) => {
    expect(isValidGitRefName(ref)).toBe(false);
  });
});

describe("GitBranchRefSchema", () => {
  it("requires a fully qualified valid branch ref, not a short name", () => {
    expect(GitBranchRefSchema.parse("refs/heads/master")).toBe("refs/heads/master");
    expect(GitBranchRefSchema.safeParse("master").success).toBe(false);
    expect(GitBranchRefSchema.safeParse("refs/tags/v1").success).toBe(false);
    expect(GitBranchRefSchema.safeParse("refs/heads/").success).toBe(false);
    expect(GitBranchRefSchema.safeParse("refs/heads/bad..name").success).toBe(false);
  });
});

describe("GitHubAgentScopeSchema", () => {
  it("represents read explicitly: access read with no publish property", () => {
    const scope = GitHubAgentScopeSchema.parse({ agentId: AGENT_ONE, role: "code", access: "read" });
    expect(scope).toEqual({ agentId: AGENT_ONE, role: "code", access: "read" });
    expect("publish" in scope).toBe(false);
  });

  it("rejects a read scope requesting a write publish mode, even as null", () => {
    expect(
      GitHubAgentScopeSchema.safeParse({ agentId: AGENT_ONE, role: "code", access: "read", publish: "direct" }).success,
    ).toBe(false);
    expect(
      GitHubAgentScopeSchema.safeParse({ agentId: AGENT_ONE, role: "code", access: "read", publish: null }).success,
    ).toBe(false);
  });

  it("requires an explicit publish mode for write scopes", () => {
    expect(GitHubAgentScopeSchema.safeParse({ agentId: AGENT_ONE, role: "code", access: "write" }).success).toBe(false);
  });

  it("requires a Tree branch for context_tree and rejects it for code", () => {
    expect(GitHubAgentScopeSchema.safeParse({ agentId: AGENT_ONE, role: "context_tree", access: "read" }).success).toBe(
      false,
    );
    expect(
      GitHubAgentScopeSchema.safeParse({
        agentId: AGENT_ONE,
        role: "code",
        access: "read",
        branch: "refs/heads/master",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      GitHubAgentScopeSchema.safeParse({ agentId: AGENT_ONE, role: "code", access: "read", token: "x" }).success,
    ).toBe(false);
  });

  it("preserves older scopes without task delegation: the property stays absent", () => {
    const scope = GitHubAgentScopeSchema.parse({ agentId: AGENT_ONE, role: "code", access: "read" });
    expect("taskDelegation" in scope).toBe(false);
    expect(githubAgentScopeAllowsTaskDelegation(scope, { sourceAgentId: AGENT_TWO })).toBe(false);
  });
});

describe("GitHubAgentScopeTaskDelegationSchema", () => {
  it("accepts explicit sender and session-Agent lists and normalizes their UUID case", () => {
    const delegation = GitHubAgentScopeTaskDelegationSchema.parse({
      imSenders: [{ bindingId: BINDING_ONE.toUpperCase(), senderId: "ou_human_1" }],
      sessionAgents: [AGENT_TWO.toUpperCase()],
    });
    expect(delegation).toEqual({
      imSenders: [{ bindingId: BINDING_ONE, senderId: "ou_human_1" }],
      sessionAgents: [AGENT_TWO],
    });
  });

  it("accepts the explicit empty delegation that denies execution", () => {
    expect(GitHubAgentScopeTaskDelegationSchema.safeParse({ imSenders: [], sessionAgents: [] }).success).toBe(true);
  });

  it("requires both lists, so a partial delegation is not silently defaulted", () => {
    expect(GitHubAgentScopeTaskDelegationSchema.safeParse({ imSenders: [] }).success).toBe(false);
    expect(GitHubAgentScopeTaskDelegationSchema.safeParse({ sessionAgents: [] }).success).toBe(false);
  });

  it("rejects duplicate sender pairs and duplicate session Agents", () => {
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({
        imSenders: [
          { bindingId: BINDING_ONE, senderId: "ou_human" },
          { bindingId: BINDING_ONE.toUpperCase(), senderId: "ou_human" },
        ],
        sessionAgents: [],
      }).success,
    ).toBe(false);
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({
        imSenders: [],
        sessionAgents: [AGENT_ONE, AGENT_ONE.toUpperCase()],
      }).success,
    ).toBe(false);
    // The same sender identity through two different Account-owned bindings is a distinct entry.
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({
        imSenders: [
          { bindingId: BINDING_ONE, senderId: "ou_human" },
          { bindingId: BINDING_TWO, senderId: "ou_human" },
        ],
        sessionAgents: [],
      }).success,
    ).toBe(true);
  });

  it("enforces both list bounds", () => {
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({
        imSenders: Array.from({ length: GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS + 1 }, (_, index) => ({
          bindingId: BINDING_ONE,
          senderId: `ou_sender_${index}`,
        })),
        sessionAgents: [],
      }).success,
    ).toBe(false);
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({
        imSenders: [],
        sessionAgents: Array.from(
          { length: GITHUB_AGENT_SCOPE_MAX_DELEGATED_SESSION_AGENTS + 1 },
          (_, index) => `3f6c8f8e-2f4c-4b7e-9f9d-${String(index).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields, unbounded sender shapes, and a non-UUID binding", () => {
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({ imSenders: [], sessionAgents: [], all: true }).success,
    ).toBe(false);
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({
        imSenders: [{ bindingId: BINDING_ONE, senderId: "ou human" }],
        sessionAgents: [],
      }).success,
    ).toBe(false);
    expect(
      GitHubAgentScopeTaskDelegationSchema.safeParse({
        imSenders: [{ bindingId: "not-a-uuid", senderId: "ou_human" }],
        sessionAgents: [],
      }).success,
    ).toBe(false);
    expect(GitHubDelegatedImSenderIdSchema.safeParse("").success).toBe(false);
    expect(GitHubDelegatedImSenderIdSchema.safeParse("U12345").success).toBe(true);
  });

  it("keeps the scope byte budget as the only overall bound", () => {
    const delegation = {
      imSenders: Array.from({ length: GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS }, (_, index) => ({
        bindingId: BINDING_ONE,
        senderId: `ou_sender_${index}`,
      })),
      sessionAgents: [AGENT_ONE],
    };
    const binding = GitHubRepositoryBindingSchema.parse(
      codeBinding({ agentScopes: [{ agentId: AGENT_ONE, role: "code", access: "read", taskDelegation: delegation }] }),
    );
    expect(binding.agentScopes[0]?.taskDelegation?.imSenders).toHaveLength(GITHUB_AGENT_SCOPE_MAX_DELEGATED_IM_SENDERS);
    expect(GitHubRepositoryBindingsSchema.safeParse([binding]).success).toBe(true);
  });
});

describe("githubAgentScopeAllowsTaskDelegation", () => {
  const scope = GitHubAgentScopeSchema.parse({
    agentId: AGENT_ONE,
    role: "code",
    access: "read",
    taskDelegation: {
      imSenders: [{ bindingId: BINDING_ONE, senderId: "ou_human" }],
      sessionAgents: [AGENT_TWO],
    },
  });

  it("allows only the exact delegated messaging identity", () => {
    expect(
      githubAgentScopeAllowsTaskDelegation(scope, { imSender: { bindingId: BINDING_ONE, senderId: "ou_human" } }),
    ).toBe(true);
    expect(
      githubAgentScopeAllowsTaskDelegation(scope, { imSender: { bindingId: BINDING_TWO, senderId: "ou_human" } }),
    ).toBe(false);
    expect(
      githubAgentScopeAllowsTaskDelegation(scope, { imSender: { bindingId: BINDING_ONE, senderId: "ou_other" } }),
    ).toBe(false);
  });

  it("allows only the exact delegated source Agent, case-insensitively", () => {
    expect(githubAgentScopeAllowsTaskDelegation(scope, { sourceAgentId: AGENT_TWO })).toBe(true);
    expect(githubAgentScopeAllowsTaskDelegation(scope, { sourceAgentId: AGENT_TWO.toUpperCase() })).toBe(true);
    expect(githubAgentScopeAllowsTaskDelegation(scope, { sourceAgentId: AGENT_ONE })).toBe(false);
  });

  it("denies when the runtime has no trusted identity to match", () => {
    expect(githubAgentScopeAllowsTaskDelegation(scope, {})).toBe(false);
    const scopeWithoutDelegation = GitHubAgentScopeSchema.parse({ agentId: AGENT_ONE, role: "code", access: "read" });
    expect(githubAgentScopeAllowsTaskDelegation(scopeWithoutDelegation, { sourceAgentId: AGENT_TWO })).toBe(false);
  });
});

describe("GitHubRepositoryBindingsSchema", () => {
  it("accepts the design example shape in camelCase", () => {
    const bindings = GitHubRepositoryBindingsSchema.parse([
      codeBinding(),
      {
        bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000002",
        installationId: "12345",
        repositoryId: "67891",
        fullNameDisplay: "team/context-tree",
        agentScopes: [treeScope(AGENT_ONE)],
      },
    ]);
    expect(bindings).toHaveLength(2);
  });

  it("rejects duplicate binding IDs and duplicate installation/repository pairs", () => {
    const first = codeBinding();
    const second = codeBinding({ repositoryId: "67891" });
    expect(GitHubRepositoryBindingsSchema.safeParse([first, { ...second, bindingId: first.bindingId }]).success).toBe(
      false,
    );
    expect(
      GitHubRepositoryBindingsSchema.safeParse([
        first,
        codeBinding({ bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000009" }),
      ]).success,
    ).toBe(false);
  });

  it("rejects the same repository under a different installation when the pair repeats", () => {
    const first = codeBinding();
    const repeatedPair = codeBinding({ bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f00000a" });
    expect(GitHubRepositoryBindingsSchema.safeParse([first, repeatedPair]).success).toBe(false);
  });

  it("rejects a duplicated Agent/repo/role grant inside one binding", () => {
    const binding = codeBinding({
      agentScopes: [
        { agentId: AGENT_ONE, role: "code", access: "read" },
        { agentId: AGENT_ONE, role: "code", access: "write", publish: "direct" },
      ],
    });
    expect(GitHubRepositoryBindingsSchema.safeParse([binding]).success).toBe(false);
  });

  it("allows one Agent code and context_tree roles across multiple Trees", () => {
    const ok = GitHubRepositoryBindingsSchema.safeParse([
      codeBinding(),
      {
        bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000003",
        installationId: "12345",
        repositoryId: "67891",
        fullNameDisplay: "team/context-tree",
        agentScopes: [treeScope(AGENT_ONE)],
      },
    ]);
    expect(ok.success).toBe(true);

    const twoTrees = GitHubRepositoryBindingsSchema.safeParse([
      codeBinding({ agentScopes: [treeScope(AGENT_ONE)] }),
      {
        bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000004",
        installationId: "12345",
        repositoryId: "67891",
        fullNameDisplay: "team/other-tree",
        agentScopes: [treeScope(AGENT_ONE)],
      },
    ]);
    expect(twoTrees.success).toBe(true);

    const otherAgentsTree = GitHubRepositoryBindingsSchema.safeParse([
      codeBinding({ agentScopes: [treeScope(AGENT_ONE)] }),
      {
        bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000005",
        installationId: "12345",
        repositoryId: "67891",
        fullNameDisplay: "team/other-tree",
        agentScopes: [treeScope(AGENT_TWO)],
      },
    ]);
    expect(otherAgentsTree.success).toBe(true);
  });

  it("enforces the repository, scope, and byte budgets", () => {
    const tooManyRepos = Array.from({ length: GITHUB_REPOSITORY_BINDINGS_MAX_REPOSITORIES + 1 }, (_, index) =>
      codeBinding({
        bindingId: `9f0f2f6c-2f5c-4d43-a9fb-${String(index).padStart(12, "0")}`,
        repositoryId: String(67890 + index),
      }),
    );
    expect(GitHubRepositoryBindingsSchema.safeParse(tooManyRepos).success).toBe(false);

    const manyScopes = codeBinding({
      agentScopes: Array.from({ length: GITHUB_REPOSITORY_BINDINGS_MAX_AGENT_SCOPES + 1 }, (_, index) => ({
        agentId: `3f6c8f8e-2f4c-4b7e-9f9d-${String(index).padStart(12, "0")}`,
        role: "code",
        access: "read",
      })),
    });
    expect(GitHubRepositoryBindingsSchema.safeParse([manyScopes]).success).toBe(false);

    const hugeName = `team/${"r".repeat(240)}`;
    const oversized = Array.from({ length: Math.ceil(GITHUB_REPOSITORY_BINDINGS_MAX_BYTES / 300) }, (_, index) =>
      codeBinding({
        bindingId: `9f0f2f6c-2f5c-4d43-a9fb-1${String(index).padStart(11, "0")}`,
        repositoryId: String(100000 + index),
        fullNameDisplay: hugeName,
      }),
    );
    const result = GitHubRepositoryBindingsSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("UTF-8 bytes"))).toBe(true);
    }
  });

  it("rejects unknown fields and non-decimal IDs inside bindings", () => {
    expect(GitHubRepositoryBindingSchema.safeParse({ ...codeBinding(), encryptedToken: "x" }).success).toBe(false);
    expect(GitHubRepositoryBindingSchema.safeParse(codeBinding({ installationId: "0123" })).success).toBe(false);
    expect(GitHubRepositoryBindingSchema.safeParse(codeBinding({ repositoryId: "repo" })).success).toBe(false);
    expect(GitHubRepositoryBindingSchema.safeParse(codeBinding({ fullNameDisplay: "no-slash" })).success).toBe(false);
  });
});

describe("canonicalizeGitHubRepositoryBindings", () => {
  it("normalizes key order so semantically equal configurations hash identically", () => {
    const binding = GitHubRepositoryBindingSchema.parse(codeBinding());
    const reordered = {
      fullNameDisplay: binding.fullNameDisplay,
      repositoryId: binding.repositoryId,
      installationId: binding.installationId,
      bindingId: binding.bindingId,
      agentScopes: binding.agentScopes.map((scope) => ({
        publish: scope.publish,
        access: scope.access,
        role: scope.role,
        agentId: scope.agentId,
      })),
    };
    expect(canonicalizeGitHubRepositoryBindings([binding])).toBe(
      canonicalizeGitHubRepositoryBindings([reordered] as never),
    );
  });
});

describe("GitHubOAuthContextSchema", () => {
  const base = {
    flowId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000aa",
    intent: "create",
    phase: "awaiting_callback",
    loginSessionHash: "a".repeat(64),
    returnSurface: "account-integrations",
    expiresAt: "2026-09-16T00:10:00.000Z",
    claimedAt: null,
  };

  it("accepts the awaiting and claimed phases with a consistent claim time", () => {
    expect(GitHubOAuthContextSchema.parse(base).phase).toBe("awaiting_callback");
    expect(
      GitHubOAuthContextSchema.parse({ ...base, phase: "claimed", claimedAt: "2026-09-16T00:05:00.000Z" }).phase,
    ).toBe("claimed");
  });

  it("rejects inconsistent claim pairs, unknown fields, and off-whitelist return surfaces", () => {
    expect(GitHubOAuthContextSchema.safeParse({ ...base, phase: "claimed" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, claimedAt: "2026-09-16T00:05:00.000Z" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, pkceVerifier: "secret" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, returnSurface: "evil.example.com" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, loginSessionHash: "not-hex" }).success).toBe(false);
  });

  it("defaults a missing return Agent to null and fences the Agent deep link by surface", () => {
    expect(GitHubOAuthContextSchema.parse(base).agentId).toBeNull();
    expect(
      GitHubOAuthContextSchema.parse({
        ...base,
        returnSurface: "agent-integrations",
        agentId: "9F0F2F6C-2F5C-4D43-A9FB-9A1C9F0000DD",
      }).agentId,
    ).toBe("9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000dd");
    expect(
      GitHubOAuthContextSchema.safeParse({ ...base, agentId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000dd" }).success,
    ).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, returnSurface: "agent-integrations" }).success).toBe(false);
  });
});

describe("GitHubConnectionStatusSchema", () => {
  it("accepts a nonsecret active status DTO and rejects secret-bearing shapes", () => {
    const dto = {
      id: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000bb",
      accountId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000cc",
      githubHost: "github.com",
      appId: "987654",
      githubUserId: "42",
      githubLogin: "octocat",
      status: "active",
      bindingsSchemaVersion: 1,
      bindings: [codeBinding()],
      authorizationVersion: "7",
      credentialGeneration: "3",
      accessExpiresAt: "2026-09-16T08:00:00.000Z",
      refreshExpiresAt: "2027-03-16T00:00:00.000Z",
      recheckRequired: false,
      nextRecheckAt: "2026-09-16T00:30:00.000Z",
      lastVerifiedAt: "2026-09-16T00:00:00.000Z",
      lastErrorCode: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    };
    expect(GitHubConnectionStatusSchema.parse(dto).authorizationVersion).toBe("7");
    expect(GitHubConnectionStatusSchema.safeParse({ ...dto, credentialCiphertext: "x" }).success).toBe(false);
    expect(GitHubConnectionStatusSchema.safeParse({ ...dto, credentialKeyId: "k" }).success).toBe(false);
    expect(GitHubConnectionStatusSchema.safeParse({ ...dto, oauthStateHash: "h" }).success).toBe(false);
    expect(
      GitHubConnectionStatusSchema.safeParse({ ...dto, authorizationVersion: "9223372036854775808" }).success,
    ).toBe(false);
  });
});

describe("management request DTOs", () => {
  it("defaults the host and return surface on create and rejects unknown fields", () => {
    expect(CreateGitHubConnectionRequestSchema.parse({ appId: "1234" })).toEqual({
      githubHost: "github.com",
      appId: "1234",
      returnSurface: "account-integrations",
      agentId: null,
    });
    expect(CreateGitHubConnectionRequestSchema.safeParse({ appId: "1234", clientSecret: "x" }).success).toBe(false);
    expect(
      CreateGitHubConnectionRequestSchema.safeParse({
        appId: "1234",
        returnSurface: "agent-integrations",
        agentId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000dd",
      }).success,
    ).toBe(true);
    expect(
      CreateGitHubConnectionRequestSchema.safeParse({ appId: "1234", returnSurface: "agent-integrations" }).success,
    ).toBe(false);
  });

  it("fences bindings updates with the observed authorization version", () => {
    const request = UpdateGitHubConnectionBindingsRequestSchema.parse({
      expectedAuthorizationVersion: "7",
      bindings: [codeBinding()],
    });
    expect(request.expectedAuthorizationVersion).toBe("7");
    expect(
      UpdateGitHubConnectionBindingsRequestSchema.safeParse({
        expectedAuthorizationVersion: "-1",
        bindings: [],
      }).success,
    ).toBe(false);
    expect(
      UpdateGitHubConnectionBindingsRequestSchema.safeParse({
        expectedAuthorizationVersion: "7",
        bindings: [codeBinding()],
        allow: true,
      }).success,
    ).toBe(false);
  });

  it("restricts begin-authorization intents to reauthorize and replace", () => {
    expect(BeginGitHubAuthorizationRequestSchema.parse({ intent: "replace" }).returnSurface).toBe(
      "account-integrations",
    );
    expect(BeginGitHubAuthorizationRequestSchema.safeParse({ intent: "create" }).success).toBe(false);
  });
});
