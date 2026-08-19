# OpenTag deployment guide

[简体中文](./zh-CN/deploying.md)

OpenTag deploys as one Server container that serves the REST API, the Computer WebSocket endpoint, and the read-only
Admin Web from a single port, next to a PostgreSQL instance that the container does not provide. This guide covers the
published image, what each image tag means, the runtime environment contract, and the Compose stack in
[docker-compose.prod.yml](../docker-compose.prod.yml).

OpenTag is pre-alpha. Its product workflows are still under development, and public APIs may change before the first
stable release.

## Published image

`.github/workflows/docker.yml` publishes `ghcr.io/first-tree-ai/opentag`, and the publishing job runs only for the
`first-tree-ai/opentag` repository. Every image is `linux/amd64`; no other architecture is published. Each build
carries a maximum-mode provenance attestation and an SBOM.

The image contains the built Server, its checked-in migrations, and the Admin Web bundle. It does not contain the
`open-tag` CLI and does not bundle or start PostgreSQL. It runs as the non-root `opentag` user from `/app`, exposes
port `8000`, ships the OpenTag Apache-2.0 license at `/app/LICENSE`, and pins `NODE_ENV=production`,
`OPENTAG_ENV=production`, `OPENTAG_HOST=0.0.0.0`, and `OPENTAG_PORT=8000`.

`OPENTAG_ENV=production` is what rejects a non-HTTPS `OPENTAG_PUBLIC_URL` and issues Secure browser cookies, so the
image always requires a TLS reverse proxy in front of it. The built-in `HEALTHCHECK` addresses
`http://127.0.0.1:8000/healthz`, so overriding `OPENTAG_PORT` inside the container makes that probe fail permanently
even while the Server is healthy. Publish a different host port instead of changing the container port.

## Image tags

| Tag | Published on | Meaning |
| --- | --- | --- |
| `X.Y.Z` | a `vX.Y.Z` release tag | One production release; the leading `v` is dropped from the image tag |
| `latest` | a `vX.Y.Z` release tag | Moving pointer to the newest production release |
| `edge` | a push to `main` | Moving pointer to the newest `main` build |
| `<full-commit-sha>` | a push to `main`, or a `vX.Y.Z` release tag | The build of exactly that commit |

Pin `X.Y.Z` for a release deployment, or the full 40-character commit SHA to pin one specific commit. A commit that is
later released is built again by the tag run, which republishes that commit's SHA tag under a new digest, so `X.Y.Z`
is the only pin that never moves. `latest` and
`edge` are moving pointers: what they resolve to changes on every release and on every `main` push, so a routine
`docker compose pull` can replace the running version without an explicit upgrade decision.

Do not deploy `edge` when a pinned release is what you want. The `Docker` workflow reacts to the `main` push itself and
does not wait for `CI`, so an `edge` image can exist for a commit whose `CI` run failed. The release guards that gate
`X.Y.Z` and `latest` are skipped on branch pushes entirely; only a tag push checks that the source repository is
public, that the tag matches `vX.Y.Z` and equals the version in `apps/cli/package.json`, and that the tagged commit
belongs to `main`.

No image build is ever cancelled by a later push. Each run forms its own concurrency group keyed on the revision, so
every `main` commit and every release tag receives its commit-SHA image even when pushes land back to back.

## Registry access

Pulling needs no credentials:

```bash
docker pull ghcr.io/first-tree-ai/opentag:X.Y.Z
```

One maintainer step stands behind that. GHCR sets visibility per package rather than inheriting it from the
repository, and a newly published package starts private. After the first successful publish, open the package, choose
Package settings, then under Danger Zone choose Change visibility and select Public. The publishing workflow never
performs that step, and it only has to be done once.

## Environment variables

