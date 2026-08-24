#!/usr/bin/env bash
set -euo pipefail

# Publishes a built portable release tree to Google Cloud Storage.
#
# The version prefix is immutable: every object under <prefix>/<channel>/<version>/ is written with a
# create-only precondition, and a rerun may only re-upload objects that are still missing. The channel
# entry points (latest.json and install.sh) are the only mutable objects, and flipping them publishes
# the release to every installer, so they are written last and only after the public download endpoint
# has proven it serves the complete versioned release.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

IMMUTABLE_CACHE_CONTROL="public, max-age=31536000, immutable"
MUTABLE_CACHE_CONTROL="no-cache, max-age=0, must-revalidate"
DEFAULT_OUT_DIR=".portable-release"
DEFAULT_BUCKET="opentag-release"
DEFAULT_PREFIX="releases"

CHANNEL=""
OUT_DIR="${OPENTAG_PORTABLE_OUT_DIR:-$DEFAULT_OUT_DIR}"
BUCKET="${OPENTAG_PORTABLE_GCS_BUCKET:-$DEFAULT_BUCKET}"
# An unset or empty environment value means "use the default prefix"; publishing at the bucket root
# is an explicit choice that has to be spelled out as `--prefix ''`.
PREFIX="${OPENTAG_PORTABLE_GCS_PREFIX:-$DEFAULT_PREFIX}"
PROJECT="${OPENTAG_PORTABLE_GCS_PROJECT:-}"
DOWNLOAD_BASE_URL="${OPENTAG_PORTABLE_DOWNLOAD_BASE_URL:-}"
DRY_RUN=0
PREFLIGHT_ONLY=0

log() {
  printf '[portable upload] %s\n' "$*"
}

die() {
  printf '[portable upload] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/portable/upload-gcs.sh --channel prod|staging [options]

Options:
  --out-dir <dir>               Portable release output directory.
  --bucket <bucket>             Cloud Storage bucket name. Defaults to opentag-release.
  --prefix <prefix>             Object name prefix before the channel segment. Defaults to releases.
  --project <project>           Google Cloud project for gcloud calls.
  --download-base-url <url>     Public release base URL, without the channel segment.
  --preflight-only              Check immutable prefix compatibility without writing objects.
  --dry-run                     Print the planned operations without contacting Cloud Storage.
  --help                        Show this help.

Environment:
  OPENTAG_PORTABLE_DOWNLOAD_BASE_URL
  OPENTAG_PORTABLE_GCS_BUCKET
  OPENTAG_PORTABLE_GCS_PREFIX
  OPENTAG_PORTABLE_GCS_PROJECT
  OPENTAG_PORTABLE_OUT_DIR

Credentials come from gcloud itself: an authenticated gcloud configuration, a workload identity
federation credential file, or GOOGLE_APPLICATION_CREDENTIALS. This script never reads or logs them.
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

normalize_prefix() {
  local value="$1"
  while [[ "$value" == /* ]]; do
    value="${value#/}"
  done
  trim_trailing_slashes "$value"
}

validate_download_base_url() {
  local value="$1"
  [[ -n "$value" ]] || die "download base URL is required for public verification"
  local trimmed
  trimmed="$(trim_trailing_slashes "$value")"
  local last_segment="${trimmed##*/}"
  if [[ "$last_segment" == "prod" || "$last_segment" == "staging" ]]; then
    die "--download-base-url must not include the channel segment; got $value"
  fi
  DOWNLOAD_BASE_URL="$trimmed"
}

json_string() {
  local file="$1"
  local path="$2"
  node -e '
const fs = require("node:fs");
let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const key of process.argv[2].split(".")) value = value?.[key];
if (typeof value !== "string") process.exit(2);
process.stdout.write(value);
' "$file" "$path"
}

asset_entries() {
  local manifest="$1"
  node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
if (assets.length === 0) process.exit(2);
for (const asset of assets) {
  if (typeof asset.fileName !== "string" || typeof asset.url !== "string") process.exit(2);
  console.log(`${asset.fileName}\t${asset.url}`);
}
' "$manifest"
}

derive_download_base_url() {
  node -e '
const fs = require("node:fs");
const latest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const suffix = `/${process.argv[2]}/${process.argv[3]}/manifest.json`;
if (typeof latest.manifestUrl !== "string" || !latest.manifestUrl.endsWith(suffix)) {
  throw new Error(`latest.json manifestUrl must end with ${suffix}`);
}
process.stdout.write(latest.manifestUrl.slice(0, -suffix.length));
' "$LATEST_PATH" "$CHANNEL" "$VERSION"
}

file_digest() {
  node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const bytes = readFileSync(process.argv[1]);
const encoding = process.argv[2] === "md5" ? "base64" : "hex";
process.stdout.write(createHash(process.argv[2]).update(bytes).digest(encoding));
' "$1" "$2"
}

file_size() {
  node -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).size));' "$1"
}

