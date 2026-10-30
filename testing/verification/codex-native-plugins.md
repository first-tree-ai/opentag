# Local Codex native plugins

Supports the [Codex native configuration contract](../../docs/system/runtime/agent-runtime-contract.md#local-codex-native-configuration-and-trust),
[Agent permissions](../../docs/system/runtime/agent-permissions.md), and
[Codex MCP composition](../../docs/system/capabilities/mcp-server-integration.md#codex-rebinding-the-thread-per-run).

## Native process acceptance

Run from the repository root with a preinstalled Codex CLI:

```bash
pnpm exec turbo run build --filter='@opentag/client^...'
pnpm --filter @opentag/client build
pnpm --filter @opentag/client test:e2e:codex-native-plugins
```

Set `OPENTAG_CODEX_COMMAND` to select an executable. The harness uses the built Client adapter,
real Codex App Server processes, a temporary local marketplace, isolated temporary homes/projects,
and deterministic Responses API and MCP fixtures on loopback. No account login, provider key,
external model response, production Server, or existing user configuration is used. The fixture
model asks the real CLI to call tools; successful catalog discovery alone does not pass.

Checks:

- Install a native plugin with `codex plugin marketplace add` and `codex plugin add`. Enable it in
  the existing project's native config with user-wide enablement off. A sibling project retains
  the user MCP but does not inherit this project's plugin or Skill context.
- Call the user MCP named `opentag-mcp`, dynamic plugin HTTP MCP, plugin stdio MCP, private execution
  gateway, and hosted tool. Native stdio MCP and shell execution receive a custom environment variable.
- Discover a unique native plugin Skill marker in the model context. Existing history may retain
  its earlier text after disablement; this is not evidence of current plugin activation.
- Rotate execution gateway tokens across Runs on the same runtime/binding. A Run without a gateway
  removes its tools while preserving native direct and plugin services.
- HTTP 401 and nonresponding required gateway handshakes restore healthy native-only tools and
  complete the Run. This fixture uses a three-second adapter budget and one-second native startup.
- Cancel a pending handshake, consume its late native response, and complete a healthy Run using
  the same runtime and binding afterward.
- Before any completed Turn, cancel three successful but delayed replacement creations and then
  complete a healthy first Run. Confirm that every abandoned native thread was already unsubscribed
  and that late replies do not change the current binding. This case uses a real App Server with
  observed RPC replies; the rest of the smoke uses the default factory process path. The unit
  regression also delivers all three late replies in reverse order after the healthy Run completes.
- In a workspace-write, network-disabled runtime, connect to exact execution Unix sockets across
  two successive configurations and remove the execution profile on a later Run. Native/plugin MCP
  and hosted tools continue working. Unit tests additionally verify exact profile content, rotation,
  removal, and failure when Codex does not acknowledge the profile.
- With an execution socket profile active, honor native `features.plugins=false`, then restore
  native plugin loading when the project re-enables it. The required network-proxy feature does
  not replace other native feature choices.
- Preserve user/project configuration bytes during adapter Runs, before intentional fixture edits.
  Known fixture project-trust entries are initialized before the snapshot: native Codex may itself
  record project trust when entering a new project.
- Scan every file in the isolated Codex Home, including rollouts and native state, for every fixture
  execution bearer. None is persisted. All temporary fixture resources are removed afterward.

### Recorded local result

2026-10-30: passed on macOS, Node.js 24.20.0, `codex-cli 0.165.0`.

- 13 completed Runs, three cancelled first Runs, and one cancelled persisted attach.
- 27 native HTTP MCP calls, 10 native stdio MCP calls, and 13 hosted tool calls.
- Gateway rotation, removal, 401/timeout recovery, and cancellation recovery passed.
- Native plugin disablement, sibling isolation, socket coexistence, and native feature preservation passed.
- Binding preserved; adapter configuration snapshots unchanged; no fixture bearer persisted.
- All three late first-Run replacements lost their native subscriptions without displacing the
  healthy binding. `thread/loaded/list` alone is not an orphan assertion because native Codex keeps
  unsubscribed threads during its inactivity grace period.

The fixture includes a native plugin hook definition without approving its hash. Native
`hooks/list` reports its `sessionStart` definition with `trustStatus=untrusted`; its execution marker
remains absent. This verifies discovery and preservation of native hook trust enforcement. Trusted hook execution through App Server
has **not** been validated by this smoke. OpenTag does not bypass trust or write native hook trust
state. Review definitions with the installed CLI's native `/hooks` flow; compatibility depends on
that Codex version and the hook. See the official [hook guide](https://learn.chatgpt.com/docs/hooks)
and [plugin guide](https://developers.openai.com/plugins/build/plugins).

This result establishes Client/native-CLI composition with controlled model and tool responses.
It does not establish real provider authentication, real-model task quality, IM delivery, deployment,
Server-side gateway revocation, every Codex version, or every plugin's headless compatibility.

## Regression scope

- Codex launch restrictions, environment preservation, private MCP keys/grants, token rotation,
  native-only restoration, cancellation replies, socket profiles, and history/binding behavior.
- Local Codex managed instructions and CLI runtime inspection environment parity; Pi's filter stays intact.
- Client Agent Runtime coverage: 781 tests passed, with statements, branches, functions, and lines at 100%.
- CLI runtime probe/preparation: 49 tests passed; managed-instruction and MCP credential environment: 30 passed.
- Native Git/gh sandbox fixtures with real Codex and gh: 9 passed, 2 Linux-only cases skipped on macOS.
- Client/CLI type checks, Client build, and `pnpm check` passed.

CI owns the complete repository matrix. This record is not a deployment or merge receipt.