The Server reads exactly these variables. A missing or malformed required value aborts startup before the listener
opens: the process writes `Failed to start OpenTag server` with secret values redacted to stderr and exits with
status `1`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENTAG_DATABASE_URL` | yes | none | PostgreSQL connection URL; the scheme must be `postgres:` or `postgresql:` |
| `OPENTAG_JWT_SECRET` | yes | none | Access-token signing secret; at least 32 characters |
| `OPENTAG_ENCRYPTION_KEY` | yes | none | Canonical base64-encoded 32-byte application encryption key |
| `OPENTAG_PUBLIC_URL` | yes | none | Externally reachable Server origin used for browser callbacks and invitation links |
| `OPENTAG_ENV` | no | `production` in the image | Runtime environment; `production` requires HTTPS and Secure cookies |
| `OPENTAG_HOST` | no | `0.0.0.0` in the image | Listen address inside the container |
| `OPENTAG_PORT` | no | `8000` in the image | Listen port inside the container; the image health check addresses `8000` |
| `OPENTAG_AUTO_MIGRATE` | no | `true` | Apply checked-in migrations before listening; exactly `true` or `false` |
| `OPENTAG_ACCESS_TOKEN_TTL_SECONDS` | no | `900` | Access-token lifetime |
| `OPENTAG_REFRESH_TOKEN_TTL_SECONDS` | no | `2592000` | Refresh-JWT lifetime |
| `OPENTAG_GOOGLE_CLIENT_ID` | no | none | Google OIDC client id; requires the matching secret |
| `OPENTAG_GOOGLE_CLIENT_SECRET` | no | none | Google OIDC client secret; requires the matching client id |
| `OPENTAG_DEV_AUTH_BYPASS_ENABLED` | no | `false` | Loopback-only development sign-in; rejected outside `development` |
| `OPENTAG_DEV_AUTH_EMAIL` | no | none | Existing unique bootstrap user selected by the development bypass |

`OPENTAG_PUBLIC_URL` must be a bare origin: the published image pins `OPENTAG_ENV=production`, which rejects any
public URL that is not HTTPS, and the schema separately rejects a URL carrying credentials, a path, a query, or a
fragment. It is the externally reachable address behind the reverse proxy, not the container address.

`OPENTAG_DATABASE_URL`, `OPENTAG_JWT_SECRET`, `OPENTAG_ENCRYPTION_KEY`, and `OPENTAG_GOOGLE_CLIENT_SECRET` are
secrets. Supply them through the deployment environment or an uncommitted environment file, and never commit them to
this or any other repository. Generate a fresh encryption key per deployment; changing it later without rotating
existing invitations makes those invitations intentionally fail closed.

```bash
openssl rand -base64 32
```

The Google client id and secret are validated together, and configuring only one of them fails startup. The two
development sign-in variables are rejected unless `OPENTAG_ENV` is explicitly `development` and both the listen host
and the public URL hostname are loopback, so a deployment of the published image must never set them. Boolean values
are the literal strings `true` and `false`; any other spelling fails configuration parsing, and both must be quoted
when they are written directly into a Compose file.

`OPENTAG_SERVER_URL` and `OPENTAG_HOME` belong to the CLI and are never read by the Server. The four
`OPENTAG_BOOTSTRAP_*` values are inputs to the one-time bootstrap command described below.

## Deploy with Compose

[docker-compose.prod.yml](../docker-compose.prod.yml) runs the published image next to a PostgreSQL 17 service. Copy it
into a dedicated deployment directory instead of running it from a repository checkout: Compose loads `.env` from the
directory holding the file, and the development values in `.env.example` would hand the production image a plain-HTTP
public URL that it refuses.

The file pins the Compose project name `opentag-prod`, so it never shares containers, networks, or the
`opentag-postgres-data` volume with the development `docker-compose.yml`. PostgreSQL publishes no host port, and the
Server publishes port `8000` on `127.0.0.1` by default. Compose reads the following variables itself; no OpenTag
process ever sees them:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENTAG_IMAGE` | no | `ghcr.io/first-tree-ai/opentag:latest` | Image reference used by the `server` and `migrate` services |
| `OPENTAG_HTTP_BIND` | no | `127.0.0.1:8000` | Host address the Server port publishes on |
| `OPENTAG_POSTGRES_PASSWORD` | yes | none | Password for the bundled PostgreSQL service |
| `OPENTAG_POSTGRES_USER` | no | `opentag` | Role created by the bundled PostgreSQL service |
| `OPENTAG_POSTGRES_DB` | no | `opentag` | Database created by the bundled PostgreSQL service |

Create an uncommitted `.env` next to the Compose file. `OPENTAG_DATABASE_URL` is independent of the PostgreSQL
credentials above: keep the password identical in both places, percent-encode it inside the URL, and address the
`postgres` service by name. Replace `X.Y.Z` with the release being deployed and every `replace-with-` placeholder with
a generated value.

```text
OPENTAG_IMAGE=ghcr.io/first-tree-ai/opentag:X.Y.Z
OPENTAG_PUBLIC_URL=https://opentag.example.com
OPENTAG_POSTGRES_PASSWORD=replace-with-a-generated-password
OPENTAG_DATABASE_URL=postgresql://opentag:replace-with-a-generated-password@postgres:5432/opentag
OPENTAG_JWT_SECRET=replace-with-at-least-32-random-characters
OPENTAG_ENCRYPTION_KEY=replace-with-openssl-rand-base64-32
```

Verify interpolation before starting anything. A missing required variable aborts the command with a named error
instead of starting a partially configured deployment.

