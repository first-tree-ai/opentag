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

### Prepare image import before activation

Image publication and Cloud Run image import are separate steps. Deployment preparation uses the verified release
record's **digest**, never a moving tag or a Docker pull on a GitHub build host. The shared `prewarm-runner` action runs
`scripts/runner/prewarm.mjs`; it reads the target app's existing project, region, service account and Direct VPC attachment
through the deployment identity. There is no second set of CI placement variables.

| Path | Preparation boundary |
| --- | --- |
| Automatic or manual **Deploy Staging** | After release verification and the initial current-main gate, before Server deployment; recheck main after preparation |
| Production tag publication | Successful complete `npm Publish` triggers **Prewarm Runner** on default main, behind the `production` Environment reviewer gate |
| Manual **Deploy Runner**, `mode=apply` | Prepare the exact selected digest before changing the target, including rollback |
| Manual **Deploy Runner**, `mode=check` | Strictly read-only; creates no probe |
| Manual **Prewarm Runner** | Prepare an exact published staging/prod version without deploying Server or changing the Runner target |

Production preparation runs separately from the tag publication job because the production Environment permits main,
not tags. It verifies the completed release artifact, npm gitHead, registry identity and main ancestry. It does not deploy
Server or bypass production approval. Failed production preparation does not undo an already published npm release;
`Deploy Runner apply` independently prepares again before activation. Keep the existing explicit production Server
deployment procedure, and complete **Prewarm Runner** before starting it. Preparation has its own FIFO concurrency group,
so it cannot displace a pending deployment.

The probe is one temporary Cloud Run Instance per invocation, with a random ownership label, internal ingress, default
URL disabled and the same digest and network placement. Its overridden command runs a minimal unprivileged HTTP listener
that exits after two minutes. It receives no bootstrap token, Server URL, Session or model credentials. Preparation waits
up to five minutes for `ContainerReady` **and** `Running`, then deletes only that probe after checking its ownership,
image, service account, UID and etag. Cleanup failure fails preparation. An `always()` cleanup step and a non-secret
ownership artifact also support interrupted-run recovery; a forcibly killed/unavailable GitHub runner still requires
checking the recorded resource manually. Never delete business Instances during image preparation.

Preparation uses the existing **deployment Environment federation**, not the image publisher service account. Before
enabling these gates, grant each exact Environment subject `run.instances.create`, `run.instances.get` and
`run.instances.delete` in its actual runtime project (a dedicated custom role can keep the scope to Instances), plus
`roles/iam.serviceAccountUser` on **only** that environment's existing Instance service account. Keep existing per-image
Artifact Registry Reader and per-secret access. The project's Cloud Run service agent must retain its existing Direct
VPC permissions. Do not grant these permissions to `OPENTAG_PORTABLE_GCP_SERVICE_ACCOUNT`, change production branch
policies, or remove reviewers. See [instance deployment permissions](https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances)
and [Direct VPC permissions](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc#set_up_iam_permissions).

Successful preparation proves this digest was imported and a disposable probe started in the selected region. It does
**not** guarantee cache retention or future hits, native Runner readiness, sandbox restoration, or business completion.
Keep those existing checks. The Cloud Run [service deployment retention contract](https://docs.cloud.google.com/run/docs/deploying)
is for serving **service revisions**; do not assume it guarantees cache retention after deleting singleton Instances.
Validate a new image with `prewarm → delete → fresh allocation` and record import and remaining startup times separately.

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
