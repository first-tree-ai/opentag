import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeExecutableNotFoundError,
  canAdvanceRuntimeCandidate,
  iterateAgentRuntimeExecutables,
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
      searchDir: bin,
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
          includeLoginShell: false,
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
          includeLoginShell: false,
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
      includeLoginShell: false,
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
      includeLoginShell: false,
      platform: "linux",
      stat: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      wellKnownDirs: () => [],
    });

    expect(result.every((entry) => entry.status === "unknown")).toBe(true);
  });
});

describe("Agent Runtime CLI candidate sequence", () => {
  it("preserves source order and does not evaluate later layers after a hit", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const wellKnown = join(root, "well-known");
    const login = join(root, "login");
    const version = join(root, "version");
    const desktop = join(root, "desktop");
    await Promise.all([caller, wellKnown, login, version, desktop].map((dir) => mkdir(dir)));
    const executable = join(caller, "codex");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    const loginShellPathDirs = vi.fn(async () => [login]);
    const versionManagerDirs = vi.fn(() => [version]);
    const desktopAppDirs = vi.fn(() => [desktop]);

    await expect(
      resolveAgentRuntimeExecutable(
        "codex",
        "codex",
        { PATH: caller },
        {
          candidateAllowed: () => true,
          desktopAppDirs,
          home: root,
          includeLoginShell: true,
          loginShellPathDirs,
          platform: "linux",
          versionManagerDirs,
          wellKnownDirs: () => [wellKnown],
        },
      ),
    ).resolves.toMatchObject({ path: await realpath(executable), source: "caller-path" });
    expect(loginShellPathDirs).not.toHaveBeenCalled();
    expect(versionManagerDirs).not.toHaveBeenCalled();
    expect(desktopAppDirs).not.toHaveBeenCalled();
  });

  it("yields later sources only when the consumer asks for the next candidate", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const wellKnown = join(root, "well-known");
    const login = join(root, "login");
    const version = join(root, "version");
    const desktop = join(root, "desktop");
    await Promise.all([caller, wellKnown, login, version, desktop].map((dir) => mkdir(dir)));
    await Promise.all(
      [caller, wellKnown, login, version, desktop].map((dir) =>
        writeFile(join(dir, "codex"), "#!/bin/sh\n", { mode: 0o700 }),
      ),
    );
    const loginShellPathDirs = vi.fn(async () => [login]);
    const versionManagerDirs = vi.fn(() => [version]);
    const desktopAppDirs = vi.fn(() => [desktop]);
    const iterator = iterateAgentRuntimeExecutables(
      "codex",
      "codex",
      { PATH: caller },
      {
        candidateAllowed: () => true,
        desktopAppDirs,
        home: root,
        includeLoginShell: true,
        loginShellPathDirs,
        platform: "linux",
        versionManagerDirs,
        wellKnownDirs: () => [wellKnown],
      },
    );
    await expect(iterator.next()).resolves.toMatchObject({ value: { source: "caller-path" } });
    expect(loginShellPathDirs).not.toHaveBeenCalled();
    expect(desktopAppDirs).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toMatchObject({ value: { source: "well-known" } });
    expect(loginShellPathDirs).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toMatchObject({ value: { source: "desktop-app" } });
    expect(desktopAppDirs).toHaveBeenCalledOnce();
    expect(loginShellPathDirs).not.toHaveBeenCalled();
    await expect(iterator.next()).resolves.toMatchObject({ value: { source: "login-shell" } });
    expect(loginShellPathDirs).toHaveBeenCalledOnce();
    expect(versionManagerDirs).toHaveBeenCalledOnce();
    await expect(iterator.next()).resolves.toMatchObject({ value: { source: "version-manager" } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("keeps an absolute explicit command as a single candidate without fallback sources", async () => {
    const root = await temporaryRoot();
    const explicit = join(root, "explicit-codex");
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(explicit, "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(join(other, "codex"), "#!/bin/sh\n", { mode: 0o700 });
    const loginShellPathDirs = vi.fn(async () => [other]);
    const iterator = iterateAgentRuntimeExecutables(
      "codex",
      explicit,
      { PATH: other },
      {
        candidateAllowed: () => true,
        desktopAppDirs: () => [other],
        home: root,
        includeLoginShell: true,
        loginShellPathDirs,
        platform: "linux",
        wellKnownDirs: () => [other],
      },
    );
    await expect(iterator.next()).resolves.toMatchObject({
      value: { path: await realpath(explicit), source: "explicit" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(loginShellPathDirs).not.toHaveBeenCalled();
  });

  it("skips login-shell and version-manager layers on the pre-connect path", async () => {
    const root = await temporaryRoot();
    const login = join(root, "login");
    await mkdir(login);
    await writeFile(join(login, "codex"), "#!/bin/sh\n", { mode: 0o700 });
    const loginShellPathDirs = vi.fn(async () => [login]);
    const versionManagerDirs = vi.fn(() => [login]);
    await expect(
      resolveAgentRuntimeExecutable(
        "codex",
        "codex",
        { PATH: "" },
        {
          candidateAllowed: () => true,
          desktopAppDirs: () => [],
          home: root,
          includeLoginShell: false,
          loginShellPathDirs,
          platform: "linux",
          versionManagerDirs,
          wellKnownDirs: () => [],
        },
      ),
    ).rejects.toBeInstanceOf(AgentRuntimeExecutableNotFoundError);
    expect(loginShellPathDirs).not.toHaveBeenCalled();
    expect(versionManagerDirs).not.toHaveBeenCalled();
  });

  it("labels a login-shell hit after cheap sources miss", async () => {
    const root = await temporaryRoot();
    const login = join(root, "login");
    await mkdir(login);
    const executable = join(login, "claude");
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
          includeLoginShell: true,
          loginShellPathDirs: async () => [login],
          platform: "linux",
          versionManagerDirs: () => [],
          wellKnownDirs: () => [],
        },
      ),
    ).resolves.toMatchObject({ path: await realpath(executable), source: "login-shell" });
  });

  it("keeps the existing desktop-app source ahead of the expensive login-shell layer", async () => {
    const root = await temporaryRoot();
    const desktop = join(root, "desktop");
    await mkdir(desktop);
    const executable = join(desktop, "codex");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    await expect(
      resolveAgentRuntimeExecutable(
        "codex",
        "codex",
        { PATH: "" },
        {
          candidateAllowed: () => true,
          desktopAppDirs: () => [desktop],
          home: root,
          includeLoginShell: true,
          loginShellPathDirs: () => {
            throw new Error("login shell must remain lazy after a cheap desktop hit");
          },
          platform: "linux",
          versionManagerDirs: () => [],
          wellKnownDirs: () => [],
        },
      ),
    ).resolves.toMatchObject({ path: await realpath(executable), source: "desktop-app" });
  });

  it("deduplicates the same canonical executable reached through a symlink or a later source", async () => {
    const root = await temporaryRoot();
    const caller = join(root, "caller");
    const alias = join(root, "alias");
    const wellKnown = join(root, "well-known");
    await mkdir(caller);
    await mkdir(alias);
    await mkdir(wellKnown);
    const executable = join(caller, "codex");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    await symlink(executable, join(alias, "codex"));
    await symlink(executable, join(wellKnown, "codex"));
    const yielded: string[] = [];
    for await (const candidate of iterateAgentRuntimeExecutables(
      "codex",
      "codex",
      { PATH: `${caller}${delimiter}${alias}` },
      {
        candidateAllowed: () => true,
        desktopAppDirs: () => [],
        home: root,
        includeLoginShell: false,
        platform: "linux",
        wellKnownDirs: () => [wellKnown],
      },
    )) {
      yielded.push(candidate.path);
    }
    expect(yielded).toEqual([await realpath(executable)]);
  });
});

describe("same-Provider candidate fallback taxonomy", () => {
  it("advances only when every issue is artifact_missing or version_incompatible", () => {
    expect(canAdvanceRuntimeCandidate({ ready: false, issues: [{ code: "artifact_missing" }] })).toBe(true);
    expect(
      canAdvanceRuntimeCandidate({
        ready: false,
        issues: [{ code: "version_incompatible" }, { code: "artifact_missing" }],
      }),
    ).toBe(true);
  });

  it("never advances on ready, empty, mixed, credential, configuration, or transient results", () => {
    expect(canAdvanceRuntimeCandidate({ ready: true, issues: [] })).toBe(false);
    expect(canAdvanceRuntimeCandidate({ ready: false, issues: [] })).toBe(false);
    expect(canAdvanceRuntimeCandidate({ ready: false, issues: [{ code: "credential_missing" }] })).toBe(false);
    expect(canAdvanceRuntimeCandidate({ ready: false, issues: [{ code: "configuration_invalid" }] })).toBe(false);
    expect(canAdvanceRuntimeCandidate({ ready: false, issues: [{ code: "temporarily_unavailable" }] })).toBe(false);
    expect(
      canAdvanceRuntimeCandidate({
        ready: false,
        issues: [{ code: "version_incompatible" }, { code: "credential_missing" }],
      }),
    ).toBe(false);
    expect(canAdvanceRuntimeCandidate({ ready: false, issues: [{ code: "other" }] })).toBe(false);
  });
});

function emptyAutomaticLocations(home: string) {
  return {
    candidateAllowed: () => true,
    desktopAppDirs: () => [],
    home,
    includeLoginShell: false,
    platform: "linux" as const,
    wellKnownDirs: () => [],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-runtime-installation-"));
  temporaryRoots.push(root);
  return root;
}
