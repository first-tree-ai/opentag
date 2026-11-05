# Provider CLI readiness

Run with a dedicated authorized Local Computer and test binding. The ready artifact is already installed and its
selection is valid. Do not install, replace or reauthorize a CLI merely to run a readiness case. Record actual
candidate identities, observations and unavailable prerequisites in the release PR or Issue. A generic CLI-ready
observation does not establish credential validity, a working provider connection or a useful IM result.

| ID | Scenario | Steps | Expected result | Automated check |
| --- | --- | --- | --- | --- |
| PC-01 | Existing binding without setup prewarm | Reconnect the dedicated Computer whose active Agent already has messaging configured; observe the next passive readiness refresh. Repeat for Slack and Feishu when authorized fixtures exist | A matching ready selected artifact establishes and continues refreshing generic IM CLI readiness without setup prewarm, ensure or credential-validation calls from passive inspection. The Server still checks credential admission independently | Client `provider-cli-reconciler.test.ts`: live requirement with and without prewarm |
| PC-02 | Requirement retired during inspection | Hold the existing fake inspection, then cancel or replace its requirement or close the Client before releasing it | The retired inspection publishes no generic readiness for the old requirement | Client `provider-cli-reconciler.test.ts`: requirement retirement cases |
| PC-03 | Inspection fails or its selection no longer matches | Use the existing fake inspection to return an unknown failure or a ready result that does not match the selected identity; refresh again | Readiness stays unavailable on both refreshes; passive inspection neither installs nor validates credentials | Client `provider-cli-reconciler.test.ts`: unknown and selection-mismatch cases |
| PC-04 | Passive inspection overlaps repair | Use the existing delayed-inspection and repair fixture; release the older unavailable inspection after repair completes | The stale inspection publishes no generic readiness for the active requirement; a later current inspection publishes ready | Client `provider-cli-reconciler.test.ts`: stale passive inspect after overlapping ensure |
