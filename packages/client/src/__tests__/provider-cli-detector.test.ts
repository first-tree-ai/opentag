import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Real child-process detection needs headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import {
  computeFileIdentity,
  detectProviderCliCandidates,
  type ProviderCliDetectOptions,
  rankProviderCliCandidates,
  readProviderCliSelection,
  requireProviderCliCatalogEntry,
  resolveProviderCliAccountLayout,
  verifyProviderCliCandidateFingerprint,
  writeProviderCliSelection,
} from "../index.js";
import { fakeCliScript, makeTempDir, sha256Hex, writeFakeCli } from "./fixtures/provider-cli.js";

const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";

const LARK = requireProviderCliCatalogEntry("feishu");

async function makeContext(
  prefix = "opentag-detector-",
): Promise<{ accountHome: string; layout: ReturnType<typeof resolveProviderCliAccountLayout> }> {
  const accountHome = await makeTempDir(prefix);
  return { accountHome, layout: resolveProviderCliAccountLayout(accountHome) };
}

function detectOptions(
  context: { accountHome: string; layout: ReturnType<typeof resolveProviderCliAccountLayout> },
  pathDirs: readonly string[],
  overrides: Partial<ProviderCliDetectOptions> = {},
): ProviderCliDetectOptions {
  return {
    provider: "feishu",
    entry: LARK,
    layout: context.layout,
    env: { PATH: pathDirs.join(":") },
    platform: PLATFORM,
    arch: ARCH,
    selection: undefined,
    mode: "auto",
    ...overrides,
  };
}

