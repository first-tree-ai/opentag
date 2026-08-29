import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeExecutableNotFoundError,
  probeAgentRuntimeCliInstallations,
  resolveAgentRuntimeExecutable,
} from "../runtime/agent-runtime-installation.js";
import { automaticCandidateAllowed } from "../runtime/protected-paths.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Agent Runtime CLI installation discovery", () => {
  it("reports a canonical ordinary executable found on caller PATH", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    const executable = join(bin, "codex");
    await mkdir(bin);
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

    await expect(
      resolveAgentRuntimeExecutable("codex", "codex", { PATH: bin }, emptyAutomaticLocations(root)),
    ).resolves.toEqual({
      path: await realpath(executable),
      provider: "codex",
      source: "caller-path",
    });
  });

  it("does not treat an executable directory as an installed Runtime CLI", async () => {
    const root = await temporaryRoot();
    const directoryNamedCodex = join(root, "bin", "codex");
    await mkdir(directoryNamedCodex, { mode: 0o700, recursive: true });
    await chmod(directoryNamedCodex, 0o700);

    await expect(
      resolveAgentRuntimeExecutable("codex", "codex", { PATH: join(root, "bin") }, emptyAutomaticLocations(root)),
    ).rejects.toBeInstanceOf(AgentRuntimeExecutableNotFoundError);
  });

  it("does not treat a non-executable file or broken link as an installed Runtime CLI", async () => {
    const root = await temporaryRoot();
    const nonExecutableBin = join(root, "non-executable-bin");
    const brokenLinkBin = join(root, "broken-link-bin");
    await Promise.all([mkdir(nonExecutableBin), mkdir(brokenLinkBin)]);
    await writeFile(join(nonExecutableBin, "codex"), "#!/bin/sh\n", { mode: 0o600 });
    await symlink(join(root, "missing-codex"), join(brokenLinkBin, "codex"));

    for (const bin of [nonExecutableBin, brokenLinkBin]) {
      await expect(
        resolveAgentRuntimeExecutable("codex", "codex", { PATH: bin }, emptyAutomaticLocations(root)),
      ).rejects.toBeInstanceOf(AgentRuntimeExecutableNotFoundError);
    }
  });

  it("labels a reviewed installation directory as well-known", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "reviewed-bin");
    const executable = join(bin, "claude");
    await mkdir(bin);
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

    await expect(
      resolveAgentRuntimeExecutable(
        "claude-code",
        "claude",
        { PATH: "" },
        {
          candidateAllowed: () => true,
          desktopAppDirs: () => [],
          home: root,
          platform: "linux",
          wellKnownDirs: () => [bin],
        },
      ),
    ).resolves.toMatchObject({ path: await realpath(executable), source: "well-known" });
  });

  it("rejects a protected automatic candidate before any path-following filesystem read", async () => {
    const stat = vi.fn();
    const access = vi.fn();
    const resolvePath = vi.fn();
    const protectedBin = "/Users/alice/Documents/runtime-bin";

    await expect(
      resolveAgentRuntimeExecutable(
        "codex",
        "codex",
        { PATH: protectedBin },
        {
          access,
          candidateAllowed: () => false,
          desktopAppDirs: () => [],
          home: "/Users/alice",
          platform: "darwin",
          realpath: resolvePath,
          stat,
          wellKnownDirs: () => [],
        },
      ),
    ).rejects.toBeInstanceOf(AgentRuntimeExecutableNotFoundError);

    expect(stat).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("rejects a candidate whose symlink chain enters a macOS protected root", () => {
    const visited: string[] = [];
    const readLink = (path: string): string => {
      visited.push(path);
      if (path === "/safe/runtime-bin") return "/Users/alice/Documents/runtime-bin";
      throw Object.assign(new Error("not a symlink"), { code: "EINVAL" });
    };

    expect(
      automaticCandidateAllowed("/safe/runtime-bin/codex", {
        home: "/Users/alice",
        platform: "darwin",
        readLink,
      }),
    ).toBe(false);
    expect(visited).toContain("/safe/runtime-bin");
    expect(visited.some((path) => path.startsWith("/Users/alice/Documents"))).toBe(false);
  });

  it("keeps one installed Provider when the other detector cannot determine its state", async () => {
    const options = {
      access: vi.fn().mockResolvedValue(undefined),
      candidateAllowed: () => true,
      commands: { "claude-code": "claude", codex: "codex" },
      desktopAppDirs: () => [],
      environment: { PATH: `/runtime${delimiter}/unused` },
      home: "/home/alice",
      platform: "linux" as const,
      realpath: vi.fn(async (path: string) => path),
      stat: vi.fn(async (path: string) => {
        if (path === "/runtime/codex") throw Object.assign(new Error("I/O failure"), { code: "EIO" });
        if (path === "/runtime/claude") return { isFile: () => true };
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
      wellKnownDirs: () => [],
    };

    await expect(probeAgentRuntimeCliInstallations(options)).resolves.toEqual([
      {
        detail: "A Runtime candidate could not be inspected safely",
        displayName: "Codex CLI",
        provider: "codex",
        status: "unknown",
      },
      {
        displayName: "Claude Code CLI",
        path: "/runtime/claude",
        provider: "claude-code",
        source: "caller-path",
        status: "installed",
      },
    ]);
  });

  it("does not collapse an inaccessible candidate into not-installed", async () => {
    const result = await probeAgentRuntimeCliInstallations({
      candidateAllowed: () => true,
      desktopAppDirs: () => [],
      environment: { PATH: "/runtime" },
      home: "/home/alice",
      platform: "linux",
      stat: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      wellKnownDirs: () => [],
    });

    expect(result.every((entry) => entry.status === "unknown")).toBe(true);
  });
});

function emptyAutomaticLocations(home: string) {
  return {
    candidateAllowed: () => true,
    desktopAppDirs: () => [],
    home,
    platform: "linux" as const,
    wellKnownDirs: () => [],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-runtime-installation-"));
  temporaryRoots.push(root);
  return root;
}