```bash
docker compose -f docker-compose.prod.yml config
docker compose -f docker-compose.prod.yml up -d
```

`up` starts PostgreSQL first and waits for its `pg_isready` health check before starting the Server. Point a TLS
reverse proxy at the published port and serve it at exactly `OPENTAG_PUBLIC_URL`: browser mutations are rejected
unless the request `Origin` equals that origin, the public URL may not carry a path, so a subpath deployment is not
possible, and `/api/v1/computer/ws` needs `Upgrade` and `Connection` forwarded before a Computer can connect.

## Migrations

`OPENTAG_AUTO_MIGRATE` defaults to `true`, so the Server applies the checked-in migrations before it listens while
holding a PostgreSQL advisory lock. Concurrent replicas serialize on that lock, and a fresh deployment needs no
separate migration step.

Set `OPENTAG_AUTO_MIGRATE=false` for controlled rollouts. The Server then verifies instead of migrating and refuses to
start when the database is empty, behind the checked-in migrations, ahead of them, or diverged from them. Apply
migrations explicitly before each deploy with the one-shot `migrate` service, which `up` never starts:

```bash
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
```

That service runs `node packages/server/dist/db/migrate-cli.mjs` from the same image and receives only
`OPENTAG_DATABASE_URL`. The published image contains no CLI, so these `node` entry points are the only administrative
commands available inside the container.

## First administrator

A new deployment has no account until the one-time bootstrap runs. It creates the first user, Team, admin membership,
and connect code in a single transaction, and it fails with `Bootstrap has already been completed` once any user
exists. Run it inside the running Server container:

```bash
docker compose -f docker-compose.prod.yml exec \
  --env OPENTAG_BOOTSTRAP_EMAIL=admin@example.com \
  --env OPENTAG_BOOTSTRAP_DISPLAY_NAME=Admin \
  --env OPENTAG_BOOTSTRAP_TEAM_NAME=example \
  --env OPENTAG_BOOTSTRAP_TEAM_DISPLAY_NAME=Example \
  server node packages/server/dist/admin/bootstrap-cli.mjs
```

The command prints one JSON line with `userId`, `teamId`, `connectCode`, and `expiresAt`. The connect code is a live
credential that expires 15 minutes after it is issued; deliver it directly to the first administrator and keep it out
of logs, tickets, and version control. The running Server never reads the four `OPENTAG_BOOTSTRAP_*` values.

Because the image contains no CLI, the administrator redeems the code from their own machine against the public
origin:

```bash
npm install --global open-tag
opentag login <connect-code> --server https://opentag.example.com
```

Browser sign-in at `/admin/` goes through Google. Create a Google Web OAuth client whose callback is
`https://opentag.example.com/api/v1/auth/google/callback`, then set `OPENTAG_GOOGLE_CLIENT_ID` and
`OPENTAG_GOOGLE_CLIENT_SECRET`. Membership and invitation changes remain explicit CLI operations; the Admin Web is
read-only.

## Health probes

`/healthz` returns `200` with `{"status":"ok","service":"opentag-server"}` as soon as the listener accepts
connections. It never touches PostgreSQL, so it reports a healthy container even when the database is unreachable. Use
it for liveness only.

`/readyz` returns `200` with `{"status":"ready"}` only after configuration, migration, application wiring, and the
listener have all completed, and `503` with `{"status":"not_ready"}` and the completed stages before that. Use it for
load balancers, rollout gates, and orchestration. Both paths are unversioned and stay outside `/api/v1`.

The image's own `HEALTHCHECK` probes `/healthz`. `docker-compose.prod.yml` overrides the Server health check to
`/readyz` with a 60 second start period, so a cold-database migration is not reported as healthy too early.

```bash
docker compose -f docker-compose.prod.yml ps
curl --fail --silent http://127.0.0.1:8000/readyz
```

A container that restarts repeatedly failed configuration parsing or migration. Read its output first; startup errors
name the failing variable and redact secret values.

```bash
docker compose -f docker-compose.prod.yml logs server
```

## Upgrades and rollback

Back up PostgreSQL before every upgrade. Change `OPENTAG_IMAGE` to the release being deployed, pull it, then recreate
the Server:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The new container applies any new migrations before it listens, and `/readyz` stays `503` until it finishes. With
`OPENTAG_AUTO_MIGRATE=false`, run the `migrate` service after the pull and before the recreate.

A rollback is not symmetric. Migrations are forward-only, and an older Server started with `OPENTAG_AUTO_MIGRATE=false`
refuses to start against a database carrying migrations it does not know. Restoring the previous `OPENTAG_IMAGE` value
is safe only while the schema has not moved; otherwise restore the database backup taken before the upgrade.
