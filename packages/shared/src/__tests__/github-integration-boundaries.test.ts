import { expect, it } from "vitest";
import * as contract from "../github-integration.js";

it("does not expose Agent repository assignment or delegation contracts", () => {
  for (const name of [
    "GitHubAgentScopeSchema",
    "GitHubRepositoryBindingsSchema",
    "UpdateGitHubConnectionBindingsRequestSchema",
    "githubAgentScopeAllowsTaskDelegation",
  ])
    expect(contract).not.toHaveProperty(name);
});
