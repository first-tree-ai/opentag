import { describe, expect, it } from "vitest";
import {
  CreateGitHubConnectionRequestSchema,
  GitHubDecimalIdSchema,
  GitHubRepositoryBindingsSchema,
  GitHubVersionStringSchema,
} from "../github-integration.js";

const agentId = "abcdef12-1234-4234-8234-123456789abc";

function treeBinding(bindingId: string, repositoryId: string, scopeAgentId: string) {
  return {
    bindingId,
    installationId: "123",
    repositoryId,
    fullNameDisplay: "owner/tree",
    agentScopes: [{ agentId: scopeAgentId, role: "context_tree", access: "read", branch: "refs/heads/master" }],
  };
}

describe("GitHub integration authorization boundaries", () => {
  it("rejects a duplicate Agent repository role across installations", () => {
    const first = {
      ...treeBinding("aabbccdd-1234-4234-8234-123456789abc", "1", agentId),
      agentScopes: [{ agentId, role: "code", access: "read" }],
    };
    const second = { ...first, bindingId: "aabbccdd-1234-4234-8234-123456789abd", installationId: "124" };
    expect(GitHubRepositoryBindingsSchema.safeParse([first, second]).success).toBe(false);
  });
  it("does not accept an unsupported host namespace in the GitHub.com-only integration", () => {
    expect(
      CreateGitHubConnectionRequestSchema.safeParse({ githubHost: "enterprise.example.com", appId: "123" }).success,
    ).toBe(false);
  });
  it.each(["invalid", "1e3", "1.2", "", "-1", "0xFF", "Infinity", "1/2"])(
    "reports malformed decimal input %j as validation failure",
    (value) => {
      expect(GitHubDecimalIdSchema.safeParse(value).success).toBe(false);
      expect(GitHubVersionStringSchema.safeParse(value).success).toBe(false);
    },
  );

  it("cannot assign two Trees to one PostgreSQL UUID through letter-case aliases", () => {
    const bindings = [
      treeBinding("aabbccdd-1234-4234-8234-123456789abc", "1", agentId),
      treeBinding("aabbccdd-1234-4234-8234-123456789abd", "2", agentId.toUpperCase()),
    ];
    expect(GitHubRepositoryBindingsSchema.safeParse(bindings).success).toBe(false);
  });

  it("rejects duplicate binding UUIDs regardless of letter case", () => {
    const first = treeBinding("aabbccdd-1234-4234-8234-123456789abc", "1", agentId);
    const second = treeBinding(first.bindingId.toUpperCase(), "2", "abcdef12-1234-4234-8234-123456789abd");
    expect(GitHubRepositoryBindingsSchema.safeParse([first, second]).success).toBe(false);
  });
});
