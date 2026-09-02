#!/usr/bin/env bash
set -euo pipefail

# Builds the portable release tree for one channel into an output directory.
#
# This wrapper only resolves defaults (platforms, Node.js runtime, release timestamp, git revision)
# and delegates the actual assembly to build-portable.mjs. It never rewrites package identity: run
# scripts/prepare-cli-release.mjs first when the checkout still carries the dev identity.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_VERSION_FILE="$SCRIPT_DIR/node-version.txt"

DEFAULT_PLATFORMS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")
DEFAULT_OUT_DIR=".portable-release"
DEFAULT_DOWNLOAD_BASE_URL="https://storage.googleapis.com/opentag-release/releases"

CHANNEL=""
VERSION=""
DOWNLOAD_BASE_URL="${OPENTAG_PORTABLE_DOWNLOAD_BASE_URL:-$DEFAULT_DOWNLOAD_BASE_URL}"
OUT_DIR="${OPENTAG_PORTABLE_OUT_DIR:-$DEFAULT_OUT_DIR}"
NODE_VERSION="${OPENTAG_PORTABLE_NODE_VERSION:-$(tr -d '[:space:]' <"$NODE_VERSION_FILE")}"
GENERATED_AT="${OPENTAG_PORTABLE_GENERATED_AT:-}"
SKIP_WORKSPACE_BUILD=0
PLATFORMS=()

log() {
  printf '[portable build] %s\n' "$*"
}

die() {
  printf '[portable build] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/portable/build-release.sh --channel prod|staging --version <version> [options]

Options:
  --download-base-url <url>     Public release base URL, without the channel segment.
  --out-dir <dir>               Output directory. Defaults to OPENTAG_PORTABLE_OUT_DIR or .portable-release.
  --platform <platform>         Repeatable platform filter.
  --node-version <version>      Exact Node.js runtime version. Defaults to scripts/portable/node-version.txt.
  --generated-at <timestamp>    Release timestamp. Defaults to the release commit timestamp.
  --skip-workspace-build        Reuse the existing apps/cli/dist build.
  --help                        Show this help.

Environment:
  OPENTAG_PORTABLE_DOWNLOAD_BASE_URL
  OPENTAG_PORTABLE_PLATFORMS
  OPENTAG_PORTABLE_NODE_VERSION
  OPENTAG_PORTABLE_GENERATED_AT
  OPENTAG_PORTABLE_OUT_DIR
EOF
}

require_value() {
  local name="$1"
  local value="${2:-}"
  [[ -n "$value" && "$value" != --* ]] || die "$name requires a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      require_value "$1" "${2:-}"
      CHANNEL="$2"
      shift 2
      ;;
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      shift 2
      ;;
    --download-base-url)
      require_value "$1" "${2:-}"
      DOWNLOAD_BASE_URL="$2"
      shift 2
      ;;
    --out-dir)
      require_value "$1" "${2:-}"
      OUT_DIR="$2"
      shift 2
      ;;
    --platform)
      require_value "$1" "${2:-}"
      PLATFORMS+=("$2")
      shift 2
      ;;
    --node-version)
      require_value "$1" "${2:-}"
      NODE_VERSION="$2"
      shift 2
      ;;
    --generated-at)
      require_value "$1" "${2:-}"
      GENERATED_AT="$2"
      shift 2
      ;;
    --skip-workspace-build)
      SKIP_WORKSPACE_BUILD=1
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$CHANNEL" ]] || die "--channel is required"
[[ -n "$VERSION" ]] || die "--version is required"

if [[ ${#PLATFORMS[@]} -eq 0 && -n "${OPENTAG_PORTABLE_PLATFORMS:-}" ]]; then
  read -r -a PLATFORMS <<<"${OPENTAG_PORTABLE_PLATFORMS//,/ }"
fi
if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
  PLATFORMS=("${DEFAULT_PLATFORMS[@]}")
fi

if [[ "$SKIP_WORKSPACE_BUILD" -eq 0 ]]; then
  log "building workspace packages"
  (cd "$REPO_ROOT" && pnpm build)
else
  log "reusing the existing workspace build"
fi

GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD)"
if [[ -z "$GENERATED_AT" ]]; then
  GENERATED_AT="$(cd "$REPO_ROOT" && git show -s --format=%cI HEAD)"
fi

ARGS=(
  "$SCRIPT_DIR/build-portable.mjs"
  --channel "$CHANNEL"
  --version "$VERSION"
  --git-sha "$GIT_SHA"
  --node-version "$NODE_VERSION"
  --download-base-url "$DOWNLOAD_BASE_URL"
  --generated-at "$GENERATED_AT"
  --out-dir "$OUT_DIR"
)
for platform in "${PLATFORMS[@]}"; do
  ARGS+=(--platform "$platform")
done

log "building $CHANNEL $VERSION portable artifacts into $OUT_DIR"
(cd "$REPO_ROOT" && node "${ARGS[@]}")
