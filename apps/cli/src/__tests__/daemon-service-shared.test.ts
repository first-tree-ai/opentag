import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getChannelConfig } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { applyDaemonEnvironment, loadDaemonEnvironment } from "../core/daemon/environment.js";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import {
  acquireProcessFileLease,
  inspectDarwinProcessIdentity,
  inspectProcessFileLease,
  inspectProcessIdentity,
  ProcessLeaseMalformedError,
  ProcessLeaseUnverifiableError,
} from "../core/daemon/process-lease.js";
import {
  acquireServiceOperationLease,
  acquireServiceTargetLease,
  buildServicePath,
  canonicalizeServiceHome,
  deriveServiceIdentity,
  escapeXml,
  invocationArguments,
  isManagerNotLoaded,
  pathExists,
  preflightHomeDirectory,
  quotePosix,
  quoteSystemdEnvironment,
  quoteSystemdToken,
  readRegularFile,
  resolveCliInvocation,
  resolveServiceManagerExecutable,
  runRequired,
  serviceError,
  sleep,
  writeFileAtomically,
} from "../core/daemon/service/shared.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon service primitives", () => {
  it("derives every visible service identity from the channel service ID", () => {
    const identities = (["dev", "staging", "prod"] as const).map((channel) => {
      const config = getChannelConfig(channel, "/users/test");
      return [config.serviceId, deriveServiceIdentity(config.serviceId)] as const;
    });

    expect(identities).toEqual([
      ["opentag-dev", visibleIdentity("opentag-dev")],
      ["opentag-staging", visibleIdentity("opentag-staging")],
      ["opentag", visibleIdentity("opentag")],
    ]);
  });

  it("uses syntax-specific escaping for service files", () => {
    const value = `a b'c"d\\e%f<&>`;
    expect(quoteSystemdToken(value)).toBe(`"a b'c\\"d\\\\e%%f<&>"`);
    expect(quoteSystemdEnvironment("KEY", value)).toContain("KEY=a b");
    expect(quotePosix(value)).toBe(`'a b'"'"'c"d\\e%f<&>'`);
    expect(escapeXml(value)).toBe("a b&apos;c&quot;d\\e%f&lt;&amp;&gt;");
  });

  it("canonicalizes service homes through filesystem aliases", async () => {
    const root = await temporaryDirectory("opentag-home-canonical-");
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    await expect(canonicalizeServiceHome(alias)).resolves.toBe(await realpath(actual));
  });

  it("resolves the freshly installed dev binary before a stale PATH shim", async () => {
    const root = await temporaryDirectory("opentag-invocation-path-");
    const installedBin = join(root, "installed-bin");
    const staleBin = join(root, "stale-bin");
    const currentDist = join(root, "current-dist.mjs");
    const staleDist = join(root, "stale-dist.mjs");
    await Promise.all([mkdir(installedBin), mkdir(staleBin)]);
    await Promise.all([
      writeFile(currentDist, "#!/usr/bin/env node\n", { mode: 0o755 }),
      writeFile(staleDist, "#!/usr/bin/env node\n", { mode: 0o755 }),
    ]);
    await Promise.all([
      symlink(currentDist, join(installedBin, "opentag-dev")),
      symlink(staleDist, join(staleBin, "opentag-dev")),
    ]);

    await expect(
      resolveCliInvocation({
        binName: "opentag-dev",
        env: { PATH: `${installedBin}:${staleBin}` },
      }),
    ).resolves.toEqual({ args: [], program: currentDist });
  });

  it("builds a stable service PATH from trusted executable, user, and platform directories", () => {
    const invocation = { args: [], program: "/opt/opentag/bin/opentag" };
    const servicePath = buildServicePath(
      invocation,
      "linux",
      "/home/test/.local/bin:relative:/opt/opentag/bin::/home/test/tools:/usr/bin",
    ).split(":");

    expect(servicePath[0]).toBe("/opt/opentag/bin");
    expect(servicePath[1]).toBe(dirname(process.execPath));
    expect(servicePath).toContain("/home/test/.local/bin");
    expect(servicePath).toContain("/home/test/tools");
    expect(servicePath).not.toContain("relative");
    expect(servicePath.filter((entry) => entry === "/opt/opentag/bin")).toHaveLength(1);
    expect(servicePath.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
  });

  it("resolves a bare service-manager name only through reviewed absolute locations", async () => {
    const inspected: string[] = [];

    await expect(
      resolveServiceManagerExecutable("launchctl", "darwin", {
        access: async (path) => {
          inspected.push(`access:${path}`);
        },
        stat: async (path) => {
          inspected.push(`stat:${path}`);
          return { isFile: () => true };
        },
      }),
    ).resolves.toBe("/bin/launchctl");

    expect(inspected).toEqual(["stat:/bin/launchctl", "access:/bin/launchctl"]);
    expect(inspected).not.toContain("stat:launchctl");
  });

  it("supports the governed NixOS systemd manager location", async () => {
    const inspected: string[] = [];

    await expect(
      resolveServiceManagerExecutable("systemctl", "linux", {
        access: async (path) => {
          inspected.push(`access:${path}`);
        },
        stat: async (path) => {
          inspected.push(`stat:${path}`);
          return { isFile: () => path === "/run/current-system/systemd/bin/systemctl" };
        },
      }),
    ).resolves.toBe("/run/current-system/systemd/bin/systemctl");

    expect(inspected).toEqual([
      "stat:/run/current-system/systemd/bin/systemctl",
      "access:/run/current-system/systemd/bin/systemctl",
    ]);
  });

  it("rejects unsupported, absolute, inaccessible, and non-file service managers", async () => {
    await expect(resolveServiceManagerExecutable("launchctl", "freebsd")).rejects.toThrow("not governed");
    await expect(
      resolveServiceManagerExecutable("/usr/bin/launchctl", "darwin", {
        stat: async () => ({ isFile: () => true }),
        access: async () => undefined,
      }),
    ).rejects.toThrow("not supported");
    await expect(
      resolveServiceManagerExecutable("systemctl", "linux", {
        stat: async (path) => ({ isFile: () => path.endsWith("/bin") }),
        access: async () => undefined,
      }),
    ).rejects.toThrow("unavailable at supported");
    await expect(
      resolveServiceManagerExecutable("systemctl", "linux", {
        stat: async () => ({ isFile: () => true }),
        access: async (path) => {
          if (path.endsWith("/systemctl")) throw new Error("no execute bit");
        },
      }),
    ).rejects.toThrow("unavailable at supported");
  });

  it("resolves a Node script invocation when no installed binary is available", async () => {
    await expect(
      resolveCliInvocation({
        binName: "missing-opentag",
        env: { PATH: "" },
        argv: ["node", "relative.mjs"],
        cwd: "/tmp",
      }),
    ).resolves.toEqual({ args: ["/tmp/relative.mjs"], program: process.execPath });
    await expect(resolveCliInvocation({ binName: "missing", env: { PATH: "" }, argv: ["node"] })).rejects.toThrow(
      "entry script",
    );
    await expect(
      resolveCliInvocation({ binName: "missing", env: { PATH: "" }, argv: ["node", "script.mjs"], execPath: "node" }),
    ).rejects.toThrow("must be absolute");
    expect(invocationArguments({ program: "/usr/bin/node", args: ["script.mjs"] })).toEqual([
      "/usr/bin/node",
      "script.mjs",
      "daemon",
      "service-run",
    ]);
    await expect(
      resolveCliInvocation({
        binName: "missing",
        env: { PATH: `${join(tmpdir(), "missing-directory")}` },
        argv: ["node", "script.mjs"],
      }),
    ).resolves.toMatchObject({ args: [expect.stringContaining("script.mjs")] });
  });

  it("atomically replaces files and leaves no temporary files", async () => {
    const root = await temporaryDirectory("opentag-atomic-");
    const path = join(root, "nested", "service");
    await writeFileAtomically(path, "first", 0o600);
    await writeFileAtomically(path, "second", 0o600);
    expect(await readFile(path, "utf8")).toBe("second");
  });

  it("writes atomically beneath a private containment root and reads regular files safely", async () => {
    const root = await temporaryDirectory("opentag-contained-atomic-");
    const path = join(root, "config", "service");
    await writeFileAtomically(path, "contained", 0o600, 0o700, root);
    await expect(readRegularFile(path)).resolves.toBe("contained");
    await expect(readRegularFile(join(root, "missing"))).resolves.toBeUndefined();
    await mkdir(join(root, "directory"));
    await expect(readRegularFile(join(root, "directory"))).rejects.toThrow("regular file");
    await symlink(path, join(root, "link"));
    await expect(readRegularFile(join(root, "link"))).rejects.toThrow("regular file");
  });

  it("cleans the temporary file when atomic replacement fails", async () => {
    const root = await temporaryDirectory("opentag-atomic-");
    const target = join(root, "service");
    await mkdir(target);
    await expect(writeFileAtomically(target, "content", 0o600)).rejects.toBeDefined();
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes service mutations per home", async () => {
    const home = await temporaryDirectory("opentag-operation-");
    const paths = resolveDaemonPaths(home);
    const first = await acquireServiceOperationLease(home);
    await expect(readFile(paths.serviceOperation, "utf8")).resolves.toContain("operationId");
    await expect(acquireServiceOperationLease(home)).rejects.toThrow("already running");
    await first.release();
    const second = await acquireServiceOperationLease(home);
    await second.release();
  });

  it("stores a channel target lease in that channel's default Home", async () => {
    const userHome = await temporaryDirectory("opentag-target-operation-");
    const config = getChannelConfig("dev", userHome);
    const paths = resolveDaemonPaths(config.defaultHome);

    const lease = await acquireServiceTargetLease(config.defaultHome, config.serviceId);
    await expect(readFile(paths.serviceTargetOperation, "utf8")).resolves.toContain("operationId");
    await lease.release();
  });

  it("does not make different channels contend for one target lease", async () => {
    const userHome = await temporaryDirectory("opentag-channel-operations-");
    const dev = getChannelConfig("dev", userHome);
    const production = getChannelConfig("prod", userHome);

    const devLease = await acquireServiceTargetLease(dev.defaultHome, dev.serviceId);
    const productionLease = await acquireServiceTargetLease(production.defaultHome, production.serviceId);
    expect(resolveDaemonPaths(dev.defaultHome).serviceTargetOperation).not.toBe(
      resolveDaemonPaths(production.defaultHome).serviceTargetOperation,
    );
    await Promise.all([devLease.release(), productionLease.release()]);
  });

  it("serializes stale lease takeover before publishing a successor", async () => {
    const home = await temporaryDirectory("opentag-stale-race-");
    const path = join(home, "lease.json");
    await writeFile(
      path,
      `${JSON.stringify({
        leaseId: "stale",
        pid: process.pid,
        processStartId: "previous-process-start",
        startedAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    let continueInspection: (() => void) | undefined;
    let inspectionStarted: (() => void) | undefined;
    const inspection = new Promise<void>((resolve) => {
      inspectionStarted = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      continueInspection = resolve;
    });
    let identityCall = 0;
    const options = {
      createRecord: (processStartId: string) => ({
        leaseId: crypto.randomUUID(),
        pid: process.pid,
        processStartId,
        startedAt: new Date().toISOString(),
      }),
      fileName: "lease.json",
      getId: (record: TestLeaseRecord) => record.leaseId,
      getProcessIdentity: async () => {
        identityCall += 1;
        if (identityCall === 2) {
          inspectionStarted?.();
          await barrier;
        }
        return { id: "current-process-start", state: "identified" as const };
      },
      parseRecord: parseTestLease,
    };
    const first = acquireProcessFileLease(home, options);
    await inspection;
    const second = acquireProcessFileLease(home, options);
    await expect(second).rejects.toThrow("already owns this operation");
    continueInspection?.();
    const winner = await first;
    expect(parseTestLease(JSON.parse(await readFile(path, "utf8"))).leaseId).toBe(winner.record.leaseId);
    await winner.release();
  });

  it("does not treat a reused PID with a different process start identity as live", async () => {
    const home = await temporaryDirectory("opentag-pid-reuse-");
    const path = join(home, "lease.json");
    await writeFile(
      path,
      `${JSON.stringify({
        leaseId: "old-process",
        pid: process.pid,
        processStartId: "previous-process-start",
        startedAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const lease = await acquireProcessFileLease(home, {
      createRecord: (processStartId) => ({
        leaseId: "current-process",
        pid: process.pid,
        processStartId,
        startedAt: new Date().toISOString(),
      }),
      fileName: "lease.json",
      getId: (record) => record.leaseId,
      getProcessIdentity: async () => ({ id: "current-process-start", state: "identified" as const }),
      parseRecord: parseTestLease,
    });
    expect(lease.record).toMatchObject({ leaseId: "current-process", processStartId: "current-process-start" });
    expect((await readdir(home)).some((name) => name.startsWith("lease.json.stale.old-process."))).toBe(true);
    await lease.release();
  });

  it("preserves a live lease when process identity cannot be verified", async () => {
    const home = await temporaryDirectory("opentag-unverifiable-lease-");
    const path = join(home, "lease.json");
    const original = {
      leaseId: "unverifiable-owner",
      pid: process.pid,
      processStartId: "recorded-process-start",
      startedAt: new Date(0).toISOString(),
    };
    await writeFile(path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
    let identityCall = 0;

    await expect(
      acquireProcessFileLease(home, {
        createRecord: (processStartId) => ({
          leaseId: "successor",
          pid: process.pid,
          processStartId,
          startedAt: new Date().toISOString(),
        }),
        fileName: "lease.json",
        getId: (record) => record.leaseId,
        getProcessIdentity: async () => {
          identityCall += 1;
          return identityCall === 1
            ? { id: "current-process-start", state: "identified" as const }
            : { state: "unverifiable" as const };
        },
        parseRecord: parseTestLease,
      }),
    ).rejects.toBeInstanceOf(ProcessLeaseUnverifiableError);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
    expect((await readdir(home)).filter((name) => name.startsWith("lease.json.stale."))).toEqual([]);
  });

  it("recovers a lease only after the recorded process is proven gone", async () => {
    const home = await temporaryDirectory("opentag-gone-lease-");
    const path = join(home, "lease.json");
    await writeFile(
      path,
      `${JSON.stringify({
        leaseId: "gone-owner",
        pid: 2_147_483_647,
        processStartId: "gone-process-start",
        startedAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const lease = await acquireProcessFileLease(home, {
      createRecord: (processStartId) => ({
        leaseId: "successor",
        pid: process.pid,
        processStartId,
        startedAt: new Date().toISOString(),
      }),
      fileName: "lease.json",
      getId: (record) => record.leaseId,
      getProcessIdentity: async (pid) =>
        pid === process.pid
          ? { id: "current-process-start", state: "identified" as const }
          : { state: "gone" as const },
      parseRecord: parseTestLease,
    });

    expect(lease.record.leaseId).toBe("successor");
    expect((await readdir(home)).some((name) => name.startsWith("lease.json.stale.gone-owner."))).toBe(true);
    await lease.release();
  });

  it("rejects an unverifiable current process and classifies lease inspection states", async () => {
    const home = await temporaryDirectory("opentag-lease-inspection-");
    const path = join(home, "lease.json");
    const record = {
      leaseId: "recorded",
      pid: process.pid,
      processStartId: "recorded-start",
      startedAt: new Date(0).toISOString(),
    };
    const options = {
      fileName: "lease.json",
      getId: (value: TestLeaseRecord) => value.leaseId,
      parseRecord: parseTestLease,
    };
    await expect(
      acquireProcessFileLease(home, {
        ...options,
        createRecord: (processStartId) => ({ ...record, leaseId: "new", processStartId }),
        getProcessIdentity: async () => ({ state: "unverifiable" as const }),
      }),
    ).rejects.toBeInstanceOf(ProcessLeaseUnverifiableError);
    await expect(inspectProcessFileLease(home, options)).resolves.toEqual({ state: "missing" });

    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await expect(
      inspectProcessFileLease(home, {
        ...options,
        getProcessIdentity: async () => ({ id: "recorded-start", state: "identified" as const }),
      }),
    ).resolves.toMatchObject({ state: "live", record });
    await expect(
      inspectProcessFileLease(home, {
        ...options,
        getProcessIdentity: async () => ({ id: "different-start", state: "identified" as const }),
      }),
    ).resolves.toMatchObject({ state: "stale", record });
    await expect(
      inspectProcessFileLease(home, {
        ...options,
        getProcessIdentity: async () => ({ state: "unverifiable" as const }),
      }),
    ).rejects.toThrow("Cannot verify whether process");
  });

  it("fails closed for malformed acquisition guards and release records", async () => {
    const home = await temporaryDirectory("opentag-lease-guard-");
    const path = join(home, "lease.json");
    const baseOptions = {
      createRecord: (processStartId: string) => ({
        leaseId: "new",
        pid: process.pid,
        processStartId,
        startedAt: new Date().toISOString(),
      }),
      fileName: "lease.json",
      getId: (value: TestLeaseRecord) => value.leaseId,
      parseRecord: parseTestLease,
    };
    await writeFile(join(home, ".lease.json.acquire"), "{}\n", { mode: 0o600 });
    await expect(
      acquireProcessFileLease(home, {
        ...baseOptions,
        getProcessIdentity: async () => ({ id: "current", state: "identified" as const }),
      }),
    ).rejects.toBeInstanceOf(ProcessLeaseMalformedError);
    await rm(join(home, ".lease.json.acquire"));

    await writeFile(
      join(home, ".lease.json.acquire"),
      `${JSON.stringify({
        guardId: "guard",
        pid: process.pid,
        processStartId: "old",
        startedAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      acquireProcessFileLease(home, {
        ...baseOptions,
        getProcessIdentity: async () => ({ id: "different", state: "identified" as const }),
      }),
    ).rejects.toThrow("stale process lease acquisition guard");
    await rm(join(home, ".lease.json.acquire"));

    const lease = await acquireProcessFileLease(home, {
      ...baseOptions,
      getProcessIdentity: async () => ({ id: "current", state: "identified" as const }),
    });
    await rm(path);
    await expect(lease.release()).resolves.toBeUndefined();
    const second = await acquireProcessFileLease(home, {
      ...baseOptions,
      getProcessIdentity: async () => ({ id: "current", state: "identified" as const }),
    });
    await writeFile(path, "not json\n", { mode: 0o600 });
    await expect(second.release()).rejects.toThrow("process lease record is malformed");
  });

  it("covers platform-specific process identity fallbacks", async () => {
    const linuxReads: string[] = [];
    const linuxStat = `4242 (opentag test) S ${Array.from({ length: 18 }, () => "0").join(" ")} 36178`;
    await expect(
      inspectProcessIdentity(4242, {
        isProcessAlive: () => true,
        platform: "linux",
        readLinuxProcessFile: async (path) => {
          linuxReads.push(path);
          return path.endsWith("/stat") ? linuxStat : "test-boot-id\n";
        },
      }),
    ).resolves.toEqual({ id: "linux:test-boot-id:36178", state: "identified" });
    expect(linuxReads).toEqual(["/proc/4242/stat", "/proc/sys/kernel/random/boot_id"]);

    const linuxHome = await temporaryDirectory("opentag-lease-linux-");
    await expect(
      acquireProcessFileLease(linuxHome, {
        createRecord: (processStartId) => ({
          leaseId: "linux",
          pid: process.pid,
          processStartId,
          startedAt: new Date().toISOString(),
        }),
        fileName: "lease.json",
        getId: (value: TestLeaseRecord) => value.leaseId,
        getProcessIdentity: (pid) =>
          inspectProcessIdentity(pid, {
            isProcessAlive: () => true,
            platform: "linux",
            readLinuxProcessFile: async () => {
              throw new Error("injected procfs read failure");
            },
          }),
        parseRecord: parseTestLease,
      }),
    ).rejects.toBeInstanceOf(ProcessLeaseUnverifiableError);

    const otherHome = await temporaryDirectory("opentag-lease-other-platform-");
    const lease = await acquireProcessFileLease(otherHome, {
      createRecord: (processStartId) => ({
        leaseId: "other",
        pid: process.pid,
        processStartId,
        startedAt: new Date().toISOString(),
      }),
      fileName: "lease.json",
      getId: (value: TestLeaseRecord) => value.leaseId,
      getProcessIdentity: (pid) => inspectProcessIdentity(pid, { isProcessAlive: () => true, platform: "freebsd" }),
      parseRecord: parseTestLease,
    });
    expect(lease.record.processStartId).toMatch(/^self:/u);
    await lease.release();
  });

  it("keeps Darwin process identity stable across parent locale and timezone changes", async () => {
    const childEnvironments: NodeJS.ProcessEnv[] = [];
    const readProcessStart = async (_pid: number, environment: NodeJS.ProcessEnv) => {
      childEnvironments.push(environment);
      return "Mon Jan  1 00:00:00 2024";
    };
    const original = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
    };
    try {
      process.env.LANG = "fr_FR.UTF-8";
      process.env.LC_ALL = "fr_FR.UTF-8";
      process.env.TZ = "Pacific/Honolulu";
      const first = await inspectDarwinProcessIdentity(4242, { isProcessAlive: () => true, readProcessStart });

      process.env.LANG = "ja_JP.UTF-8";
      process.env.LC_ALL = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      const second = await inspectDarwinProcessIdentity(4242, { isProcessAlive: () => true, readProcessStart });

      expect(first).toMatchObject({ state: "identified" });
      expect(second).toEqual(first);
      expect(childEnvironments).toHaveLength(2);
      for (const environment of childEnvironments) {
        expect(environment).toMatchObject({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
      }
      await expect(
        inspectDarwinProcessIdentity(4242, {
          isProcessAlive: () => true,
          readProcessStart: async () => undefined,
        }),
      ).resolves.toEqual({ state: "unverifiable" });
      await expect(
        inspectDarwinProcessIdentity(4242, {
          isProcessAlive: () => false,
          readProcessStart: async () => undefined,
        }),
      ).resolves.toEqual({ state: "gone" });
    } finally {
      restoreEnvironment("LANG", original.LANG);
      restoreEnvironment("LC_ALL", original.LC_ALL);
      restoreEnvironment("TZ", original.TZ);
    }
  });

  it("keeps subprocess stderr and timeout classification", async () => {
    await expect(
      runRequired(
        { run: async () => ({ code: 1, stderr: "manager denied", stdout: "", timedOut: false }) },
        "manager",
        [],
        "service start",
      ),
    ).rejects.toThrow("manager denied");
    await expect(
      runRequired(
        { run: async () => ({ code: null, stderr: "", stdout: "", timedOut: true }) },
        "manager",
        [],
        "service start",
        12,
      ),
    ).rejects.toThrow("timed out after 12ms");
    await expect(
      runRequired(
        { run: async () => ({ code: 3, stderr: "", stdout: "", timedOut: false }) },
        "manager",
        [],
        "service stop",
      ),
    ).rejects.toThrow("service stop failed: exited with code 3");
    await expect(
      runRequired(
        { run: async () => ({ code: 0, stderr: "", stdout: "ok", timedOut: false }) },
        "manager",
        [],
        "service start",
      ),
    ).resolves.toEqual({
      code: 0,
      stderr: "",
      stdout: "ok",
      timedOut: false,
    });
  });

  it("classifies manager state and validates service homes", async () => {
    expect(isManagerNotLoaded({ code: 1, stdout: "not loaded", stderr: "", timedOut: false })).toBe(true);
    expect(isManagerNotLoaded({ code: 1, stdout: "could not find service", stderr: "", timedOut: false })).toBe(true);
    expect(isManagerNotLoaded({ code: 1, stdout: "NOT FOUND", stderr: "", timedOut: false })).toBe(true);
    expect(isManagerNotLoaded({ code: 1, stdout: "no such process", stderr: "", timedOut: false })).toBe(true);
    expect(isManagerNotLoaded({ code: 0, stdout: "not loaded", stderr: "", timedOut: false })).toBe(false);
    expect(serviceError("CONFIGURATION", "bad", "cause")).toMatchObject({ code: "CONFIGURATION", message: "bad" });
    await expect(pathExists(process.execPath)).resolves.toBe(true);
    await expect(pathExists(join(tmpdir(), "opentag-no-such-path"))).resolves.toBe(false);
    await expect(preflightHomeDirectory("relative-home")).rejects.toThrow("must be absolute");
    const root = await temporaryDirectory("opentag-preflight-");
    await expect(preflightHomeDirectory(join(root, "new", "home"))).resolves.toBeUndefined();
    await expect(preflightHomeDirectory(join(root, "new", "home"))).resolves.toBeUndefined();
    await writeFile(join(root, "file"), "not a directory");
    await expect(preflightHomeDirectory(join(root, "file", "nested"))).rejects.toThrow("not writable");
    const symlinkTarget = join(root, "symlink-target");
    await mkdir(symlinkTarget);
    await symlink(symlinkTarget, join(root, "symlink-home"));
    await expect(preflightHomeDirectory(join(root, "symlink-home"))).rejects.toThrow("real directory");
    await expect(canonicalizeServiceHome("relative-home")).rejects.toThrow("must be absolute");
    await expect(canonicalizeServiceHome(`${root}\0`)).rejects.toThrow("Cannot canonicalize");
    await expect(pathExists("\0")).rejects.toBeDefined();
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it("maps malformed and unverifiable service leases and validates target IDs", async () => {
    const home = await temporaryDirectory("opentag-service-lease-errors-");
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.serviceState, { recursive: true, mode: 0o700 });
    await writeFile(paths.serviceOperation, "{}\n", { mode: 0o600 });
    await expect(acquireServiceOperationLease(home)).rejects.toThrow("malformed");
    await writeFile(paths.serviceOperation, "[]\n", { mode: 0o600 });
    await expect(acquireServiceOperationLease(home)).rejects.toThrow("malformed");
    await expect(acquireServiceTargetLease(home, "Invalid ID")).rejects.toThrow("service ID is invalid");
    await rm(paths.serviceOperation, { force: true });
    const lease = await acquireServiceOperationLease(home);
    await expect(acquireServiceOperationLease(home)).rejects.toThrow("already running");
    await lease.release();
  });
});

describe("daemon.env", () => {
  it("fills missing keys without overriding pinned values or logging values", async () => {
    const home = await temporaryDirectory("opentag-env-");
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.config, { mode: 0o700, recursive: true });
    await writeFile(
      paths.daemonEnvironment,
      ["# service env", "export HTTPS_PROXY='http://secret-proxy'", "OPENTAG_HOME=/wrong", "BROKEN", ""].join("\n"),
      { mode: 0o600 },
    );
    const result = await loadDaemonEnvironment(home, { OPENTAG_HOME: home });

    expect(result.env.OPENTAG_HOME).toBe(home);
    expect(result.env.HTTPS_PROXY).toBe("http://secret-proxy");
    expect(result.appliedKeys).toEqual(["HTTPS_PROXY"]);
    expect(result.diagnostics.join(" ")).not.toContain("secret-proxy");
  });

  it("rejects broad permissions and symlinks", async () => {
    const home = await temporaryDirectory("opentag-env-");
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.config, { mode: 0o700, recursive: true });
    const target = join(paths.config, "target.env");
    await writeFile(target, "KEY=value\n", { mode: 0o600 });
    await symlink(target, paths.daemonEnvironment);
    await expect(loadDaemonEnvironment(home, {})).rejects.toThrow("regular file");
    await rm(paths.daemonEnvironment);
    await writeFile(paths.daemonEnvironment, "KEY=value\n", { mode: 0o600 });
    await chmod(paths.daemonEnvironment, 0o644);
    await expect(loadDaemonEnvironment(home, {})).rejects.toThrow("permissions");
  });

  it("rejects a symlinked config directory", async () => {
    const home = await temporaryDirectory("opentag-env-home-");
    const external = await temporaryDirectory("opentag-env-external-");
    const paths = resolveDaemonPaths(home);
    await writeFile(join(external, "daemon.env"), "KEY=value\n", { mode: 0o600 });
    await symlink(external, paths.config, "dir");

    await expect(loadDaemonEnvironment(home, {})).rejects.toThrow(/real director/i);
  });

  it("parses quoted values, preserves pinned keys, and applies a missing daemon.env", async () => {
    const home = await temporaryDirectory("opentag-env-values-");
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.config, { mode: 0o700, recursive: true });
    const base = { PINNED: "from-base" };
    await writeFile(
      paths.daemonEnvironment,
      [
        "SINGLE='value'",
        'DOUBLE="line\\nnext\\tcolumn\\"quoted"',
        "EMPTY=",
        "UNQUOTED=plain",
        "BROKEN_SINGLE='value",
        'BROKEN_DOUBLE="value',
        "HAS_QUOTE=bad'value",
        "PINNED=from-file",
      ].join("\n"),
      { mode: 0o600 },
    );
    const loaded = await loadDaemonEnvironment(home, base);
    expect(loaded.env).toMatchObject({
      SINGLE: "value",
      DOUBLE: 'line\nnext\tcolumn"quoted',
      EMPTY: "",
      UNQUOTED: "plain",
      PINNED: "from-base",
    });
    expect(loaded.appliedKeys).toEqual(["SINGLE", "DOUBLE", "EMPTY", "UNQUOTED"]);
    expect(loaded.malformedLineNumbers).toEqual([5, 6, 7]);

    await rm(paths.daemonEnvironment);
    const environment = { BASE: "yes" };
    const applied = await applyDaemonEnvironment(home, environment);
    expect(applied.env).toEqual(environment);
    expect(applied.appliedKeys).toEqual([]);
  });
});

function visibleIdentity(serviceId: string) {
  return {
    launchdLabel: serviceId,
    launchdPlistName: `${serviceId}.plist`,
    launchdWrapperName: serviceId,
    systemdUnitName: `${serviceId}.service`,
  };
}

interface TestLeaseRecord {
  leaseId: string;
  pid: number;
  processStartId: string;
  startedAt: string;
}

function parseTestLease(value: unknown): TestLeaseRecord {
  if (!value || typeof value !== "object") throw new Error("invalid test lease");
  const record = value as Record<string, unknown>;
  if (
    typeof record.leaseId !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.processStartId !== "string" ||
    record.processStartId.length === 0 ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error("invalid test lease");
  }
  return record as unknown as TestLeaseRecord;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(path);
  return path;
}

function restoreEnvironment(key: "LANG" | "LC_ALL" | "TZ", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
