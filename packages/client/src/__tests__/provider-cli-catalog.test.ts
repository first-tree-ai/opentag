import semver from "semver";
import { describe, expect, it } from "vitest";
import {
  catalogExecutableDigests,
  findCatalogArtifact,
  PROVIDER_CLI_CATALOG,
  providerCliArtifactId,
  providerCliVersionDirPath,
  requireProviderCliCatalogEntry,
  resolveAccountHome,
  resolveProviderCliAccountLayout,
} from "../index.js";

const SHA256 = /^[0-9a-f]{64}$/;

describe("PROVIDER_CLI_CATALOG", () => {
  it("covers feishu and slack with the documented probe contracts", () => {
    const feishu = requireProviderCliCatalogEntry("feishu");
    expect(feishu.command).toBe("lark-cli");
    expect(feishu.probes.versionArgs).toEqual(["--version"]);
    expect(feishu.probes.surfaceArgs).toEqual(["im", "--help"]);
    const slack = requireProviderCliCatalogEntry("slack");
    expect(slack.command).toBe("slack");
    expect(slack.compatibility).toBe(">=4.2.0 <5.0.0");
    expect(slack.probes.versionArgs).toEqual(["version"]);
    expect(slack.probes.surfaceArgs).toEqual(["api", "--help"]);
    expect(slack.managedArguments).toEqual(["--skip-update"]);
  });

  it("pins reviewed digests, size bounds, and https URLs for every P0 platform", () => {
    for (const entry of PROVIDER_CLI_CATALOG) {
      expect(semver.valid(entry.version)).toBeTruthy();
      expect(semver.satisfies(entry.version, entry.compatibility)).toBe(true);
      for (const platform of ["darwin", "linux"] as const) {
        for (const arch of ["arm64", "x64"] as const) {
          const artifact = findCatalogArtifact(entry, platform, arch);
          expect(artifact, `${entry.provider} ${platform}/${arch}`).toBeDefined();
          if (!artifact) continue;
          expect(artifact.url.startsWith("https://")).toBe(true);
          expect(artifact.sha256).toMatch(SHA256);
          expect(artifact.executableSha256).toMatch(SHA256);
          expect(artifact.archiveBytes).toBeGreaterThan(1024);
          expect(artifact.executableBytes).toBeGreaterThan(1024);
          expect(artifact.maxExtractedBytes).toBeGreaterThan(artifact.executableBytes);
          expect(artifact.executablePath.length).toBeGreaterThan(0);
          expect(artifact.executablePath.startsWith("/")).toBe(false);
        }
      }
      // Version patterns capture a valid semver from the documented probe output.
      const pattern = new RegExp(entry.probes.versionPattern);
      const sample =
        entry.provider === "feishu" ? `lark-cli version ${entry.version}` : `Using slack v${entry.version}`;
      expect(pattern.exec(sample)?.[1]).toBe(entry.version);
    }
  });

  it("exposes executable digests for catalog-verified trust", () => {
    const feishu = requireProviderCliCatalogEntry("feishu");
    expect(catalogExecutableDigests(feishu).size).toBe(feishu.artifacts.length);
  });
});

describe("account layout", () => {
  it("derives the account-global root from the account home, never the environment", () => {
    const layout = resolveProviderCliAccountLayout("/home/alice");
    expect(layout.root).toBe("/home/alice/.opentag/provider-cli");
    expect(layout.bin).toBe("/home/alice/.opentag/provider-cli/bin");
    expect(layout.publicBinDir).toBe("/home/alice/.local/bin");
    expect(layout.plans).toBe("/home/alice/.opentag/provider-cli/plans");
  });

  it("reserves the Windows layout without claiming support", () => {
    const layout = resolveProviderCliAccountLayout("C:\\\\Users\\\\alice", "win32");
    expect(layout.root).toContain("OpenTag");
  });

  it("builds digest-addressed artifact ids and version directories", () => {
    const layout = resolveProviderCliAccountLayout("/home/alice");
    const artifact = findCatalogArtifact(requireProviderCliCatalogEntry("slack"), "linux", "x64");
    if (!artifact) throw new Error("missing artifact");
    const id = providerCliArtifactId(artifact, "4.7.0");
    expect(id).toBe(`4.7.0/linux-x64/${artifact.sha256}`);
    expect(providerCliVersionDirPath(layout, "slack", id)).toBe(
      `/home/alice/.opentag/provider-cli/versions/slack/4.7.0/linux-x64/${artifact.sha256}`,
    );
  });

  it("resolves the account home from the OS account record", () => {
    expect(resolveAccountHome({ homedir: "/home/bob" })).toBe("/home/bob");
    expect(() => resolveAccountHome({ homedir: "" })).toThrow();
    expect(() => resolveAccountHome({ homedir: "relative" })).toThrow();
  });

  it("rejects a relative account home in the injectable layout boundary", () => {
    expect(() => resolveProviderCliAccountLayout("relative/home")).toThrow();
  });
});
