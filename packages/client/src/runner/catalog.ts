import {
  findCatalogArtifact,
  PROVIDER_CLI_CATALOG,
  type ProviderCliCatalogArtifact,
  type ProviderCliCatalogEntry,
} from "../runtime/provider-cli/catalog.js";

export interface RunnerProviderCliPlan {
  readonly artifact: ProviderCliCatalogArtifact;
  readonly command: ProviderCliCatalogEntry["command"];
  readonly displayName: string;
  readonly entry: ProviderCliCatalogEntry;
  readonly managedArguments: readonly string[];
  readonly managedEnvironment: Readonly<Record<string, string>>;
  readonly probes: ProviderCliCatalogEntry["probes"];
  readonly provider: ProviderCliCatalogEntry["provider"];
  /** Anchored against the pinned CLI's reviewed `surfaceArgs` help banner; exit 0 alone never passes. */
  readonly surfacePattern: RegExp;
  readonly version: string;
}

/** Reviewed first-line banners of the pinned CLIs' surface help commands. */
const SURFACE_PATTERNS: Readonly<Record<string, RegExp>> = {
  "lark-cli": /^Message and group chat management$/m,
  slack: /^Call any Slack API method directly\.$/m,
};

/** Linux amd64 artifacts from the reviewed catalog — the only Slack/Lark pin for the Runner image. */
export function linuxAmd64ProviderCliPlans(
  catalog: readonly ProviderCliCatalogEntry[] = PROVIDER_CLI_CATALOG,
): readonly RunnerProviderCliPlan[] {
  return catalog.map((entry) => {
    const artifact = findCatalogArtifact(entry, "linux", "x64");
    if (!artifact) {
      throw new Error(`Provider CLI catalog has no linux/x64 artifact for ${entry.provider} ${entry.version}`);
    }
    const surfacePattern = SURFACE_PATTERNS[entry.command];
    if (!surfacePattern) throw new Error(`Provider CLI catalog has no reviewed surface pattern for ${entry.command}`);
    return {
      provider: entry.provider,
      command: entry.command,
      displayName: entry.displayName,
      version: entry.version,
      probes: entry.probes,
      managedEnvironment: entry.managedEnvironment,
      managedArguments: entry.managedArguments,
      artifact,
      entry,
      surfacePattern,
    };
  });
}
