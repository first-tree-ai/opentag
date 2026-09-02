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
curl -fsSL https://storage.googleapis.com/opentag-release/releases/prod/install.sh | sh
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

## Automatic upgrades

Portable is the only install mode with fully supported automatic upgrades; an npm-global install never upgrades
itself and uses the manual `opentag upgrade` / `opentag upgrade --check` commands instead. One exact target per
channel, no cohorts or canaries: the Server polls the channel's published `latest.json` and advertises that exact
target to connected Clients on v2 heartbeat results (the `runtime.channelTarget` capability — see
[runtime-protocol.md](./runtime-protocol.md)).

The daemon's updater follows a strict contract:

- **Exact target identity, monotonic precedence.** Only an exact version-string match is already current, so a target
  that differs only by SemVer build metadata is still installed. SemVer precedence is used only to reject an older
  target; the target must also belong to the Client's own channel, and an automatic downgrade never happens.
- **Protected work comes first.** Before installing, the updater waits indefinitely until the Session module reports
  no protected work — no accepted Turn under local custody, no pending Turn completion or report, and no accepted
  IM delivery could be lost or duplicated by the handoff. The Session module bounds every one of those units (Turn
  budgets, delivery deadlines, report retries with terminal outcomes), so the updater adds no force timeout of its
  own. New-work admission is closed before the zero-work snapshot; deliveries accepted before that point continue
  draining, while later deliveries receive a retryable busy result.
- **One attempt per target.** The attempt is recorded durably before any install work starts. A failure — including
  an interrupted attempt — becomes a blocked state that is never retried automatically: the updater waits for a
  newer target or a manual `opentag upgrade`, which prevents retry and restart storms.
- **The existing layout does the work.** The install downloads the immutable version manifest (never the channel
  pointer), verifies the published SHA-256, extracts into a fresh immutable version directory, smoke-checks the new
  runtime, rewrites the stable shim, and moves `current` in one atomic switch — the same mechanics as `install.sh`.
- **Service refresh and handoff.** After the switch, the updater runs `daemon refresh-service` through the newly
  installed binary so the supervisor definition is rewritten by the version that will run next, without restarting
  anything itself. It then exits with the reserved supervisor-restart exit code `75`: systemd maps it to a clean
  forced restart (`SuccessExitStatus=0 75` + `RestartForceExitStatus=75`), and launchd restarts it through
  `KeepAlive.SuccessfulExit=false`. The stable shim means the restarted service runs the new version with the
  OpenTag home, Account credentials, Computer connection, Agents, and placement untouched.

Current version, target, updater state, and the last attempt with its failure reason are visible in
`opentag daemon status`.

## Published object layout

~~~text
<prefix>/<channel>/latest.json                 Mutable channel pointer
<prefix>/<channel>/install.sh                  Mutable channel installer, pinned to this channel and base URL
<prefix>/<channel>/<version>/manifest.json     Immutable release metadata
<prefix>/<channel>/<version>/SHA256SUMS        Immutable checksums
<prefix>/<channel>/<version>/<package>-<version>-<platform>.tar.gz
~~~

Default coordinates are the `opentag-release` bucket under the `releases` prefix, served from
`https://storage.googleapis.com/opentag-release/releases`.

Everything under a version prefix is immutable and written with a create-only precondition
(`--if-generation-match=0`) plus a `--content-md5` digest, so Cloud Storage rejects both a silent overwrite and a
corrupted upload. Only `latest.json` and `install.sh` are mutable; they are written last, and `latest.json` is written
under a generation precondition so two publishers can never interleave.

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
   artifact's size, `md5Hash`, and `sha256` metadata. `md5Hash` is required, not opportunistic: it is the only one of
   the three that describes the stored bytes, so an object without it fails closed. Parallel composite uploads are
   disabled for the same reason, because a composite object reports no `md5Hash`.
3. Upload only the missing immutable objects, create-only, each with a `--content-md5` digest.
4. Re-list and require the version prefix to be complete.
5. Over the **public** endpoint: compare the versioned `manifest.json` and `SHA256SUMS` byte for byte, then download
   every asset in full and verify its SHA-256 against the manifest.
6. Install the release from the public endpoint, pinned to the exact version, and check the reported version. This
   runs on the release host, so it covers that platform only.
7. Read the channel pointer and the generation that produced it. If the channel already advertises a newer version,
   stop here: the immutable objects are published and installable by exact version, and the pointer is left alone.
8. Write `install.sh`, then `latest.json` conditioned on the generation from step 7, and verify both. A lost
   precondition is not a failure — steps 7 and 8 are retried against the new state until they converge.

Steps 5 and 6 are why a release cannot advertise a version the public endpoint does not actually serve. A `HEAD` or
single-byte range request would only prove that something answers at the URL; a stale or misrouted cached object would
pass while every installer that fetched it would reject its checksum. Every URL checked is derived from the local
release metadata, never from anything already remote.

Step 7 makes publication monotonic and step 8 makes it single-writer. `install.sh` is written first because it is
channel-pinned and version-independent, so a failure between the two writes leaves an installer that is at least as new
as the pointer.

## Channel heads

A release channel has two heads that must agree: the npm dist-tag and the portable `latest.json`. `npm publish --tag
latest` moves npm's head to whatever it publishes regardless of what is already there, so publishing an older release
after a newer one would drop npm back while the portable pointer correctly held, and the two would advertise different
versions. Both heads therefore apply the same rule — advance only on a forward move, using one shared comparator in
`scripts/release-versions.mjs`. An out-of-order release still publishes and stays installable by exact version; it
publishes under the `superseded` npm dist-tag and leaves `latest.json` alone.

Release jobs are serialized per channel with `queue: max`, which keeps every pending run in FIFO order. The default
`single` cancels whatever run is already pending, which would silently drop a protected release tag. Order is still not
relied upon: the monotonic guards hold regardless of the order runs are processed in.

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
| `OPENTAG_PORTABLE_DOWNLOAD_BASE_URL` | Public base URL (default `https://storage.googleapis.com/opentag-release/releases`) |
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
- The installer only installs or upgrades OpenTag. The onboarding command runs `opentag connect`, which exchanges the
  one-time Computer code, binds its explicit Agent/Computer target, and then installs or restarts the daemon service.
  Provider CLI detection and installation belongs to that active daemon, never to `install.sh`.
- Any released version can be installed directly with `sh install.sh --version <version>`, which reads that version's
  immutable manifest and never consults the channel pointer. This is how a rollback is performed, and how the release
  gate installs a release before it is advertised.
- An existing version directory is never rewritten in place, because `current` may resolve through it. A forced
  reinstall lands in a new directory, `current` is moved onto it atomically, and only then is the superseded copy
  removed — so an interrupted reinstall can leave a stray directory but can never leave `current` dangling.
