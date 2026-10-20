---
title: "Cloud Runner toolchain"
description: "Contents, build, and boundaries of the digest-addressed Cloud Runner image."
---

# Cloud Runner toolchain

This is the openTag **Cloud Runner image**: a linux/amd64 Linux environment consumed by
[E3 execution](cloud-runner-execution.md) as a fixed, digest-addressed image. This document
covers image construction and local toolchain acceptance; E3 documents the native Cloud path.

The Runner is owned by `@opentag/client`. It shares the **CLI release coordinate**
(`apps/cli`, currently `0.0.5`). Private Client `0.0.0` is not a Runner version.

Publication follows the CLI workflow; environment activation and rollback are described in
[Cloud Runner releases](../../operations/cloud-runner-release.md).

## What the image contains

The image default user is `root` because the Cloud Run native sandbox launcher requires the
Instance parent process to run as root. `runner-entrypoint` keeps root only for the exact
`opentag-runner serve` invocation, which it runs under the source-owned `opentag-init`; every
other command is dropped to uid/gid 10000 with supplementary groups cleared through the
base-image `setpriv`. Nothing installs or downloads `setpriv`: the digest-pinned Node bookworm
image ships it (util-linux), and the build asserts both the version banner and the exact
uid/gid/group drop before any image is produced.

Binaries on `PATH` stay root-owned and the unprivileged `runner` user keeps dedicated `HOME`,
`/workspace`, and `/tmp`:

| Command | Pin |
| --- | --- |
| `node` | `v24.19.0` (`scripts/portable/node-version.txt`), image digest-pinned |
| `pi` | `@earendil-works/pi-coding-agent@0.84.2` (locked under `scripts/runner/pi/`) |
| `context-tree` | `@first-tree-ai/context-tree@0.1.16` from `apps/cli` (not a second pin) |
| `git` | inherited from the digest-pinned Node image (`2.39.5`, asserted at build; no apt download) |
| `gh` | GitHub CLI `2.100.0`, checksum-verified linux/amd64 release |
| `slack` / `lark-cli` | Reviewed Provider CLI catalog (Slack `4.10.0`, Lark `1.0.92`) with skip-update env/args |

Native Slack/Lark executables keep their upstream basenames in the root-owned internal directory
`/opt/opentag/tools/internal/`; the user-facing commands in `/opt/opentag/tools/bin/` are the
managed launchers, so the reviewed catalog probe patterns match the binaries' actual output.

Pi receives an explicit skill list through the Client Pi adapter (`--no-skills` plus `--skill`
on each selected directory):
the six packaged Context Tree skills plus four source-owned tool skills (`git`, `gh`, `slack`,
`lark-cli`) assembled at `/opt/opentag/skills/`, whose guidance is tied to the installed CLI help
and catalog pins. Host skills are never copied. Real acceptance verifies the skills Pi actually
loaded via a dedicated Pi RPC `get_commands` query (exactly those ten names, never contents).

Runtime credentials are supplied separately. The real acceptance harness injects only a filtered
Pi configuration through `docker cp`; credentials are never Docker build args.

## Build

The build entry is `scripts/runner/cli.mjs`. It reuses `scripts/prepare-cli-release.mjs` and the
existing release-version convention. Staging versions must be supplied from outside; the Runner
never increments them.

~~~bash
# Production coordinate (must match apps/cli version)
node scripts/runner/cli.mjs build --channel prod --version 0.0.5 --tag opentag-runner:0.0.5

# Staging coordinate resolved by the existing release workflow, then passed in
node scripts/runner/cli.mjs build --channel staging --version 0.0.6-staging.4.1 --tag opentag-runner:staging

# Development; dirty trees require an explicit flag. A final clean build must still be possible.
node scripts/runner/cli.mjs build --channel dev --allow-dirty true --tag opentag-runner:local
~~~

The stager copies an allowlist only (no `.git`, `.env`, `.npmrc`, HOME, tests, or work data),
rejects every symlink, refuses credential filenames such as `auth.json` even under an allowed
directory, and stages **only Git-tracked files** (`git ls-files`, so index intent-to-add counts):
ignored or untracked local files (logs, editor droppings) never enter the context or the final
skills directory, and staging fails safely when source Git ownership cannot be established. A new
intended source file therefore needs index intent; dirty development builds still carry the
working-tree content of tracked files. The Docker context is that staged directory, not the
checkout. Frozen `pnpm install` runs before any staging/prod `prepare-cli-release` rewrite so the
lockfile still matches.

The Node version must have a reviewed image digest in `scripts/runner/pins.mjs`; a version bump
without that mapping fails before building. Runtime dependency conflicts support one level of
nesting; a conflict beneath an already nested package fails explicitly instead of shipping the
wrong version. Before copying, the closure verifies the complete planned layout — every dependency
edge of every top-level and nested placement — and fails closed on anything it cannot represent
exactly, including same-name shadowing in any placement.

Image labels record source SHA, dirty flag, CLI/version, and tool lock. `docker inspect` reports
the image ID after a successful build.

Cloud Run requires **linux/amd64**. The Dockerfile and harness always pass `--platform linux/amd64`.
See the [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract).

## Teardown

The Node harness registers temp directories and containers and removes them on success, failure,
`SIGINT`, and `SIGTERM`. There is no keep-secrets option.

~~~bash
docker rm -f <container>
docker rmi -f opentag-runner:local
~~~

## E3 consume

E3 should pin a **built image ID** (the local `sha256:…` reported by `docker image inspect`
after the build) together with the same CLI release version and source SHA recorded in
`/opt/opentag/identity.json`. A local image ID is not a registry digest: once the image is pushed,
the registry content digest is the value to pin for remote consumption. Do not retag `latest`.
Do not treat a local Docker run as proof of native Cloud Run, Sandbox, network policy, or IM.

Acceptance measurements (image size, startup latency, `memory.peak`) belong in a separate record
once a parent run supplies them.

## Boundaries

- Local Docker on a non-amd64 host uses emulation; that is not native Sandbox or Cloud Run.
- The E3 `serve` command connects outbound to the authenticated Server Runner WebSocket. It opens
  no parent-container HTTP control port. See [execution configuration](cloud-runner-execution.md).
- Slack/Lark in the image are catalog-pinned CLIs with update checks disabled, not logged-in IM.
