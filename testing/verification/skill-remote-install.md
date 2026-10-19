# Installing Skills from a remote source: verification and acceptance

Test and acceptance material for [Installing Skills from a remote source](../../docs/system/capabilities/skill-remote-install.md).

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
