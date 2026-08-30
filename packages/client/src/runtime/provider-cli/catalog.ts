import type { ProviderCliProvider } from "./types.js";

/**
 * Reviewed Provider CLI catalog.
 *
 * The catalog is the only source of managed-install truth: version, platform asset,
 * digests, size bounds, probe contract, and license are reviewed static data that ship
 * in an OpenTag release. Nothing here is fetched from a mutable remote `latest`
 * manifest. Probe contracts run without credentials and never call a provider API.
 *
 * Current entries were reviewed on 2026-08-30:
 * - lark-cli v1.0.92 archive digests match the upstream-published `checksums.txt` from
 *   https://github.com/larksuite/cli/releases/tag/v1.0.92; executable digests were
 *   computed from those verified archives.
 * - Slack CLI v4.7.0 archives were downloaded from the official
 *   https://downloads.slack-edge.com/slack-cli/ prefix (Slack publishes no checksum
 *   file); digests were computed from those archives.
 */
export interface ProviderCliProbeContract {
  /** Arguments that print the version, e.g. `["--version"]` or `["version"]`. */
  readonly versionArgs: readonly string[];
  /** Arguments proving the required command surface, e.g. `["im", "--help"]`. */
  readonly surfaceArgs: readonly string[];
  /** RegExp source whose first capture group is the semantic version. */
  readonly versionPattern: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ProviderCliCatalogArtifact {
  readonly platform: "darwin" | "linux";
  readonly arch: "arm64" | "x64";
  readonly archiveType: "tar.gz";
  /** Official artifact URL; the reviewed catalog is the trust root for this location. */
  readonly url: string;
  /** SHA-256 of the archive. */
  readonly sha256: string;
  /** Exact archive size; doubles as the bounded download limit. */
  readonly archiveBytes: number;
  /** Hard cap on the decompressed archive stream (decompression-bomb guard). */
  readonly maxExtractedBytes: number;
  /** Expected executable member path inside the archive (and below the version dir). */
  readonly executablePath: string;
  /** SHA-256 of the extracted executable; also the external `catalog-verified` trust digest. */
  readonly executableSha256: string;
  readonly executableBytes: number;
}

export interface ProviderCliCatalogEntry {
  readonly provider: ProviderCliProvider;
  /** Native command name visible to users and Agents. */
  readonly command: "lark-cli" | "slack";
  readonly displayName: string;
  /** Exact version a managed install publishes. */
  readonly version: string;
  /** Semver range an external candidate must satisfy to be compatible. */
  readonly compatibility: string;
  readonly probes: ProviderCliProbeContract;
  /** Update-check suppression applied by the launcher for managed targets only. */
  readonly managedEnvironment: Readonly<Record<string, string>>;
  /** Global flags the launcher prepends for managed targets only. */
  readonly managedArguments: readonly string[];
  readonly license: {
    readonly name: string;
    readonly copyright: string;
    readonly notices: string;
  };
  readonly artifacts: readonly ProviderCliCatalogArtifact[];
}

const MIB = 1024 * 1024;

const LARK_VERSION = "1.0.92";
const LARK_RELEASE_BASE = `https://github.com/larksuite/cli/releases/download/v${LARK_VERSION}`;

const SLACK_VERSION = "4.7.0";
const SLACK_RELEASE_BASE = `https://downloads.slack-edge.com/slack-cli`;

export const PROVIDER_CLI_CATALOG: readonly ProviderCliCatalogEntry[] = [
  {
    provider: "feishu",
    command: "lark-cli",
    displayName: "Feishu/Lark CLI",
    version: LARK_VERSION,
    compatibility: ">=1.0.0 <2.0.0",
    probes: {
      versionArgs: ["--version"],
      surfaceArgs: ["im", "--help"],
      versionPattern: "lark-cli version ([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)",
      timeoutMs: 10_000,
      maxOutputBytes: MIB,
    },
    managedEnvironment: {
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
    managedArguments: [],
    license: {
      name: "MIT",
      copyright: "Copyright (c) 2026 Lark Technologies Pte. Ltd.",
      notices: "lark-cli is published by Lark Technologies under the MIT License.",
    },
    artifacts: [
      {
        platform: "darwin",
        arch: "arm64",
        archiveType: "tar.gz",
        url: `${LARK_RELEASE_BASE}/lark-cli-${LARK_VERSION}-darwin-arm64.tar.gz`,
        sha256: "abb1b96eee5ad32da4e12f434e44d48a9e01ebb0e81772419ac0347f91c34265",
        archiveBytes: 13_799_162,
        maxExtractedBytes: 46_614_106 + 4 * MIB,
        executablePath: "lark-cli",
        executableSha256: "d98aa671fc74c3c47a6f6b350bb7f1f59d730399df8d86e890e1cbba00c1beec",
        executableBytes: 46_614_106,
      },
      {
        platform: "darwin",
        arch: "x64",
        archiveType: "tar.gz",
        url: `${LARK_RELEASE_BASE}/lark-cli-${LARK_VERSION}-darwin-amd64.tar.gz`,
        sha256: "421b36f95966028fb047231cb6351c4224a0fdcb076d2bc434d4aed1bb6d1891",
        archiveBytes: 14_949_574,
        maxExtractedBytes: 49_572_328 + 4 * MIB,
        executablePath: "lark-cli",
        executableSha256: "b7c125bb33e50fe6032adf6852be9a81ecd03d42ee3714a2a8ead964e0e6be2b",
        executableBytes: 49_572_328,
      },
      {
        platform: "linux",
        arch: "x64",
        archiveType: "tar.gz",
        url: `${LARK_RELEASE_BASE}/lark-cli-${LARK_VERSION}-linux-amd64.tar.gz`,
        sha256: "ef0e19799c1edd94eb52d3bb5d587e00d0a2898e0a4b407a1b8dc66d56181ef1",
        archiveBytes: 14_185_288,
        maxExtractedBytes: 47_866_018 + 4 * MIB,
        executablePath: "lark-cli",
        executableSha256: "0317b9a76b2d8e27c9e787d89294a922af13ec8caa7eb610531a7f184617bba0",
        executableBytes: 47_866_018,
      },
      {
        platform: "linux",
        arch: "arm64",
        archiveType: "tar.gz",
        url: `${LARK_RELEASE_BASE}/lark-cli-${LARK_VERSION}-linux-arm64.tar.gz`,
        sha256: "683546b6754c780e0f828e87cb00ccf7c0710798a9f1ddb8c6b956afbfb570ae",
        archiveBytes: 13_074_832,
        maxExtractedBytes: 44_630_178 + 4 * MIB,
        executablePath: "lark-cli",
        executableSha256: "22fe63fd7057044c80142e11792b3cd7989beaf435cdd4ecbfeacead837349e3",
        executableBytes: 44_630_178,
      },
    ],
  },
  {
    provider: "slack",
    command: "slack",
    displayName: "Slack CLI",
    version: SLACK_VERSION,
    compatibility: ">=4.0.0 <5.0.0",
    probes: {
      versionArgs: ["version"],
      surfaceArgs: ["api", "--help"],
      versionPattern: "Using slack v([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)",
      timeoutMs: 10_000,
      maxOutputBytes: MIB,
    },
    managedEnvironment: {},
    managedArguments: ["--skip-update"],
    license: {
      name: "Apache-2.0",
      copyright: "Copyright Slack Technologies, LLC",
      notices: "Slack CLI is published by Slack Technologies under the Apache License 2.0.",
    },
    artifacts: [
      {
        platform: "darwin",
        arch: "arm64",
        archiveType: "tar.gz",
        url: `${SLACK_RELEASE_BASE}/slack_cli_${SLACK_VERSION}_macOS_arm64.tar.gz`,
        sha256: "ccb6dc5910e06e8b12ff4d9690d015b72f8a81249ea716e8829dddddfd39d404",
        archiveBytes: 7_414_910,
        maxExtractedBytes: 20_181_840 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "61edbf3b490dc552fb223d623fbc10e01338db07043504f2cd01a6da349840aa",
        executableBytes: 20_181_840,
      },
      {
        platform: "darwin",
        arch: "x64",
        archiveType: "tar.gz",
        url: `${SLACK_RELEASE_BASE}/slack_cli_${SLACK_VERSION}_macOS_amd64.tar.gz`,
        sha256: "8a66be49be2e23cb19a08dc58fb1d7695eaad9b649556ea9a06a3f7c9b5142dc",
        archiveBytes: 8_265_622,
        maxExtractedBytes: 22_089_968 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "cdb7ba5142c07192dea457d3f13f6f828e20618713205e4236a636fe0a46281e",
        executableBytes: 22_089_968,
      },
      {
        platform: "linux",
        arch: "x64",
        archiveType: "tar.gz",
        url: `${SLACK_RELEASE_BASE}/slack_cli_${SLACK_VERSION}_linux_amd64.tar.gz`,
        sha256: "9d06c481bca07c1afffd106462e5ad3a8748334eb3b09aba3911a557673b5429",
        archiveBytes: 8_060_859,
        maxExtractedBytes: 21_401_762 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "54d9ea4405cea1fd9bb3803b1d243f699236d5ac2ae0fe8e2ac4c8a23cbb670f",
        executableBytes: 21_401_762,
      },
      {
        platform: "linux",
        arch: "arm64",
        archiveType: "tar.gz",
        url: `${SLACK_RELEASE_BASE}/slack_cli_${SLACK_VERSION}_linux_arm64.tar.gz`,
        sha256: "365834eda454783c6229a4cf5fe392df650d81a0465b8701c57b7c2a544db11a",
        archiveBytes: 7_281_730,
        maxExtractedBytes: 19_595_426 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "0024b00f1c6cf8a41fffaaf8d5feb7dee58b814dec37bea58242e243c7f3e2fa",
        executableBytes: 19_595_426,
      },
    ],
  },
];

export function findProviderCliCatalogEntry(
  provider: ProviderCliProvider,
  catalog: readonly ProviderCliCatalogEntry[] = PROVIDER_CLI_CATALOG,
): ProviderCliCatalogEntry | undefined {
  return catalog.find((entry) => entry.provider === provider);
}

export function requireProviderCliCatalogEntry(
  provider: ProviderCliProvider,
  catalog: readonly ProviderCliCatalogEntry[] = PROVIDER_CLI_CATALOG,
): ProviderCliCatalogEntry {
  const entry = findProviderCliCatalogEntry(provider, catalog);
  if (!entry) throw new Error(`The reviewed Provider CLI catalog has no entry for ${provider}`);
  return entry;
}

/** Find the reviewed artifact for one platform/architecture pair. */
export function findCatalogArtifact(
  entry: ProviderCliCatalogEntry,
  platform: NodeJS.Platform,
  arch: string,
): ProviderCliCatalogArtifact | undefined {
  return entry.artifacts.find((artifact) => artifact.platform === platform && artifact.arch === arch);
}

/** Every reviewed executable digest for a provider; backs `catalog-verified` trust. */
export function catalogExecutableDigests(entry: ProviderCliCatalogEntry): ReadonlySet<string> {
  return new Set(entry.artifacts.map((artifact) => artifact.executableSha256));
}
