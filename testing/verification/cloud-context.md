# Cloud Context Tree and Session collaboration: verification and acceptance

Test and acceptance material for [Cloud Context Tree and Session collaboration](../../docs/system/cloud/cloud-context.md).

## Validation boundary

Local verification covers fresh configuration after real archive restoration, independent Session
state, Tree conflict preservation, exact source authorization, duplicate delivery, execution
serialization and idle-reclaim races. Provider fixtures prove those boundaries, not real-account
authorization.

Native acceptance must use a matching Server and Runner source/version, actual Cloud Run/GCS and Pi,
including cold restoration and physical Instance reuse. Live GitHub acceptance additionally requires
the configured App, an explicitly authorized test repository and real user admission. End-to-end IM
acceptance needs a selected test conversation and authorization for outbound synthetic messages.

See [Cloud Runner execution](../../docs/system/cloud/cloud-runner-execution.md),
[workspace persistence](../../docs/system/cloud/cloud-workspace-persistence.md),
[internal Session collaboration](../../docs/system/messaging/internal-session-collaboration.md), and
[platform integrations](../../docs/system/capabilities/github-platform-integration.md) for the existing contracts.
