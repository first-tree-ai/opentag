---
title: "Doctor product specification"
description: "The read-only local baseline checked by opentag doctor, its authority, output, and repair guidance."
---

# Doctor product specification

## Purpose and scope

`opentag doctor` diagnoses the basic state of the openTag Home selected by the current CLI invocation.
It does not establish Daemon, Provider, Integration, or end-to-end handoff readiness. A successful P0
result means only that every blocking baseline check below passed. It must not say that openTag or
handoff is ready, or that all necessary checks passed.

Doctor is a bounded, read-only diagnostic orchestrator. It identifies the exact target, says which
layers it checked, distinguishes failure from unavailable evidence, and gives the narrowest safe next
action. Related commands retain separate responsibilities:

| Command | Responsibility | Mutation |
| --- | --- | --- |
| `status` | Show one subsystem's current state | None |
| `doctor` | Correlate bounded checks across prerequisite layers | None |
| `probe` or `test` | Perform an explicitly selected deeper check | Only as its own contract permits |
| `repair`, `install`, `login`, `connect` | Change local or remote state | Explicitly initiated by the operator |

Context Tree diagnostics are outside this contract. Agent settings shows repository selection and
Session prompts report preparation. Doctor emits no Context Tree checks or section heading.
openTag is an independent product; another product's Doctor implementation does not define this contract.

## Target and authority

The command accepts no Doctor-specific target arguments: neither `--server-url` nor `--server` is
supported, and `OPENTAG_SERVER_URL` does not select its Server. `OPENTAG_HOME` selects the complete
local installation; otherwise the current channel's default Home applies. Resolve and print its
normalized absolute path and whether it came from the environment or channel default, without
creating the Home or missing directories. CLI version, channel, platform, architecture, and Node.js
version are informational context.

The only authoritative Server is the one in that Home's validated Computer credential. A caller's
arbitrary URL could name a Server the Computer will never use.

Runtime and Integration CLI observations belong to the invoking CLI's environment. They do not
prove that the installed daemon has the same environment or can execute the selected artifact.
The report must state this limitation.

## Result semantics

Checks use `pass`, `fail`, `unknown`, `info`, or `skipped`, with an explicit blocking flag. A check
also has a stable code, scope, label, bounded detail, and optional observation source, path, and
remediation. Scopes are `target`, `local-configuration`, `daemon-service`, `server`, `agent-runtime`,
and `provider-cli`.

Exit 0 requires every blocking check to pass. A blocking `fail` or `unknown` returns 1; informational
and skipped results do not independently change the exit code. Invalid command syntax remains a CLI
usage error. Never present unknown or skipped evidence as a pass. Invalid prerequisites skip their
dependent checks with a reason while independent checks continue.

The complete human-readable report goes to stdout even when checks fail. Unexpected command-level
errors may additionally use stderr. Presentation consumes structured results; P0 does not promise a
public `--json` interface or its compatibility.

## Baseline checks

### Local Computer configuration

Local configuration is blocking and strictly read-only. Do not reuse `resolveComputerIdentity`,
which can create or rewrite identity state, or treat a runtime credential projection as a complete
configuration inspection. Passing requires all of the following:

- Home and config paths satisfy the existing private-storage safe-read rules.
- `computer.json` exists and is valid.
- `computer-credentials.json` exists, has a supported envelope version, and contains exactly one
  usable Computer credential. No malformed credential is silently discarded, and credential IDs
  satisfy the format's uniqueness rules.
- The credential's `computerId` matches the identity.
- The credential supplies one canonical Server origin, exactly equal to the identity's `serverUrl`.

Never print `machineToken`, credential file contents, or unredacted parse errors that may contain
file data. A missing, unsafe, malformed, inconsistent, or unsupported configuration fails locally
and prevents Server contact.

### Daemon service

The existing read-only service manager/status implementation owns this blocking check. Passing
requires a supported platform, an installed active service, a configured Home verified as the
selected Home, no service-definition drift, and runtime-owner consistency with that active service.
Inactive, absent, unsupported, drifted, mismatched, malformed, unverified, and other unknown states
fail closed. Include the existing log hint and the narrowest repair command when its parameters
are safely known.

Service status executes governed system programs from reviewed absolute locations, including
supported non-FHS locations such as NixOS systemd paths. A bare `launchctl`, `systemctl`, or `loginctl`
selected through the caller's `PATH` is not authoritative and cannot produce a pass.

The service manager obtains uid, username, and account home from the same operating-system account
record snapshot. It locates launchd plists and systemd user units at the product's defined locations
under that account home. Shell `HOME` and `XDG_CONFIG_HOME` cannot relocate the service definition.
Custom XDG installation paths are unsupported: when the OS user service manager loads units only
from another location, installation/status postconditions fail rather than guessing a definition.

### Bound Server health

After configuration establishes one authoritative origin, perform `GET /healthz` with a five-second
deadline and validate `ServerHealthSchema`. Distinguish configuration failure, timeout/network
failure, non-2xx HTTP, and an invalid response shape without exposing the raw body.

This proves only that the public health endpoint responded with the expected schema. It does not
validate the machine token, WebSocket registration, or Turn delivery. Invalid local configuration
makes this check `skipped` because there is no authoritative bound Server. Daemon and artifact
checks still run independently.

### Agent Runtime CLI artifacts

P0 reports Codex CLI and Claude Code CLI separately. The blocking aggregate passes when at least
one supported artifact is known to be installed. A missing alternative is informational: P0 has no
authoritative Agent-to-Provider assignment view that would justify requiring both.

Installed means the shared production resolver selected an ordinary executable file without
starting the Provider. Runtime composition and Doctor use the same resolver so their definitions
cannot drift. It must:

