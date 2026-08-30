import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wellKnownAgentRuntimeBinDirs } from "../runtime/agent-runtime-installation.js";
import { versionManagerBinDirs } from "../runtime/install-locations.js";

const NEVER_LISTED = (path: string): string[] => {
  throw new Error(`unexpected readdir: ${path}`);
};

const linux = { platform: "linux" as const, env: {} as NodeJS.ProcessEnv };

describe("versionManagerBinDirs", () => {
  it("returns the sole candidate when exactly one root holds exactly one version", () => {
    const home = "/home/u";
    const versions = join(home, ".nvm", "versions", "node");
    expect(
      versionManagerBinDirs(home, { ...linux, readDir: (path) => (path === versions ? ["v22.2.0"] : []) }),
    ).toEqual([join(versions, "v22.2.0", "bin")]);
  });

  it("contributes nothing from a root holding more than one version", () => {
    const home = "/home/u";
    const versions = join(home, ".local", "share", "fnm", "node-versions");
    expect(
      versionManagerBinDirs(home, {
        ...linux,
        readDir: (path) => (path === versions ? ["v20.11.0", "v22.2.0"] : []),
      }),
    ).toEqual([]);
  });

  it("fails closed globally when any scanned safe root has multiple versions even if another root is unique", () => {
    const home = "/home/u";
    const nvm = join(home, ".nvm", "versions", "node");
    const fnm = join(home, ".local", "share", "fnm", "node-versions");
    expect(
      versionManagerBinDirs(home, {
        ...linux,
        readDir: (path) => (path === nvm ? ["v20.11.0", "v22.2.0"] : path === fnm ? ["v18.0.0"] : []),
      }),
    ).toEqual([]);
  });

  it("contributes nothing when two roots each hold one version", () => {
    const home = "/home/u";
    const nvm = join(home, ".nvm", "versions", "node");
    const fnm = join(home, ".local", "share", "fnm", "node-versions");
    expect(
      versionManagerBinDirs(home, {
        ...linux,
        readDir: (path) => (path === nvm ? ["v22.2.0"] : path === fnm ? ["v18.0.0"] : []),
      }),
    ).toEqual([]);
  });

  it("uses only the active $FNM_DIR the shell reported, and only when it is unambiguous", () => {
    const home = "/home/u";
    const activeVersions = join("/opt/fnm", "node-versions");
    const staleNvm = join(home, ".nvm", "versions", "node");
    const readDir = (path: string): string[] =>
      path === activeVersions ? ["v20.11.0", "v22.2.0"] : path === staleNvm ? ["v18.0.0"] : [];

    expect(versionManagerBinDirs(home, { ...linux, readDir, active: { fnmDir: "/opt/fnm" } })).toEqual([]);
    expect(
      versionManagerBinDirs(home, {
        ...linux,
        readDir: (path) => (path === activeVersions ? ["v20.11.0"] : path === staleNvm ? ["v18.0.0"] : []),
        active: { fnmDir: "/opt/fnm" },
      }),
    ).toEqual([join(activeVersions, "v20.11.0", "installation", "bin")]);
  });

  it("takes $NVM_BIN as authoritative instead of enumerating nvm", () => {
    const home = "/home/u";
    const active = join(home, ".nvm", "versions", "node", "v20.11.0", "bin");
    expect(
      versionManagerBinDirs(home, {
        ...linux,
        readDir: () => ["v20.11.0", "v22.2.0"],
        active: { nvmBin: active },
      }),
    ).toEqual([active]);
  });

  it("fails closed when the shell reported both managers", () => {
    const home = "/home/u";
    const nvmBin = join(home, ".nvm", "versions", "node", "v20.11.0", "bin");
    const fnmVersions = join("/opt/fnm", "node-versions");
    expect(
      versionManagerBinDirs(home, {
        ...linux,
        readDir: (path) => (path === fnmVersions ? ["v18.0.0"] : []),
        active: { nvmBin, fnmDir: "/opt/fnm" },
      }),
    ).toEqual([]);
  });

  it("rejects relative active manager paths before any filesystem read", () => {
    const readDir = (path: string): string[] => {
      throw new Error(`must not inspect relative path: ${path}`);
    };
    expect(versionManagerBinDirs("/home/u", { ...linux, active: { fnmDir: "relative-fnm" }, readDir })).toEqual([]);
    expect(versionManagerBinDirs("/home/u", { ...linux, active: { nvmBin: "relative-nvm/bin" }, readDir })).toEqual([]);
  });

  it("returns nothing when no version manager is installed", () => {
    expect(
      versionManagerBinDirs("/home/u", {
        ...linux,
        readDir: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual([]);
  });

  it("keeps version dirs out of well-known dirs, whose precedence is above the login shell", () => {
    const dirs = wellKnownAgentRuntimeBinDirs("/home/u", "linux");
    expect(dirs.some((dir) => dir.includes(".nvm"))).toBe(false);
    expect(dirs.some((dir) => dir.includes("fnm"))).toBe(false);
  });
});

describe("versionManagerBinDirs protected-root vetting (macOS)", () => {
  function macHome(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ot-vm-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents"), { recursive: true });
    return home;
  }

  it("never lists a $FNM_DIR pointing into a protected folder", () => {
    const home = macHome();
    expect(
      versionManagerBinDirs(home, {
        platform: "darwin",
        home,
        readDir: NEVER_LISTED,
        env: { FNM_DIR: join(home, "Documents", "fnm") },
      }),
    ).toEqual([]);
  });

  it("never lists a default root symlinked into a protected folder", () => {
    const home = macHome();
    mkdirSync(join(home, "Documents", "nvm", "versions", "node"), { recursive: true });
    symlinkSync(join(home, "Documents", "nvm"), join(home, ".nvm"));
    expect(versionManagerBinDirs(home, { platform: "darwin", home, readDir: NEVER_LISTED, env: {} })).toEqual([]);
  });

  it("drops a version entry symlinked into a protected folder", () => {
    const home = macHome();
    const versions = join(home, ".nvm", "versions", "node");
    mkdirSync(versions, { recursive: true });
    mkdirSync(join(home, "Documents", "sneaky", "bin"), { recursive: true });
    symlinkSync(join(home, "Documents", "sneaky"), join(versions, "v23.0.0"));
    expect(
      versionManagerBinDirs(home, {
        platform: "darwin",
        home,
        readDir: (path) => (path === versions ? ["v23.0.0"] : []),
        env: {},
      }),
    ).toEqual([]);
  });
});
