#!/bin/sh
set -eu

# OpenTag portable installer.
#
# Downloads a self-contained release (bundled CLI plus its own Node.js runtime), verifies it against
# the published checksum, and activates it behind a stable shim in BIN_DIR. Releases published to the
# public endpoint carry a rendered copy of this script with PORTABLE_CHANNEL and DOWNLOAD_BASE_URL
# pinned to the channel they belong to.

PORTABLE_CHANNEL="${OPENTAG_PORTABLE_CHANNEL:-prod}"
DOWNLOAD_BASE_URL="${OPENTAG_PORTABLE_DOWNLOAD_BASE_URL:-https://download.opentag.build/releases}"
DEFAULT_PREFIX="${HOME}/.local/share/opentag/${PORTABLE_CHANNEL}"
DEFAULT_BIN_DIR="${HOME}/.local/bin"
PATH_MODE="auto"
REQUESTED_VERSION=""
PREFIX="$DEFAULT_PREFIX"
BIN_DIR="$DEFAULT_BIN_DIR"
FORCE=0
PATH_UPDATED_PROFILE=""
ORIGINAL_PATH="${PATH:-}"
BIN_NAME=""

START_MARKER="# >>> opentag portable >>>"
END_MARKER="# <<< opentag portable <<<"

usage() {
  cat <<EOF
Usage: sh install.sh [options]

Options:
  --version <version>       Install an immutable version instead of latest
  --prefix <path>           Install root (default: $DEFAULT_PREFIX)
  --bin-dir <path>          Shim directory (default: $DEFAULT_BIN_DIR)
  --force                   Reinstall even when the target version is already active
  --no-path-edit            Do not edit shell startup files
  --path-mode <mode>        auto, prompt, or off (default: auto)
  --help                    Show this help
EOF
}

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'opentag portable installer: %s\n' "$*" >&2
  exit 1
}

