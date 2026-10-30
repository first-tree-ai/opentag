# Local Pi native resources

Supports the [Pi native resource contract](../../docs/system/runtime/agent-runtime-contract.md#local-pi-native-resources-and-trust),
[Agent permissions](../../docs/system/runtime/agent-permissions.md), and
[Pi MCP composition](../../docs/system/capabilities/mcp-server-integration.md#pi-and-cloud-runtime-delivery).

## Native process acceptance

```bash
pnpm exec turbo run build --filter='@opentag/client^...'
pnpm --filter @opentag/client build
pnpm --filter @opentag/client test:e2e:pi-native-plugins
```

The harness uses the built public Client, the installed pinned Pi 0.84.2 CLI and MCP adapter 2.36.0,
real RPC processes, temporary homes and projects, and deterministic model/MCP fixtures on loopback.
The platform Web extension calls the real local Web gateway with a fixture dispatcher. No account
login, external model response, production Server, or existing user configuration is used. Set
`OPENTAG_KEEP_PI_NATIVE_FIXTURE=1` to retain the temporary fixture for diagnosis.

Checks:

- Install a real local Pi package with `pi install -l <source> --approve` and discover its command.
  Disable its extensions through the native package filter and confirm the command disappears
  while the unrelated project extension remains available.
- Discover project Skills, an explicitly supplied duplicate Skill path, and prompt templates in
  the actual native catalog. The duplicate Skill has exactly one catalog entry. Execute a prompt
  template and verify its expanded content reaches the model.
- Call a discovered native extension tool, the platform Web tool, user MCP named `opentag-mcp`,
  and the platform MCP gateway. Discover and connect the private runtime MCP server through the
  native adapter before calling its tool. Require actual HTTP tool calls and Web dispatches,
  rather than inferring success from the model's final response.
- Rotate platform bearer credentials on the same runtime and materialized binding. Each Run
  starts a new Pi process; the second gateway call uses the new bearer and the native MCP service
  remains available. The model sees one generic `mcp` tool, rather than competing registrations.
- Preserve custom plugin variables and both native project and managed system instructions.
  A sibling cwd does not inherit project extensions or context. A Run without a platform grant
  continues to load native resources.
- Accept native fire-and-forget notifications/status/widgets/title changes and custom messages
  outside a model turn. A consumed slash command, throwing command, and handled-input event each
  return the explicit legacy protocol compatibility error without calling a model. Command side
  effects and extension errors are observed independently of that error result.
- Model-option queries do not load project extensions. Native project settings and MCP config
  retain identical bytes; `trust.json` is not created. No managed bearer appears in persisted
  fixture files, model input, or bindings.

## Automated regression scope

The Runtime coverage gate covers Local-only resource arguments, inherited environment preparation,
legacy command rejection, custom message framing, notification and interactive-UI behavior, and
waiting for `agent_settled` when an extension holds model cleanup after Pi becomes idle. Cloud
retains its disabled-resource arguments and controlled environment helper. The CLI inspection
regression verifies the same Pi Home and custom plugin variables as daemon preparation.

The gateway unit tests verify deferred registration after native factories, private server disposal,
Cloud's isolated configuration, non-overwrite behavior for incompatible native tool/command
namespaces, and fallback startup without rerunning other native startup handlers. The native MCP
smoke exercises platform-only fallback and Cloud mode with real Pi RPC.

## Limits and evidence boundary

This is native resource enablement, not complete plugin compatibility. Pi 0.84.2 does not provide
an RPC completion disposition for non-model commands or consumed input. These operations can run
side effects, then return `provider_request_rejected`; they are never reported as successful from
idle state. Interactive dialogs fail explicitly. RPC supplies no TUI or theme switching, even
though resource discovery is enabled. Older/incompatible native MCP adapters can prevent platform
MCP registration; OpenTag warns and preserves the native namespace.

The harness installs a local package; public npm/Git package downloads and arbitrary third-party
plugins are not acceptance evidence. The tests do not establish deployed Server execution fencing,
Cloud deployment/business acceptance, or a production integration's authentication. No deployment
or merge is part of this verification.

## Recorded local acceptance

On 2026-10-30 with Pi 0.84.2 and adapter 2.36.0:

- The native harness passed with 16 model requests, four MCP tool calls, and two Web dispatches.
  Both completed Runs on the same binding used native tools and the current gateway grant.
  Template and sibling-project Runs completed; three consumed-input cases returned the expected
  explicit compatibility error, with no model requests.
- Runtime: 789 tests passed; statements, branches, functions, and lines were each 100% covered.
- MCP composition, Cloud worker, and Runner acceptance regression: 66 tests passed.
- CLI environment inspection: 16 tests passed. Client type checking and build passed.

These are local fixture results, not remote CI or deployment acceptance.
