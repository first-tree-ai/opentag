import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProbeScript,
  defaultRunShell,
  getLoginShellPathDirs,
  LOGIN_SHELL_ENV_DELIM,
  LOGIN_SHELL_PATH_DELIM,
  LOGIN_SHELL_PROBE_KILL_SIGNAL,
  LOGIN_SHELL_PROBE_MAX_ATTEMPTS,
  LOGIN_SHELL_PROBE_MAX_STDOUT_BYTES,
  LOGIN_SHELL_PROBE_TIMEOUT_MS,
  probeLoginShellPath,
  type RunShell,
  resetLoginShellPathDirsCache,
} from "../runtime/login-shell-path.js";

function wrap(dirs: string[], env: { fnmDir?: string; nvmBin?: string } = {}): string {
  const envBody = `${env.fnmDir ?? ""}\n${env.nvmBin ?? ""}\n`;
  return `some prompt noise\n${LOGIN_SHELL_PATH_DELIM}${dirs.join("\n")}${LOGIN_SHELL_PATH_DELIM}${LOGIN_SHELL_ENV_DELIM}${envBody}${LOGIN_SHELL_ENV_DELIM}\n`;
}

const linux = { platform: "linux" as const, home: "/home/u" };

describe("getLoginShellPathDirs", () => {
  afterEach(() => {
    resetLoginShellPathDirsCache();
    vi.useRealTimers();
  });

  it("parses delimiter-bracketed canonical dirs, dropping empty lines", async () => {
    await expect(
      getLoginShellPathDirs({ ...linux, runShell: () => wrap(["/home/u/.nvm/v/bin", "", "/usr/local/bin", ""]) }),
    ).resolves.toEqual(["/home/u/.nvm/v/bin", "/usr/local/bin"]);
  });

  it("returns [] when the shell output is null (probe failure)", async () => {
    await expect(getLoginShellPathDirs({ ...linux, runShell: () => null })).resolves.toEqual([]);
  });

  it("returns [] when the delimiters are missing (parse miss)", async () => {
    await expect(getLoginShellPathDirs({ ...linux, runShell: () => "no markers here" })).resolves.toEqual([]);
  });

  it("treats a successfully-parsed empty PATH as success (cached, no retry)", async () => {
    const runShell = vi.fn(() => wrap([]));
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual([]);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("returns [] on win32 without invoking the shell", async () => {
    const runShell = vi.fn(() => wrap(["/should/not/be/used"]));
    await expect(getLoginShellPathDirs({ platform: "win32", home: "/Users/x", runShell })).resolves.toEqual([]);
    expect(runShell).not.toHaveBeenCalled();
  });

  it("does not throw when the shell seam throws", async () => {
    await expect(
      getLoginShellPathDirs({
        ...linux,
        runShell: () => {
          throw new Error("spawn failed");
        },
      }),
    ).resolves.toEqual([]);
  });

  it("memoizes a successful probe across calls", async () => {
    const runShell = vi.fn(() => wrap(["/a/bin"]));
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual(["/a/bin"]);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual(["/a/bin"]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight probe across concurrent callers", async () => {
    let release!: (value: string | null) => void;
    const runShell = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    const first = getLoginShellPathDirs({ ...linux, runShell });
    const second = getLoginShellPathDirs({ ...linux, runShell });
    expect(runShell).toHaveBeenCalledTimes(1);
    release(wrap(["/shared/bin"]));
    await expect(first).resolves.toEqual(["/shared/bin"]);
    await expect(second).resolves.toEqual(["/shared/bin"]);
    expect(runShell).toHaveBeenCalledTimes(1);
  });

  it("re-probes a failing shell up to the cap, then settles to [] cached", async () => {
    const runShell = vi.fn(() => null);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual([]);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual([]);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(LOGIN_SHELL_PROBE_MAX_ATTEMPTS);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual([]);
    expect(runShell).toHaveBeenCalledTimes(LOGIN_SHELL_PROBE_MAX_ATTEMPTS);
  });

  it("recovers: a success after transient failures caches and stops retrying", async () => {
    const runShell = vi
      .fn<RunShell>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(wrap(["/late/bin"]))
      .mockReturnValue(wrap(["/unused/bin"]));
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual([]);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual(["/late/bin"]);
    await expect(getLoginShellPathDirs({ ...linux, runShell })).resolves.toEqual(["/late/bin"]);
    expect(runShell).toHaveBeenCalledTimes(2);
  });

  it("drops macOS TCC-protected dirs using injected platform/home, not process globals", async () => {
    await expect(
      getLoginShellPathDirs({
        platform: "darwin",
        home: "/Users/tester",
        environment: { HOME: "/Users/tester" },
        runShell: () =>
          wrap([
            "/opt/homebrew/bin",
            "/Users/tester/Documents/bin",
            "/Users/tester/Desktop",
            "/Users/tester/Downloads/tools/bin",
            "/Users/tester/Library/Mobile Documents/com~apple~CloudDocs/bin",
            "/Users/tester/Library/CloudStorage/OneDrive/bin",
            "/Users/tester/.nvm/versions/node/v22.0.0/bin",
            "/Users/tester/Documents-archive/bin",
          ]),
      }),
    ).resolves.toEqual([
      "/opt/homebrew/bin",
      "/Users/tester/.nvm/versions/node/v22.0.0/bin",
      "/Users/tester/Documents-archive/bin",
    ]);
  });

  it.skipIf(process.platform === "win32")("rejects symlinks into a protected root without entering them", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ot-symlink-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents", "real", "bin"), { recursive: true });
    mkdirSync(join(home, "deep"), { recursive: true });
    mkdirSync(join(home, "safe", "bin"), { recursive: true });
    symlinkSync(join(home, "Documents", "real"), join(home, "bin"));
    symlinkSync(join(home, "Documents"), join(home, "deep", "mid"));
    symlinkSync(join(home, "safe", "bin"), join(home, "safe-link"));

    await expect(
      getLoginShellPathDirs({
        platform: "darwin",
        home,
        environment: { HOME: home },
        runShell: () =>
          wrap([join(home, "bin", "bin"), join(home, "deep", "mid", "real", "bin"), join(home, "safe-link")]),
      }),
    ).resolves.toEqual([join(home, "safe", "bin")]);
  });

  it("matches protected roots regardless of case", async () => {
    await expect(
      getLoginShellPathDirs({
        platform: "darwin",
        home: "/Users/tester",
        environment: { HOME: "/Users/tester" },
        runShell: () =>
          wrap([
            "/Users/tester/documents/bin",
            "/Users/tester/DOWNLOADS/bin",
            "/Users/tester/Library/mobile documents/bin",
            "/opt/homebrew/bin",
          ]),
      }),
    ).resolves.toEqual(["/opt/homebrew/bin"]);
  });

  it.skipIf(process.platform === "win32")("never passes a protected path to readlink", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ot-touch-")));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents", "real", "bin"), { recursive: true });
    mkdirSync(join(home, "deep"), { recursive: true });
    symlinkSync(join(home, "Documents", "real"), join(home, "bin"));
    symlinkSync(join(home, "Documents"), join(home, "deep", "mid"));
    const touched: string[] = [];
    const readLink = (path: string): string => {
      touched.push(path);
      return readlinkSync(path);
    };

    await getLoginShellPathDirs({
      platform: "darwin",
      home,
      environment: { HOME: home },
      readLink,
      runShell: () =>
        wrap([
          join(home, "Documents", "bin"),
          join(home, "documents", "bin"),
          join(home, "bin", "bin"),
          join(home, "deep", "mid", "real", "bin"),
        ]),
    });

    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((path) => path.toLowerCase().startsWith(join(home, "documents")))).toEqual([]);
  });

  it("keeps protected-looking dirs on non-macOS hosts", async () => {
    await expect(
      getLoginShellPathDirs({
        platform: "linux",
        home: "/home/tester",
        runShell: () => wrap(["/home/tester/Documents/bin", "/usr/local/bin"]),
      }),
    ).resolves.toEqual(["/home/tester/Documents/bin", "/usr/local/bin"]);
  });

  it("drops both manager trees from live dirs when macOS sees both managers", async () => {
    const nvmBin = "/Users/tester/.nvm/versions/node/v22.2.0/bin";
    const fnmDir = "/opt/fnm";
    await expect(
      getLoginShellPathDirs({
        platform: "darwin",
        home: "/Users/tester",
        environment: { HOME: "/Users/tester" },
        runShell: () => wrap(["/opt/fnm-multishells/1/bin", nvmBin, "/opt/homebrew/bin"], { fnmDir, nvmBin }),
      }),
    ).resolves.toEqual(["/opt/fnm-multishells/1/bin", "/opt/homebrew/bin"]);
  });

  it("keeps a dual-manager PATH intact where the shell already canonicalized it", async () => {
    const nvmBin = "/home/u/.nvm/versions/node/v22.2.0/bin";
    const fnmDir = "/opt/fnm";
    const fnmTarget = "/opt/fnm/node-versions/v20.11.0/installation/bin";
    await expect(
      getLoginShellPathDirs({
        ...linux,
        runShell: () => wrap([fnmTarget, nvmBin], { fnmDir, nvmBin }),
      }),
    ).resolves.toEqual([fnmTarget, nvmBin]);
  });

  it("captures active NVM_BIN and FNM_DIR evidence from the login shell", async () => {
    const env = { fnmDir: "/opt/fnm", nvmBin: "/home/u/.nvm/versions/node/v20/bin" };
    await expect(
      probeLoginShellPath({ ...linux, runShell: () => wrap(["/usr/local/bin"], env) }),
    ).resolves.toMatchObject({
      ok: true,
      dirs: ["/usr/local/bin"],
      env,
    });
  });
});