content_type_for_file() {
  case "$1" in
    manifest.json | latest.json) printf 'application/json' ;;
    SHA256SUMS) printf 'text/plain; charset=utf-8' ;;
    *.tar.gz) printf 'application/gzip' ;;
    *.sh) printf 'text/x-shellscript; charset=utf-8' ;;
    *) printf 'application/octet-stream' ;;
  esac
}

object_name() {
  if [[ -n "$PREFIX" ]]; then
    printf '%s/%s' "$PREFIX" "$1"
  else
    printf '%s' "$1"
  fi
}

gcs_uri() {
  printf 'gs://%s/%s' "$BUCKET" "$(object_name "$1")"
}

run_gcloud() {
  local args=(storage "$@")
  [[ -n "$PROJECT" ]] && args+=(--project "$PROJECT")
  gcloud "${args[@]}"
}

download_url() {
  curl -fsSL --retry 3 --retry-delay 2 "$1" -o "$2"
}

check_asset_url() {
  local url="$1"
  if curl -fsSI --retry 3 --retry-delay 2 "$url" >/dev/null; then
    return 0
  fi
  curl -fsSL --retry 3 --retry-delay 2 -r 0-0 "$url" -o /dev/null
}

verify_public_file_matches() {
  local label="$1"
  local url="$2"
  local local_path="$3"
  local dest="$4"
  log "verifying public $label: $url"
  download_url "$url" "$dest" || die "public $label is not readable: $url"
  cmp -s -- "$local_path" "$dest" || die "public $label does not match the local release artifact: $url"
}

# Every expected URL is derived from the local release metadata, never from anything already remote,
# so a stale or hostile remote object cannot redirect the verification to a copy it controls.
validate_local_release_urls() {
  local expected_manifest_url="$DOWNLOAD_BASE_URL/$CHANNEL/$VERSION/manifest.json"
  local local_manifest_url
  local_manifest_url="$(json_string "$LATEST_PATH" "manifestUrl")"
  if [[ "$local_manifest_url" != "$expected_manifest_url" ]]; then
    die "local latest.json manifestUrl mismatch: expected $expected_manifest_url, got $local_manifest_url (build and upload must use the same download base URL)"
  fi
  local file_name url
  while IFS=$'\t' read -r file_name url; do
    [[ -n "$file_name" ]] || continue
    if [[ "$url" != "$DOWNLOAD_BASE_URL/$CHANNEL/$VERSION/$file_name" ]]; then
      die "manifest asset url mismatch for $file_name: expected $DOWNLOAD_BASE_URL/$CHANNEL/$VERSION/$file_name, got $url"
    fi
  done < <(asset_entries "$MANIFEST_PATH")
}

verify_remote_versioned_release() {
  (
    set -euo pipefail
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/opentag-portable-remote.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT

    version_base_url="$DOWNLOAD_BASE_URL/$CHANNEL/$VERSION"
    verify_public_file_matches "versioned manifest" "$version_base_url/manifest.json" "$MANIFEST_PATH" "$tmp_dir/manifest.json"
    verify_public_file_matches "versioned SHA256SUMS" "$version_base_url/SHA256SUMS" "$VERSION_DIR/SHA256SUMS" "$tmp_dir/SHA256SUMS"

    while IFS=$'\t' read -r file_name url; do
      [[ -n "$file_name" ]] || continue
      log "verifying public release asset: $url"
      check_asset_url "$url" || die "public release asset is not readable: $url"
    done < <(asset_entries "$MANIFEST_PATH")
  )
}

verify_remote_channel_pointers() {
  (
    set -euo pipefail
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/opentag-portable-remote.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT

    verify_public_file_matches "channel latest.json" "$DOWNLOAD_BASE_URL/$CHANNEL/latest.json" "$LATEST_PATH" "$tmp_dir/latest.json"
    verify_public_file_matches "channel install.sh" "$DOWNLOAD_BASE_URL/$CHANNEL/install.sh" "$INSTALLER_PATH" "$tmp_dir/install.sh"
  )
}