describe("detectProviderCliCandidates", () => {
  it("finds nothing when PATH has no provider command", async () => {
    const context = await makeContext();
    const empty = join(context.accountHome, "bin");
    await mkdir(empty);
    const detection = await detectProviderCliCandidates(detectOptions(context, [empty]));
    expect(detection.candidates).toEqual([]);
    expect(detection.ignored).toEqual([]);
  });

  it("detects one compatible external candidate with unverified trust", async () => {
    const context = await makeContext();
    const bin = join(context.accountHome, "bin");
    await writeFakeCli(bin, "feishu", { version: "1.0.92" });
    const detection = await detectProviderCliCandidates(detectOptions(context, [bin]));
    expect(detection.ignored).toEqual([]);
    expect(detection.candidates).toHaveLength(1);
    const candidate = detection.candidates[0];
    expect(candidate?.kind).toBe("external");
    expect(candidate?.version).toBe("1.0.92");
    expect(candidate?.trust).toBe("compatible-unverified");
    expect(candidate?.pathRank).toBe(0);
    expect(candidate?.fingerprint.startsWith("v1:")).toBe(true);
  });

  it("marks a digest-matching candidate catalog-verified", async () => {
    const context = await makeContext();
    const bin = join(context.accountHome, "bin");
    const content = fakeCliScript("feishu", { version: "1.0.92" });
    await writeFakeCli(bin, "feishu", { version: "1.0.92" });
    const digest = sha256Hex(content);
    const entry = {
      ...LARK,
      artifacts: LARK.artifacts.map((artifact) => ({ ...artifact, executableSha256: digest })),
    };
    const detection = await detectProviderCliCandidates(detectOptions(context, [bin], { entry }));
    expect(detection.candidates[0]?.trust).toBe("catalog-verified");
  });

  it("ignores relative, empty, and world-writable PATH entries", async () => {
    const context = await makeContext();
    const unsafe = join(context.accountHome, "unsafe-bin");
    await writeFakeCli(unsafe, "feishu", { version: "1.0.92" });
    await chmod(unsafe, 0o777);
    const detection = await detectProviderCliCandidates(detectOptions(context, ["relative-bin", ".", unsafe]));
    expect(detection.candidates).toEqual([]);
    const reasons = detection.ignored.map((entry) => entry.reason);
    expect(reasons).toContain("relative-path-entry");
    expect(reasons).toContain("world-writable-path-entry");
  });

  it("ignores world-writable candidate files", async () => {
    const context = await makeContext();
    const bin = join(context.accountHome, "bin");
    const target = await writeFakeCli(bin, "feishu", { version: "1.0.92" });
    await chmod(target, 0o777);
    const detection = await detectProviderCliCandidates(detectOptions(context, [bin]));
    expect(detection.candidates).toEqual([]);
    expect(detection.ignored.map((entry) => entry.reason)).toEqual(["world-writable"]);
  });

  it("ignores unparseable, incompatible, and probe-failing candidates", async () => {
    const context = await makeContext();
    const badVersion = join(context.accountHome, "bad-version");
    await writeFakeCli(badVersion, "feishu", { version: "0.0.0", versionOutput: "totally not a version" });
    const oldVersion = join(context.accountHome, "old-version");
    await writeFakeCli(oldVersion, "feishu", { version: "0.9.0" });
    const failing = join(context.accountHome, "failing");
    await writeFakeCli(failing, "feishu", { version: "1.0.92", surfaceExit: 3 });
    const detection = await detectProviderCliCandidates(detectOptions(context, [badVersion, oldVersion, failing]));
    expect(detection.candidates).toEqual([]);
    const reasons = detection.ignored.map((entry) => entry.reason).sort();
    expect(reasons).toEqual(["probe-failed", "unparseable-version", "version-incompatible"]);
  });

  it("ignores candidates built for another platform or architecture", async () => {
    const context = await makeContext();
    const bin = join(context.accountHome, "bin");
    await mkdir(bin, { recursive: true });
    // A Mach-O arm64 header never runs on Linux; an ELF never runs on macOS.
    const foreign =
      PLATFORM === "darwin"
        ? "7f454c4602010100000000000000000002003e0001000000600d4900000000004000000000000000900100"
        : "cffaedfe0c0000010000000002000000110000006008000004002000000000001900000048000000";
    const bytes = new Uint8Array(foreign.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(foreign.slice(index * 2, index * 2 + 2), 16);
    }
    const target = join(bin, "lark-cli");
    await writeFile(target, bytes, { mode: 0o755 });
    await chmod(target, 0o755);
    const detection = await detectProviderCliCandidates(detectOptions(context, [bin]));
    expect(detection.candidates).toEqual([]);
    expect(detection.ignored.map((entry) => entry.reason)).toEqual(["wrong-platform-architecture"]);
  });

  it("deduplicates candidates by canonical path across symlinked PATH entries", async () => {
    const context = await makeContext();
    const real = join(context.accountHome, "real-bin");
    await writeFakeCli(real, "feishu", { version: "1.0.92" });
    const alias = join(context.accountHome, "alias-bin");
    await symlink(real, alias);
    const detection = await detectProviderCliCandidates(detectOptions(context, [real, alias]));
    expect(detection.candidates).toHaveLength(1);
  });

  it("includes the current selection even when it is not on PATH", async () => {
    const context = await makeContext();
    const outside = join(context.accountHome, "outside-bin");
    await writeFakeCli(outside, "feishu", { version: "1.0.92" });
    const empty = join(context.accountHome, "empty-bin");
    await mkdir(empty);

    // First detection learns the fingerprint, then persists the selection.
    const first = await detectProviderCliCandidates(detectOptions(context, [outside]));
    const candidate = first.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    await writeProviderCliSelection(
      context.layout,
      "feishu",
      {
        kind: "external",
        executablePath: candidate.path,
        fingerprint: candidate.fingerprint,
        trust: candidate.trust,
        version: candidate.version,
      },
      undefined,
      new Date("2026-08-30T00:00:00Z"),
    );

    const selection = await readProviderCliSelection(context.layout, "feishu");
    const detection = await detectProviderCliCandidates(detectOptions(context, [empty], { selection }));
    expect(detection.candidates).toHaveLength(1);
    expect(detection.candidates[0]?.incumbent).toBe(true);
    expect(detection.candidates[0]?.pathRank).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("never offers the account-global launcher as an external candidate", async () => {
    const context = await makeContext();
    // Simulate a managed installation: launcher inside the OpenTag bin dir on PATH.
    const launcherDir = context.layout.bin;
    await mkdir(launcherDir, { recursive: true });
    await writeFile(join(launcherDir, "lark-cli"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(join(launcherDir, "lark-cli"), 0o755);
    const detection = await detectProviderCliCandidates(detectOptions(context, [launcherDir]));
    expect(detection.candidates).toEqual([]);
    expect(detection.ignored).toEqual([]);
  });

  it("ignores PATH entries under macOS protected roots", async () => {
    const context = await makeContext();
    const protectedDir = join(context.accountHome, "Desktop", "bin");
    await writeFakeCli(protectedDir, "feishu", { version: "1.0.92" });
    const detection = await detectProviderCliCandidates(detectOptions(context, [protectedDir]));
    if (PLATFORM === "darwin") {
      expect(detection.candidates).toEqual([]);
      expect(detection.ignored.map((entry) => entry.reason)).toEqual(["protected-path-entry"]);
    } else {
      // Protected roots are a macOS concept; other platforms have none.
      expect(detection.candidates).toHaveLength(1);
    }
  });

  it("skips PATH scanning entirely in managed-only mode", async () => {
    const context = await makeContext();
    const bin = join(context.accountHome, "bin");
    await writeFakeCli(bin, "feishu", { version: "1.0.92" });
    const detection = await detectProviderCliCandidates(detectOptions(context, [bin], { mode: "managed-only" }));
    expect(detection.candidates).toEqual([]);
  });
});

describe("rankProviderCliCandidates", () => {
  const candidate = (
    id: string,
    version: string,
    trust: "catalog-verified" | "compatible-unverified" = "compatible-unverified",
    pathRank = 0,
    incumbent = false,
  ) => ({
    id,
    provider: "feishu" as const,
    kind: "external" as const,
    path: `/bin/${id}`,
    sourceDir: "/bin",
    version,
    trust,
    fingerprint: `v1:${id}`,
    pathRank,
    incumbent,
  });

  it("orders newest compatible version first", () => {
    const { ordered, reasons } = rankProviderCliCandidates([
      candidate("old", "1.0.90"),
      candidate("new", "1.0.92"),
      candidate("mid", "1.0.91"),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["new", "mid", "old"]);
    expect(reasons.get("new")).toBe("newest compatible version");
    expect(reasons.get("mid")).toBe("older compatible version");
  });

  it("prefers catalog-verified over compatible-unverified at the same version", () => {
    const { ordered, reasons } = rankProviderCliCandidates([
      candidate("unverified", "1.0.92", "compatible-unverified", 0),
      candidate("verified", "1.0.92", "catalog-verified", 1),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["verified", "unverified"]);
    expect(reasons.get("verified")).toBe("catalog-verified trust");
  });

  it("prefers the incumbent, then PATH order, for full ties", () => {
    const { ordered: byIncumbent } = rankProviderCliCandidates([
      candidate("other", "1.0.92", "compatible-unverified", 0),
      candidate("incumbent", "1.0.92", "compatible-unverified", 5, true),
    ]);
    expect(byIncumbent[0]?.id).toBe("incumbent");

    const { ordered, reasons } = rankProviderCliCandidates([
      candidate("second", "1.0.92", "compatible-unverified", 7),
      candidate("first", "1.0.92", "compatible-unverified", 2),
    ]);
    expect(ordered[0]?.id).toBe("first");
    expect(reasons.get("first")).toBe("first in PATH");
    expect(reasons.get("second")).toBe("same version, later in PATH");
  });

  it("orders by semantic version, including prereleases", () => {
    const { ordered } = rankProviderCliCandidates([candidate("stable", "1.0.92"), candidate("pre", "1.0.93-beta.1")]);
    expect(ordered.map((entry) => entry.id)).toEqual(["pre", "stable"]);
  });
});

describe("verifyProviderCliCandidateFingerprint", () => {
  it("accepts an unchanged candidate and rejects a replaced one", async () => {
    const context = await makeContext();
    const bin = join(context.accountHome, "bin");
    const target = await writeFakeCli(bin, "feishu", { version: "1.0.92" });
    const detection = await detectProviderCliCandidates(detectOptions(context, [bin]));
    const candidate = detection.candidates[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(await verifyProviderCliCandidateFingerprint(candidate)).toBe(true);
    await writeFile(
      target,
      fakeCliScript("feishu", { version: "1.0.92", versionOutput: "lark-cli version 1.0.92 patched" }),
      {
        mode: 0o755,
      },
    );
    expect(await verifyProviderCliCandidateFingerprint(candidate)).toBe(false);
  });
});

describe("computeFileIdentity", () => {
  it("rejects an executable larger than its identity bound", async () => {
    const directory = await makeTempDir("opentag-fingerprint-");
    const path = join(directory, "lark-cli");
    await writeFile(path, "too-large", { mode: 0o755 });
    await expect(computeFileIdentity(path, 4)).rejects.toMatchObject({ code: "too-large" });
  });
});
