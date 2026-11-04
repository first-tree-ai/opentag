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
| First-candidate Server and daemon | Both ran source commit `968890cc7b763f06a0f4e111612f2c6ff1a341d8`. This is the application source revision as well as the controller's implementation commit for this run. | Passed |
| First-candidate build | Build ID `76ed87ac-c5c6-499b-8132-f16f14425d33` is associated with the selected source and artifact receipt. This identity supplements the SHA rather than inferring a build from HEAD. | Passed |
| First-candidate live version cross-check | Server `/readyz` reports the matching `x-opentag-revision`; the controller reports both processes running with verified identities. | Passed |
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

## Second-candidate switch and native verification

The coordinator serially selected a second prebuilt candidate while retaining the acceptance reservation.
The same copied controller implementation from `968890cc7b763f06a0f4e111612f2c6ff1a341d8` controlled both candidates.

| Check | Coordinator-reported observation | Result |
| --- | --- | --- |
| Second application source | Server and daemon both ran `d7d8033758d7fee4df05a5e47195a2640db6c387`. The controller copy remained at the implementation commit above. | Passed |
| Second observed build | Build ID `b31df7c8-436e-4c93-8cb5-48eda52c03f6` matched the selected source and receipt. | Passed |
| Second live identities | Server and daemon identities verified; the Server's `/readyz` revision header matched the second source SHA. | Passed |
| Schema boundary | Both candidates had the same schema fingerprint as the declared database source. No additional migration was performed for this switch. | Passed |
| Single DM reply | One reply precisely included `IM-W2-20261104-J9C5`, the controlled CSV rows below, and the earlier marker `IM-E2E-20261104-A7F3`. Native input/reply identifiers are omitted. | Passed |
| Completion cross-check | The coordinator observed the same reply in native Feishu UI and a completed Server report. | Passed |
| Existing installation | The original Runtime binding hash and old controlled file modification time remained unchanged after the switch. | Passed |
| Downloaded attachment | The CSV was downloaded through native Feishu UI to a separate private evidence directory. Its 23 bytes exactly matched the original generated file. | Passed |

The controlled CSV contained these two synthetic rows:

```csv
item,value
canary,H7B4
```

The downloaded bytes and the original generated file had SHA-256
`05246257c6fb67b76bdd6fd7e366816f344180588f7b57e442b82a56224c9b29`.
The byte count and digest describe the actual attachment bytes, including their line endings; the code block is a
readable representation of the two rows.

The second application source served to verify the candidate-switch mechanism. Native testing did not substantiate
the suspected column-card product defect, and this change proposes no column-card fix or rendering change.

## Scope and limits

The two candidates passed serial live checks under the same controller. The observed original binding and controlled
local data survived adoption and switching; these checks do not prove preservation of every private file, every
connection state, or provider-wide behavior.

The application acceptance SHAs are exactly `968890cc7b763f06a0f4e111612f2c6ff1a341d8` and
`d7d8033758d7fee4df05a5e47195a2640db6c387`. Subsequent documentation commits do not change the reviewed controller bytes
and were not rerun as application source. The coordinator manages the final running candidate separately.

No original UI screenshots are published because they may include unrelated conversations. Only synthetic test markers
and redacted textual outcomes are retained. Credentials, environment contents, raw process state, private logs, message
identifiers and unrelated message contents remain outside the repository. No product UI change, automatic merge or
release is part of this evidence update.
