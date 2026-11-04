# Cloud workspace persistence: verification and acceptance

Test and acceptance material for [Cloud workspace persistence](../../docs/system/cloud/cloud-workspace-persistence.md).

## Local checkpoint diagnostics

- `cloud-workspace.test.ts` checks that hard links and an oversized Context Tree cache retained
  for an active write session preserve their specific archive error codes, the last saved object,
  and unsaved local files. Verified read-only caches follow the existing omission rules. A repeated
  terminal failure performs no new transfer.
- `cloud-turns.test.ts` and `cloud-turns-session.test.ts` check that deterministic save failures
  are logged without filenames and keep the report/control channel available. IM execution
  effects remain truthful and reconciliation never reruns the completed worker.
- `context-tree-commands.test.ts` uses a real local managed HTTP request to verify that aborting
  a sync returns `TIMEOUT`, rather than rejecting before the offline recovery path.
  `cloud-context-tree.test.ts` verifies that a timed-out managed HTTP refresh then reads its
  cached snapshot within a fresh recovery budget.
- `native-provider-bridge.test.ts` verifies that a Context Tree caller's TCP FIN cancels the
  parent HTTP response while the other bridge entries retain their large-response and half-close
  behavior. This local test does not establish how an incident's native processes terminated.

These checks establish reproducible failure handling. They do not identify the exact archive
violation from an incident without its original error or prove real GCS/native recovery.

## Web recovery

- `cloud-workspace-recovery.test.tsx` checks access without a release-failure marker, generation
  capture, duplicate-click prevention, discard confirmation/cancellation, a replacement during
  confirmation, status-read failures, uncertain mutations without automatic resubmission,
  pagination and revoked access. Running, queued and unknown work requires an interruption
  confirmation before save/release. Save/release and discard/release both refresh the separate
  progress-notice query: two regression cases fail before that refresh is added and pass after it,
  so a successful recovery removes the previously visible save-failure banner without polling.
- `api-cloud-workspace.test.ts` checks the existing Account status/stop paths, exact generation and
  discard bodies, CSRF, denial and response deadlines without a second mutation.
- [Browser evidence](../web-ui/cloud-workspace-recovery/README.md) covers responsive layout,
  both locales, keyboard confirmation behavior and accessibility with mocked Account APIs.

These checks do not establish real GCS, Instance deletion, or same-Session restoration. The live
acceptance below remains separate and requires authorization for its owned disposable resources.

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
