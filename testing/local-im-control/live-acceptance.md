# Local IM controller live acceptance

Date: 2026-11-04 (Asia/Shanghai).

This redacted record supplements the [controller's offline checks and adoption procedure](README.md).
It supports the existing [local source workflow](../../DEVELOPMENT.md#stop-and-restart).
Live operations and native Feishu observations were performed and reported by the instance coordinator;
the implementation task records those observations here without independently operating the shared instance.

## Version and ownership evidence

| Check | Coordinator-reported observation | Result |
| --- | --- | --- |
| Controller implementation | Copied tool bytes match commit `968890cc7b763f06a0f4e111612f2c6ff1a341d8` and the independently reviewed snapshot. | Passed |
| Running Server and daemon | Both run source commit `968890cc7b763f06a0f4e111612f2c6ff1a341d8`. This is the application source revision as well as the controller's implementation commit for this run. | Passed |
| Observed build | Build ID `76ed87ac-c5c6-499b-8132-f16f14425d33` is associated with the selected source and artifact receipt. This identity supplements the SHA rather than inferring a build from HEAD. | Passed |
| Live version cross-check | Server `/readyz` reports the matching `x-opentag-revision`; the controller reports both processes running with verified identities. | Passed |
| Process ownership | Recorded source, full command, PID, UID and start time were verified through the adopted controller. Process IDs, local account identifiers and machine paths are omitted here. | Passed |
| Session exclusion | A second session in the actual existing home was refused while the coordinator retained the reservation. | Passed |
| Retired entry | The old mutation entry was replaced and actual legacy mutation attempts were refused. The old launcher cannot silently restart its previous source through that entry. | Passed |
| Existing installation | The original Runtime binding hash and controlled file modification time remained unchanged; the existing connection remained available. Values and private filesystem locations are omitted. | Passed |

The coordinator performed a separately authorized database backup and upgrade before adoption. The declared database
source is `c48435a73d7db651c087299d8b369698e1d3735c`. This controller did not perform that migration, and this record does
not extend that authorization or establish application data compatibility from equal schema trees alone.
The private environment configuration remains outside the repository and is referenced by the adopted configuration.

## Native Feishu observations

| Scenario | Coordinator-reported observation | Result |
| --- | --- | --- |
| DM reply on the running candidate | A single reply correctly echoed the current synthetic marker `IM-W1-20261104-F6A2`. Native input/reply message IDs are omitted. | Passed |
| Controlled file read | The same reply correctly included the controlled file contents `IM-FILE-20261104-C8D2`. The binding hash and file modification time did not change. | Passed |
| Earlier conversation memory | The same reply correctly recalled the earlier synthetic marker `IM-E2E-20261104-A7F3`. No unrelated conversation content is included. | Passed |
| Native file delivery | A 23-byte CSV attachment was delivered through Feishu and its native preview displayed the two expected rows correctly. Attachment identifiers, business content and raw UI images are omitted. | Passed |
| Native column-card baseline | The baseline observation did not establish a defect in the native column-card presentation. This harness does not change card rendering. | No defect established |

## Scope and remaining acceptance

The first candidate's live DM, memory and controlled file checks passed on the exact running revision above.
They demonstrate preservation of the observed existing binding and local data through adoption; they do not prove
preservation of every private file, every connection state, or provider-wide behavior.

The coordinator is conducting the second-candidate switch serially under the same reservation. Its live result has not
yet been supplied for this record, so the two-candidate acceptance remains incomplete. No second-candidate pass or
completed end-to-end comparison is claimed. Native UI work is coordinated with the user to avoid concurrent interaction.

No original UI screenshots are published because they may include unrelated conversations. Only synthetic test markers
and redacted textual outcomes are retained. Credentials, environment contents, raw process state, private logs, message
identifiers and unrelated message contents remain outside the repository. No product UI change, automatic merge or
release is part of this evidence update.