- accept an explicit path only when openTag actually offers that configuration; add no
  Doctor-specific Provider override;
- search the diagnostic process's `PATH` and reviewed well-known installation roots;
- search verified macOS ChatGPT/Codex App bundle locations for Codex only;
- reject executable directories, broken links, non-executable files, and unsafe automatic candidates;
- enforce the macOS protected-root policy before `stat`, `access`, `realpath`, enumeration, or other
  following reads, including symlink routes into Desktop, Documents, Downloads, iCloud, or cloud drives;
- return the canonical selected path and source (`caller-path`, `well-known`, `desktop-app`, or an
  actual supported configuration source);
- isolate detector failures, so one Provider's error cannot hide the other one's result.

Do not launch `codex` or `claude`, request `--version` or `--help`, inspect credentials or login,
initialize an App Server, call a model, install a binary, or modify Provider configuration.
An exception is unknown evidence, not proof that an artifact is absent.

`CLAUDE_CONFIG_DIR` has credential semantics and is not an installation signal. Discovery must not
synthesize or inject it. An unset value remains unset; an explicit value remains labeled observation
context. Runtime credential handling never permits Doctor to claim Claude authentication was checked.

### Integration CLI artifacts

Lark CLI and Slack CLI use the same install-only observation and are always nonblocking. Missing
one or both is informational; detector failure is nonblocking `unknown`. There is no
`integration.any-installed` aggregate or Integration-specific readiness contract.

Search the diagnostic process's `PATH`, openTag's account-global launcher directory, and reviewed
well-known roots. Select an ordinary executable and report its canonical path and source, with
independent detector failures. Do not execute or parse `--version`/`--help`, inspect credentials,
read Provider CLI selection/configuration, access the network, install, repair, or perform an
end-to-end operation. Runtime credential projection belongs to the Provider CLI lifecycle, outside Doctor.

## Output and guidance

Keep a fixed section order, regardless of concurrent completion:

1. Target
2. Local configuration
3. Daemon service
4. Server
5. Agent Runtime CLIs
6. IM Provider CLIs
7. Summary
8. Not evaluated

Installed artifact rows show their canonical path and source. Missing optional artifacts remain
visible. Summary is exactly one of:

- `Baseline checks passed for this openTag Home.`
- `N blocking baseline check(s) failed for this openTag Home.`

Every report includes **Not evaluated**, covering Runtime authentication, version/protocol
compatibility, visibility from the installed daemon environment, machine-token authentication,
WebSocket registration, Integration CLI version/credentials/configuration/network, and end-to-end
Turn or handoff delivery. These omissions are not passes. Remove one only after a reviewed contract
defines the check and the command actually performs it.

Doctor prints repair guidance and performs no repair. Print a complete executable command only
when every required nonsecret parameter is known; otherwise describe the action and link its
command or documentation. Never include connect codes, tokens, credential contents, or copied raw
Provider errors. Do not delete, rewrite, reconnect, reinstall, restart, or log in on the operator's
behalf. Do not recommend Runtime or Integration login when its authentication was not checked.

## Ownership, ordering, and budgets

Commander registration stays thin. `apps/cli` owns orchestration and rendering; reusable storage
inspection, Server health, and artifact discovery come through public `@opentag/client` interfaces.
The existing CLI daemon service manager owns service status. Do not duplicate production resolution
or use a Provider CLI readiness probe that runs the binary.

Resolve the target first. Local configuration, Runtime artifacts, Integration artifacts, and Daemon
status can proceed independently; only Server health waits for validated binding. Collect all
independent results before rendering in fixed order.

Network and subprocess work have explicit deadlines. Server health has five seconds; service
manager subprocesses retain their existing bounds. Filesystem inspection stays within the selected
Home and reviewed installation roots, with no recursive scan of the user's whole Home or macOS TCC
prompt. No Provider subprocess, model call, or Provider API request runs. Independent checks may run
concurrently when safe; the expected healthy-host total is under six seconds. All displayed errors
are bounded and redacted. The command is noninteractive.

| Check code | Blocking | Meaning |
| --- | --- | --- |
| `target.home` | No | Canonical selected Home and source |
| `local.identity` | Yes | Safe, valid `computer.json` |
| `local.credentials` | Yes | Valid envelope and single Computer credential |
| `local.binding` | Yes | Matching Computer identity, credential, and unique Server origin |
| `daemon.service` | Yes | Active, undrifted service for this Home |
| `server.health` | Yes | Bound Server's public health check passes within its deadline |
| `runtime.any-installed` | Yes | At least one supported Runtime artifact |
| `runtime.codex.installation` | No | Codex artifact observation |
| `runtime.claude-code.installation` | No | Claude Code artifact observation |
| `provider-cli.feishu.installation` | No | Lark CLI artifact observation |
| `provider-cli.slack.installation` | No | Slack CLI artifact observation |

## Verification and excluded extensions

Deterministic checks cover target resolution, rejected target flags, malformed/unsafe configuration,
credential and identity mismatches, service drift and shadowed manager commands, health deadlines
and invalid responses, protected-root and executable-file discovery, independent detector failure,
optional Integration results, redaction, exit codes, and the restricted baseline summary. Keep
maintained release regression cases in the [regression catalogue](https://github.com/first-tree-ai/opentag/blob/main/testing/regression/README.md),
and task-specific acceptance evidence in its PR or Issue.

P0 does not add Runtime authentication or credential-presence checks, version/protocol
compatibility, authoritative daemon-environment resolution, Integration selection/authentication,
machine-token or WebSocket validation, end-to-end delivery, automatic repair, public JSON
compatibility, or Windows service support beyond the published platform contract. Those require
their own reviewed product contracts. Install-only Integration observation does not expand these
boundaries.
