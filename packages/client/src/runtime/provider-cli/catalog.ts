import type { ProviderCliProvider } from "./types.js";

/**
 * Reviewed Provider CLI catalog.
 *
 * The catalog is the only source of managed-install truth: version, platform asset,
 * digests, size bounds, probe contract, and license are reviewed static data that ship
 * in an OpenTag release. Nothing here is fetched from a mutable remote `latest`
 * manifest. Probe contracts run without credentials and never call a provider API.
 *
 * Reviewed sources:
 * - lark-cli v1.0.92 (2026-08-30) archive digests match the upstream-published `checksums.txt` from
 *   https://github.com/larksuite/cli/releases/tag/v1.0.92; executable digests were
 *   computed from those verified archives.
 * - Slack CLI v4.10.0 (2026-10-16) archive digests match GitHub release asset digests
 *   at https://github.com/slackapi/slack-cli/releases/tag/v4.10.0; executable digests
 *   were computed from those verified archives. Go 1.27 honors SSL_CERT_FILE on macOS
 *   (https://go.dev/doc/go1.27), required by the execution-local HTTPS proxy.
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

const SLACK_VERSION = "4.10.0";
const SLACK_RELEASE_BASE = `https://github.com/slackapi/slack-cli/releases/download/v${SLACK_VERSION}`;

export const PROVIDER_CLI_CATALOG: readonly ProviderCliCatalogEntry[] = [
  {
    provider: "feishu",
    command: "lark-cli",
    displayName: "Feishu/Lark CLI",
    version: LARK_VERSION,
    compatibility: ">=1.0.92 <2.0.0",
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
    compatibility: ">=4.10.0 <5.0.0",
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
        sha256: "0f897eee17ce549ba1f34c389c2591c32c191ce94eea15cd4b92053d8f35c80a",
        archiveBytes: 7_602_398,
        maxExtractedBytes: 20_527_104 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "c5052abde30361430c8cc294fcae24824bb5951ac1493f5a18871274496f78e6",
        executableBytes: 20_527_104,
      },
      {
        platform: "darwin",
        arch: "x64",
        archiveType: "tar.gz",
        url: `${SLACK_RELEASE_BASE}/slack_cli_${SLACK_VERSION}_macOS_amd64.tar.gz`,
        sha256: "1ae1db7c4da5e861e24ee4c0f09965829d0f7508a080f87692193678549b5895",
        archiveBytes: 8_490_341,
        maxExtractedBytes: 22_471_888 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "a270df6fc6287e04de933ec4da4372f705b8572e904ec4a9965604a5ae67fbaf",
        executableBytes: 22_471_888,
      },
      {
        platform: "linux",
        arch: "x64",
        archiveType: "tar.gz",
        url: `${SLACK_RELEASE_BASE}/slack_cli_${SLACK_VERSION}_linux_amd64.tar.gz`,
        sha256: "9772b17f70c4ec522ea6ae25545220dfe17d6afb5babe28fa1cd55a24b2abffa",
        archiveBytes: 8_257_319,
        maxExtractedBytes: 21_778_592 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "ff0e9711bb0ecbc7e0644488f5cffdac69b8f1f4cc7e5ab174b07fc979ab2dc2",
        executableBytes: 21_778_592,
      },
      {
        platform: "linux",
        arch: "arm64",
        archiveType: "tar.gz",
        url: `${SLACK_RELEASE_BASE}/slack_cli_${SLACK_VERSION}_linux_arm64.tar.gz`,
        sha256: "a930e089977e1138320efbe3bc49dc18f40d187bbbf4a9c7ff419c443bc52d30",
        archiveBytes: 7_430_050,
        maxExtractedBytes: 19_988_640 + 4 * MIB,
        executablePath: "bin/slack",
        executableSha256: "72355e94ca06b3264c98262c40e47dd7355d5d45b6c88ef8d2dabb43908020cc",
        executableBytes: 19_988_640,
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
