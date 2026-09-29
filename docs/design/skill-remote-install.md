# Installing Skills from a remote source

> **Status: delivered.** The shared source contract and discovery rules live in
> `packages/shared/src/skill-source.ts` and `packages/shared/src/skill-discovery.ts`; the Server lane
> lives in `packages/server/src/services/skills/source/**`; the Web entry point is the Skills page.
> See `agent-skills.md` for the Skill contract itself — this document covers only where a Skill can
> come from when it is not an upload.

## What this feature is for

`agent-skills.md` describes a Skill that somebody built and uploaded. This document describes the
other half: an operator pastes an address from the open skills ecosystem (skills.sh) into an Agent's
Skills page, sees what that address publishes, picks some of it, and installs it. The installed Skill
is an ordinary Skill from that point on — same archive, same row, same runtime delivery.

The authoritative behaviour contract is the change's specs; the sections below record the decisions
that are not visible on the wire.

## Accepted sources

`parseSkillSource` normalizes one user-supplied string. The table below is the whole accepted set, and
each row names the case in `packages/shared/src/__tests__/skill-source.test.ts` that pins it.

| Input | Normalized to | Test case |
| --- | --- | --- |
| `owner/repo` | GitHub repository root | "GitHub shorthand resolves to the repository root" |
| `owner/repo/` | the same | "GitHub shorthand with a trailing slash" |
| `owner/repo/sub/path` | repository + subpath | "shorthand carries a subpath" |
| `owner/repo@skill` | repository + Skill filter | "shorthand carries a Skill filter" |
| `github:owner/repo` | the same as the shorthand | "the github: prefix is shorthand, not a scheme" |
| `gitlab:group/sub/repo` | `https://gitlab.com/group/sub/repo.git` | "the gitlab: prefix resolves against gitlab.com" |
| `https://github.com/o/r` | repository root | "a GitHub repository URL keeps the full URL path" |
| `https://github.com/o/r/tree/<ref>` | repository + ref | "a GitHub tree URL without a path yields a ref" |
| `https://github.com/o/r/tree/<ref>/<path>` | repository + ref + subpath | "a GitHub tree URL yields a ref and a subpath" |
| `https://<gitlab-host>/group/sub/repo/-/tree/<ref>/<path>` | GitLab repository + ref + subpath | "a GitLab instance is not limited to gitlab.com" |
| `https://gitlab.com/group/sub/repo` | GitLab repository (subgroups kept) | "a GitLab repository URL keeps its subgroups" |
| `https://dev.azure.com/o/p/_git/r?path=/x&version=GBmain` | Azure repository + ref + subpath | "Azure Repos restores the ref and subpath from the query" |
| `https://raw.githubusercontent.com/...` | direct download | "a raw file host is a direct download" |
| `https://github.com/o/r/releases/download/...` | direct download | "a GitHub release asset is a direct download" |
| `https://gitlab.com/g/r/-/archive/...` | direct download | "a GitLab archive URL is a direct download" |
| `https://example.com/skills` | well-known discovery | "an ordinary host is well-known discovery first" |
| `https://git.example.com/acme/skills.git` | generic git clone | "a generic git URL is not well-known discovery" |
| `<source>#<ref>` | ref | "a percent-encoded shorthand fragment is decoded" |
| `<source>#<ref>@<skill>` | ref + Skill filter | "a fragment carries both ref and Skill filter" |

Refused, each with its own case: an empty input, local paths (`./x`, `/x`, `C:\x`), SSH and scp
addresses, a URL carrying credentials, anything that is not a URL or a shorthand, non-HTTP schemes,
and any input with a `..` path segment (`unsafe_subpath`). A refusal is reported to the user as
`SKILL_SOURCE_INVALID`; the finer reason is logged, never returned.

## Discovery rules

`discoverSkillDirectories` is a pure function of a file listing, so the rules are exhaustively
testable (`packages/shared/src/__tests__/skill-discovery.test.ts`):

- the search root is itself a Skill when it holds a `SKILL.md`, and that short-circuits everything
  below it;
- otherwise the documented container directories are scanned in priority order, the root one level
  deep and each container three levels deep, so `skills/<name>`, `skills/<category>/<name>`, and
  `skills/<a>/<b>/<name>` are all found;
