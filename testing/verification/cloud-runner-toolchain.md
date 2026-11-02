# Cloud Runner toolchain: verification and acceptance

Test and acceptance material for [Cloud Runner toolchain](../../docs/system/cloud/cloud-runner-toolchain.md).

## Repeat / acceptance

Dedicated CI (`.github/workflows/runner-toolchain.yml`) builds the same linux/amd64 image and runs
**offline** smoke with container networking disabled. It never publishes and never requires model credentials.

~~~bash
node scripts/e2e/cloud-computer.mjs runner-toolchain --channel dev --mode offline --tag opentag-runner:worker-dev --allow-dirty true
# Reuse a built image:
node scripts/e2e/cloud-computer.mjs runner-toolchain --image opentag-runner:worker-dev --mode offline
# Real model acceptance (parent supplies the isolated Pi config privately):
node scripts/e2e/cloud-computer.mjs runner-toolchain --image opentag-runner:worker-dev --mode real --pi-config-dir /path/to/pi-config --provider deepseek
~~~

The harness always uses `--cpus=1 --memory=1g --memory-swap=1g` and asserts those inspect values.
Offline checks probe exact parsed Node/Git/gh/Slack/Lark/Pi/CT/CLI versions (anchored full-line
patterns including the reviewed catalog banners) and assemble the six Context Tree skills on a
disposable tree. Unknown flags fail. `--mode real` requires `--pi-config-dir` and `--provider`; missing config fails before
any model claim, and providers other than the currently supported `deepseek` are rejected at
parse time. Offline is the only mode that reports `model=skipped`. Real validates the supplied
config host-side (whitelisted regular files, selected-provider documents, safe settings keys, no
HOME, no symlinks, no `!` shell-command indirections), stages a filtered copy, and injects only
that copy via `docker cp` plus a one-shot root `chown`/`chmod` exec into a fresh guard container —
never a whole `HOME` mount. `models.json` is rebuilt from the recognized top-level fields
`models` and `providers` only, so unknown fields never reach the container; malformed shapes fail
with fixed messages. The guard runs with Docker `--init` so PID 1 is an init that reaps orphaned
children (a zombie is not a gone process), keeping `sleep infinity` alive until harness cleanup
removes it. The image entrypoint uses the source-owned `opentag-init` to forward signals and
reap orphaned children; offline acceptance tests this init without Docker `--init`. The same
offline pass asserts the privilege boundary: a normal command reports uid 10000, gid 10000 and
`id -G` 10000, while the exact `serve` path keeps root and delegates to the source-owned init.
The real acceptance command has a separate 30-minute timeout. It asserts a confirmed cancellation of a live Bash fixture child
(shared tracked Pi PID set), and removes the container afterwards with daemon-confirmed removal.

This offline pass is the release-time tool validation: it executes every pinned tool — including
a full Pi CLI startup with an exact version comparison against the image identity — before a Runner
image is published. The runtime native Sandbox readiness probe (E3) deliberately does not repeat
that Pi CLI launch on every launch/reset; it reads the locked Pi package metadata from the
immutable rootfs and validates it against the image identity, keeping per-launch readiness fast
without weakening this release-time gate.

Timing fields are distinct: `startupMs` measures a fresh container plus Runner CLI startup
(`identity`); probe/skills/accept durations are reported separately (`durations`, `acceptanceMs`).
`memory.peak` is read inside the container before it exits, never after removal. The Runner CLI
installs SIGTERM/SIGINT handlers beneath `opentag-init`, runs its scoped cleanup, and exits
143/130; the host harness kills owned process groups, including nested Docker CLI processes,
on signals before removing containers. Malformed config JSON is reported with the filename only
(never source fragments), and acceptance log redaction covers quoted JSON secret fields and full
`Authorization`/`Bearer` values as well as structured fields and known key prefixes.

Default `opentag-runner` with no command exits nonzero. It does not hang waiting for a server.


## Pi MCP first-RPC startup

The image build compiles the pinned adapter before rootfs assembly. Regression checks cover
static and lazy TypeScript imports without a runtime TypeScript loader, adjacent assets,
native loading of the real pinned adapter without root-level optional peers, and inclusion
of the compiler in the staged image build context:

~~~bash
node --test --test-concurrency=1 scripts/__tests__/runner-pi-mcp-build.test.mjs scripts/__tests__/runner-build-context.test.mjs scripts/__tests__/runner-runtime-closure.test.mjs
pnpm --filter @opentag/client test src/__tests__/cloud-turn-worker.test.ts src/__tests__/pi-mcp-gateway.test.ts src/__tests__/pi-mcp-gateway-smoke.test.ts
pnpm --filter @opentag/client typecheck
pnpm exec turbo run build --filter=@opentag/client --concurrency=2
pnpm check
~~~

A controlled native Sandbox comparison uses the pinned Pi 0.84.2 / adapter 2.36.0 installation,
1 vCPU and 1 GiB, a fresh namespace per case, and a bounded CPU-pressure child. The MCP and
model endpoints are loopback fixtures with no upstream credentials or external actions.
CPU profiles of the source adapter show Jiti/Babel traversal, module reads and garbage
collection before the first MCP request; the compiled path removes adapter transformation.
Merely compiling one monolithic file is insufficient: Jiti also transforms dynamic `.mjs`
imports, and flattening lazy modules eagerly loads unnecessary dependency graphs. The final
path preserves lazy imports and uses Node's native loader with the SDK's own peer paths.

Native validation overlays the generated adapter modules and gateway wrapper into an existing
Runner image's disposable rootfs. It verifies native loading and fixture MCP execution; it
does not establish a rebuilt image release, staging deployment, or recovery of a user's IM Task.
The first `get_state` timeout remains 60 seconds throughout this change.

Recorded native fixture validation on 2026-11-02: with the bounded CPU-pressure child, the
source path returned `get_state` after 80.491s (the 60s deadline had already fired), while the
compiled lazy path returned in 44.076s without deadline expiry. Gateway module import fell
from 29.394s to 2.610s. In a separate fresh native namespace without pressure, the complete
fixture Turn finished in 7.861s: `get_state` took 6.788s, prompt acceptance took 82ms, and two
fixture model responses completed one MCP `tools/call`. Diagnostics still reported the
original 60,000ms RPC budget. The native fixture's overall Run bound was 90s, separate from
the unchanged per-RPC budget.