need_value() {
  [ "$#" -ge 2 ] || die "$1 requires a value"
  case "$2" in
    --*) die "$1 requires a value" ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      need_value "$1" "${2:-}"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --prefix)
      need_value "$1" "${2:-}"
      PREFIX="$2"
      shift 2
      ;;
    --bin-dir)
      need_value "$1" "${2:-}"
      BIN_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-path-edit)
      PATH_MODE="off"
      shift
      ;;
    --path-mode)
      need_value "$1" "${2:-}"
      case "$2" in
        auto|prompt|off) PATH_MODE="$2" ;;
        *) die "--path-mode must be auto, prompt, or off" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$PREFIX" in
  /*) ;;
  *) die "--prefix must be an absolute path" ;;
esac
case "$BIN_DIR" in
  /*) ;;
  *) die "--bin-dir must be an absolute path" ;;
esac

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

trim_slashes() {
  printf '%s' "$1" | sed 's:/*$::'
}

download_to() {
  url="$1"
  dest="$2"
  if command_exists curl; then
    curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$dest"
  elif command_exists wget; then
    wget -qO "$dest" "$url"
  else
    die "curl or wget is required"
  fi
}

sha256_file() {
  file="$1"
  if command_exists sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  elif command_exists shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

extract_tarball() {
  tarball="$1"
  dest="$2"
  if tar --version 2>/dev/null | grep -qi "GNU tar"; then
    tar --warning=no-unknown-keyword -xzf "$tarball" -C "$dest"
  else
    tar -xzf "$tarball" -C "$dest"
  fi
}

json_string() {
  file="$1"
  key="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | sed -n '1p'
}

json_number() {
  file="$1"
  key="$2"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$file" | sed -n '1p'
}

asset_block() {
  file="$1"
  platform="$2"
  awk -v needle="\"platform\": \"${platform}\"" '
    $0 ~ needle { found = 1 }
    found { print }
    found && $0 ~ /}/ { exit }
  ' "$file"
}

detect_platform() {
  os="$(uname -s 2>/dev/null || true)"
  machine="$(uname -m 2>/dev/null || true)"
  case "$os" in
    Darwin) portable_os="darwin" ;;
    Linux) portable_os="linux" ;;
    *) die "unsupported platform: ${os:-unknown}. Download and extract a matching portable tarball manually." ;;
  esac
  case "$machine" in
    arm64|aarch64) portable_arch="arm64" ;;
    x86_64|amd64) portable_arch="x64" ;;
    *) die "unsupported architecture: ${machine:-unknown}. Download and extract a matching portable tarball manually." ;;
  esac
  printf '%s-%s' "$portable_os" "$portable_arch"
}

shell_single_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\"'\"'/g"
  printf "'"
}

# The shim is the only stable entry point: it resolves through `current` on every invocation, so an
# update never has to rewrite it and the daemon service definition never pins a version directory.
write_shim() {
  path="$1"
  current_root="$2"
  bin_dir="$3"
  tmp="${path}.$$"
  root_literal="$(shell_single_quote "$current_root")"
  bin_literal="$(shell_single_quote "$bin_dir")"
  cat >"$tmp" <<EOF
#!/bin/sh
set -eu
root=$root_literal
bin_dir=$bin_literal
export OPENTAG_INSTALL_MODE=portable
export OPENTAG_PORTABLE_ROOT="\$root"
export OPENTAG_PORTABLE_BIN_DIR="\$bin_dir"
exec "\$root/node/bin/node" "\$root/app/cli/index.mjs" "\$@"
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$path"
}

shim_targets_current() {
  shim="$1"
  current_link="$2"
  [ -f "$shim" ] || return 1
  [ -x "$shim" ] || return 1
  grep -Fqx -- "root=$(shell_single_quote "$current_link")" "$shim"
}

# Answers "is the requested version already the live install?" strictly enough that a positive answer
# means there is nothing left to do: the payload must be present and runnable, and the stable shim
# must already resolve through it. A partial or hand-edited install falls through to a full reinstall.
portable_install_is_current() {
  target_version="$1"
  bin_name="$2"
  current_link="$PREFIX/current"
  [ -L "$current_link" ] || return 1
  install_file="$current_link/INSTALL.json"
  [ -f "$install_file" ] || return 1
  [ "$(json_string "$install_file" version)" = "$target_version" ] || return 1
  [ "$(json_string "$install_file" platform)" = "$PLATFORM" ] || return 1
  [ "$(json_string "$install_file" installMode)" = "portable" ] || return 1
  [ "$(json_string "$install_file" binName)" = "$bin_name" ] || return 1
  app_entry="$(json_string "$install_file" appEntry)"
  [ -n "$app_entry" ] || return 1
  [ -f "$current_link/$app_entry" ] || return 1
  [ -x "$current_link/node/bin/node" ] || return 1
  shim_targets_current "$BIN_DIR/$bin_name" "$current_link" || return 1
  return 0
}

atomic_replace_current_link() {
  new_link="$1"
  current_link="$2"
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Linux)
      if mv -f -T "$new_link" "$current_link"; then
        return 0
      fi
      ;;
    Darwin)
      if mv -f -h "$new_link" "$current_link"; then
        return 0
      fi
      ;;
    *)
      rm -f "$new_link"
      die "unsupported platform for atomic current replacement: ${os:-unknown}"
      ;;
  esac

  rm -f "$new_link"
  die "failed to atomically replace $current_link"
}

path_contains_bin_dir() {
  path_value="$1"
  case ":${path_value}:" in
    *:"$BIN_DIR":*) return 0 ;;
    *) return 1 ;;
  esac
}

portable_shim_wins_on_original_path() {
  bin_name="$1"
  old_path="${PATH:-}"
  PATH="$ORIGINAL_PATH"
  resolved="$(command -v "$bin_name" 2>/dev/null || true)"
  PATH="$old_path"
  [ "$resolved" = "$BIN_DIR/$bin_name" ]
}

profile_for_shell() {
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) printf '%s/.zshrc' "$HOME" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s/.bashrc' "$HOME"
      else
        printf '%s/.bash_profile' "$HOME"
      fi
      ;;
    sh|dash|ksh) printf '%s/.profile' "$HOME" ;;
    *) return 1 ;;
  esac
}

rewrite_path_block() {
  profile="$1"
  tmp="${profile}.$$"
  if [ -f "$profile" ]; then
    awk -v start="$START_MARKER" -v end="$END_MARKER" '
      $0 == start { skip = 1; next }
      $0 == end { skip = 0; next }
      skip != 1 { print }
    ' "$profile" >"$tmp"
  else
    : >"$tmp"
  fi
  {
    cat "$tmp"
    printf '\n%s\n' "$START_MARKER"
    # The profile must receive a literal $PATH for expansion by the future shell.
    # shellcheck disable=SC2016
    printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
    printf '%s\n' "$END_MARKER"
  } >"${tmp}.new"
  mv -f "${tmp}.new" "$profile"
  rm -f "$tmp"
}

maybe_edit_path() {
  bin_name="$1"
  [ "$PATH_MODE" != "off" ] || return 0
  if path_contains_bin_dir "$ORIGINAL_PATH" && portable_shim_wins_on_original_path "$bin_name"; then
    return 0
  fi

  if ! profile="$(profile_for_shell)"; then
    log "Automatic PATH setup skipped: this shell is not recognized."
    return 0
  fi

  if [ "$PATH_MODE" = "prompt" ]; then
    if [ ! -t 0 ]; then
      log "Automatic PATH setup skipped because prompt mode requires an interactive shell."
      return 0
    fi
    printf 'Add %s to PATH in %s? [Y/n] ' "$BIN_DIR" "$profile"
    read -r answer || answer="n"
    case "$answer" in
      ""|y|Y|yes|YES) ;;
      *)
        log "Skipped PATH setup."
        return 0
        ;;
    esac
  fi

  if rewrite_path_block "$profile"; then
    PATH_UPDATED_PROFILE="$profile"
    log "Updated PATH block in $profile"
  else
    log "PATH setup failed for $profile."
  fi
}

print_path_guidance() {
  if [ -n "$PATH_UPDATED_PROFILE" ]; then
    log "Restart your shell, or run: . \"$PATH_UPDATED_PROFILE\""
  elif path_contains_bin_dir "$ORIGINAL_PATH"; then
    # Judge against the user's incoming PATH: the installer prepends BIN_DIR to its own PATH so the
    # daemon service resolves the stable shim, which says nothing about the user's shell.
    log "$BIN_NAME should be available now."
  else
    log "Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

# Service reconciliation is best-effort by design: exit code 3 means the CLI deliberately deferred
# setup until login creates credentials, and any other failure must not fail an install that already
# produced a working command.
ensure_daemon_service() {
  bin_name="$1"
  status=0
  "$BIN_DIR/$bin_name" daemon ensure-service || status=$?
  case "$status" in
    0) return 0 ;;
    3)
      log "Daemon service setup is deferred until you run: $bin_name login <connect-code>"
      return 0
      ;;
    *)
      log "Daemon service reconciliation failed (exit $status)."
      log "Run \"$BIN_DIR/$bin_name login <connect-code>\" to refresh credentials and service state."
      return 0
      ;;
  esac
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opentag-portable.XXXXXX")"
TEMP_VERSION_DIR=""
cleanup() {
  rm -rf "$WORK_DIR"
  # An interrupted install must not leave a half-extracted payload under the install root.
  [ -z "$TEMP_VERSION_DIR" ] || rm -rf "$TEMP_VERSION_DIR"
}
trap cleanup EXIT HUP INT TERM

PLATFORM="$(detect_platform)"
BASE="$(trim_slashes "$DOWNLOAD_BASE_URL")"
if [ -n "$REQUESTED_VERSION" ]; then
  MANIFEST_URL="${BASE}/${PORTABLE_CHANNEL}/${REQUESTED_VERSION}/manifest.json"
else
  MANIFEST_URL="${BASE}/${PORTABLE_CHANNEL}/latest.json"
fi

MANIFEST_FILE="$WORK_DIR/manifest.json"
log "Downloading OpenTag portable metadata: $MANIFEST_URL"
download_to "$MANIFEST_URL" "$MANIFEST_FILE"

VERSION="$(json_string "$MANIFEST_FILE" version)"
PACKAGE_NAME="$(json_string "$MANIFEST_FILE" packageName)"
BIN_NAME="$(json_string "$MANIFEST_FILE" binName)"
[ -n "$VERSION" ] || die "metadata missing version"
[ -n "$PACKAGE_NAME" ] || die "metadata missing packageName"
[ -n "$BIN_NAME" ] || die "metadata missing binName"

# Resolve the install paths the same way a previous run did before comparing against it: `pwd -L`
# drops trailing slashes and dot segments without resolving a caller-selected symlink prefix, which
# matches the lexical absolute paths recorded in the shims.
if [ -d "$PREFIX" ]; then
  PREFIX="$(CDPATH="" cd -L "$PREFIX" && pwd -L)"
fi
if [ -d "$BIN_DIR" ]; then
  BIN_DIR="$(CDPATH="" cd -L "$BIN_DIR" && pwd -L)"
fi

if [ "$FORCE" -eq 0 ] && portable_install_is_current "$VERSION" "$BIN_NAME"; then
  log "OpenTag ${VERSION} is already installed and up to date; skipping download."
  log "Command: $BIN_DIR/$BIN_NAME"
  log "Run this installer with --force to reinstall the same version."
  maybe_edit_path "$BIN_NAME"
  print_path_guidance
  exit 0
fi

ASSET_FILE="$WORK_DIR/asset.json"
asset_block "$MANIFEST_FILE" "$PLATFORM" >"$ASSET_FILE"
ASSET_PLATFORM="$(json_string "$ASSET_FILE" platform)"
ASSET_URL="$(json_string "$ASSET_FILE" url)"
ASSET_SHA="$(json_string "$ASSET_FILE" sha256)"
ASSET_SIZE="$(json_number "$ASSET_FILE" size)"
[ "$ASSET_PLATFORM" = "$PLATFORM" ] || die "no portable asset for $PLATFORM"
[ -n "$ASSET_URL" ] || die "asset missing url"
[ -n "$ASSET_SHA" ] || die "asset missing sha256"
[ -n "$ASSET_SIZE" ] || die "asset missing size"

mkdir -p "$PREFIX/versions" "$PREFIX/.tmp" "$BIN_DIR"
PREFIX="$(CDPATH="" cd -L "$PREFIX" && pwd -L)"
BIN_DIR="$(CDPATH="" cd -L "$BIN_DIR" && pwd -L)"
TARBALL="$WORK_DIR/payload.tar.gz"
log "Downloading OpenTag ${VERSION} for ${PLATFORM}"
download_to "$ASSET_URL" "$TARBALL"
ACTUAL_SHA="$(sha256_file "$TARBALL")"
if [ "$ACTUAL_SHA" != "$ASSET_SHA" ]; then
  die "checksum mismatch for portable payload: expected $ASSET_SHA, got $ACTUAL_SHA"
fi

CANONICAL_VERSION_DIR="$PREFIX/versions/$VERSION"
TEMP_VERSION_DIR="$PREFIX/.tmp/${VERSION}.$$"
rm -rf "$TEMP_VERSION_DIR"
mkdir -p "$TEMP_VERSION_DIR"
extract_tarball "$TARBALL" "$TEMP_VERSION_DIR"

# A version directory is never written in place once it exists, because `current` may resolve through
# it: replacing it would leave the link pointing at a half-removed tree, and a crash between the two
# renames of a swap would strand it permanently. A fresh payload is instead installed under a
# directory that nothing points at yet, and `current` is moved onto it in one atomic step.
if [ -e "$CANONICAL_VERSION_DIR" ]; then
  if [ "$FORCE" -eq 0 ]; then
    rm -rf "$TEMP_VERSION_DIR"
    VALIDATION_DIR="$CANONICAL_VERSION_DIR"
    FINAL_VERSION_DIR="$CANONICAL_VERSION_DIR"
  else
    VALIDATION_DIR="$TEMP_VERSION_DIR"
    FINAL_VERSION_DIR="$PREFIX/versions/${VERSION}+$$"
    rm -rf "$FINAL_VERSION_DIR"
  fi
else
  VALIDATION_DIR="$TEMP_VERSION_DIR"
  FINAL_VERSION_DIR="$CANONICAL_VERSION_DIR"
fi

INSTALL_FILE="$VALIDATION_DIR/INSTALL.json"
[ -f "$INSTALL_FILE" ] || die "portable payload missing INSTALL.json"
INSTALL_VERSION="$(json_string "$INSTALL_FILE" version)"
INSTALL_PACKAGE="$(json_string "$INSTALL_FILE" packageName)"
INSTALL_BIN="$(json_string "$INSTALL_FILE" binName)"
INSTALL_PLATFORM="$(json_string "$INSTALL_FILE" platform)"
INSTALL_MODE="$(json_string "$INSTALL_FILE" installMode)"
INSTALL_ENTRY="$(json_string "$INSTALL_FILE" appEntry)"
[ "$INSTALL_VERSION" = "$VERSION" ] || die "INSTALL.json version does not match downloaded metadata"
[ "$INSTALL_PACKAGE" = "$PACKAGE_NAME" ] || die "INSTALL.json packageName does not match downloaded metadata"
[ "$INSTALL_BIN" = "$BIN_NAME" ] || die "INSTALL.json binName does not match downloaded metadata"
[ "$INSTALL_PLATFORM" = "$PLATFORM" ] || die "INSTALL.json platform does not match the current platform"
[ "$INSTALL_MODE" = "portable" ] || die "INSTALL.json does not describe a portable install"
[ "$INSTALL_ENTRY" = "app/cli/index.mjs" ] || die "INSTALL.json appEntry is unsupported"

CURRENT_LINK="$PREFIX/current"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  die "$CURRENT_LINK exists and is not a symlink"
fi
NEW_LINK="$PREFIX/.current.$$"

# Exercise the candidate runtime where it was extracted, before anything already on disk is touched.
# The payload resolves its own root, so a failure here leaves an existing install completely intact.
if ! "$VALIDATION_DIR/node/bin/node" "$VALIDATION_DIR/$INSTALL_ENTRY" --version >/dev/null; then
  die "portable payload failed the pre-commit runtime smoke check"
fi

# A single rename into a path nothing occupies. Until `current` moves, the previous install stays
# whole and reachable; after it moves, the new payload is already complete.
if [ "$VALIDATION_DIR" = "$TEMP_VERSION_DIR" ]; then
  mv "$TEMP_VERSION_DIR" "$FINAL_VERSION_DIR"
fi

# Prepare the stable shim while current still names the old version. The current symlink is the final
# commit point, so a shim write failure never reports failure after activating the new runtime.
write_shim "$BIN_DIR/$BIN_NAME" "$CURRENT_LINK" "$BIN_DIR"
rm -f "$NEW_LINK"
ln -s "$FINAL_VERSION_DIR" "$NEW_LINK"
atomic_replace_current_link "$NEW_LINK" "$CURRENT_LINK"

# Past the commit point. Everything below is best-effort and must not fail the install.
#
# A forced reinstall left the superseded copy of this version behind so that `current` never pointed
# at a directory being rewritten. Now that `current` resolves elsewhere, drop it: leaving it would
# make the next ordinary install of the same version reuse a stale payload instead of this one.
if [ "$FINAL_VERSION_DIR" != "$CANONICAL_VERSION_DIR" ] && [ -e "$CANONICAL_VERSION_DIR" ]; then
  rm -rf "$CANONICAL_VERSION_DIR" || log "Could not remove the superseded payload at $CANONICAL_VERSION_DIR"
fi

PATH="$BIN_DIR:${PATH:-}"
export PATH
maybe_edit_path "$BIN_NAME"
ensure_daemon_service "$BIN_NAME"

log "OpenTag ${VERSION} installed at $FINAL_VERSION_DIR"
log "Command: $BIN_DIR/$BIN_NAME"
print_path_guidance
