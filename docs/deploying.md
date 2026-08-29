# OpenTag deployment guide

[简体中文](./zh-CN/deploying.md)

OpenTag runs its Staging environment on [CapRover](https://caprover.com/). Every revision that lands on `main` and
passes CI is deployed automatically from the container image the `Docker` workflow already published to GHCR. Nothing is
built on the CapRover host and no source tarball is uploaded; the deployment is a pointer change to an immutable image.

| Environment | Trigger | Image | Workflow |
| --- | --- | --- | --- |
| Staging | Successful `CI` on `main`, or an intentional manual run | `ghcr.io/first-tree-ai/opentag:<commit-sha>` | `deploy-staging.yml` |

Production is not deployed by this repository. See [releasing.md](./releasing.md) for the published production
artifacts.

## How a push reaches Staging

1. A revision lands on `main`. `CI` and `Docker` start in parallel.
2. `Docker` builds and pushes the immutable commit coordinate `ghcr.io/first-tree-ai/opentag:<commit-sha>`.
3. `CI` succeeds, which starts `Deploy Staging`.
4. `Deploy Staging` proves the revision belongs to `main` history, waits for the commit coordinate to be published, and
   confirms the revision is still the tip of `main`.
5. The CapRover App is pointed at that exact image tag and CapRover pulls and rolls it out.

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

Enable HTTPS and force HTTPS on the App before setting `OPENTAG_PUBLIC_URL`; the server refuses to start in a hosted
environment whose public URL is not HTTPS. Staging secrets must not be shared with any other environment.

Configuration is validated before the server listens, so add a newly required variable to the App **before** the
revision that needs it is deployed. A missing one leaves CapRover restarting a container that exits at startup rather
than serving a degraded App.

The GHCR package is public, so CapRover pulls the image anonymously. If the package is ever made private, add a
registry credential in **CapRover → Cluster → Docker Registries** using a GitHub token with `read:packages`, otherwise
every deployment fails at the pull step.

## Manual deployment and rollback

Run the **Deploy Staging** workflow from the Actions tab on `main`. Leaving the `revision` input empty deploys the
current tip; supplying a commit SHA deploys that revision instead, which is how a rollback is performed. A manual run is
treated as an explicit decision and is never skipped as stale, but the revision must still belong to `main` history and
must already have a published image.

Rolling back only reverts application code. It does not revert database migrations that a later revision applied, so a
rollback across a destructive migration needs a deliberate database plan.

## Verifying a deployment

The job summary records the deployed revision, the image tag, and the image digest. Confirm the rollout from the
CapRover side afterwards:

- The App's Deployment tab shows the new image reference and a successful build log.
- `https://<app>/healthz` returns success.
- The App logs show the migration and listen lines for the expected revision.