- a `SKILL.md` at a shallower level shadows anything nested below it;
- `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` add their declared directories as
  containers (`declaredSkillContainers`);
- when the standard locations yield nothing, the whole search root is walked recursively, five levels
  deep;
- `node_modules`, `.git`, `dist`, `build`, and `__pycache__` are never entered and never claimed.

Two deliberate divergences from the reference implementation:

- **Skipped directories are never claimed.** The reference stops *descending* into `dist/` and still
  accepts a `SKILL.md` directly inside it. Offering a build output as an installable Skill is a
  footgun, so this platform ignores those trees entirely.
- **Duplicate Skill names are resolved by discovery, first occurrence wins.** Selection is by name, so
  two candidates called `demo` would make "install `demo`" ambiguous.

`skills-lock.json` suppression is local CLI state and has no meaning server-side, so it is not
implemented.

## Reading a source

Three readers produce the same thing — a `SkillSourceSnapshot`: a file listing, with contents read on
demand.

- **A repository** is read by `fetchGitSnapshot` as a tree-first shallow partial clone:
  `--depth 1 --no-checkout --single-branch --no-tags --filter=blob:none`. Only the commit and its trees
  are downloaded; a blob arrives when a candidate's manifest is read, or when a selected Skill is
  packaged. A peer that ignores `--filter` degrades to an ordinary shallow clone and the same code
  path still works.
- **A direct download** is read by `openDocumentSource`: zip and gzip-tar by magic bytes (through the
  same reader an upload uses), or a single `SKILL.md`. Anything else is a source with no Skills.
- **A well-known host** is read by `resolveWellKnownSource`: `/.well-known/agent-skills/index.json`
  then `/.well-known/skills/index.json`, in the `0.2.0` format (per-artifact `url` plus a verified
  `digest`) and the legacy `0.1.0` format (per-entry `files`). A host that publishes no index at all
  is *not* an error: the same URL is then read as a direct download, which is what makes a plain
  "download this Skill" link work. A `digest` is accepted in the RFC's `sha256:<64 hex>` form and in
  the bare-hex form the ecosystem CLI still publishes; the normalized bare hex is what a fingerprint
  is built from, so a publisher that switches spelling does not look like a content change.

### What a preview promises about content

Every candidate carries a `fingerprint`, and the install sends it back. The Server re-derives it from
the source as it reads now and refuses an item whose value moved, with `SKILL_REVISION_CONFLICT` — the
code that already means "this changed while you were working". That is what makes "what you previewed
can have moved, and the result says so" true rather than aspirational.

A listing's read returns the files **and** the fingerprint of those same bytes, from one call, and the
install compares and then packages that one read. Comparing one read and using another would leave a
check/use race: a publisher able to answer twice with different bodies would pass the comparison and
have the second body installed. The pairing is the contract, not an implementation detail.

| Source | Fingerprint covers | Preview cost |
| --- | --- | --- |
| Repository (git) | every path with its blob id and mode | a tree listing; no blob is read |
| Direct download, artifact archive | every path with the content hash and mode | the download itself, which the preview already performs |
| Well-known `0.2.0` | the `digest` the index publishes, which the install also verifies against the artifact | the index only |
| Well-known `0.1.0` | every path with the content hash and mode | the entry's files, which the format gives no way to identify without reading |

Every source is therefore bound to content. The legacy directory layout publishes no content hash, so
a preview *reads* each of its entries — within `SKILL_SOURCE_PREVIEW_CONTENT_MAX_BYTES` — rather than
fingerprinting a declared file list: a list-only identity would let a publisher change `SKILL.md` and
still install as though nothing had moved. The budget is what stops a long catalog from turning one
preview into a download of the whole catalog, and each entry spends only what it actually used, so the
budget is a catalog-wide total rather than a per-entry allowance. Three outcomes are distinct, and only
the first ends the catalog:

- the shared budget is spent — no later entry can be read either, so the preview stops;
- an entry does not fit its own ceiling, or its published metadata is unusable — the entry is skipped,
  and a later smaller or valid entry is still read and listed;
- the entry is read — it is listed, bound to the content that was read.

## Outbound policy

