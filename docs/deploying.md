# OpenTag deployment guide

[简体中文](./zh-CN/deploying.md)

OpenTag runs its Staging environment on [CapRover](https://caprover.com/). Every revision that lands on `main` and
passes CI and completes CLI/Runner publication is deployed automatically from the container image the `Docker` workflow already published to GHCR. Nothing is
built on the CapRover host and no source tarball is uploaded; the deployment is a pointer change to an immutable image.

| Environment | Trigger | Image | Workflow |
| --- | --- | --- | --- |
| Staging | Successful CLI/Runner publication on `main`, or an intentional manual run | `ghcr.io/first-tree-ai/opentag:<commit-sha>` | `deploy-staging.yml` |

The production Server is deployed through the existing operator procedure. The manual **Deploy Runner** workflow
activates a published Runner after that compatible Server is ready; see [Cloud Runner releases](./cloud-runner-release.md).

## How a push reaches Staging

1. A revision lands on `main`. `CI` and `Docker` start in parallel.
2. `Docker` builds and pushes the immutable commit coordinate `ghcr.io/first-tree-ai/opentag:<commit-sha>`.
3. `CI` succeeds, starting CLI/Runner publication; successful publication starts `Deploy Staging`.
4. `Deploy Staging` proves the revision belongs to `main` history, waits for the commit coordinate to be published, and
   confirms the revision is still the tip of `main`.
5. The CapRover App is pointed at that exact image tag and CapRover pulls and rolls it out.
6. The verified Runner image/version is activated after the matching Server is ready, then the responding Server target
   is verified. Existing ready Instances remain on their original compatible images until normal reclamation.

The deployment always uses the per-commit tag, never `edge` or `latest`. A moving tag would leave CapRover with an
unchanged image reference and nothing to roll forward to, and it would make the running revision unidentifiable.

Two properties are worth knowing before debugging a missing deployment:

- **Staging never moves backwards.** Runs for consecutive commits can overlap, so an automatic run whose revision is no
  longer the tip of `main` skips instead of overwriting a newer revision. The run succeeds and records the skip in its
  job summary.
- **A broken tip parks Staging.** If commit `A` passes CI and commit `B` lands and fails, the run for `A` skips because
  `A` is no longer the tip, and `B` never deploys. Staging stays on the last revision that shipped. Use a manual run to
  deploy `A` on purpose.

## Repository secrets

Configure these as repository secrets under **Settings → Secrets and variables → Actions**. The workflow fails with the
missing names listed before it calls CapRover, so an unconfigured deployment is reported rather than half-attempted.

| Secret | Value | Where to find it |
| --- | --- | --- |
| `CAPROVER_STAGING_SERVER` | CapRover dashboard URL, for example `https://captain.apps.example.com` | Your CapRover installation |
| `CAPROVER_STAGING_APP` | The CapRover App name that serves Staging | CapRover dashboard → Apps |
| `CAPROVER_STAGING_APP_TOKEN` | App-scoped deployment token | CapRover dashboard → App → Deployment → App Token |

Use the App Token rather than the CapRover account password. The token authorises deployments to that one App, so a leak
cannot reconfigure the rest of the server, and it can be rotated from the App's Deployment tab without touching any
other App.

The workflow declares a `staging` GitHub Environment so deployments appear in the repository's Deployments view and can
later be given protection rules. Repository secrets remain readable from that job; moving the three secrets into the
Environment instead also works and scopes them to Staging.

## CapRover App prerequisites

The workflow only changes which image the App runs. Everything below is CapRover-side configuration that has to exist
before the first deployment.

- **Container HTTP port** `8000`, matching the port the image exposes.
- **PostgreSQL**, either a CapRover one-click Postgres App or an external instance reachable from the host.
- **Persistent storage** is not required by the server image itself, but the database App needs it.

### Container log rotation

The server image does not control Docker's logging driver. Configure the Docker daemon on every Swarm node that may run
the server, or set the equivalent CapRover logging option, before the first deployment. The concrete Docker daemon gate is
`/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Restart or reload the Docker daemon according to the host operating system after changing this file. The `max-size` and
`max-file` values above are the intended server limits; Docker does not read them from image labels. The `logging:` block
in this repository's `docker-compose.yml` applies to the local Postgres service only and does not configure the CapRover
server container.

- **Environment variables** on the App:

| Variable | Staging value |
| --- | --- |
| `OPENTAG_ENV` | `staging` |
| `OPENTAG_HOST` | `0.0.0.0` |
| `OPENTAG_PORT` | `8000` |
| `OPENTAG_PUBLIC_URL` | The App's HTTPS URL; hosted environments reject plain HTTP |
| `OPENTAG_DATABASE_URL` | `postgresql://…` for the Staging database |
| `BETTER_AUTH_SECRET` | At least 32 random characters, unique to Staging; signs every Account session |
| `OPENTAG_JWT_SECRET` | At least 32 random characters, unique to Staging and distinct from `BETTER_AUTH_SECRET`; signs Slack OAuth state only |
| `OPENTAG_ENCRYPTION_KEY` | Base64 32-byte key, unique to Staging |
| `OPENTAG_AUTO_MIGRATE` | `true` so each rollout applies pending migrations |
| `OPENTAG_PORTABLE_DOWNLOAD_BASE_URL` | Optional; defaults to `https://dl.opentag.build/releases` |
| `OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS` | Optional; defaults to `300000` |

The two optional variables control how the Server learns the exact channel latest target it advertises to connected
Clients for automatic upgrades: it polls the channel's published `latest.json` under the download base URL and keeps
advertising the last known target through any outage. The dev channel never advertises a target.

Enable HTTPS and force HTTPS on the App before setting `OPENTAG_PUBLIC_URL`; the server refuses to start in a hosted
environment whose public URL is not HTTPS. Staging secrets must not be shared with any other environment.

Configuration is validated before the server listens, so add a newly required variable to the App **before** the
revision that needs it is deployed. A missing one leaves CapRover restarting a container that exits at startup rather
than serving a degraded App.

The GHCR package is public, so CapRover pulls the image anonymously. If the package is ever made private, add a
registry credential in **CapRover → Cluster → Docker Registries** using a GitHub token with `read:packages`, otherwise
every deployment fails at the pull step.

## Object storage for Agent Skills

Agent Skills are stored as one `tar.gz` object per Skill in S3-compatible object storage. Storage is
optional: without the group below, Skill listing and the enable, disable, and remove operations still
work, but every bundle upload or download fails with `SKILL_STORAGE_UNAVAILABLE` and the UI disables
those actions instead of offering a dead button. The five material values must be configured together
or not at all; the server refuses to start on a partially configured group.

| Variable | Value |
| --- | --- |
| `OPENTAG_SKILL_STORAGE_ENDPOINT` | HTTP(S) origin of the S3-compatible service, without credentials, query, or fragment |
| `OPENTAG_SKILL_STORAGE_REGION` | Region the client signs for, for example `us-east-1` |
| `OPENTAG_SKILL_STORAGE_BUCKET` | Bucket that holds Skill archives; it must stay private |
| `OPENTAG_SKILL_STORAGE_ACCESS_KEY_ID` | Access key with read and write access to that bucket |
| `OPENTAG_SKILL_STORAGE_SECRET_ACCESS_KEY` | Secret for that access key; never logged |
| `OPENTAG_SKILL_STORAGE_PREFIX` | Optional object-key prefix, normalized (empty slash segments dropped); defaults to `skills`; an empty or traversal segment is rejected at startup |
| `OPENTAG_SKILL_STORAGE_FORCE_PATH_STYLE` | Optional; defaults to `true`, which MinIO and several other services require |
| `OPENTAG_SKILL_STORAGE_GC_INTERVAL_SECONDS` | Optional collection interval for orphaned Skill objects; defaults to `3600`, and `0` disables collection |
| `OPENTAG_SKILL_STORAGE_GC_GRACE_SECONDS` | Optional minimum object age before collection; defaults to `86400` with a floor of `300` |

Bundles stream through the server under the caller's own credential — the Account session, a Computer
machine token, or a Session CLI proof — so the bucket never needs presigned or public URLs and can be
fully private. Object keys are derived server-side from the Account, Agent, Skill, and content hash;
a caller never supplies a path. `docker-compose.yml` starts a local MinIO and a one-shot init
container that creates the `opentag-skills` bucket, and the commented block in `.env.example` points
the server at it.

Replacing a Skill writes a new object and leaves the previous one in place; a background collector
sweeps objects that are older than the grace period and are not referenced by any Skill row. The
collector only ever considers keys directly under this deployment's own normalized prefix, so several
deployments may share one bucket — including with nested prefixes such as `skills` and
`skills/staging` — and none will collect another's objects. `skills/` and `/skills` mean the same
prefix as `skills`: the configured value is normalized once and used identically for writes and for
collection. The two `GC_` values are only meaningful when the storage group is configured.

## Official website session indicator

When `OPENTAG_PUBLIC_URL` is `https://app.opentag.build`, the Server exposes
`GET /api/v1/auth/browser/session-status` to `https://opentag.build` and `https://www.opentag.build` only.
This credentialed CORS read returns only `{ "authenticated": true | false }`; it never exposes an Account profile
or token. It checks the live browser session and active Account without extending session lifetime. Responses are
`no-store`. Other deployments do not register the endpoint, and other API routes retain their existing origin rules.

Deploy this Server support before the website's navigation indicator. If the check is unavailable, the website keeps
the ordinary login entry; the application still verifies the session after navigation.

## Manual deployment and rollback

Run the **Deploy Staging** workflow from the Actions tab on `main`. Leaving the `revision` input empty deploys the
current tip; supplying a commit SHA deploys that revision instead, which is how a rollback is performed. A manual run is
treated as an explicit decision and is never skipped as stale, but the revision must still belong to `main` history and
must already have published Server and matching CLI/Runner images. For a Runner-only rollback, use **Deploy Runner**
with the current compatible Server revision instead; see [Cloud Runner releases](./cloud-runner-release.md).

Rolling back only reverts application code. It does not revert database migrations that a later revision applied, so a
rollback across a destructive migration needs a deliberate database plan.

## Verifying a deployment

The job summary records the deployed revision, the image tag, and the image digest. Confirm the rollout from the
CapRover side afterwards:

- The App's Deployment tab shows the new image reference and a successful build log.
- `https://<app>/healthz` returns success.
- The App logs show the migration and listen lines for the expected revision.
