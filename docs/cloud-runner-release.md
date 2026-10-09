# Cloud Runner releases

[简体中文](./zh-CN/cloud-runner-release.md)

Runner uses the CLI release version. The existing npm publication workflow now builds and smoke-tests a linux/amd64
Runner from the same clean source, publishes it to Artifact Registry, then publishes npm and portable artifacts. It
records the verified image digest, channel, version and source SHA as a GitHub Actions artifact after the complete release
succeeds. A version tag is never overwritten; a retry can reuse an existing image only after its identity is verified.
`Runner Toolchain` remains the independent, offline-only PR build check.

## Publishing configuration

Reuse the portable workflow's `OPENTAG_PORTABLE_GCP_WORKLOAD_IDENTITY_PROVIDER` and
`OPENTAG_PORTABLE_GCP_SERVICE_ACCOUNT`; there is no service account key or npm token fallback. Configure:

| Repository variable | Meaning |
| --- | --- |
| `OPENTAG_RUNNER_STAGING_IMAGE_REPOSITORY` | Staging GAR image path, without a tag or digest |
| `OPENTAG_RUNNER_PROD_IMAGE_REPOSITORY` | Production GAR image path, without a tag or digest |
| `CAPROVER_STAGING_PASSWORD_SECRET` | Existing Secret Manager credential resource, `projects/.../secrets/.../versions/latest` |
| `CAPROVER_PROD_PASSWORD_SECRET` | Corresponding production Secret Manager resource |

The existing publisher service account needs `roles/artifactregistry.writer` only on the selected image repository.
Deployment uses **direct federation** through the same provider, without impersonating that publisher. Grant the exact
GitHub Environment subject reader access on its image repository and `roles/secretmanager.secretAccessor` on its own
CapRover secret. Read the repository subject configuration before constructing that identity:

```sh
gh api repos/first-tree-ai/opentag/actions/oidc/customization/sub
```

For the default template with `use_immutable_subject: true`, append `:environment:staging` (or `:production`) to the
returned `sub_claim_prefix`; it includes immutable organization/repository IDs. The older
`repo:first-tree-ai/opentag:environment:staging` form does not match such a token. For a custom template, verify its actual
`sub` claim instead of assuming either format. The full member is
`principal://iam.googleapis.com/projects/<pool-project-number>/locations/global/workloadIdentityPools/<pool>/subject/<subject>`.
Do not grant administrator-secret access to the publisher service account. No additional service account is required.

Restrict both deployment Environments to main; configure production reviewers before granting its secret access. Keep the
publisher's federation limited to reviewed main/protected-tag workflows. Configure permissions and variables before
merging/enabling this workflow: missing publishing configuration fails before npm publication. This follows Google's
[direct federation deployment guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).

### Failed release recovery

A publish run that claims a version tag (Runner image pushed) but fails before npm publication leaves an orphaned image
tag. Staging versions derive from the published npm sequence, so every later commit recomputes the same version and the
workflow fails the tag identity check instead of overwriting it. Recovery: add a quarantine tag to the claimed image and
then delete the exact version tag in Artifact Registry, then re-run the workflow (it rebuilds the version from clean
source). Never overwrite the existing tag with a different build.

The CapRover App Token still deploys the Server image. It cannot update environment variables, so Runner activation
retrieves the existing administrator credential through workload identity, keeps it in memory and changes only the two
Runner target variables. No administrator password is added to GitHub Secrets. Staging uses the existing
`CAPROVER_STAGING_SERVER`, `CAPROVER_STAGING_APP`, and `CAPROVER_STAGING_APP_TOKEN` secrets. Production activation uses
`CAPROVER_PROD_SERVER` and `CAPROVER_PROD_APP`. Production approval belongs to the `production` GitHub Environment.

## Staging and production

Staging deployment starts after successful `npm Publish`, reads that run's exact release record and verifies its npm
gitHead and registry identity. It deploys the matching Server first, then changes `OPENTAG_CLOUD_RUNNER_IMAGE` and
`OPENTAG_CLOUD_RUNNER_VERSION` together. Superseded automatic revisions still skip. An incomplete Runner publication
cannot silently leave an old Runner while reporting the new Cloud release complete.

### Background image preparation after Server startup

The Server starts an independent image-preparation worker **after** listening and completing readiness. When Cloud Runner
is enabled, staging/prod enable this worker by default; development defaults off. No additional required configuration
or GitHub IAM grants are needed: it uses the Server's existing Instance management and runtime-service-account act-as
permissions, Direct VPC placement and metadata token provider. Each API call obtains a valid cached/refreshed token,
including cleanup after a long image import. It never reads credential files or shells out to `gcloud`.

The first check runs immediately in the background. Subsequent checks run every 60 seconds by default, without overlapping
work. Failures are reported as `RUNNER_IMAGE_PREWARM_FAILED` through the existing background supervisor and retried on the
next check. Preparation does not delay `/readyz`, block releases, or gate message dispatch. A message arriving before
preparation finishes can still encounter an uncached image import.

Replicas coordinate through a nonblocking PostgreSQL session advisory lock using one dedicated connection for the leader.
No database table, migration, long transaction or external scheduler is added. The lock key covers the environment,
project, region, runtime identity, image repository and network placement; it is stable across digest changes. The leader
retains the lock after success, and subsequent checks only verify that session still holds it. Healthy successful leaders
do not repeatedly allocate probes. When a leader stops or loses its connection, another replica can prepare the image on
its next check. During a rolling deployment, the old leader must release its lock before a replacement can prepare a new
digest. Full Server restarts and leadership replacement may repeat a successful import.

