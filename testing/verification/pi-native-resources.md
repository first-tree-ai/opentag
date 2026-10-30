# Local Pi native resources

Supports the [Pi native resource contract](../../docs/system/runtime/agent-runtime-contract.md#local-pi-native-resources-and-trust),
[Agent permissions](../../docs/system/runtime/agent-permissions.md), and
[Pi MCP composition](../../docs/system/capabilities/mcp-server-integration.md#pi-and-cloud-runtime-delivery).

## Native process acceptance

```bash
pnpm exec turbo run build --filter='@opentag/client^...'
pnpm --filter @opentag/client build
pnpm --filter @opentag/client test:e2e:pi-native-plugins
pnpm --filter @opentag/client test:e2e:pi-native-lifecycle
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

## Prompt lifecycle regression acceptance

`test:e2e:pi-native-lifecycle` uses the built public Client and real Pi RPC with a loopback model
and a persisted Session. Its controlled response gates reproduce the previously ambiguous windows
without patching the native Session or using idle time as a completion signal:

- Hold delivery of the initial state result while a real `session_start` extension triggers a
  model turn. Reject startup activity before sending the requested prompt; neither startup text
  nor a startup terminal is attributed to the requested Run.
- Start a real foreign model turn while a native input handler holds prompt preflight open.
  Reject its lifecycle before ACK; the requested prompt was submitted, but receives no ACK or
  model output. A wire regression separately puts ACK and normal events in one JSONL chunk and
  proves the ACK observer runs before those events, even before the request Promise resumes.
- Hold prompt acknowledgement and its subsequent state fence around a consumed command. A
  concurrent steer stays pending until the fence rejects the command, then rejects too. No
  `steer` RPC, `input_accepted`, native queued input, or model request occurs for that steer.
- Hold a real active model response and steer successfully. The queued follow-up reaches the
  next model request and the Run completes, preserving supported model steering.
- Delay the native `agent_settled` hook after the model becomes idle. Reject a real steer RPC
  during that cleanup without an acceptance event, then let the owned Run complete.
- Hold the host's steer response while the real model finishes. Reject steer after settlement
  without an input acceptance event; ordinary active-model steering still succeeds.
- Call both `ctx.ui.setEditorText` and `ctx.ui.pasteToEditor` through a real native extension.
  Require their `set_editor_text` wire events and successful model completion. The native resource
  harness exercises the same APIs alongside native tools and platform MCP/Web tools.

The scripted regression also rejects initial streaming/compaction/queued state even without
observed start events, checks every startup lifecycle shape, resets ownership between Runs,
retains startup custom messages/notifications, and rejects a waiting steer after model settlement.
The Runtime coverage gate includes these cases. `public-exports.test.ts` separately verifies the
public barrel remains within its checked contract; the Cloud environment helper stays internal.

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

The prompt-ownership fix was additionally verified with 809 Runtime tests and four 100% coverage
metrics. The new focused regressions failed against the prior implementation and pass with the fix.
The real lifecycle harness rejects a startup turn before prompt submission, rejects concurrent
steer for consumed input without queuing it, completes active-model steering, and accepts both
native editor APIs. The resource harness still passes its 16 model requests, four MCP calls and
two Web dispatches with those editor APIs enabled.

The subsequent ACK/steer boundary fix passes 818 Runtime tests with all four metrics at 100%.
Its focused tests fail on the preceding head. Wire-level rechecks use a real JSONL subprocess
transport to exercise ACK plus model events in one batch, foreign completion before ACK, and
settlement during steer. Seven real Pi lifecycle scenarios pass, including pre-ACK activity and
idle cleanup before the native terminal; native resource acceptance and 64 affected regressions
also pass. These results do not replace new-head CI or owner review.