write_expected_objects() {
  local output_path="$1"
  : >"$output_path"

  local file_name
  local -a immutable_names=(manifest.json SHA256SUMS)
  while IFS= read -r file_name; do
    [[ -n "$file_name" ]] || continue
    if [[ "$file_name" == */* || "$file_name" == "." || "$file_name" == ".." || "$file_name" == *$'\t'* ]]; then
      die "manifest asset fileName must be a simple file name, got: $file_name"
    fi
    immutable_names+=("$file_name")
  done < <(cut -f 1 <(asset_entries "$MANIFEST_PATH"))

  for file_name in "${immutable_names[@]}"; do
    local local_path="$VERSION_DIR/$file_name"
    [[ -f "$local_path" ]] || die "missing immutable release object: $local_path"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$file_name" \
      "$local_path" \
      "$(file_digest "$local_path" sha256)" \
      "$(file_size "$local_path")" \
      "$(content_type_for_file "$file_name")" \
      "$(object_name "$CHANNEL/$VERSION/$file_name")" \
      "$(file_digest "$local_path" md5)" \
      >>"$output_path"
  done
}

list_remote_version_objects() {
  local output_path="$1"
  local error_path
  error_path="$(mktemp "${TMPDIR:-/tmp}/opentag-gcs-list.XXXXXX")"
  local status=0
  run_gcloud objects list "$(gcs_uri "$CHANNEL/$VERSION/")**" --raw --format=json >"$output_path.json" 2>"$error_path" || status=$?
  if [[ "$status" -ne 0 ]]; then
    if grep -qi "matched no objects" "$error_path"; then
      : >"$output_path"
      rm -f "$error_path" "$output_path.json"
      return 0
    fi
    cat "$error_path" >&2
    rm -f "$error_path" "$output_path.json"
    die "failed to list $(gcs_uri "$CHANNEL/$VERSION/")"
  fi
  node -e '
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[1], "utf8").trim();
const items = text ? JSON.parse(text) : [];
for (const item of Array.isArray(items) ? items : [items]) {
  if (typeof item?.name === "string") console.log(item.name);
}
' "$output_path.json" >"$output_path"
  rm -f "$error_path" "$output_path.json"
}

validate_no_extra_remote_objects() {
  local remote_keys_path="$1"
  local expected_keys_path="$2"
  local key
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if ! grep -Fxq -- "$key" "$expected_keys_path"; then
      die "remote version prefix contains an unexpected object: $key"
    fi
  done <"$remote_keys_path"
}

# Compares what Cloud Storage actually holds against the local artifact. The size and sha256 checks
# are mandatory; md5Hash is absent for composite objects, so it strengthens the comparison when the
# API reports it instead of rejecting an otherwise valid object.
check_remote_object_matches() {
  local key="$1" expected_size="$2" expected_sha="$3" expected_md5="$4"
  local described
  described="$(run_gcloud objects describe "gs://$BUCKET/$key" --raw --format=json)" ||
    die "failed to describe gs://$BUCKET/$key"
  node -e '
const described = JSON.parse(process.argv[1]);
const [key, expectedSize, expectedSha, expectedMd5] = process.argv.slice(2);
const problems = [];
if (String(described.size) !== expectedSize) {
  problems.push(`size ${described.size ?? "missing"} != ${expectedSize}`);
}
const remoteSha = described.metadata?.sha256;
if (remoteSha !== expectedSha) {
  problems.push(`sha256 metadata ${remoteSha ?? "missing"} != ${expectedSha}`);
}
if (typeof described.md5Hash === "string" && described.md5Hash !== expectedMd5) {
  problems.push(`md5Hash ${described.md5Hash} != ${expectedMd5}`);
}
if (problems.length > 0) {
  console.error(`immutable object ${key} already exists with different content: ${problems.join("; ")}`);
  process.exit(1);
}
' "$described" "$key" "$expected_size" "$expected_sha" "$expected_md5" ||
    die "remote immutable object does not match the local release artifact: $key"
}

check_remote_immutable_prefix() {
  local mode="$1"
  local expected_objects_path="$2"
  local missing_objects_path="$3"
  local remote_keys_path expected_keys_path
  remote_keys_path="$(mktemp "${TMPDIR:-/tmp}/opentag-gcs-remote-keys.XXXXXX")"
  expected_keys_path="$(mktemp "${TMPDIR:-/tmp}/opentag-gcs-expected-keys.XXXXXX")"

  cut -f 6 "$expected_objects_path" >"$expected_keys_path"
  list_remote_version_objects "$remote_keys_path"
  validate_no_extra_remote_objects "$remote_keys_path" "$expected_keys_path"
  : >"$missing_objects_path"

  local file_name local_path expected_sha expected_size content_type key expected_md5
  while IFS=$'\t' read -r file_name local_path expected_sha expected_size content_type key expected_md5; do
    [[ -n "$file_name" ]] || continue
    if grep -Fxq -- "$key" "$remote_keys_path"; then
      check_remote_object_matches "$key" "$expected_size" "$expected_sha" "$expected_md5"
    elif [[ "$mode" == "require-complete" ]]; then
      die "remote immutable object is missing after upload: $key"
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$file_name" "$local_path" "$expected_sha" "$expected_size" "$content_type" "$key" "$expected_md5" \
        >>"$missing_objects_path"
    fi
  done <"$expected_objects_path"
  rm -f "$remote_keys_path" "$expected_keys_path"
}

upload_immutable_object() {
  local local_path="$1" expected_sha="$2" content_type="$3" key="$4" expected_md5="$5"
  log "uploading immutable object: gs://$BUCKET/$key"
  run_gcloud cp "$local_path" "gs://$BUCKET/$key" \
    --cache-control="$IMMUTABLE_CACHE_CONTROL" \
    --content-type="$content_type" \
    --custom-metadata="sha256=$expected_sha" \
    --content-md5="$expected_md5" \
    --if-generation-match=0
}

upload_mutable_object() {
  local label="$1" local_path="$2" content_type="$3" key="$4"
  log "uploading mutable $label to $(gcs_uri "$key")"
  run_gcloud cp "$local_path" "$(gcs_uri "$key")" \
    --cache-control="$MUTABLE_CACHE_CONTROL" \
    --content-type="$content_type" \
    --custom-metadata="sha256=$(file_digest "$local_path" sha256)" \
    --content-md5="$(file_digest "$local_path" md5)"
}

print_planned_uploads() {
  local expected_objects_path="$1"
  local file_name local_path expected_sha expected_size content_type key expected_md5
  while IFS=$'\t' read -r file_name local_path expected_sha expected_size content_type key expected_md5; do
    [[ -n "$file_name" ]] || continue
    log "would upload immutable object gs://$BUCKET/$key ($expected_size bytes, $content_type, sha256=$expected_sha)"
  done <"$expected_objects_path"
  log "would upload mutable latest.json to $(gcs_uri "$CHANNEL/latest.json")"
  log "would upload mutable install.sh to $(gcs_uri "$CHANNEL/install.sh")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      require_value "$1" "${2:-}"
      CHANNEL="$2"
      shift 2
      ;;
    --out-dir)
      require_value "$1" "${2:-}"
      OUT_DIR="$2"
      shift 2
      ;;
    --bucket)
      require_value "$1" "${2:-}"
      BUCKET="$2"
      shift 2
      ;;
    --prefix)
      [[ $# -ge 2 ]] || die "--prefix requires a value"
      PREFIX="$2"
      shift 2
      ;;
    --project)
      require_value "$1" "${2:-}"
      PROJECT="$2"
      shift 2
      ;;
    --download-base-url)
      require_value "$1" "${2:-}"
      DOWNLOAD_BASE_URL="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=1
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
[[ -n "$BUCKET" ]] || die "--bucket or OPENTAG_PORTABLE_GCS_BUCKET is required"
PREFIX="$(normalize_prefix "$PREFIX")"
if [[ -n "$PREFIX" && ("${PREFIX##*/}" == "prod" || "${PREFIX##*/}" == "staging") ]]; then
  die "--prefix must not include the channel segment; got $PREFIX"
fi

command -v node >/dev/null 2>&1 || die "node is required"
if [[ "$DRY_RUN" -eq 0 ]]; then
  command -v gcloud >/dev/null 2>&1 || die "the gcloud CLI is required"
  if [[ "$PREFLIGHT_ONLY" -eq 0 ]]; then
    command -v curl >/dev/null 2>&1 || die "curl is required for public release verification"
  fi
fi

if [[ "$OUT_DIR" == /* ]]; then
  CHANNEL_DIR="$OUT_DIR/$CHANNEL"
else
  CHANNEL_DIR="$REPO_ROOT/$OUT_DIR/$CHANNEL"
fi
LATEST_PATH="$CHANNEL_DIR/latest.json"
INSTALLER_PATH="$CHANNEL_DIR/install.sh"
[[ -f "$LATEST_PATH" ]] || die "missing latest metadata: $LATEST_PATH"
[[ -f "$INSTALLER_PATH" ]] || die "missing installer: $INSTALLER_PATH"

LOCAL_CHANNEL="$(json_string "$LATEST_PATH" "channel")"
VERSION="$(json_string "$LATEST_PATH" "version")"
[[ "$LOCAL_CHANNEL" == "$CHANNEL" ]] || die "local latest channel mismatch: expected $CHANNEL, got $LOCAL_CHANNEL"
VERSION_DIR="$CHANNEL_DIR/$VERSION"
MANIFEST_PATH="$VERSION_DIR/manifest.json"
[[ -d "$VERSION_DIR" ]] || die "missing version directory: $VERSION_DIR"
[[ -f "$MANIFEST_PATH" ]] || die "missing manifest: $MANIFEST_PATH"
[[ -f "$VERSION_DIR/SHA256SUMS" ]] || die "missing checksums: $VERSION_DIR/SHA256SUMS"

MANIFEST_CHANNEL="$(json_string "$MANIFEST_PATH" "channel")"
MANIFEST_VERSION="$(json_string "$MANIFEST_PATH" "version")"
[[ "$MANIFEST_CHANNEL" == "$CHANNEL" ]] || die "local manifest channel mismatch: expected $CHANNEL, got $MANIFEST_CHANNEL"
[[ "$MANIFEST_VERSION" == "$VERSION" ]] || die "local manifest version mismatch: expected $VERSION, got $MANIFEST_VERSION"

if [[ -z "$DOWNLOAD_BASE_URL" ]]; then
  DOWNLOAD_BASE_URL="$(derive_download_base_url)"
fi
validate_download_base_url "$DOWNLOAD_BASE_URL"
validate_local_release_urls

EXPECTED_OBJECTS_PATH="$(mktemp "${TMPDIR:-/tmp}/opentag-gcs-expected-objects.XXXXXX")"
MISSING_OBJECTS_PATH="$(mktemp "${TMPDIR:-/tmp}/opentag-gcs-missing-objects.XXXXXX")"
trap 'rm -f "$EXPECTED_OBJECTS_PATH" "$MISSING_OBJECTS_PATH"' EXIT
write_expected_objects "$EXPECTED_OBJECTS_PATH"

if [[ "$DRY_RUN" -eq 1 ]]; then
  print_planned_uploads "$EXPECTED_OBJECTS_PATH"
  log "dry run completed; no Cloud Storage calls were made"
  exit 0
fi

log "checking immutable version prefix compatibility: $(gcs_uri "$CHANNEL/$VERSION")/"
check_remote_immutable_prefix "allow-missing" "$EXPECTED_OBJECTS_PATH" "$MISSING_OBJECTS_PATH"

if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
  if [[ -s "$MISSING_OBJECTS_PATH" ]]; then
    log "preflight found missing immutable objects that the release step can still upload"
  fi
  log "preflight completed without immutable prefix conflicts"
  exit 0
fi

if [[ -s "$MISSING_OBJECTS_PATH" ]]; then
  while IFS=$'\t' read -r file_name local_path expected_sha expected_size content_type key expected_md5; do
    [[ -n "$file_name" ]] || continue
    upload_immutable_object "$local_path" "$expected_sha" "$content_type" "$key" "$expected_md5"
  done <"$MISSING_OBJECTS_PATH"
else
  log "all immutable version objects already exist and match the local artifacts"
fi

log "rechecking the immutable version prefix before mutable channel updates"
check_remote_immutable_prefix "require-complete" "$EXPECTED_OBJECTS_PATH" "$MISSING_OBJECTS_PATH"

log "verifying the public versioned release before updating mutable channel entry points"
verify_remote_versioned_release

upload_mutable_object "latest.json" "$LATEST_PATH" "application/json" "$CHANNEL/latest.json"
upload_mutable_object "install.sh" "$INSTALLER_PATH" "text/x-shellscript; charset=utf-8" "$CHANNEL/install.sh"

verify_remote_channel_pointers
log "published $CHANNEL $VERSION to $(gcs_uri "$CHANNEL")/"
