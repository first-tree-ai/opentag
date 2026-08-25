#!/usr/bin/env bash
set -euo pipefail

# Builds the portable release, publishes it to Google Cloud Storage, and proves the published channel
# is installable by running the public installer against a throwaway prefix.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEFAULT_DOWNLOAD_BASE_URL="https://download.opentag.build/releases"

CHANNEL=""
VERSION=""
DOWNLOAD_BASE_URL="${OPENTAG_PORTABLE_DOWNLOAD_BASE_URL:-$DEFAULT_DOWNLOAD_BASE_URL}"
DRY_RUN=0
PREFLIGHT_ONLY=0
SKIP_BUILD=0
SKIP_INSTALL_SMOKE=0
BUILD_ARGS=()
UPLOAD_ARGS=()

# Forwarded option arrays are expanded as ${ARR[@]+"${ARR[@]}"}: the bash 3.2 that ships with macOS
# treats a plain "${ARR[@]}" on an empty array as an unbound variable under `set -u`.

log() {
  printf '[portable release] %s\n' "$*"
}

die() {
  printf '[portable release] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/portable/release-gcs.sh --channel prod|staging --version <version> [options]

Options:
  --download-base-url <url>     Public release base URL, without the channel segment.
  --out-dir <dir>               Output directory shared by the build and upload steps.
  --platform <platform>         Repeatable platform filter.
  --node-version <version>      Exact Node.js runtime version.
  --generated-at <timestamp>    Release timestamp. Defaults to the release commit timestamp.
  --skip-workspace-build        Reuse the existing apps/cli/dist build.
  --skip-build                  Reuse portable artifacts already present in --out-dir.
  --skip-install-smoke          Publish without running the public installer smoke test.
  --bucket <bucket>             Cloud Storage bucket name.
  --prefix <prefix>             Object name prefix before the channel segment.
  --project <project>           Google Cloud project for gcloud calls.
  --preflight-only              Build and check immutable prefix compatibility without writing.
  --dry-run                     Build and print planned uploads without contacting Cloud Storage.
  --help                        Show this help.
EOF
}

require_value() {
  local name="$1"
  local value="${2:-}"
  [[ -n "$value" && "$value" != --* ]] || die "$name requires a value"
}

