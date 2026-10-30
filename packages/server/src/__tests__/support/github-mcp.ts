import type { DatabaseClient } from "../../db/client.js";
import { AgentGitHubCredentialService } from "../../services/github/agent-github-credential-service.js";
import { GitHubApiClient } from "../../services/github/github-api-client.js";
import { GITHUB_MCP_ISSUER } from "../../services/mcp/github-authorization.js";
import { sharedMcpFixture } from "./mcp-shared-authorization.js";

export async function githubMcpFixture(database: DatabaseClient) {
  const f = await sharedMcpFixture(database, {
    issuer: GITHUB_MCP_ISSUER,
    url: "https://api.githubcopilot.com/mcp/",
    scopes: ["repo"],
    clientId: "github-client",
  });
  const api = new GitHubApiClient({
    clientId: "github-client",
    clientSecret: "test-secret",
    redirectUri: "https://opentag.example.test/callback",
    fetch: async () => {
      throw new Error("Unexpected GitHub API request");
    },
  });
  const github = new AgentGitHubCredentialService({
    database,
    authorization: f.auth,
    api,
    configured: true,
    trustedClient: (...args) => f.flows.reusableClient(...args),
  });
  return { ...f, api, github };
}
