# OpenTag release guide

[简体中文](./zh-CN/releasing.md)

OpenTag publishes one self-contained CLI artifact in two isolated npm package identities:

| Channel | Package | Binary | Source trigger |
| --- | --- | --- | --- |
| Staging | `open-tag-staging` | `opentag-staging` | Successful `CI` on `main`, or an intentional manual rerun on `main` |
| Production | `open-tag` | `opentag` | A protected stable `vX.Y.Z` tag |

The internal `@opentag/client`, `@opentag/shared`, and `@opentag/server` workspaces remain private. Client and Shared
code is bundled into the CLI tarball, and the packed manifest must not expose an `@opentag/*` runtime dependency.
`THIRD_PARTY_NOTICES` is generated from the exact third-party packages bundled into the CLI and contains their complete
license texts. Run `pnpm notices:write` after a bundled dependency changes; `pnpm check` rejects stale notices.

## Release authority

GitHub Actions is the only release authority. npm publishing uses trusted publishing with `id-token: write`; the
repository must not contain an npm access token or a token fallback. Configure the staging package publisher in npm with
these exact fields:

- Provider: GitHub Actions
- Organization or owner: `first-tree-ai`
- Repository: `opentag`
- Workflow filename: `publish-npm-package.yml`
- Environment: none

The source manifest stays `open-tag`, has `private: true`, and carries a stable base version. The workflow rewrites
identity only in its ephemeral checkout by calling `scripts/prepare-cli-release.mjs`.

## Staging

After successful `main` CI, the npm workflow computes the next patch and publishes:

~~~text
X.Y.(Z+1)-staging.<release_sequence>.<github_run_attempt>
~~~

The first prerelease component is a registry-backed release sequence, not a GitHub workflow run number. Publishing jobs
are serialized, read the highest published sequence for the target release line, and increment it by one. A new release
line starts at sequence `1`. A retry for the same commit reuses its existing coordinate, while a stale run whose commit is
no longer current `main` fails before publishing.

The workflow checks the registry before publishing. An absent coordinate may be published; an existing coordinate is
accepted only when its `gitHead` matches the release commit. A registry failure, unsupported published version, stale
revision, or coordinate owned by another commit fails closed.

If the first run fails because npm trusted publishing is not configured, configure the publisher above and manually
dispatch the workflow from `main`. Do not add a token. After publishing, verify package metadata and install the exact
registry version into an empty directory before treating the staging release as usable.

## Production

Production publishing is intentionally stricter:

- the repository must be public;
- the tag must match `vX.Y.Z`;
- the tag version must equal `apps/cli/package.json`;
- the tagged commit must belong to `main`;
- the version must be `0.0.2` or newer and absent from npm; and
- the `v*` tag must be created through the protected release-tag ruleset.

The same tag publishes the npm CLI and the GHCR server image. The image carries full-commit and SemVer tags, and takes
over `latest` unless a higher release is already published. It is the image already built for that commit rather than a
rebuild, and includes the OpenTag Apache-2.0 license at `/app/LICENSE`. Creating a production tag is an irreversible
release action and requires an explicit release decision; testing the workflow is not authorization to create one.

## Contributor smoke

Build dependencies and the source CLI, then test the real tarball:

~~~bash
pnpm exec turbo run build --filter=open-tag...
SOURCE_NAME=$(node -p "require('./apps/cli/package.json').name")
SOURCE_VERSION=$(node -p "require('./apps/cli/package.json').version")
SOURCE_BINARY=$(node -p "Object.keys(require('./apps/cli/package.json').bin)[0]")
node scripts/cli-pack-smoke.mjs \
  --channel source \
  --name "$SOURCE_NAME" \
  --version "$SOURCE_VERSION" \
  --binary "$SOURCE_BINARY"
~~~

CI additionally derives a deterministic next-patch staging coordinate from the source manifest and CI run identity,
rewrites an isolated checkout, rebuilds it, and runs the same pack, empty-install, version, help, and doctor-failure checks.