trim_trailing_slashes() {
  local value="$1"
  while [[ "$value" == */ ]]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

# Installs the published release the same way a user would: fetch the channel installer over the
# public endpoint and run it against a throwaway prefix, so a broken artifact or an unserved object
# fails the release instead of the first person to run the install command.
remote_install_smoke() {
  local bin_name
  # The module path travels in the environment: a module that sees its own path as process.argv[1]
  # treats itself as the process entry point and runs its CLI main().
  bin_name="$(OPENTAG_CHANNEL_CONFIG_MODULE="$SCRIPT_DIR/../channel-config.mjs" node -e '
const { pathToFileURL } = require("node:url");
import(pathToFileURL(process.env.OPENTAG_CHANNEL_CONFIG_MODULE).href).then((module) => {
  process.stdout.write(module.CHANNEL_CONFIG[process.argv[1]].binName);
});
' "$CHANNEL")"
  [[ -n "$bin_name" ]] || die "could not resolve the $CHANNEL binary name"

  (
    set -euo pipefail
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/opentag-portable-install.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT

    installer="$tmp_dir/install.sh"
    installer_url="$DOWNLOAD_BASE_URL/$CHANNEL/install.sh"
    log "running the public install smoke test from $installer_url"
    curl -fsSL --retry 3 --retry-delay 2 "$installer_url" -o "$installer"

    # This stage validates the channel pointer, so it asserts against whatever the channel actually
    # advertises. Publication is monotonic: republishing an older release leaves a newer pointer in
    # place on purpose, and that must not be reported as a broken channel.
    curl -fsSL --retry 3 --retry-delay 2 "$DOWNLOAD_BASE_URL/$CHANNEL/latest.json" -o "$tmp_dir/latest.json"
    published_version="$(node -e '
const latest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (typeof latest.version !== "string") process.exit(2);
process.stdout.write(latest.version);
' "$tmp_dir/latest.json")"
    [[ -n "$published_version" ]] || die "the published channel pointer carries no version"
    if [[ "$published_version" != "$VERSION" ]]; then
      log "the $CHANNEL channel advertises $published_version rather than $VERSION; smoking that instead"
    fi

    OPENTAG_PORTABLE_DOWNLOAD_BASE_URL="$DOWNLOAD_BASE_URL" \
      OPENTAG_PORTABLE_CHANNEL="$CHANNEL" \
      OPENTAG_HOME="$tmp_dir/home" \
      sh "$installer" --prefix "$tmp_dir/prefix" --bin-dir "$tmp_dir/bin" --no-path-edit

    version_output="$(OPENTAG_HOME="$tmp_dir/home" "$tmp_dir/bin/$bin_name" --version 2>&1)"
    [[ "$version_output" == *"$published_version"* ]] ||
      die "installed portable CLI reported \"$version_output\", expected $published_version"

    # A second run must recognize the release it just installed and stop before downloading again.
    repeat_output="$(
      OPENTAG_PORTABLE_DOWNLOAD_BASE_URL="$DOWNLOAD_BASE_URL" \
        OPENTAG_PORTABLE_CHANNEL="$CHANNEL" \
        OPENTAG_HOME="$tmp_dir/home" \
        sh "$installer" --prefix "$tmp_dir/prefix" --bin-dir "$tmp_dir/bin" --no-path-edit 2>&1
    )"
    [[ "$repeat_output" == *"already installed and up to date"* ]] ||
      die "reinstalling the published release did not short-circuit: $repeat_output"

    log "public install smoke test passed for $CHANNEL $published_version"
  )
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
      BUILD_ARGS+=(--out-dir "$2")
      UPLOAD_ARGS+=(--out-dir "$2")
      shift 2
      ;;
    --platform)
      require_value "$1" "${2:-}"
      BUILD_ARGS+=(--platform "$2")
      shift 2
      ;;
    --node-version)
      require_value "$1" "${2:-}"
      BUILD_ARGS+=(--node-version "$2")
      shift 2
      ;;
    --generated-at)
      require_value "$1" "${2:-}"
      BUILD_ARGS+=(--generated-at "$2")
      shift 2
      ;;
    --skip-workspace-build)
      BUILD_ARGS+=(--skip-workspace-build)
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-install-smoke)
      SKIP_INSTALL_SMOKE=1
      shift
      ;;
    --bucket)
      require_value "$1" "${2:-}"
      UPLOAD_ARGS+=(--bucket "$2")
      shift 2
      ;;
    --prefix)
      [[ $# -ge 2 ]] || die "--prefix requires a value"
      UPLOAD_ARGS+=(--prefix "$2")
      shift 2
      ;;
    --project)
      require_value "$1" "${2:-}"
      UPLOAD_ARGS+=(--project "$2")
      shift 2
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
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

[[ "$CHANNEL" == "prod" || "$CHANNEL" == "staging" ]] || die "--channel must be prod or staging"
[[ -n "$VERSION" ]] || die "--version is required"
DOWNLOAD_BASE_URL="$(trim_trailing_slashes "$DOWNLOAD_BASE_URL")"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  "$SCRIPT_DIR/build-release.sh" \
    --channel "$CHANNEL" \
    --version "$VERSION" \
    --download-base-url "$DOWNLOAD_BASE_URL" \
    ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
else
  log "reusing existing portable artifacts"
fi

[[ "$PREFLIGHT_ONLY" -eq 0 ]] || UPLOAD_ARGS+=(--preflight-only)
[[ "$DRY_RUN" -eq 0 ]] || UPLOAD_ARGS+=(--dry-run)

"$SCRIPT_DIR/upload-gcs.sh" \
  --channel "$CHANNEL" \
  --download-base-url "$DOWNLOAD_BASE_URL" \
  ${UPLOAD_ARGS[@]+"${UPLOAD_ARGS[@]}"}

if [[ "$DRY_RUN" -eq 1 || "$PREFLIGHT_ONLY" -eq 1 ]]; then
  log "skipping the public install smoke test"
  exit 0
fi
if [[ "$SKIP_INSTALL_SMOKE" -eq 1 ]]; then
  log "public install smoke test skipped by request"
  exit 0
fi

remote_install_smoke
