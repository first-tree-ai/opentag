# Provider CLI management architecture

[简体中文](../zh-CN/design/provider-cli-management.md)

Status: proposed

Last updated: 2026-08-30

## 1. Purpose

This document defines the minimum local architecture for the official Feishu/Lark
and Slack CLIs used by OpenTag Agents. It covers installation scope, executable
identity, abnormal states, credential delivery, and the native command experience.

Later landing, install, standalone repair, and doctor products must consume this
foundation. They must not add another resolver, readiness definition, or credential
path.

## 2. Product decisions

1. **An OpenTag-managed Provider CLI is installed globally for one operating-system
   account by default.** Here, global means available outside a project and directly
   callable by that user. It does not mean a root-owned system installation.
2. **The installed commands are `lark-cli` and `slack`.** The same commands are used
   by a human shell and an Agent Runtime.
3. **The provider binary remains official.** OpenTag owns only installation,
   selection, a thin launcher, and temporary credential projection. It does not
   translate provider methods or restore an adapter send API.
4. **Installation is deterministic and non-interactive by default.** The OpenTag CLI
   detects compatible commands already visible in the user's current environment,
   automatically selects the newest compatible version, and internally persists its
   path. If no compatible local command exists, it immediately performs the managed
   install. The user never types an absolute path and OpenTag never mutates a selected
   external installation.
5. **Detection and runtime authority are separate.** User-facing detection performs
   one bounded scan of exact command names in the invoking CLI process's PATH. The
   daemon later uses only the canonical path persisted from the selected candidate;
   it does not launch a login shell or scan version managers and well-known
   directories.
6. **Readiness is daemon-owned and read-only.** Caller-shell `HOME`,
   `XDG_CONFIG_HOME`, PATH, and provider login state cannot change the answer.
7. **Provider credentials are Turn-scoped.** Installation, version, login,
   subscription, and API-token usability are separate facts.
8. **Only an exact, compatible, successfully probed executable is ready.** Unknown,
   stale, ambiguous, or partially installed state fails closed.

The direct-provider-CLI boundary remains unchanged: OpenTag owns inbound facts,
routing, and credential projection; Agents send through official `lark-cli` or
`slack api`; provider-native outbound truth remains outside OpenTag.

## 3. Minimal architecture

```text
reviewed ProviderCliCatalog
          |
          v
explicit ProviderCliInstaller mutation
          |
          v
account-global store + stable lark-cli/slack launchers
          |
          +-------------------------> human shell
          |
          v
daemon ProviderCliManager --probe--> fresh local readiness --> Server
          |
          v
Turn exact-target plan + private credential environment
          |
          v
Agent Runtime: lark-cli ... / slack api ...
```

Only five components are required:

| Component | Responsibility |
| --- | --- |
| `ProviderCliCatalog` | Reviewed version, platform asset, digest, license, and probe contract. |
| `ProviderCliInstaller` | Explicit managed install, upgrade, rollback, and removal. |
| Account-global launcher | Native command name that executes the selected official binary. |
| `ProviderCliManager` | Read-only selection validation, probing, readiness, and exact Turn plan. |
| `CredentialEnvironmentManager` | Authorized private Turn environment and cleanup. |

The Server receives only provider, coarse readiness, freshness, and connection
identity. It never receives a local path, selection record, package manifest, or
credential-file path.

## 4. Account-global layout

The global root is derived from the installed service's operating-system account
record, not caller environment variables or `OPENTAG_HOME`:

```text
POSIX:   <account-home>/.opentag/provider-cli/
Windows: <account-local-app-data>/OpenTag/provider-cli/  # reserved, not P0

provider-cli/
  bin/lark-cli       # authoritative OpenTag Runtime launcher
  bin/slack[.exe]    # authoritative OpenTag Runtime launcher
  versions/<provider>/<version>/<platform>-<arch>/<sha256>/...
  state/<provider>.json
  staging/<provider>/<operation-id>/...
  plans/<turn-id>/...
```

