# Cloud workspace persistence (E5)

E5 preserves an Agent Session's working files and Pi conversation across replacement Cloud Run
Instances. It does not resume process memory. The existing Sandbox remains the durable link between
the Session, its fixed `storage_uri`, and the currently allocated Instance. There is no new table,
storage history catalogue, or user-selectable checkpoint version.

## Saved state

The latest complete archive is `<storage_uri>/state.tar.gz` in Google Cloud Storage. It includes
the Session workspace, Git files, and `.opentag/pi-session` (Pi history and its provider binding).
The image/rootfs, running processes, trusted Runner delivery journal, temporary model grants,
provider credential material, proxy sockets, and private signing material are outside that tree.
The Server's existing durable delivery custody remains authoritative for execution and reports.

Platform credential exclusion relies on the directory boundary. It is not secret detection for
files an Agent or user independently creates in the workspace. Other Session directories are not
mounted or synchronized. Agent-wide Context Tree integration remains E8.

## Save and restore boundaries

The Runner restores and verifies the workspace before reporting execution readiness. A complete
archive is validated in a sibling staging directory before installation; an invalid or missing
expected archive never becomes a successful empty restore. Reconnecting the same live Runner does
not replace its current local files with an older archive.

At a Turn boundary, the Runner keeps the Session execution slot occupied, stops native Sandbox
writers, saves the workspace, and then reopens execution. Native deletion also removes orphaned
background processes. The workspace survives that namespace reset. A completed external action
does not become safe to replay merely because persistence failed.

Normal release first closes admission through `releasing`, then asks the Runner to quiesce,
receive durable Server acknowledgments for terminal reports, and save a sealed archive. The
Server verifies that archive for the exact current environment before deleting the Instance. Failed saving retains the resource binding and local copy for retry.
A confirmed missing Instance has no local copy to save; recovery uses the last successful archive.

OOM, SIGKILL, and machine loss cannot guarantee a final save. Changes since the last successful
boundary may be lost, including progress within a long-running Turn. Already-started operations
with unknown effects follow existing custody reconciliation and are never automatically replayed.

## Storage and authority

The Server reuses its Google identity to access GCS. The trusted Runner transfers archive bytes
over authenticated streaming HTTP, using its current allocation-scoped bootstrap credential.
Small control messages remain on WSS. The Sandbox receives neither a Google token nor an extra
parent management listener. The Server derives the destination from the database; the caller
cannot supply a bucket, object name, or another Session's storage address.

The Server conditionally initializes the empty object before reserving the first allocation.
A failed initialization leaves generation zero retryable; Runner claims never recreate a missing
object, including in generation one. Each new allocation claims the same object's metadata before reading it. Writes require both its
GCS generation and metageneration to match. Updating the owning environment generation fences a
late upload from the previous Instance even when the replacement has not written new archive
bytes. A fresh Runner process also conditionally saves once before readiness, fencing a delayed
upload from an earlier process of the same allocation. These are native conditional-write tokens,
not application storage versions.
See Google's [request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)
and [conditional object insertion](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert).

An interrupted upload retains the previous complete object. When an upload's response is lost,
success requires readback matching the intended owner, length, checksum, and seal. No unconditional
overwrite or automatic empty fallback is allowed.

## Resource and rollout limits

The fixed configuration remains 1 vCPU / 1 GiB. Archive processing streams rather than buffering
the whole payload. Initial safety limits are 128 MiB compressed, 256 MiB expanded, and 50,000
entries; exceeding a limit fails saving/restoring explicitly. Temporary files also consume the
Instance's memory-backed filesystem, so these limits are not a guarantee against workload OOM.
Relative workspace symlinks are supported. Hard links (including internal hard links), unsafe
paths, external symlinks, special files, and malformed archives are rejected by the initial format.

Deploy the Server before its matching pinned Runner image. Persistence capability and restored
readiness are explicitly negotiated. The Server identity needs GCS object read/create/delete/update
permissions for the configured storage prefix; the Instance identity does not gain those permissions.
Existing storage configuration and allocation identity are reused. The ingress/reverse proxy must
allow the archive body size (128 MiB) and the transfer deadline (120 seconds); verify these values
in staging before enabling E5. Workspace HTTP requests and the Runner WSS connection must
reach the same Server process while connection ownership is held in the in-memory Runner hub.
Local tests do not prove the
Cloud Run native Sandbox or real GCS behavior; live acceptance must separately demonstrate a
save, confirmed Instance deletion, new allocation, and same-Session continuation.

## Live acceptance before rollout

Use a disposable Account/Session and an owned GCS prefix in staging (us-west1). The existing
`cloud-runner` harness now requires `--storage-base gs://<bucket>/<owned-prefix>` (or
`OPENTAG_E3_STORAGE_BASE`) instead of inventing a storage bucket. Its basic native/Pi checks
alone still do not prove Session restoration.

1. Run the exact candidate Server and digest-pinned matching Runner. Confirm storage permissions
   and ingress limits; record image digest, source commit, Sandbox ID, and Instance UID.
2. Send a task that writes a unique workspace marker and establishes Pi history. Confirm its
   terminal report and the saved object's checksum; keep credentials out of artifacts.
3. Stop the Session's allocation. Verify the report acknowledgment, sealed current-generation
   object, actual Instance deletion, and unchanged Sandbox ID/storage URI.
4. Resume the same Session on a new Instance. Confirm the marker and original Pi conversation
   binding survive and subsequent work uses that conversation. An unacknowledged started task
   must be reconciled honestly, never replayed automatically.
5. Deny an upload in the test fixture: stopping must keep the Instance bound in `releasing`.
   Restore access and retry. Also replace an already-missing Instance and confirm only the last
   successful saved boundary is recoverable.
6. Record all temporary Instance and object names, then remove only resources created by this
   acceptance. Allocation release retains the latest archive by design; storage cleanup is
   separate and must use the recorded owned prefix.
