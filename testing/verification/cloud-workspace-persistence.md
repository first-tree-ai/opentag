# Cloud workspace persistence: verification and acceptance

Test and acceptance material for [Cloud workspace persistence](../../docs/system/cloud/cloud-workspace-persistence.md).

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