`provider-cli/bin` is the only authoritative command directory for OpenTag Runtime.
By default, the installer also creates an OpenTag-owned public shim in the
`<account-home>/.local/bin` directory already used by the portable installer. A user
can therefore invoke the native command directly, while the daemon and Agent
Runtime always prepend the absolute `provider-cli/bin` path and never depend on
shell startup files. When the portable installer uses a custom `BIN_DIR`, the
install flow passes that already-resolved directory to the Provider CLI manager;
this is not exposed as external-path registration.

If an unmanaged file already occupies the public command name, OpenTag does not
overwrite it. The internal Runtime launcher can still execute the selected target
exactly, but the install result must report `global_command_shadowed` and identify
what the human shell currently resolves. This warning is not disguised as a
Runtime installation failure; readiness fails only when the internal launcher or
selected target is unusable.

The product never writes `/usr/local/bin`, `/usr/bin`, another package manager's
prefix, or a root-owned directory. It never requires `sudo`. If the user's shell
PATH already resolves another command with the same name first, activation reports
`global_command_shadowed`; it does not overwrite that file. Running the install flow
authorizes the idempotent account-global PATH registration already used by the
OpenTag launcher, so no second prompt is required. `--no-path-update` may opt out;
the result then remains not globally active until the user fixes PATH.

All OpenTag Homes for one operating-system account share this global Provider CLI
installation. Each daemon independently probes the one current selection. An older
OpenTag version that cannot use it reports `version_incompatible`; it does not
silently select or install another version.

## 5. Selection model

Exactly two selections exist:

```ts
type ProviderCliSelection =
  | { kind: "managed"; artifactId: string }
  | {
      kind: "external";
      executablePath: string;
      fingerprint: string;
      trust: "catalog-verified" | "compatible-unverified";
    };
```

External selection is created only from a candidate returned by the user-facing
detector. The detector owns path resolution; the user or Agent receives the resolved
path as feedback but never has to enter, edit, or confirm it. When no eligible
external candidate remains, the same operation proceeds directly to managed install.

### 5.1 External detection contract

Detection is a read-only OpenTag CLI operation, not daemon readiness. It:

1. reads the invoking CLI process's PATH and, on Windows, `PATHEXT`;
2. inspects only exact provider command names in absolute PATH directories;
3. ignores empty, relative, current-directory, protected-root, and unsafe
   world-writable entries;
4. canonicalizes and deduplicates candidates by realpath;
5. validates regular-file, executable, platform, architecture, version, and required
   command surface without credentials or provider API requests;
6. includes the current selected target even when it is not present in caller PATH,
   and classifies the OpenTag account-global launcher as the managed candidate
   instead of offering it again as external;
7. returns an ephemeral candidate ID, canonical path, version, source directory,
   fingerprint, and trust level.

A digest matching the shipped catalog is `catalog-verified`. Another compatible
artifact is `compatible-unverified`: OpenTag cannot prove its provenance, so the result
must say so explicitly, but the explicit install-script invocation authorizes using
the detected local command. `--managed-only` disables all external selection when an
operator requires catalog-verified managed artifacts only.

After validation, candidate selection is deterministic:

1. discard unsafe, unparseable-version, unsupported, and incompatible candidates;
2. sort by normalized semantic version, newest first;
3. for the same version, prefer `catalog-verified` over `compatible-unverified`;
4. for the same version and trust, prefer the command that the invoking shell's PATH
   would resolve first;
5. report every ignored candidate and the exact reason, then report the selected
   path, version, trust, and tie-breaker.

The candidate set includes the current managed or external selection plus newly
detected PATH candidates. Therefore repeated `ensure` still notices a newer local
installation instead of returning early.

Immediately before persistence, the CLI reopens the winner by canonical path and
verifies its candidate ID and fingerprint. If it changed, that candidate is removed
and the ranking runs again. If no eligible candidate remains, OpenTag proceeds to
managed install. The flow never stops to ask the user to choose.

Candidate IDs exist only in memory for that CLI operation. A later or separate
invocation must detect again; there is no durable pre-selection candidate cache.

An external target must be a regular executable file outside protected roots. Its
canonical realpath, platform, architecture, version, and file identity are recorded
and revalidated. It cannot resolve back to the OpenTag launcher. OpenTag does not
upgrade, delete, relocate, log in, or repair it.

