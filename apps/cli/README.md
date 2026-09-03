# OpenTag CLI

The OpenTag CLI connects local OpenTag clients to the OpenTag server. The project is pre-alpha and currently exposes
health diagnostics, connect-code login, Linux/macOS user-service management, and Computer presence listing.

Source builds use `opentag-dev` and `~/.opentag-dev`. The production npm package is `open-tag` with the `opentag`
binary and `~/.opentag`; preview builds use the separate `open-tag-staging` package, `opentag-staging` binary, and
`~/.opentag-staging`.

Login installs and starts the daemon service by default. Use `--no-start` for credential-only login. The public daemon
commands are `install`, `start`, `stop`, `restart`, `status`, and `uninstall`; v0.1 does not provide a Windows service.

## Targeted Computer preparation

`opentag connect <code>` (also `opentag computer connect <code>`) binds the Computer named by the one-time setup flow.
When the Server returns a target Agent, the foreground command checks only that Agent's selected Runtime CLI, including
its required capabilities and credentials, and prepares both Lark and Slack through Provider CLI ensure. The operator
must install and sign in to the Runtime CLI; OpenTag never installs a Runtime. A Runtime or daemon failure does not skip
Provider preparation. An untargeted code remains an ordinary Computer connection without an inferred Runtime.

Human output and `--json` use the same local result, with four required rows: Computer (connection and daemon checks),
selected Runtime, Lark CLI, and Slack CLI. JSON exposes it as `result.preparation`, next to `result.connected`,
`result.connection`, and `result.guidance`. Non-blocking warnings do not downgrade ready rows. `--no-start` skips only
the daemon service; `--no-prepare-provider-clis` explicitly skips both Providers. Skipped required checks remain blocking.

All four local checks passing produces `Local computer preparation: READY`; it does not prove Server/Web readiness.
The Web must still wait for fresh daemon observations. Partial preparation returns exit `3` and
`LOCAL_COMPUTER_PREPARATION_INCOMPLETE`, retains `connected: true`, and sets the connect envelope's retryability to
`never`: **do not replay the one-time code**. Follow the individual rows' idempotent repair/verify actions instead.
Provider ensure remains independently retryable according to its own error contract. Daemon repair uses the exact
connected Home, even when `--home` differs from the channel default.

After manually repairing a Runtime, run `opentag computer runtime-inspect --provider codex` or
`opentag computer runtime-inspect --provider claude-code` (optionally `--json`). This explicitly selected, read-only
command performs the same full probe; neither `doctor` nor a version string alone substitutes for it.

The exchange advertises support in its existing `clientVersion` SemVer build metadata (`opentag-connect-runtime-v1`).
New Servers omit `runtimeProvider` for unmarked Clients, preserving their strict response schema and version floor.
A new CLI accepts an older Server's missing Runtime evidence but reports `runtime:unconfirmed`, keeps the connection,
and requests an upgrade/recheck instead of guessing a provider or claiming local readiness.

## Command result and exit-code contract

Every user-facing command uses the same result policy. Human-readable success output is written to stdout. Failures are
written to stderr and never include access tokens, refresh tokens, cookies, authorization headers, passwords, or request
bodies. Commands that support `--json` emit one JSON document. A successful document has the shape
`{"ok":true,"result":...}`. A failure document has the shape
`{"ok":false,"error":{"code","category","retryability","phase","requestId?","message"}}`. A command that
completed a safe partial operation may also include `result` in that failure document, with bounded state and next actions.

The process exit code is stable across commands:

- `0` — success.
- `1` — operational failure, authentication failure, authorization failure, conflict, or not-found result.
- `2` — command usage or input validation failure.
- `3` — service or dependency unavailable. The hidden `daemon ensure-service` command also uses `3` when setup is
  deliberately deferred because credentials are not available or the platform is unsupported.
- `130` — interrupted by cancellation or signal.

The structured error fields are intentionally transport-neutral: `code` identifies the condition, `category` groups it,
`retryability` describes a safe retry posture, `phase` identifies the lifecycle boundary, and `requestId` correlates a
server request when one is available. Use `--json` for scripts and agents; do not parse human-readable text.

See the [OpenTag repository](https://github.com/first-tree-ai/opentag) for setup, contribution, security, and release
documentation.
