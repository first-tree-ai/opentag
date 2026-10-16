import { isAbsolute } from "node:path";
import { AgentRuntimeError } from "../../agent-runtime/errors.js";
import type { AgentRuntimePolicy, AgentRuntimeWorkspace } from "../../agent-runtime/types.js";

export const CODEX_EXECUTION_PERMISSIONS = "opentag-execution";

/** Trusted per-run sockets, never a wildcard, writable root, or persisted user setting. */
export function codexSocketPermissions(
  sockets: readonly string[] | undefined,
  workspace: AgentRuntimeWorkspace,
  policy: AgentRuntimePolicy,
): Record<string, unknown> | undefined {
  if (!sockets?.length || policy.fileSystem === "unrestricted" || policy.network === "enabled") return undefined;
  if (sockets.length > 8 || sockets.some((path) => !isAbsolute(path) || path.includes("\0") || /[\r\n*?]/.test(path)))
    throw new AgentRuntimeError("configuration_invalid", "Invalid execution Unix socket path");
  return {
    // Codex applies exact Unix exceptions through its managed network proxy. Limited mode with
    // no domains preserves denied TCP egress; enabling this controller is not network authority.
    features: { network_proxy: true },
    permissions: {
      [CODEX_EXECUTION_PERMISSIONS]: {
        extends: policy.fileSystem === "read-only" ? ":read-only" : ":workspace",
        ...(policy.fileSystem === "workspace-write"
          ? {
              filesystem: Object.fromEntries(
                (workspace.writableRoots ?? [workspace.cwd]).map((path) => [path, "write"]),
              ),
            }
          : {}),
        network: {
          enabled: true,
          mode: "limited",
          domains: {},
          allow_local_binding: false,
          unix_sockets: Object.fromEntries(sockets.map((path) => [path, "allow"])),
        },
      },
    },
  };
}

/** Named permission profiles and the legacy sandbox argument are mutually exclusive. */
export function codexThreadPermissions(
  params: Readonly<Record<string, unknown>>,
  socketConfig?: Record<string, unknown>,
): Record<string, unknown> {
  if (!socketConfig) return { ...params };
  const { sandbox: _sandbox, ...rest } = params;
  return { ...rest, permissions: CODEX_EXECUTION_PERMISSIONS };
}

/** Older App Servers may ignore unknown launch fields; require explicit profile acknowledgement. */
export function assertCodexSocketProfile(response: Record<string, unknown>, config: Record<string, unknown>): void {
  if (!config.permissions) return;
  const profile = response.activePermissionProfile;
  if (!profile || typeof profile !== "object" || (profile as { id?: unknown }).id !== CODEX_EXECUTION_PERMISSIONS)
    throw new AgentRuntimeError("configuration_invalid", "Codex did not acknowledge execution socket permissions");
}