An automatically selected `compatible-unverified` external installation remains a
clearly reported install-script trust decision. Diagnostics must label its
provenance accordingly, never `opentag-verified`.

After installation, Runtime has no automatic precedence chain or ambiguity:

- a healthy selected target is used;
- an unhealthy selected target is unavailable;
- only an explicit `ensure` or install operation may switch the target; daemon
  readiness never does so.

The account-global launcher is reconciled byte-for-byte to the persisted selection
and transparently executes that exact official binary. Inspection rejects a missing,
replaced, or mismatched launcher; the next explicit `ensure` repairs it. It forwards
argv, stdin, stdout, stderr, signals, and exit status without interpreting provider
operations. PR 2 adds the per-Turn plan that makes active-Turn execution independent
from concurrent selection updates.

Outside an OpenTag Turn, the launcher behaves as a normal global provider command
and uses the user's ordinary provider environment. This is what lets the user use
the OpenTag-managed CLI directly. A managed target never self-updates; its launcher
disables update checks and upgrades only through `ProviderCliInstaller`. An external
target keeps its operator-owned update behavior outside OpenTag Turn mode.

## 6. Managed installation transaction

The catalog entry contains only reviewed static data:

- provider and native command name;
- exact supported version or compatibility range;
- platform, architecture, archive type, and expected executable;
- official artifact URL and SHA-256 digest;
- bounded download, archive, and executable sizes;
- non-secret probe commands and timeouts;
- license and required third-party notices.

The daemon never consumes a mutable remote `latest` manifest. A catalog change
ships in a reviewed OpenTag release.

Initial probe contracts are:

| Provider | Command | Required local probes |
| --- | --- | --- |
| Feishu/Lark | `lark-cli` | `--version`, `im --help` |
| Slack | `slack` | `version`, `api --help` |

Probes run in a fresh private temporary HOME/config directory, with caller credential
variables removed and update checks disabled. The temporary directory is deleted
after the bounded probes. They make no provider API request and never read the user's
normal provider configuration.

An explicit install or upgrade is one transaction:

1. acquire an account/provider exclusive lock;
2. download to one private staging directory with time and size limits;
3. verify the exact digest and safely extract the expected file only;
4. reject path traversal, absolute archive members, devices, setuid/setgid files,
   and unexpected links or executables;
5. publish to a digest-addressed immutable version directory;
6. run the full non-secret compatibility probe, including when reusing an already
   published digest-addressed directory;
7. reconcile the internal launcher and the OpenTag-owned public shim; never overwrite
   an unmanaged command, and report PATH shadowing as a local warning without
   downgrading internal Runtime readiness;
8. atomically replace the selection record;
9. refresh readiness and retain the previous version for rollback.

Failure before step 8 leaves the persisted selection record unchanged. A crash or
write failure that leaves launcher/selection mismatch is fail-closed by inspection
and repaired by the next explicit `ensure`. Startup recovery removes only recognized
stale staging directories within the locked provider's staging subtree, never a
concurrent operation for the other provider. The previous version is deleted
only when it is unselected, no Turn plan references it, and a retention grace period
has elapsed.

OpenTag does not run an upstream global installer or arbitrary npm `postinstall`
from daemon readiness. It installs reviewed official release artifacts from the
catalog. This gives Lark and Slack the same lifecycle despite different upstream
packaging.

Step 7 validates the current installer environment and the account-global PATH
registration owned by the installer. It is an install-activation check, not daemon
readiness derived from an arbitrary future caller shell. If the user's PATH later
changes, daemon readiness remains based on the absolute global bin while a future
installer or doctor may separately report user-command shadowing.

## 7. Probe-to-execution identity

The current implementation can probe one absolute path and later ask the Agent to
run a different bare command from PATH. The global launcher removes that gap.

`ProviderCliManager` establishes readiness by validating the selected target and
running the required probes through the global launcher. It records a fingerprint
over the selection generation, canonical target, file identity, version, and
managed digest when present.

Before admitting a visible Turn, the manager:

1. verifies the current fingerprint;
2. writes a `0600` private, non-secret plan record under the fixed runtime plan root
   that pins the exact target and fingerprint;
