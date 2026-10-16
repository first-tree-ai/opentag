# OpenTag CLI

The OpenTag CLI connects local OpenTag clients to the OpenTag server. The project is pre-alpha and currently exposes
health diagnostics, connect-code login, Linux/macOS user-service management, and Computer presence listing.

Source builds use `opentag-dev` and `~/.opentag-dev`. The production npm package is `open-tag` with the `opentag`
binary and `~/.opentag`; preview builds use the separate `open-tag-staging` package, `opentag-staging` binary, and
`~/.opentag-staging`.

Login installs and starts the daemon service by default. Use `--no-start` for credential-only login. The public daemon
commands are `install`, `start`, `stop`, `restart`, `status`, and `uninstall`; v0.1 does not provide a Windows service.

## Persistent runtime credentials

Put daemon-only runtime environment values in `<OPENTAG_HOME>/config/daemon.env` (production default:
`~/.opentag/config/daemon.env`). Keep the Home and config directories private and the file mode at `0600`.
The daemon loads this file at startup; non-empty values already supplied by its supervisor take precedence.
Restart the daemon after changing the file, once its current work can safely stop. Never share credential values.
For unattended Claude subscription access, use the token created by `claude setup-token` as
`CLAUDE_CODE_OAUTH_TOKEN`, rather than copying a short-lived access token from native login storage.

Service installation and upgrade refresh preserve existing custom environment values in launchd plists and
environment directives in the systemd unit. Installation and refresh enforce mode `0600` even when the definition content is unchanged, because it may contain secrets. OpenTag still regenerates its executable and managed `PATH`,
`OPENTAG_HOME`, and `OPENTAG_SERVICE_MODE`. On Linux, the service entrypoint sets these three values after systemd
applies environment files and removals, so custom directives cannot change the daemon's Home or service mode.
Systemd drop-ins are separate files and remain untouched.
An unsupported or ambiguous launchd environment is rejected before any definition is overwritten. Only supported UTF-8 XML environments are preserved; binary plists and other encodings must be converted first or use `config/daemon.env`.

Claude readiness always consults the CLI's authentication status using the same setting sources as execution.
Explicit credentials targeting the default Anthropic endpoint are additionally checked with one bounded, read-only
Models API request per readiness check. Equivalent official URLs (including the default port and host case) receive the same check. When both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are set, the check sends both authentication headers. A rejected credential requires sign-in or replacement; connectivity, permission, rate-limit,
and service failures remain retryable unavailability. This check makes no model generation request and does not
prove access to a particular model or available quota. Native login storage, custom gateways, Bedrock, Vertex,
and Foundry remain under the Claude CLI's credential handling; OpenTag does not read or renew their tokens.

## Targeted Computer preparation

`opentag connect <code>` (also `opentag computer connect <code>`) binds the Computer named by the one-time setup flow.
When the Server returns a target Agent, the foreground command checks only that Agent's selected Runtime CLI, including
its required capabilities and credentials, and prepares both Lark and Slack through Provider CLI ensure. The operator
must install and authenticate the selected Codex, Claude Code, or Pi CLI; OpenTag never installs a Runtime.
Pi requires version 0.80.6 or newer and a configured model provider with usable credentials. A Runtime or daemon failure does not skip
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

If the Server exchange succeeds but a local file write fails, the command instead returns exit `3` with
`COMPUTER_LOCAL_PERSISTENCE_FAILED`, `connected: true` (Server-side only), `codeConsumed: true`, and
`localPersistenceReady: false`. It does not start/restart the daemon or run preparation on an incomplete local binding.
Credentials are written before identity; these are not a two-file atomic transaction. After fixing local storage,
run the emitted `computer repair-local --installation-id <id> --home <path>` command. This idempotently rewrites the
saved credential and reconstructs its identity without a code exchange, including recovery after a crash between writes
or a post-rename durability error. For an interrupted process, use the installation ID in the saved credential file
(do not share its machine token). Repair refuses a missing credential or one from a different installation. If the
new credential was never saved, request a **new** connect/repair code in Web; never replay the consumed code or assume
the previous credential still works. Local repair alone does not assert Runtime, Provider, daemon, or Server readiness.

After manually repairing a Runtime, run `opentag computer runtime-inspect --provider codex` or
`opentag computer runtime-inspect --provider claude-code`, or select `--provider pi` (optionally `--json`).
This explicitly selected, read-only
command performs the same full probe; neither `doctor` nor a version string alone substitutes for it. Transient probe
failures use `retryability: backoff`; install, login, version, and configuration failures require manual repair first.
The probe is point-in-time local evidence: it neither creates Runtime homes nor shares the daemon's discovery cache.

The exchange advertises support in its existing `clientVersion` SemVer build metadata (`opentag-connect-runtime-v1`).
New Servers omit `runtimeProvider` for unmarked Clients, preserving their strict response schema and version floor.
A new CLI accepts an older Server's missing Runtime evidence but reports `runtime:unconfirmed`, keeps the connection,
and requests an upgrade/recheck instead of guessing a provider or claiming local readiness.

Pi runs with unrestricted filesystem access, enabled network access, and no approval prompts in Local mode.
OpenTag rejects unsupported stricter Pi execution settings. Selecting Pi does not create an OS sandbox.
Automatic extensions and ambient skills/context discovery are disabled; packaged Context Tree skills are explicit.
See the [Agent Runtime contract](../../docs/design/agent-runtime-contract.md) for Session persistence and recovery.

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
