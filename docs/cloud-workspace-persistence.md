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

Persistent Runners keep their local files and control listener alive after an authentication
rejection, with execution admission closed and bounded reconnect backoff. An opted-in
`renewExpired: true` handshake can exchange a correctly signed expired bootstrap token for a fresh
short-lived token only after the Server verifies the current persisted allocation and its tracked
Cloud Run UID/ownership. The renewal-only `auth:renewed` reply never attaches a control channel;
the Runner must authenticate again normally. Workspace HTTP still rejects the expired token.
The renewal ability lasts only while that allocation remains current, rather than sharing the
access token's TTL: keep the bootstrap secret in the trusted parent and restrict Instance-read
permissions accordingly. Invalid signatures, foreign audiences, released or replaced allocations
cannot renew; a provider lookup failure is retried without discarding the only local copy.

When no Runner is connected and the provider confirms a previously ready Instance's tracked UID
is absent, start/ingress conditionally clears that exact binding and restores the same storage URI
in the next generation. This loss repair skips the normal `releasing` phase because there is no
local resource left to seal or delete; it cannot be mistaken for an explicit stop by concurrent
ingress. Present or unknown provider results never authorize replacement. Old accepted work still
settles through the existing custody recovery as unknown, never automatic task replay.

At a Turn boundary, the Runner keeps the Session execution slot occupied, stops native Sandbox
writers, saves the workspace, and then reopens execution. Native deletion also removes orphaned
background processes. The workspace survives that namespace reset. A completed external action
does not become safe to replay merely because persistence failed. A failed save produces an honest
`workspace_failed` Turn report while preserving the execution-effects classification and local files.
Reconciliation sends that report before attempting another save. Deterministic archive violations
(size/count limits, unsupported entries, unsafe paths) stop retries of unchanged files and keep
execution blocked, but retain the control/report connection. Transient storage failures retry on
reconnection. A crash during the save, before journaling the terminal report, is reconciled as
unknown execution effects and never automatically replayed.

Normal release first closes admission through `releasing`, then asks the Runner to quiesce,
receive durable Server acknowledgments for terminal reports, and save a sealed archive. The
Server verifies that archive for the exact current environment before deleting the Instance.
During drain, a journaled `received` entry re-announces its original receipt. The Server rejects
and retires an input it never accepted; accepted custody receives cancellation and a durable
`not_started` report. A late verified reply after admission closes also cancels without execution.
Unanswered drain receipts/reports retry every five seconds within the original release deadline.
This reuses the existing receipt/report protocol; reports for unaccepted dispatches remain invalid. Failed saving retains the resource binding and local copy for retry.
A confirmed missing Instance has no local copy to save; recovery uses the last successful archive.
An ordinary Account stop request requires `{ "environmentGeneration": <observed generation> }`.
The Server checks it under the release row lock; a stale page cannot stop a newer allocation.
For a permanently unsaveable or unavailable Runner, the Account stop endpoint supports an explicit
`{ "discardUnsavedChanges": true, "environmentGeneration": <current generation> }` body. It records
the discard intent for that allocation, preserves the previous archive, and performs the same
UID-verified deletion. A stale generation is rejected. Ordinary stop never silently discards files.
Instances that the provider confirms were created without persistence keep their legacy stop
behavior; a missing archive alone is not proof of a legacy Instance. The default seal wait is
480 seconds to cover drain, checkpoint, final upload, and archive work; individual HTTP transfers
retain the 120-second deadline.

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
The Cloud system prompt explains these limits and directs disposable dependency caches/build output
outside the saved workspace; those files must be recreated on subsequent Turns.
Relative workspace symlinks are supported. Hard links (including internal hard links), unsafe
paths, external symlinks, special files, and malformed archives are rejected by the initial format.

Deploy the Server before its matching pinned Runner image. Persistence capability and restored
readiness are explicitly negotiated. The Server identity needs GCS object read/create/delete/update
permissions for the configured storage prefix; the Instance identity does not gain those permissions.
Existing E3/E4 allocations are not automatically migrated: a previously allocated Sandbox without
an archive is rejected before creating a replacement Instance. Initial acceptance uses a new Session; retaining an existing live
workspace requires a separate migration procedure before switching its Runner.
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
6. Create an unsupported hard link in the fixture workspace. The task must report save failure,
   keep the last good object, and remain controllable across reconnect. Ordinary stop preserves
   the Instance; explicit generation-bound discard releases it. Verify a stale discard request
   cannot affect a replacement allocation. A legacy released Session with no archive must not
   allocate a new Instance.
7. Record all temporary Instance and object names, then remove only resources created by this
   acceptance. Allocation release retains the latest archive by design; storage cleanup is
   separate and must use the recorded owned prefix.