3. emits the plan ID into the Turn environment.

The launcher accepts only a bounded plan ID, resolves it beneath the fixed private
plan root, verifies file ownership and shape, and executes the pinned target in
OpenTag Turn mode,
not the current account-global selection. A managed update may therefore switch the
global selection atomically without changing an active Turn. The old immutable
target remains until all referencing plans are removed. A changed external
executable produces `artifact_drifted` and requires a new probe; the launcher never
falls back to another PATH entry.

Human invocations outside OpenTag do not need a Turn plan. Atomic selection and
immutable version paths allow an already-running process to finish while later
commands use the new version.

## 8. Credential delivery

For an authorized visible Turn:

```text
fresh ready selection
  -> private exact-target Turn plan
  -> fenced credential grant from Server
  -> private provider config and 0600 environment file
  -> Agent sources OPENTAG_PROVIDER_ENV_FILE
  -> Agent runs lark-cli ... or slack api ...
  -> Turn ends: credentials/config/plan removed
```

The environment file contains the non-secret Turn plan ID and an OpenTag Turn-mode
marker plus only the required provider variables.

- **Feishu/Lark:** private `LARKSUITE_CLI_CONFIG_DIR`, bound App identity and brand,
  fresh tenant access token, and no user access token.
- **Slack:** `SLACK_BOT_TOKEN`, explicitly removed `SLACK_USER_TOKEN` and
  `SLACK_APP_TOKEN`, plus a private config directory. In Turn mode the launcher
  supplies Slack's global `--config-dir` and disables update checks before
  forwarding the Agent's native arguments.

Outside Turn mode the launcher does not apply OpenTag credentials or private config,
so a user may configure and use the globally installed CLI normally.

Credentials never enter a selection record, process argv, prompt, log, persistent
Runtime binding, or Server readiness. Internal Sessions never receive the file.
Cleanup occurs at Turn completion, is retried during Session and Client shutdown,
and is recovered after a crash on the next Client startup. Plan files contain no
credential but follow the same bounded cleanup lifecycle.

This design does not require `lark-cli auth login`, `slack login`, a provider
subscription check, or a static API-token check. The authorized OpenTag Bot grant is
the credential authority for the Turn.

## 9. Minimal state and diagnostics

```ts
type ProviderCliLocalState =
  | "checking"
  | "absent"
  | "ready"
  | "unavailable";
```

The stable diagnostic code retains the reason without expanding the state machine:

| Code | Meaning |
| --- | --- |
| `not_installed` | No managed artifact or external selection exists. |
| `global_bin_unavailable` | Account-global command directory cannot be created or used. |
| `launcher_invalid` | The OpenTag-owned global launcher is missing, replaced, or malformed. |
| `global_command_shadowed` | User shell resolves a different command first. |
| `external_path_invalid` | The selected external path is missing, unsafe, non-regular, or non-executable. |
| `external_not_detected` | No compatible existing command is visible to the invoking CLI. |
| `external_candidate_changed` | Candidate identity changed before selection or during later validation. |
| `external_candidate_unverified` | Candidate is compatible but its digest is not in the reviewed catalog. |
| `artifact_drifted` | Selected target changed after validation. |
| `integrity_failed` | Managed digest, manifest, or archive is invalid. |
| `version_incompatible` | Version or required native command surface is unsupported. |
| `probe_failed` | Bounded local version/help probe failed or timed out. |
| `install_incomplete` | Explicit mutation failed before publication. |
| `credential_unavailable` | Installation is ready, but this Turn could not obtain or materialize credentials. |

Only `ready` maps to Server `ready`; `absent` maps to `install`; error-severity
failures map to `unavailable`; an in-flight observation maps to `checking`.
`global_command_shadowed` and `external_candidate_unverified` are mandatory local
warnings and do not independently downgrade Runtime readiness. Credential errors
fail the Turn but do not rewrite installation readiness.

Paths and diagnostic details remain local. Raw child-process output and secrets are
never forwarded to Server or logs.

## 10. Adversarial checks and surviving design

