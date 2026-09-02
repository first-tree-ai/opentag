import {
  type AgentRuntimeExecutableSource,
  probeInstalledCliCommand,
  type ResolveAgentRuntimeExecutableOptions,
  wellKnownAgentRuntimeBinDirs,
} from "./agent-runtime-installation.js";
import { resolveAccountHome, resolveProviderCliAccountLayout } from "./provider-cli/account-layout.js";

export type IntegrationCliId = "feishu" | "slack";

export type IntegrationCliInstallation =
  | {
      cli: IntegrationCliId;
      displayName: string;
      status: "installed";
      path: string;
      source: AgentRuntimeExecutableSource;
    }
  | {
      cli: IntegrationCliId;
      displayName: string;
      status: "not-installed";
    }
  | {
      cli: IntegrationCliId;
      displayName: string;
      status: "unknown";
      detail: string;
    };

type LoginShellProbeOptions =
  | "includeLoginShell"
  | "loginShellPathDirs"
  | "loginShellEnv"
  | "runShell"
  | "loginShellSpawn"
  | "versionManagerDirs";

export type ProbeIntegrationCliInstallationsOptions = Omit<
  ResolveAgentRuntimeExecutableOptions,
  LoginShellProbeOptions
> & {
  accountHome?: string;
  environment?: NodeJS.ProcessEnv;
  commands?: Partial<Record<IntegrationCliId, string>>;
};

const INTEGRATION_CLIS = [
  { cli: "feishu", displayName: "Lark CLI", command: "lark-cli" },
  { cli: "slack", displayName: "Slack CLI", command: "slack" },
] as const;

/**
 * Install-only observation of Lark CLI and Slack CLI. This reuses the shared
 * spawn-free executable discovery and never inspects Provider CLI selection,
 * credentials, versions, or network endpoints.
 */
export async function probeIntegrationCliInstallations(
  options: ProbeIntegrationCliInstallationsOptions = {},
): Promise<IntegrationCliInstallation[]> {
  const { accountHome: requestedAccountHome, commands, environment = process.env, ...resolverOptions } = options;
  const accountHome = requestedAccountHome ?? resolveAccountHome();
  const wellKnownDirs =
    options.wellKnownDirs ??
    ((home: string, platform: NodeJS.Platform) => [
      resolveProviderCliAccountLayout(accountHome, platform).bin,
      ...wellKnownAgentRuntimeBinDirs(home, platform),
    ]);
  return Promise.all(
    INTEGRATION_CLIS.map(async ({ cli, displayName, command }): Promise<IntegrationCliInstallation> => {
      const probed = await probeInstalledCliCommand(commands?.[cli] ?? command, environment, {
        ...resolverOptions,
        home: resolverOptions.home ?? accountHome,
        includeLoginShell: false,
        wellKnownDirs,
      });
      if (probed.status === "installed") {
        return { cli, displayName, status: "installed", path: probed.path, source: probed.source };
      }
      if (probed.status === "unknown") {
        return { cli, displayName, status: "unknown", detail: probed.detail };
      }
      return { cli, displayName, status: "not-installed" };
    }),
  );
}