Every network operation goes through the same rules the MCP gate uses, in the two layers that make
them up. `packages/shared/src/mcp-outbound-url.ts` holds the pure URL rules — HTTPS only (plain HTTP
only for a loopback development opt-in), no credentials in the URL, literals judged against the
non-public ranges — because build-time tooling applies them too. `packages/server/src/services/outbound/destination-policy.ts`
holds the half that needs a resolver: a public destination only, judged on every A and AAAA record,
returning the address to dial. No redirect is followed, because a redirect names a destination the
policy never saw.

The address rules produce the address to dial, and the two transports bind that address to the
connection rather than resolving again:

- **HTTP.** `node:https`/`node:http` replaces the resolver with the approved address (`lookup`), so the
  hostname stays on the request — `Host`, TLS SNI, and the certificate check are the URL's own — while
  the socket goes where the policy decided. `fetch` cannot express that split, which is why this
  transport is hand-built.
- **Git.** libcurl resolves inside git, and it offers no hook for a resolved address, so git is routed
  through `SkillSourceTunnel`: a loopback proxy that resolves the target itself, refuses anything the
  policy blocks, and only then dials. The clone, the tree listing, and every lazy blob fetch go through
  it (`http.proxy` is recorded in the clone so the on-demand fetches inherit it), and a plain-HTTP
  forward closes its upstream connection after each request so every request is judged on its own.
  `NO_PROXY`/`no_proxy` are cleared so an inherited bypass cannot skip the tunnel. Every socket the
  tunnel owns is tracked: an upstream connect has its own deadline, dies with the client that caused
  it, and is destroyed by `close()` along with the rest, so a killed git process cannot leave a
  connection — or a pending connect — behind.

The git transport applies the same judgement before spawning a process and then removes every way git
could reach outside the clone:

```
protocol.allow=never            protocol.http.allow=always     protocol.https.allow=always
protocol.file.allow=never       http.followRedirects=false     core.hooksPath=/dev/null
gc.auto=0                       advice.detachedHead=false
GIT_CONFIG_NOSYSTEM=1           GIT_CONFIG_GLOBAL=/dev/null     GIT_TERMINAL_PROMPT=0
GIT_ASKPASS=                    GIT_SSH_COMMAND=/bin/false      HOME=<the request's workspace>
```

The process itself runs through `github-proxy/git-process.ts`, which spawns without a shell, kills the
process group on its deadline, and bounds the output it will collect. That module is shared by direct
import rather than duplicated; moving it to a neutral `services/git/` module is a reasonable
follow-up, since its current home names a feature it no longer exclusively belongs to.

A local `file://` or plain-path repository is refused by design, which is why the git transport's
tests serve a real repository over smart HTTP on `127.0.0.1`
(`__tests__/support/git-http-fixture.ts`, `__tests__/skill-source-git.test.ts`) instead of pointing
git at a directory.

## Request lifecycle

One preview (`POST …/skills/install/resolve`) and one install (`POST …/skills/install`) each read the
source again. There is no server-side snapshot cache: a cache would need expiry, cleanup, and an
assumption that a caller returns to the same instance, while re-reading costs a tree listing and, at
most, one bounded artifact download per selected Skill. The consequence is honest and reported: what
was previewed can have moved, and the per-item result says so.

Each repository read stages a private workspace (`SkillSourceWorkspace`): `mkdtemp` under the system
temporary directory, mode `0700`, re-checked after creation, removed on every path — success, failure,
and abandonment alike. A staging directory that cannot be called private fails closed with
`SKILL_SOURCE_UNREACHABLE` rather than being used.

## Installing a selection

The install request carries the source and the selected names, never file content. For each name:

1. the name is looked up among the freshly discovered candidates; a name that is gone fails with
   `SKILL_NOT_FOUND`;
2. a candidate that could never be packaged fails with the reason it was listed with
   (`SKILL_MANIFEST_INVALID`, `SKILL_NAME_RESERVED`, `SKILL_ARCHIVE_TOO_LARGE`);
3. otherwise the candidate is materialized and packed through `normalizeSkillEntries` — the same
   packer an upload uses, which is what makes the canonical bytes, and therefore the sha256 and the
   object key, identical however the Skill arrived;
4. the packaged manifest name must equal the selected name, because selection is by name and a
   well-known index publishes its own metadata: a disagreement fails with `SKILL_MANIFEST_INVALID`
   rather than installing something the user did not choose;