| Attack or failure | Required behavior |
| --- | --- |
| Doctor shell changes HOME, XDG, or PATH | Daemon selection and readiness do not change. |
| A project adds a fake `lark-cli` or `slack` to PATH | Runtime prepends the absolute account-global bin; fake command is not selected. |
| Detection PATH contains `.`, a relative directory, or a world-writable directory | Detector ignores the unsafe entry and never offers its command. |
| Candidate changes after detection | Candidate is removed, remaining candidates are ranked again, then managed install is used if none remain. |
| Several compatible commands are on PATH | Newest compatible semantic version wins; trust and effective PATH order are deterministic tie-breakers. |
| A process supplies a forged plan path | Launcher accepts only a bounded ID under the private fixed plan root and validates the record. |
| Several package-manager versions exist | No scanning occurs; only the explicit selected target is considered. |
| External binary is replaced after probe | Fingerprint check fails with `artifact_drifted`. |
| Update races with an active Turn | The Turn plan keeps executing its pinned immutable target; the new selection affects later Turns. |
| Download is truncated or archive is malicious | Digest and safe extraction fail before publication. |
| Process crashes during install | Active selection is unchanged; recognized staging is recovered. |
| Ambient Slack/Lark login exists | Turn-private config and explicit Bot variables win; user credentials are not selected. |
| User invokes the managed CLI directly | Native command works with ordinary user config and no OpenTag secret. |
| An unmanaged command already exists | It is not overwritten and no prompt is shown; activation reports shadowing and the resolved target while OpenTag Runtime continues through its internal launcher. |
| Multiple OpenTag Homes exist | They share one account-global selection; each daemon probes it and an incompatible daemon fails closed. |
| Global install would require root | Installation fails with a user-level remediation; OpenTag never escalates privileges. |

The following earlier ideas are intentionally rejected as unnecessary complexity:

- bundling both provider binaries in the base npm package;
- calling upstream global install scripts at daemon runtime;
- recursively scanning home directories;
- starting a login shell to discover PATH;
- enumerating nvm/fnm/asdf/mise/package-manager versions;
- maintaining per-Turn command directories;
- reporting local executable paths to Server;
- probing login, subscriptions, or API-token usability as installation readiness.

## 11. Foundation interfaces for later product work

```ts
inspect(provider): ProviderCliDiagnostic;       // read-only
detectExternal(provider, callerEnvironment):
  readonly ProviderCliCandidate[];              // read-only, user CLI scope
ensure(provider, mode = "auto"):
  ProviderCliEnsureResult;                      // select newest or managed install
install(provider, catalogArtifact): void;       // explicit mutation
useManaged(provider): void;                     // explicit mutation
removeManaged(provider, version): void;         // explicit mutation
planForTurn(provider): ProviderCliTurnPlan;     // ephemeral local state
```

The later landing/download, install-script, standalone, and Agent-driven flows call
`ensure`. Running the install flow is the explicit authorization for selection or
managed installation; no second confirmation is required. `auto` selects the newest
eligible local version and installs managed only when none exists. `managed-only`
skips local candidates. These flows must not copy secrets, own an external package,
or hide why one candidate won.

### 11.1 Agent-friendly execution and feedback

The install flow must work without a TTY and without prompts. Human mode prints
bounded single-line phase updates rather than spinners:

```text
[lark] detect: 2 candidates
[lark] select: 1.0.92 external /canonical/path (newest compatible)
[lark] verify: ready
```

Required phases are `detect`, `select` or `managed-install`, `verify`, and `ready` or
`failed`. Feedback includes provider, action (`noop`, `selected-existing`, or
`installed-managed`), version, canonical path, source, trust, ignored candidates
with reasons, and final readiness. It never includes credentials or raw untrusted
child-process output.

For Agents and automation, `--json` emits one stable JSON document to stdout with
the same phase records and final result, with no ANSI, spinner, or prompt. Human
progress is suppressed in that mode. Exit codes are `0` for ready (including an
idempotent no-op), `1` for an operational failure, and `2` for invalid usage.
`--dry-run` performs detection, ranking, and reporting without selection or install.

The JSON result has this minimum shape:

