# GitHub MCP connector: verification and acceptance

Supports [MCP Server integration](../../docs/system/capabilities/mcp-server-integration.md).
GitHub uses the ordinary per-Agent OAuth, probe, and gateway paths. Reusing an OAuth App
does not copy the Account integration's token or share a credential across Agents.

## Local coverage

- Catalog validation checks the official endpoint, explicit OAuth scopes, and toolsets.
- Configuration tests cover a complete pair, a missing half, secret redaction, and independence
  from the existing Account GitHub integration configuration.
- OAuth service tests cover the path-bearing GitHub issuer, client-secret POST at callback and
  refresh, refusal to disclose client credentials to a foreign origin, and missing configuration.
- Existing MCP lifecycle, gateway, and Web directory suites cover the unchanged consumers.

## Staging acceptance

Record the PR head, deployed Server revision, Agent/runtime, OAuth App client ID, and the
GitHub user ID selected during authorization. Never record tokens, client secrets, callback
codes/state, browser cookies, or private message contents.

Use the standard Agent Connectors > Discover > GitHub flow, including the real OAuth callback
and capability probe. GitHub writes must run through the deployed MCP gateway; native git/gh
or direct API writes cannot substitute for this acceptance. Independent read-only GitHub
queries may verify the resulting objects and identities.

The authorized target is `first-tree-ai/opentag`, a public repository. Prefix test Issue and
Draft PR titles with `[MCP staging test]`, use a unique `test/github-mcp-<run-id>` branch, and
change only a disposable fixture on that branch. Do not merge the test PR.

| Scenario | Required evidence |
| --- | --- |
| Identity | MCP `get_me` matches the GitHub user selected for this Agent's OAuth flow. |
| Issue read/write | Create, edit, comment, and read back the test Issue; GitHub author IDs match that user. |
| Code commit | Create the test branch and call `push_files`; read back file content, SHA, and associated author/committer identities. |
| PR read/write | Create and edit the Draft PR, comment, and read its diff; verify author identity and the exact head SHA. |
| Agent isolation | Another Agent without the mount cannot call its tools. Removing the mount denies subsequent MCP calls. |
| Cleanup | Close the test Issue and PR; retain URLs, commit SHAs, and redacted invocation evidence. |

Success requires all three business capabilities: Issue read/write, PR read/write, and a code
commit attributed to the authorized GitHub user. A successful HTTP response, a display name,
or a signature badge alone does not prove identity. Report any unresolved attribution as
partial. These public-repository checks do not prove private access or elapsed-time refresh.