5. the archive goes to `SkillService.upload` with `source: "url_install"` and no `replace`, so the
   name rules, the per-Agent limit, the object store, and the revision semantics are the ones that
   already exist. A name conflict becomes `skipped_name_conflict`; any other Skill failure becomes a
   failed item carrying its own code.

One item's failure never stops the others, a duplicate name in one request is installed once and
reported as skipped the second time, and the response is always a per-item report.

## Rollout and rollback

Deploy the migration and the code together. Rolling the Server back once `url_install` rows exist is
**not** safe on its own: an older Server validates `Skill.source` against the three earlier enum
values, so every Skill read for the affected Agents fails validation. Before rolling back, run:

```sql
update agent_skills set source = 'web_upload' where source = 'url_install';
```

The Skills, their archives, and their revisions are untouched; they simply report as web uploads on
the older build, which is the closest representation it has. Redeploying the newer Server afterwards
is safe. If the enum value has to survive a rollback window, stage the change instead: deploy
migration `0053` alone, then deploy the code that writes `url_install`. The same step is recorded for
operators in `docs/deploying.md`.

## Deliberate omissions

- **SSH and scp sources** (`git@github.com:owner/repo.git`, `ssh://…`): a hosted Server has no private key and never
  sends a caller's credentials to a third party.
- **Local paths**: the Server has no user file system. An Agent that authors a Skill locally uses
  `opentag skill push`, which is described in `agent-skills.md`.
- **Source aliases** (`coinbase/agentWallet` → `coinbase/agentic-wallet-skills`, and one other in the
  reference CLI): a convenience mapping, not a source format. Paste the canonical repository instead.
- **An origin-root well-known fallback**: a scoped URL (`https://host/team`) never installs the
  catalog published at `https://host`.
- **Uncompressed `.tar`**: like the upload surface, only `zip` and `tar.gz`/`.tgz` are accepted.
- **`--full-depth` discovery**: only the documented containers plus the recursive fallback are
  searched.

## Limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `SKILL_SOURCE_INPUT_MAX_LENGTH` | 2048 | Maximum length of the pasted source |
| `SKILL_SOURCE_DOWNLOAD_MAX_BYTES` | 10 MiB | Maximum bytes read for one direct download, and per file of a legacy index entry |
| `SKILL_SOURCE_EXTRACT_MAX_BYTES` | 25 MiB | Maximum total bytes an unpacked download may hold, shared across the files of one legacy index entry |
| `SKILL_SOURCE_EXTRACT_MAX_FILES` | 1000 | Maximum entries an unpacked download or a legacy index entry may declare |
| `SKILL_SOURCE_SNAPSHOT_MAX_BYTES` | 256 MiB | Maximum bytes a repository snapshot may occupy on disk |
| `SKILL_SOURCE_MAX_CANDIDATES` | 200 | Maximum candidates one preview returns, for every source kind |
| `SKILL_SOURCE_PREVIEW_CONTENT_MAX_BYTES` | 64 MiB | Maximum bytes a preview downloads to identify what a legacy index publishes |
| `SKILL_SOURCE_GIT_TIMEOUT_MS` | 60 s | Deadline for one repository transfer |
| `SKILL_SOURCE_HTTP_TIMEOUT_MS` | 30 s | Deadline for one HTTP request |

A downloaded artifact is read through the Skill archive reader with these source ceilings, not the
general archive ones, so a 10 MiB download cannot unpack to 64 MiB, and the decompressed-stream
ceiling is derived from the payload ceiling the caller asked for rather than the general one — a
stream guard fixed at the general limit would still admit a bomb that the caller's own limit exists to
reject. A legacy index entry's declared file list is bounded before anything is fetched, and its files
share one unpacked-byte budget: each request is allowed only what remains, so a long list of large
files cannot retain one full download per file.

A repository Skill is bounded by the *unpacked* ceiling while it is read, and by the 16 MiB canonical
archive ceiling after it is packed, exactly as an upload is. Applying the packed ceiling to the raw
total would make a compressible repository Skill impossible to install while the same bytes upload
fine. A single file may be as large as the unpacked ceiling, and the blob read is allowed that much
for the same reason.