```ts
interface ProviderCliEnsureResult {
  ok: boolean;
  provider: "feishu" | "slack";
  action: "noop" | "selected-existing" | "installed-managed" | "failed";
  phases: Array<{ phase: string; status: "started" | "completed" | "failed" }>;
  selected?: { path: string; version: string; source: string; trust: string };
  candidates: Array<{
    path: string;
    version?: string;
    trust?: string;
    disposition: "selected" | "ignored";
    reason: string;
  }>;
  readiness: "ready" | "unavailable";
  globalCommand: { active: boolean; path?: string; resolvedPath?: string };
  warnings: Array<{ code: string; remediation?: string }>;
  diagnostic?: { code: string; remediation?: string };
}
```

A multi-provider execution returns one result per provider and a nonzero overall
exit code if any requested provider failed; completed providers are not rolled back.

Repeated execution is idempotent: `noop` is reported only when the current healthy
selection remains the highest-ranked compatible installed candidate. A newer local
version is selected and reported. When no eligible external candidate exists, an
older OpenTag-managed selection is upgraded to the newer reviewed catalog artifact;
an older OpenTag binary never downgrades a newer incompatible managed selection. An
interrupted managed install leaves the prior selection unchanged and the next
execution safely resumes from detection. Use `ensure --dry-run` to detect and rank
caller-PATH installations without mutating selection; `inspect` validates only the
persisted account selection and deliberately does not infer it from caller PATH.

Future doctor work may render the same diagnostics, but it must not infer daemon
readiness from its own PATH or turn a version probe into an authentication or
end-to-end claim. The current P0 `opentag doctor` scope remains unchanged until its
product specification is explicitly revised.

## 12. Comparison with the current implementation

Current `origin/main` already contains the second half of the direct-provider-CLI
flow, but not a third-party CLI package manager. The boundary between code to keep
and code to replace is:

| Capability | Current implementation | Gap from this specification | Landing action |
| --- | --- | --- | --- |
| IM CLI readiness wire | `computer.ts` defines only `checking/install/ready/unavailable`; Client heartbeat reports it and Server stores it with freshness for the handoff gate. | The coarse model is sufficient, but local causes are not represented. | **Keep the wire and Server behavior.** Map local manager results to the existing states and never report path/version. |
| Command discovery | `refreshImCliReadiness` resolves only the first `lark-cli`/`slack` on daemon PATH. | No multiple candidates, version ordering, trust, selection, or account authority. | Replace the resolver with `ProviderCliManager.inspect()`; the daemon never performs external detection. |
| Probe | Lark already runs `--version` plus `im --help`; Slack runs `version` plus `api --help`, with a 10-second timeout. | Errors are collapsed, versions are not parsed, and executable identity is absent. | Move the existing probe contract into the catalog and add bounded output, diagnostics, and a fingerprint. |
| Selection/storage | None; `larkCliCommand`/`slackCliCommand` are test-only injection hooks. | A probed file and a later Agent bare command can differ. | Add an account-global selection record, generation, and immutable managed artifact. |
| Credential handoff | `ImCredentialEnvironmentManager` writes a `0600` Turn env; Lark gets private config, while Slack receives the Bot token and explicitly drops user/app tokens; cleanup and recovery already exist. | It is not bound to a Provider CLI target; Slack private config must be completed against the official CLI contract. | **Extend the existing manager instead of creating another secret store.** Add only plan ID and Turn marker to the env. |
| Agent command | The prompt already requires sourcing the env and invoking native `lark-cli`/`slack api`. | Runtime PATH does not prepend the authoritative launcher, leaving a probe/execution fork. | Keep the prompt, prepend the account-global launcher in the Session workspace environment, and bind the Turn plan ID. |
| Install/upgrade | There is no Provider CLI command; the portable installer installs only OpenTag. | No catalog, digest, transaction, global activation, or Agent-friendly output. | Add `opentag provider-cli ensure/inspect`; later portable `.sh` calls it and does not copy package logic. |
| Installation transaction base | The portable installer already has a pinned manifest, SHA-256, immutable versions, pre-commit smoke, atomic `current`, and a stable shim. | The logic is shell-only and cannot directly serve the Provider CLI manager. | Reuse its transaction semantics and test model; implement the Provider CLI transaction in TypeScript. |
| OS account authority | Daemon service resolves account home from `userInfo().homedir`, independent of caller `HOME`. | `packages/client` has only an OpenTag Home layout based on `OPENTAG_HOME`/`homedir()`. | Add an injectable `accountHome` account-global layout; both CLI and daemon pass the OS account record. |
| Doctor | The current P0 doctor specification excludes Integration CLI checks. | This work must not expand doctor incidentally. | **No change in this rollout.** A later doctor consumes manager diagnostics and never infers daemon state from doctor-shell PATH. |
| Login/token/subscription | Current readiness does not verify these facts. | None; this is an explicit product boundary. | **Do not add them and do not claim end-to-end readiness from installation.** |

