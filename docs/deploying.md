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
| `OPENTAG_JWT_SECRET` | At least 32 random characters, unique to Staging |
| `OPENTAG_ENCRYPTION_KEY` | Base64 32-byte key, unique to Staging |
| `OPENTAG_AUTO_MIGRATE` | `true` so each rollout applies pending migrations |

Enable HTTPS and force HTTPS on the App before setting `OPENTAG_PUBLIC_URL`; the server refuses to start in a hosted
environment whose public URL is not HTTPS. Staging secrets must not be shared with any other environment.

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

## Deployments that need action outside the rollout

Most revisions need nothing beyond the checks above. A migration that invalidates credentials held outside the
database is different: the rollout succeeds, `/healthz` passes, the logs look clean, and the Computer fleet goes dark
anyway. Record each such migration here, because nothing in the deployment surfaces it.

### Workspace and machine authority cutover — `0016_certain_revanche` (#161)

This migration moved Runtime authentication from Account access tokens to enrollment-scoped machine credentials. It
deliberately creates no credentials for existing Computers, and asserts that it created none:

```sql
IF EXISTS (SELECT 1 FROM "workspace_computer_credentials") THEN
    RAISE EXCEPTION 'Workspace cutover must not synthesize machine credentials';
```

Synthesizing a credential nobody consented to would be a back door, so the assertion is correct. The cost is that
**every Computer enrolled before the cutover must be enrolled again by hand**, and three separate effects hide the
reason:

- Every Computer reports Offline. `workspace_computers` rows are inserted without `current_instance_id`, and only a
  Computer registration sets it.
- A daemon on the pre-cutover CLI authenticates the Runtime WebSocket with an Account access token and is refused with
  `AUTH_INVALID_TOKEN` and close code 4401.
- Upgrading the CLI alone does not recover a Computer. The daemon exits with `This Computer is not enrolled; run
  computer connect first`, because `computer-credentials.json` does not exist. The pre-cutover CLI has no
  `computer connect` subcommand at all, so the upgrade is required before the enrolment can be run.

The Agent's Connected computer page reports `OpenTag is not running on <name>. Start it there to bring this Computer
back online.` That advice is correct for a Computer that is merely asleep and wrong here; starting the old daemon
cannot succeed.

#### Finding the affected enrollments

```sql
select w.name as workspace, wc.display_name, wc.computer_id, wc.platform, wc.last_seen_at
from workspace_computers wc
join workspaces w on w.id = wc.workspace_id
left join workspace_computer_credentials c
       on c.workspace_computer_id = wc.id and c.revoked_at is null
where wc.revoked_at is null and c.id is null
order by wc.computer_id, w.name;
```

Each row is one enrollment waiting to be recovered, not one host. A `computer_id` appearing on more than one row is a
host enrolled in several Workspaces, and every one of those rows needs its own pass. The list is empty once the fleet
has recovered.

#### Recovery

**The unit of recovery is one Workspace enrollment, not one physical machine.** A connect code carries the Workspace it
was issued for and `computer connect` writes the credential for that Workspace alone, while the daemon runs one
independent Runtime connection per stored enrollment. Running the procedure once on a host enrolled in several
Workspaces leaves the other Workspaces' Agents offline on a machine that already looks recovered.

It cannot be done centrally either — the credential is written to the target host's disk.

For each row returned above:

1. A Workspace Admin **of that Workspace** opens the Computers page in the web app and generates a connection command.
   The command is single-use and expires in 15 minutes, so generate it once the person is ready rather than in advance.
2. That person runs the generated command on the host. It upgrades the CLI and enrols in one line, which matters
   because the installed CLI predates the `computer connect` subcommand.
3. The command writes the machine credential and restarts the daemon service. That enrollment reports Online within
   one registration.

Repeating this on a host already recovered for another Workspace is safe. `computer-credentials.json` holds one entry
per enrollment and enrolling replaces only the entry for the Workspace being enrolled, so earlier credentials survive
and the daemon picks up every stored enrollment when it restarts.

Re-enrolling a host that still has its `config/computer.json` keeps the same `computerId`, so existing enrollments are
reused and their Agents stay bound. Losing that file makes the host a new Computer, and every previous enrollment stays
offline with its Agents attached to it.
