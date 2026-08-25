# OpenTag portable release guide

[简体中文](./zh-CN/portable-release.md)

A portable release is a self-contained OpenTag install: one tarball per platform that carries the bundled CLI **and its
own Node.js runtime**, so a machine with no Node.js, no npm, and no package manager can install and run OpenTag. It is
published to Google Cloud Storage and installed with a single `curl … | sh` command.

The portable channels mirror the npm channels exactly. Every portable release is built from the same commit, the same
identity rewrite, and the same version coordinate as the npm package it accompanies — see
[releasing.md](./releasing.md) for how those coordinates are derived.

| Channel | Package | Binary | Install root |
| --- | --- | --- | --- |
| Staging | `open-tag-staging` | `opentag-staging` | `~/.local/share/opentag/staging` |
| Production | `open-tag` | `opentag` | `~/.local/share/opentag/prod` |

## Installing

~~~bash
curl -fsSL https://download.opentag.build/releases/prod/install.sh | sh
~~~

The installer resolves the channel's `latest.json`, downloads the tarball for the detected platform, verifies its
published SHA-256, extracts it, runs the new runtime once, and only then activates it. Options:

| Option | Effect |
| --- | --- |
| `--version <version>` | Install an immutable version instead of `latest` |
| `--prefix <path>` | Install root (default `~/.local/share/opentag/<channel>`) |
| `--bin-dir <path>` | Shim directory (default `~/.local/bin`) |
| `--force` | Reinstall even when the target version is already active |
| `--no-path-edit` | Never edit shell startup files |
| `--path-mode auto\|prompt\|off` | How the installer manages the `PATH` block |

**Reinstalling is cheap.** After reading `latest.json`, the installer checks whether the requested version is already
the live install: the `current` symlink must resolve to a payload whose `INSTALL.json` matches the target version,
platform, and binary name, the embedded runtime and app entry must both be present, and the stable shim in `--bin-dir`
must already resolve through `current`. When all of that holds it reports that OpenTag is already up to date and exits
without downloading the payload. A partial install, a hand-edited shim, or a deleted `--bin-dir` entry fails that check
and is repaired by a full reinstall. `--force` reinstalls unconditionally.

## Layout

The installer keeps every version it has installed and switches between them with one symlink:

~~~text
<prefix>/versions/<version>/    Extracted payload (immutable once activated)
<prefix>/current                Symlink to the active version, replaced atomically
<bin-dir>/<binName>             Stable shim; resolves through `current` on every run
~~~

The shim is what makes updates safe. It never names a version directory, so the daemon service definition written by
`daemon ensure-service` keeps pointing at the shim and survives every subsequent update. The shim exports
`OPENTAG_INSTALL_MODE=portable`, `OPENTAG_PORTABLE_ROOT`, and `OPENTAG_PORTABLE_BIN_DIR` before exec'ing the embedded
runtime.

Each payload contains:

~~~text
VERSION                 Plain-text version
INSTALL.json            Release metadata, platform, install mode, and app entry
node/bin/node           Embedded Node.js runtime, checked against the official SHASUMS256.txt
app/                    Bundled CLI, its package manifest, LICENSE, README, THIRD_PARTY_NOTICES
bin/<binName>           Artifact-local shim, used before the payload is activated
~~~

The bundled CLI has no `node_modules`: `apps/cli` declares no runtime dependencies, and the build fails closed if that
ever changes rather than shipping an artifact that only breaks when a user runs it.

## Published object layout

~~~text
<prefix>/<channel>/latest.json                 Mutable channel pointer
<prefix>/<channel>/install.sh                  Mutable channel installer, pinned to this channel and base URL
<prefix>/<channel>/<version>/manifest.json     Immutable release metadata
<prefix>/<channel>/<version>/SHA256SUMS        Immutable checksums
<prefix>/<channel>/<version>/<package>-<version>-<platform>.tar.gz
~~~

Default coordinates are the `opentag-release` bucket under the `releases` prefix, served from
`https://download.opentag.build/releases`.

Everything under a version prefix is immutable and written with a create-only precondition
(`--if-generation-match=0`) plus a `--content-md5` digest, so Cloud Storage rejects both a silent overwrite and a
corrupted upload. Only `latest.json` and `install.sh` are mutable, and they are written last.

## Building

~~~bash
# Rewrite the checkout to the target channel identity first; the portable build verifies it and
# refuses to ship a stale or mismatched apps/cli/dist.
node scripts/prepare-cli-release.mjs --channel staging --version 0.0.2-staging.1.1
pnpm --dir apps/cli build

./scripts/portable/build-release.sh \
  --channel staging \
  --version 0.0.2-staging.1.1 \
  --skip-workspace-build \
  --platform "$(node -p 'process.platform + "-" + process.arch')"
~~~

