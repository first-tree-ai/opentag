# OpenTag CLI

The OpenTag CLI connects local OpenTag clients to the OpenTag server. The project is pre-alpha and currently exposes
health diagnostics, connect-code login, Linux/macOS user-service management, and Computer presence listing.

Source builds use `opentag-dev` and `~/.opentag-dev`. The production npm package is `open-tag` with the `opentag`
binary and `~/.opentag`; preview builds use the separate `open-tag-staging` package, `opentag-staging` binary, and
`~/.opentag-staging`.

Login installs and starts the daemon service by default. Use `--no-start` for credential-only login. The public daemon
commands are `install`, `start`, `stop`, `restart`, `status`, and `uninstall`; v0.1 does not provide a Windows service.

See the [OpenTag repository](https://github.com/first-tree-ai/opentag) for setup, contribution, security, and release
documentation.