The worker creates one deterministic `ot-warm-*` Cloud Run Instance with separate purpose/target labels, internal ingress,
default URL disabled, the exact configured image digest and Direct VPC attachment. Its overridden entrypoint runs a
minimal unprivileged HTTP listener that exits after two minutes. It receives no bootstrap token, Server URL, Session,
Turn or model credentials. Business allocation, readiness, queue consumption and idle reclamation remain independent.

Preparation waits up to five minutes for **both** `ContainerReady` and `Running`. Cleanup has a separate two-minute budget
and requires a final not-found response. It verifies purpose/target/environment labels, image repository, service account,
command, arguments, absence of environment credentials, UID and etag before deleting. It checks leadership again before
create/delete. A matching previous-digest probe is deleted before importing the new digest. Foreign or replaced resources
are rejected rather than deleted; create responses of uncertain outcome are reconciled without blindly repeating POST.

Graceful shutdown aborts preparation, drains bounded cleanup, then closes the dedicated lock connection. A forced kill
can interrupt cleanup; the next leader recovers the same named, strictly owned probe. A change to project, identity,
repository or VPC placement creates a different namespace: inspect old `ot-warm-*` probes explicitly after such a change.
A failed cleanup is observable and never reported as successful preparation.

Optional Server variables:

| Variable | Default / meaning |
| --- | --- |
| `OPENTAG_CLOUD_RUNNER_PREWARM_ENABLED` | `true` in staging/prod, `false` in dev; `false` disables this worker |
| `OPENTAG_CLOUD_RUNNER_PREWARM_INTERVAL_MS` | `60000`; retry/leadership check cadence, allowed range 1000–3600000 |

Publication and activation workflows keep their existing release-record, source-ancestry and `/readyz` verification.
`Deploy Runner check` remains read-only. There is no CI prewarm workflow or deployment prewarm gate.

Successful preparation logs the image, resource name, UID, import/running timestamps and preparation duration **after**
probe deletion. It proves this digest was imported and a disposable probe started in the selected region. It does not
guarantee cache retention, future cache hits, native Runner readiness or business completion. Validate a new image with
`prewarm → delete → fresh allocation` and measure import and remaining startup times separately. Existing cold-start and
end-to-end acceptance checks still apply; this change alone does not establish the three-second target.

An accepted npm publication can remain unavailable while npm processes it. Exact-version E404 responses receive a
bounded wait; invalid metadata, authorization failures and source mismatches still fail immediately. Runner activation
also waits for the initial CapRover build to finish before capturing the configuration snapshot. `check` and the final
pre-update build/configuration checks remain fail-fast; configuration writes are never retried.

If activation fails during post-update verification, run **Deploy Runner** with `mode=check` for the same target before
repeating an update. A failed response or read does not prove that the configuration write failed.

Production tags publish the formal CLI and Runner together. Deploy the compatible Server through the existing production
procedure, then run **Deploy Runner** on main with `channel=prod`, the exact published `version`, and the full
`server_revision` already deployed. Start with `mode=check`; `mode=apply` activates and verifies the target. This workflow
does not deploy or roll back the Server. It rejects a Runner source outside the selected Server's main ancestry; source
ancestry establishes provenance, not a promise that arbitrary protocol-breaking releases are compatible.

Deployment verification uses `/readyz` from the responding process: `x-opentag-revision` identifies the Server source
baked into its image, and `x-opentag-runner-target` hashes the configured image and version. Control-plane acceptance alone
is insufficient. These headers contain no credentials; local builds without a revision do not claim a deployment proof.
Instances created afterwards must still pass the existing native Runner readiness checks. HTTP readiness does not itself
prove an actual Cloud Run allocation or completion of every replica in a rolling deployment.

## Existing Instances and rollback

Before the first unified rollout, preserve the currently configured digest as a rollback baseline. If a manually
published image lacks its CLI version tag, verify its image identity and npm gitHead first, then add the missing tag to
that same digest. Do not rebuild it or overwrite an existing version tag. Subsequent unified releases already provide
this coordinate, so the ordinary rollback workflow needs no legacy fallback.

The target selects new Instances. A previously verified, ready Instance with the same persisted physical identity may
reconnect across a target change when its protocol remains compatible and the provider confirms the Instance has not
been updated since creation. [Cloud Run](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.instances)
supports in-place image updates without changing the resource UID, so UID alone
is insufficient: this path requires the original provider generation. OpenTag itself never updates an Instance image.
Initial admission keeps the strict target-image and version checks. Old-image Instances cannot be borrowed by another
Session. They continue existing work, save and
leave through the existing idle reclamation path; the next allocation restores the same Session storage URI.

For a Runner-only rollback, run **Deploy Runner** with a previous published version and the **current compatible Server
revision**. Staging manual activation shares its concurrency group with automatic staging deployment. Coordinate any
queued/new automatic deployments during incident response; a later successful main release can intentionally advance the
target again. Neither the CLI channel head nor installed local Clients are downgraded by this operation.

Rollback changes the target immediately after verification; it does not replace already running Instances. Use the
existing cancellation/save/reclaim controls for an urgently affected Instance. There is no global drain for an ordinary
compatible Runner upgrade or rollback, and no in-place download/self-update inside an Instance.

Before rolling the **Server** back across an incompatible protocol boundary, stop new work, settle and save while the
compatible Server is still present, then reclaim those Instances. Do not delete an Instance with unconfirmed execution
receipts merely to make a rollout green. Image rollback does not undo database migrations, persisted workspaces or
external effects. A failed Instance may only have its last confirmed workspace save available.
