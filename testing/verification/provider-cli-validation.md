# Provider CLI identity validation

Supports [Direct provider CLI messaging](../../docs/system/messaging/direct-provider-cli.md) and
[Server observability](../../docs/operations/observability.md).

## Offline native reproduction

The official `lark-cli v1.0.92` Darwin ARM64 executable was checked against the managed catalog:
SHA-256 `d98aa671fc74c3c47a6f6b350bb7f1f59d730399df8d86e890e1cbba00c1beec`.
Each invocation used a fresh private home, synthetic app/token/bot identities, and the CLI's
fixed loopback proxy mode with an ephemeral test CA. The proxy terminated requests locally and
never forwarded them. Bot info returned a synthetic success; metadata returned a synthetic
`403 validation_scope`. No provider credential or external API was used.

| Invocation | Observed GET paths | Identity result |
| --- | --- | --- |
| Native CLI, remote metadata enabled | `/api/tools/open/api_definition?protocol=meta&client_version=1.0.92&data_version=1.0.0`, `/open-apis/bot/v3/info` | Success despite metadata rejection |
| Native CLI, `LARKSUITE_CLI_REMOTE_META=off` | `/open-apis/bot/v3/info` | Success |
| Patched proxy validation runner with native CLI, session environment requesting metadata enabled | `/open-apis/bot/v3/info` | `ready` |

The pinned upstream sources explain the optional request and the process-scoped switch:
[remote metadata](https://github.com/larksuite/cli/blob/6646386e0996b1ff5df640bccff834a20bcb203b/internal/registry/remote.go)
and [registry initialization](https://github.com/larksuite/cli/blob/6646386e0996b1ff5df640bccff834a20bcb203b/internal/registry/loader.go).
Disabling the optional refresh removes the validation request without extending proxy authority.

## Regression scope

- `provider-cli-validation.test.ts`: both Local and proxy Feishu identity probes disable remote
  metadata; proxy-session environment overrides cannot re-enable it.
- `runtime-credentials-im.test.ts` and `runtime-provider-proxy-adapter.test.ts`: bot identity succeeds;
  metadata and business operations remain unavailable during validation; unknown methods/paths
  fail closed; normal execution metadata queries still forward their query parameters.
- `runtime-credentials-transport.test.ts`: all registered IM failure codes survive warning
  sanitization, existing GitHub codes remain recognized, and unknown codes/raw error text stay
  absent from warning records.
- `provider-proxy-support.test.ts` and `runtime-credentials-broker.test.ts`: adjacent request,
  credential-purpose, and authorization-fence behavior.

These checks establish offline behavior. Staging rollout and real provider acceptance are separate.