The minimum code path is therefore to preserve
`RuntimeImCliReadinessObservation`, the Server registry, handoff gate, credential
grant, and outbox prompt; replace only Client-local command resolution and put a
reusable package-management core in front of it.

### 12.1 Current false green that must be removed first

Today the daemon can probe an absolute executable resolved from its PATH, then ask
the Agent to execute a bare command in a different shell. If those PATH values
differ, Server can receive `ready` even though the Agent executes another file or
gets command-not-found.

The first Runtime integration acceptance condition is not merely “probe passed.” A
single test must prove:

```text
selected target fingerprint
  == daemon probed target fingerprint
  == Turn plan target fingerprint
  == Agent native command actual executable fingerprint
```

## 13. Landing plan

### 13.1 Module boundaries

Reusable implementation belongs under `packages/client/src/runtime/provider-cli/`,
while Commander presentation remains in `apps/cli`:

```text
packages/client/src/runtime/provider-cli/
  account-layout.ts       OS account-global paths; no OPENTAG_HOME authority
  catalog.ts              reviewed artifacts, compatibility and probe contract
  detector.ts             caller-PATH exact-name detection and fingerprinting
  selection-store.ts      schema-v1 state, atomic write and generation
  installer.ts            lock, download, digest, safe extract and publish
  launcher.ts             global shim reconciliation and exact exec plan
  manager.ts              inspect, ensure, readiness mapping and planForTurn

apps/cli/src/core/provider-cli/
  ensure.ts               reusable command orchestration
  inspect.ts              read-only diagnostics

apps/cli/src/commands/provider-cli.ts
                          thin Commander and human/JSON rendering
```

`packages/client` reuses the existing secure durable-file primitives. The required
account/provider lock is also implemented in that package and must not depend back
on the daemon lease in `apps/cli`. Semantic versioning uses an explicit direct
dependency; it must not rely on a transitively hoisted pnpm package or an incomplete
hand-written prerelease ordering.

P0 supports only macOS and Linux, matching the current daemon service. Windows
layout and launcher contracts may remain reserved in the schema, but Windows must
not be claimed before real daemon/Agent QA exists.

### 13.2 Two pull requests

#### PR 1: Provider CLI management foundation

The goal is an independently usable and verifiable third-party CLI manager without
changing current daemon, handoff, Agent Turn, or installation-page behavior.

The PR may contain several compiling commits:

1. account-global layout, reviewed catalog, PATH detector, version/fingerprint, and
   newest-wins ranking;
2. selection store, exclusive lock, bounded download, digest/safe extraction,
   immutable publication, and launcher;
3. `opentag provider-cli inspect`, complete `opentag provider-cli ensure`,
   deterministic tests, and local E2E.

After PR 1, a user or Agent can independently run:

```sh
opentag provider-cli inspect --provider lark|slack|all [--json]
opentag provider-cli ensure --provider lark|slack|all \
  [--managed-only] [--no-path-update] [--dry-run] [--json]
```

`ensure` implements the final semantics in one PR: choose the newest compatible
version among multiple candidates, immediately perform managed install when no
eligible candidate exists, and leave a native command usable from the human shell.
It must not expose a temporary “managed install arrives in the next PR” state.

PR 1 acceptance closes the loop by:

- covering zero/one/multiple external installations, unsafe paths, version ranking,
  candidate replacement, and idempotent reruns under a fresh account root;