Per-Skill bounds are the Skill contract's own (`SKILL_ARCHIVE_MAX_BYTES`, `SKILL_UNPACKED_MAX_BYTES`,
`SKILL_MAX_ENTRIES`, `SKILL_MAX_PATH_BYTES`). Repository and index entries pass through the same
member rules the archive reader applies — `normalizeMemberPath`, the ignored-metadata rule, the
duplicate check, and the entry and unpacked-byte ceilings — because git permits a backslash or a
leading dot and an install must not store a Skill the Computer's extractor will later refuse. A
candidate whose paths break those rules is listed with `path_invalid` and is not installable, rather
than reporting success for something the runtime cannot materialize.

A `owner/repo@skill` or `#ref@skill` filter selects exactly that Skill: the filter is applied before
the candidate cap, so a filtered source lists the named Skill instead of truncating a larger catalog
to nothing, and an install can never fall back to "everything in the repository".

## Verification

| Suite | What it asserts |
| --- | --- |
| `packages/shared/src/__tests__/skill-source.test.ts` | Every accepted source form and every refusal, the resolve/install schemas, and the pinned limit values |
| `packages/shared/src/__tests__/skill-discovery.test.ts` | The container list against its checked-in expectation, depth and shadowing, plugin manifests, the recursive fallback, subpath scoping, determinism, and skipped directories |
| `packages/server/src/__tests__/skill-source-fetcher.test.ts` | Address refusals, the address pin handed to the transport, redirect refusal, both byte caps, the deadline, non-2xx mapping, and that only the transport and the tunnel dial |
| `packages/server/src/__tests__/skill-source-transport.test.ts` | The real socket: the pin determines the dialed address while the hostname stays in `Host`, the declared and delivered byte caps, an unfollowed redirect, no body from an error, an error response stopped rather than drained, and the deadline |
| `packages/server/src/__tests__/skill-source-tunnel.test.ts` | The git proxy: plain-HTTP forwarding with a close, a CONNECT byte tunnel, refusal of a blocked or loopback target, refusal of a non-absolute target, no dial for a name the policy blocks, the upstream dying with its client, a connect that never completes being refused on its deadline (with an injected dial, so the result does not depend on an address happening to blackhole), and every socket released on close |
| `packages/server/src/__tests__/skill-source-git.test.ts` | The clone argv and the git environment, the pre-spawn address check, `ls-tree` parsing, a real clone and blob read over local smart HTTP, the `--filter` fallback, lazy blobs, the size budget, and a missing ref |
| `packages/server/src/__tests__/skill-source-workspace.test.ts` | Private staging, cleanup, failing closed on a directory that is not private, and removing a directory whose privacy check failed after it was created |
| `packages/server/src/__tests__/skill-source-document.test.ts` | Magic-byte format detection, the single-`SKILL.md` case, invalid content, and both caps |
| `packages/server/src/__tests__/skill-source-well-known.test.ts` | Both index versions, the two probe paths, digest verification (both spellings), the legacy fallback for an unreadable modern document, no origin-root fallback, the candidate ceiling for a long catalog and for legacy entries, the shared legacy content budget, and a content-only change moving a legacy fingerprint |
| `packages/server/src/__tests__/skill-archive-entries.test.ts` | One logical Skill producing identical canonical bytes and sha256 through the upload, download, and listing entry points |
| `packages/server/src/__tests__/skill-remote-install.test.ts` | Preview, already-installed marking, per-item install outcomes (installed, skipped, failed), name mismatches, the per-Agent limit, cross-Account isolation, the `@skill` filter, a selection whose source moved (including a legacy entry whose file list did not), one read per legacy request, an unusable path, a repository Skill that packs under the archive ceiling from more raw bytes than it, installs from a real repository through the pinning tunnel, and the monitor stopping when a post-fetch failure releases the request |
| `apps/web/src/features/skills/*.test.tsx` | The page entry point and the install dialog's behaviour |

## Open items

- A snapshot token shared between preview and install would remove the second read and the drift
  between them. It needs a server-side cache with expiry (or an object-store snapshot) and is not
  needed while a source read is one tree listing.
- The same source rules could be exposed as a CLI command (`opentag skill install`); the shared
  contract and the HTTP endpoints are already transport-neutral.
- `--full-depth` discovery, and the reference CLI's partner `skills update` semantics, are not
  implemented.
