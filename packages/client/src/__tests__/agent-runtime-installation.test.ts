import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  codexDesktopAppBinDirs,
  probeAgentRuntimeCliInstallations,
  resolveAgentRuntimeExecutable,
  wellKnownAgentRuntimeBinDirs,
} from "../runtime/agent-runtime-installation.js";
import { resolveOutsideProtectedRoots } from "../runtime/protected-paths.js";

describe("Agent Runtime CLI install-only discovery", () => {
  it("prefers PATH before well-known and desktop-app candidates", async () => {
    const attempts: string[] = [];
    const resolved = await resolveAgentRuntimeExecutable(
      "codex",
      "codex",
      { PATH: "/path/bin", HOME: "/home/u" },
      {
        access: async (path, mode) => {
          expect(mode).toBe(constants.X_OK);
          attempts.push(path);
          if (path !== "/path/bin/codex") throw new Error("missing");
        },
        realpath: async (path) => `/real${path}`,
        platform: "darwin",
        pathDelimiter: ":",
        wellKnownDirs: () => ["/well-known"],
        desktopAppDirs: () => ["/Applications/ChatGPT.app/Contents/Resources"],
        candidateAllowed: () => true,
      },
    );

    expect(attempts).toEqual(["/path/bin/codex"]);
    expect(resolved).toEqual({ provider: "codex", path: "/real/path/bin/codex", source: "path" });
  });

  it("finds Codex in the macOS desktop app after cheaper candidates miss", async () => {
    const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const resolved = await resolveAgentRuntimeExecutable(
      "codex",
      "codex",
      { PATH: "", HOME: "/home/u" },
      {
        access: async (path) => {
          if (path !== desktop) throw new Error("missing");
        },
        realpath: async (path) => path,
        platform: "darwin",
        wellKnownDirs: () => ["/well-known"],
        desktopAppDirs: () => ["/Applications/ChatGPT.app/Contents/Resources"],
        candidateAllowed: () => true,
      },
    );

    expect(resolved).toEqual({ provider: "codex", path: desktop, source: "desktop-app" });
  });

  it("does not use Codex desktop-app locations for Claude Code", async () => {
    const access = vi.fn(async (path: string) => {
      if (path.includes("ChatGPT.app")) return;
      throw new Error("missing");
    });

    await expect(
      resolveAgentRuntimeExecutable(
        "claude-code",
        "claude",
        { PATH: "", HOME: "/home/u" },
        {
          access,
          realpath: async (path) => path,
          platform: "darwin",
          wellKnownDirs: () => [],
          desktopAppDirs: () => ["/Applications/ChatGPT.app/Contents/Resources"],
          candidateAllowed: () => true,
        },
      ),
    ).rejects.toThrow("not installed");
    expect(access).not.toHaveBeenCalled();
  });

  it("skips automatic candidates rejected by the protected-path guard", async () => {
    const access = vi.fn(async () => undefined);
    const resolved = await resolveAgentRuntimeExecutable(
      "codex",
      "codex",
      { PATH: "/blocked:/safe", HOME: "/home/u" },
      {
        access,
        realpath: async (path) => path,
        platform: "darwin",
        pathDelimiter: ":",
        wellKnownDirs: () => [],
        desktopAppDirs: () => [],
        candidateAllowed: (path) => !path.startsWith("/blocked"),
      },
    );

    expect(access).toHaveBeenCalledOnce();
    expect(resolved.path).toBe("/safe/codex");
  });

  it("treats an explicit absolute path as operator-directed", async () => {
    const candidateAllowed = vi.fn(() => false);
    const resolved = await resolveAgentRuntimeExecutable(
      "claude-code",
      "/custom/claude",
      {},
      {
        access: async () => undefined,
        realpath: async (path) => path,
        candidateAllowed,
      },
    );

    expect(resolved.source).toBe("explicit");
    expect(candidateAllowed).not.toHaveBeenCalled();
  });

  it("reports both supported providers without launching either CLI", async () => {
    const access = vi.fn(async (path: string) => {
      if (path === "/bin/codex") return;
      throw new Error("missing");
    });
    const result = await probeAgentRuntimeCliInstallations({
      access,
      realpath: async (path) => path,
      environment: { PATH: "/bin", HOME: "/home/u" },
      platform: "linux",
      wellKnownDirs: () => [],
      desktopAppDirs: () => [],
      candidateAllowed: () => true,
    });

    expect(result).toEqual([
      { provider: "codex", displayName: "Codex CLI", installed: true, path: "/bin/codex", source: "path" },
      { provider: "claude-code", displayName: "Claude Code CLI", installed: false },
    ]);
  });
});

describe("First Tree-compatible install locations", () => {
  it("includes native and common global install locations", () => {
    expect(wellKnownAgentRuntimeBinDirs("/home/u", "darwin")).toEqual(
      expect.arrayContaining(["/home/u/.local/bin", "/home/u/.claude/local", "/opt/homebrew/bin"]),
    );
    expect(codexDesktopAppBinDirs("/home/u", "darwin")[0]).toBe("/Applications/ChatGPT.app/Contents/Resources");
    expect(codexDesktopAppBinDirs("/home/u", "linux")).toEqual([]);
  });

  it("rejects a symlink expansion into a protected root before following it", () => {
    const touched: string[] = [];
    const resolved = resolveOutsideProtectedRoots("/Users/u/.local/bin/codex", ["/Users/u/Documents"], (path) => {
      touched.push(path);
      if (path === "/Users/u/.local") return "/Users/u/Documents/tools";
      throw new Error("not a link");
    });

    expect(resolved).toBeNull();
    expect(touched).not.toContain("/Users/u/Documents");
  });
});
