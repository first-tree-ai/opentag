# Release guide: verification and acceptance

Test and acceptance material for [Release guide](../../docs/operations/releasing.md).

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
