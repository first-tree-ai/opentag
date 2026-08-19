#!/usr/bin/env bash
# Install the in-tree dev CLI and reconcile the channel-specific daemon service.
# Login remains a separate CLI command and owns credential creation.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHANNEL_CONFIG="$REPO_ROOT/packages/shared/src/channel-config.json"
CLI_DIST="$REPO_ROOT/apps/cli/dist/cli/index.mjs"
BIN_DIR="${HOME}/.local/bin"
ENSURE_SERVICE_DEFERRED=3

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dev-install.sh

Builds the source checkout, installs the dev CLI under ~/.local/bin, and
installs/starts or repairs the dev daemon when credentials already exist.
On a first install, service setup is deferred until the separate login command.
EOF
}

case "${1:-}" in
  "") ;;
  --help | -h)
    usage
    exit 0
    ;;
  *)
    printf 'dev-install does not accept login or daemon arguments\n' >&2
    usage >&2
    exit 2
    ;;
esac

command -v node >/dev/null 2>&1 || { printf 'Node.js is required\n' >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { printf 'pnpm is required\n' >&2; exit 1; }

BIN_NAME=$(node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(config.dev.binName);
' "$CHANNEL_CONFIG")
if [[ ! "$BIN_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'Invalid dev binary name in channel config\n' >&2
  exit 1
fi
BIN_PATH="$BIN_DIR/$BIN_NAME"

cd "$REPO_ROOT"
printf 'Installing workspace dependencies...\n'
pnpm install --frozen-lockfile
printf 'Building OpenTag...\n'
pnpm build

if [[ ! -x "$CLI_DIST" ]]; then
  printf 'Built CLI is missing or not executable: %s\n' "$CLI_DIST" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
ln -sfn "$CLI_DIST" "$BIN_PATH"
"$BIN_PATH" --version >/dev/null
printf 'Installed %s -> %s\n' "$BIN_PATH" "$CLI_DIST"

ensure_output=""
ensure_rc=0
ensure_output=$(PATH="$BIN_DIR${PATH:+:$PATH}" "$BIN_PATH" daemon ensure-service 2>&1) || ensure_rc=$?
case "$ensure_rc" in
  0)
    [[ -z "$ensure_output" ]] || printf '%s\n' "$ensure_output"
    printf 'Dev daemon service is installed and running.\n'
    ;;
  "$ENSURE_SERVICE_DEFERRED")
    [[ -z "$ensure_output" ]] || printf '%s\n' "$ensure_output"
    printf 'CLI install is complete; the dev daemon service will be installed after login.\n'
    ;;
  *)
    [[ -z "$ensure_output" ]] || printf '%s\n' "$ensure_output" >&2
    printf 'Dev daemon service reconciliation failed.\n' >&2
    exit "$ensure_rc"
    ;;
esac