Artifacts land in `.portable-release/<channel>/`. Verify one before publishing it:

~~~bash
node scripts/portable/verify-portable-artifact.mjs \
  --manifest .portable-release/staging/0.0.2-staging.1.1/manifest.json \
  --platform darwin-arm64 \
  --tarball .portable-release/staging/0.0.2-staging.1.1/open-tag-staging-0.0.2-staging.1.1-darwin-arm64.tar.gz
~~~

The verifier checks the published checksum, the extracted layout, and the metadata, and additionally runs the artifact
when it targets the host platform.

The embedded Node.js version is pinned in `scripts/portable/node-version.txt` and must be an exact `vX.Y.Z`. Its tarball
is checked against the official `SHASUMS256.txt` for that release before it becomes part of an artifact.

Tarballs are byte-reproducible for a given commit, version, and platform: archive timestamps are normalized to the
release timestamp, entries are sorted, owner identity is zeroed, and gzip records no mtime. Release retries therefore
re-upload identical bytes instead of colliding with the create-only precondition. Reproducibility holds per tar flavor;
release builds run on Linux CI with GNU tar.

## Publishing

~~~bash
./scripts/portable/release-gcs.sh --channel staging --version 0.0.2-staging.1.1 --skip-workspace-build
~~~

`release-gcs.sh` builds, uploads, and then installs the published release the way a user would. The upload step runs in
a fixed order, and each stage is a gate on the next:

1. Validate the local tree, and check that every asset URL matches the download base URL the build used.
2. List the remote version prefix. An unexpected object fails the release; an existing object must match the local
   artifact's size, `sha256` metadata, and `md5Hash`.
3. Upload only the missing immutable objects, create-only.
4. Re-list and require the version prefix to be complete.
5. Fetch the versioned `manifest.json` and `SHA256SUMS` over the **public** endpoint and compare them byte for byte,
   and confirm every tarball URL is readable.
6. Only then write `latest.json` and `install.sh`, and verify those too.

Step 5 is why a release cannot advertise a version the public endpoint does not actually serve. Every URL it checks is
derived from the local release metadata, never from anything already remote.

Useful flags: `--dry-run` prints the planned operations without contacting Cloud Storage, `--preflight-only` checks
immutable-prefix compatibility without writing, and `--skip-build` reuses artifacts already in the output directory.

## Release authority

GitHub Actions is the release authority. `publish-npm-package.yml` preflights the portable release before `npm publish`
so an immutable-prefix conflict fails while the release is still retryable, and publishes it afterwards from the same
preflighted artifacts. The portable steps are skipped unless the repository is configured for Cloud Storage.

Required repository variables:

| Variable | Purpose |
| --- | --- |
| `OPENTAG_PORTABLE_GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload identity provider; also the switch that enables the portable steps |
| `OPENTAG_PORTABLE_GCP_SERVICE_ACCOUNT` | Service account impersonated by the workflow |
| `OPENTAG_PORTABLE_GCS_BUCKET` | Bucket name (default `opentag-release`) |
| `OPENTAG_PORTABLE_GCS_PREFIX` | Object prefix before the channel segment (default `releases`) |
| `OPENTAG_PORTABLE_GCS_PROJECT` | Project used for `gcloud` calls |
| `OPENTAG_PORTABLE_DOWNLOAD_BASE_URL` | Public base URL (default `https://download.opentag.build/releases`) |
| `OPENTAG_PORTABLE_PLATFORMS` | Optional platform filter for the build |

Publishing uses workload identity federation, so no service-account key is stored in the repository. The service
account needs `roles/storage.objectUser` on the bucket: read, create, and list cover the immutable objects, and
`storage.objects.delete` is additionally required because Cloud Storage treats overwriting `latest.json` and
`install.sh` as replacing them. The version prefix stays immutable through the create-only upload precondition rather
than through IAM. To enforce that at the IAM layer as well, grant `roles/storage.objectUser` under an IAM condition
limited to the two channel pointer paths, and `roles/storage.objectCreator` plus `roles/storage.objectViewer`
elsewhere.

The workload identity provider must carry an attribute condition that pins it to this repository. Without one, any
GitHub Actions workflow anywhere can mint a token for the pool and impersonate the release service account.

The bucket must serve the release prefix publicly at the download base URL. Until it does, uploads still succeed but
the public verification gate fails and the channel pointers are deliberately left untouched.

## Operational notes

- The installer needs `curl` or `wget`, `tar`, and `sha256sum` or `shasum`. Linux and macOS on x64 and arm64 are
  supported; Windows is not.
- After activation the installer runs `daemon ensure-service`. Exit code 3 means the CLI deferred service setup until
  `login` creates credentials, which is the normal first-install path and not a failure.
- A release never deletes an old version directory, so an install can be rolled back with
  `sh install.sh --version <older-version>`.