describe("defaultRunShell timeout, kill, and source environment", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("kills a hanging child with SIGKILL and settles null even when close is never emitted", async () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    const spawnFn = () => {
      const child = new EventEmitter();
      Object.assign(child, {
        stdout: new PassThrough(),
        kill,
      });
      return child;
    };
    const pending = defaultRunShell({
      platform: "linux",
      environment: { SHELL: "/bin/bash" },
      spawn: spawnFn as never,
    });
    await vi.advanceTimersByTimeAsync(LOGIN_SHELL_PROBE_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(kill).toHaveBeenCalledWith(LOGIN_SHELL_PROBE_KILL_SIGNAL);
  });

  it("selects the source-environment shell and passes that environment to spawn", async () => {
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      Object.assign(child, { stdout, kill: vi.fn() });
      queueMicrotask(() => {
        stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    });
    const environment = { SHELL: "/custom/shell", HOME: "/Users/x", PATH: "/bin" };
    await defaultRunShell({ platform: "darwin", environment, spawn: spawn as never });
    expect(spawn).toHaveBeenCalledWith("/custom/shell", ["-lic", expect.any(String)], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: environment,
    });
  });

  it("inherits the current process environment when no source environment is supplied", async () => {
    vi.stubEnv("SHELL", "/process/shell");
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      Object.assign(child, { stdout, kill: vi.fn() });
      queueMicrotask(() => child.emit("close", 1, null));
      return child;
    });
    await defaultRunShell({ platform: "linux", spawn: spawn as never });
    expect(spawn).toHaveBeenCalledWith("/process/shell", ["-lic", expect.any(String)], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: process.env,
    });
  });

  it("defaults to zsh on darwin and bash elsewhere when SHELL is unset", async () => {
    const spawn = vi.fn((_command: string) => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => child.emit("close", 1, null));
      return child;
    });
    await defaultRunShell({ platform: "darwin", environment: {}, spawn: spawn as never });
    expect(spawn.mock.calls[0]?.[0]).toBe("/bin/zsh");
    await defaultRunShell({ platform: "linux", environment: {}, spawn: spawn as never });
    expect(spawn.mock.calls[1]?.[0]).toBe("/bin/bash");
  });

  it("kills and fails closed when stdout exceeds the bounded limit", async () => {
    const kill = vi.fn(() => true);
    const spawnFn = () => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      Object.assign(child, { stdout, kill });
      queueMicrotask(() => {
        stdout.write("x".repeat(LOGIN_SHELL_PROBE_MAX_STDOUT_BYTES + 1));
      });
      return child;
    };
    await expect(
      defaultRunShell({ platform: "linux", environment: { SHELL: "/bin/bash" }, spawn: spawnFn as never }),
    ).resolves.toBeNull();
    expect(kill).toHaveBeenCalledWith(LOGIN_SHELL_PROBE_KILL_SIGNAL);
  });
});

describe("probe script shape", () => {
  it("emits a script with no filesystem access on macOS", () => {
    const darwin = buildProbeScript("darwin");
    expect(darwin).not.toContain("cd ");
    expect(darwin).not.toContain("pwd");
    expect(darwin).not.toContain("readlink");
  });

  it("keeps shell canonicalization on non-macOS platforms", () => {
    const linuxScript = buildProbeScript("linux");
    expect(linuxScript).toContain('(cd "$d" 2>/dev/null && pwd -P)');
    expect(buildProbeScript("win32")).toBe(linuxScript);
  });
});
