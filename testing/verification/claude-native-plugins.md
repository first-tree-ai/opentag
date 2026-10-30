# Local Claude native plugins

Supports the native configuration boundary in [Agent permissions](../../docs/system/runtime/agent-permissions.md),
the [Claude MCP composition](../../docs/system/capabilities/mcp-server-integration.md#claude-code-native-configuration),
and [Agent Skills delivery](../../docs/system/capabilities/agent-skills.md#delivery-to-the-computer).

## Native process acceptance

Run from the repository root with a preinstalled Claude Code CLI:

```bash
pnpm exec turbo run build --filter='@opentag/client^...'
pnpm --filter @opentag/client build
pnpm --filter @opentag/client test:e2e:claude-code-native-plugins
```

Set `OPENTAG_CLAUDE_COMMAND` to select a particular executable. This is a manual native-process smoke,
not a unit test or an installation step for the user's own plugins.

The harness runs the built Client adapter against the real Claude executable. It installs a project
plugin from a temporary local marketplace, uses isolated temporary home/configuration directories,
and serves deterministic Anthropic and MCP responses on loopback. It does not use an account login,
real provider key, external model response, or production Server. The fixture's model responses ask
the real CLI to call native and hosted tools; successful discovery alone does not pass the test.

Checks:

- Native project plugin hooks run and see a custom operator environment variable.
- A project Skill is discovered once; an external packaged Skill remains available through the
  `opentag` plugin.
- A user MCP server named `opentag-mcp` keeps its endpoint, while the platform gateway is loaded as
  `plugin:opentag:opentag-mcp`. The plugin's own MCP server also remains callable.
- Each of two Runs calls the user MCP, plugin MCP, platform gateway, and hosted tool. The two Runs
  use different fixture gateway tokens through the same adapter instance.
- Disabling the native plugin in project settings stops its hook and removes its tool on the next
  Run, while the user and platform MCP services remain available.
- A sibling working directory does not inherit the first project's plugin or local MCP service.
- The adapter does not rewrite the user's project settings or MCP configuration. All fixture
  resources are removed after the test.

### Recorded local result

2026-10-30: passed on macOS, Node.js 24.20.0, Claude Code 2.1.210.

```json
{
  "ok": true,
  "version": "2.1.210 (Claude Code)",
  "reports": [
    { "phase": "enabled-one", "nativePluginLoaded": true, "userMcpLoaded": true },
    { "phase": "enabled-two", "nativePluginLoaded": true, "userMcpLoaded": true },
    { "phase": "disabled", "nativePluginLoaded": false, "userMcpLoaded": true },
    { "phase": "sibling", "nativePluginLoaded": false, "userMcpLoaded": false }
  ],
  "nativeMcpCalls": 6,
  "hostedCalls": 2,
  "projectSkillLoadedOnce": true,
  "hookCount": 2,
  "sharedFilesUnchanged": true
}
```

This establishes Client/native-CLI composition with controlled model and tool responses. It does
not establish real provider authentication, real-model task quality, IM delivery, deployment,
Server gateway revocation, or every third-party plugin's headless compatibility.

## Regression scope

- Claude runtime, native setting sources, environment preservation, permission callbacks, hosted
  bridge namespace, project Skill deduplication, and native model-option tests.
- Local composition, including default/custom Claude homes and unchanged Codex/Pi paths.
- Existing CLI `runtime-inspect`, including preserved custom plugin variables and unchanged
  Codex/Pi environment filters.
- Client Agent Runtime coverage, Client/CLI type checks, Client build, and `pnpm check`.

CI owns the complete repository matrix. This record is not a deployment or merge receipt.