- using a local HTTP fixture for valid, wrong-digest, truncated, malicious-archive,
  wrong-architecture, probe-failure, and interruption-recovery cases;
- proving pre-publication failures preserve prior selection, non-TTY has no prompt,
  and JSON stdout contains one document;
- leaving `refreshImCliReadiness`, Server wire, Turn credentials, and portable
  installer unchanged.

Rollback removes only the explicit Provider CLI management command. Current Runtime
does not depend on PR 1 state or launchers.

#### PR 2: OpenTag product integration

The goal is to connect PR 1 foundation to formal onboarding, daemon readiness, and
Agent execution.

The PR may contain several compiling commits:

1. atomic daemon-readiness and visible-Turn exact-execution cutover with tests;
2. portable-installer and onboarding/download provider options with non-interactive
   feedback;
3. Docker/macOS, official-binary, and staging-credential product E2E and QA record.

Runtime integration is atomic: the daemon probes selected target, the Turn plan pins
the same fingerprint, Agent Runtime prepends the authoritative launcher, and the
Agent's bare `lark-cli`/`slack api` executes that target. Readiness cannot switch in
one commit while Agent PATH is repaired in a later commit.

The installation flow only invokes the already merged
`opentag provider-cli ensure`; `.sh` and Web do not copy detector, ranking, catalog,
or download logic. Provider CLI installation failure preserves the successfully
installed OpenTag base, exits nonzero, and prints remediation.

PR 2 acceptance closes the loop by:

- contaminating daemon and Agent PATH with same-name fixture CLIs with different
  fingerprints, then proving selection, probe, Turn plan, and actual execution are
  identical;
- covering managed-update/active-Turn races, external drift, caller HOME/XDG/PATH
  changes, ambient-credential exclusion, and cleanup recovery;
- running one scenario contract on fresh Docker Linux and macOS for external,
  managed fallback, multiple versions, shadowing, repeated install, and recovery;
- running pinned official-binary native help/version on macOS/Linux and one real
  daemon-to-Agent `lark-cli` and `slack api` execution each with staging credentials.

Rollback restores the legacy Runtime resolver and portable install flow. Server
needs no schema rollback or data migration.

### 13.3 Commit and acceptance rules

- The two PRs are serial: PR 2 starts from the merged and accepted PR 1 head; no
  parallel stacked PRs are maintained.
- Every commit compiles and passes `pnpm check`, `pnpm typecheck`, and targeted tests;
  implementation and its failure-path test land in the same commit.
- Every PR head runs from a fresh worktree and empty temporary account root and
  passes `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm test`,
  `pnpm test:coverage`, and `git diff --check`.
- Merge-blocking tests use local fixtures and a local HTTP server rather than mutable
  upstream state. Real binaries, daemon, and staging credentials are an additional
  product QA gate.
- The PR description records exact base/head, commands, fixture digests, supported
  and unverified platforms, and rollback boundary. All evidence is rerun after a
  head change.

### 13.4 Explicit non-goals for this rollout

- no Server URL, registration protocol, or readiness-schema change;
- no Provider CLI, login, subscription, API-token, or end-to-end send check in
  doctor;
- no restoration of Lark/Slack outbound adapters;
- no package-manager internals, home-tree, or login-shell scanning;
- no automatic overwrite of unmanaged global commands and no privilege escalation;
- no direct bundling of both Provider CLI binaries into the OpenTag npm package.

The two PRs are accepted in PR 1 → PR 2 order. PR 1 ships only independently usable
foundation. Daemon and onboarding switch to the new manager only after PR 2 passes
exact-executable and installation E2E. Any failed stage can roll back without
changing Server state.

## 14. Upstream references

- [Lark CLI releases](https://github.com/larksuite/cli/releases)
- [Lark CLI configuration source](https://github.com/larksuite/cli/blob/main/internal/core/config.go)
- [Slack CLI installation](https://docs.slack.dev/tools/slack-cli/guides/installing-the-slack-cli-for-mac-and-linux/)
- [`slack api` token resolution and flags](https://docs.slack.dev/tools/slack-cli/reference/commands/slack_api/)
