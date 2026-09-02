# OpenTag CLI

The OpenTag CLI connects local OpenTag clients to the OpenTag server. The project is pre-alpha and currently exposes
health diagnostics, connect-code login, Linux/macOS user-service management, and Computer presence listing.

Source builds use `opentag-dev` and `~/.opentag-dev`. The production npm package is `open-tag` with the `opentag`
binary and `~/.opentag`; preview builds use the separate `open-tag-staging` package, `opentag-staging` binary, and
`~/.opentag-staging`.

Login installs and starts the daemon service by default. Use `--no-start` for credential-only login. The public daemon
commands are `install`, `start`, `stop`, `restart`, `status`, and `uninstall`; v0.1 does not provide a Windows service.

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
