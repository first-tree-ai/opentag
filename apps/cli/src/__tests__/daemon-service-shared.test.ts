import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannelConfig } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { loadDaemonEnvironment } from "../core/daemon/environment.js";
import {
  acquireProcessFileLease,
  inspectDarwinProcessIdentity,
  ProcessLeaseUnverifiableError,
} from "../core/daemon/process-lease.js";
import {
  acquireServiceOperationLease,
  canonicalizeServiceHome,
  deriveServiceIdentity,
  escapeXml,
  quotePosix,
  quoteSystemdEnvironment,
  quoteSystemdToken,
  runRequired,
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
    await expect(canonicalizeServiceHome(alias)).resolves.toBe(actual);
  });

  it("atomically replaces files and leaves no temporary files", async () => {
    const root = await temporaryDirectory("opentag-atomic-");
    const path = join(root, "nested", "service");
    await writeFileAtomically(path, "first", 0o600);
    await writeFileAtomically(path, "second", 0o600);
    expect(await readFile(path, "utf8")).toBe("second");
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
    const first = await acquireServiceOperationLease(home);
    await expect(acquireServiceOperationLease(home)).rejects.toThrow("already running");
    await first.release();
    const second = await acquireServiceOperationLease(home);
    await second.release();
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

  it("keeps Darwin process identity stable across parent locale and timezone changes", async () => {
    const original = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
    };
    try {
      process.env.LANG = "fr_FR.UTF-8";
      process.env.LC_ALL = "fr_FR.UTF-8";
      process.env.TZ = "Pacific/Honolulu";
      const first = await inspectDarwinProcessIdentity(process.pid);

      process.env.LANG = "ja_JP.UTF-8";
      process.env.LC_ALL = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      const second = await inspectDarwinProcessIdentity(process.pid);

      expect(first).toMatchObject({ state: "identified" });
      expect(second).toEqual(first);
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
  });
});

describe("daemon.env", () => {
  it("fills missing keys without overriding pinned values or logging values", async () => {
    const home = await temporaryDirectory("opentag-env-");
    await writeFile(
      join(home, "daemon.env"),
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
    const target = join(home, "target.env");
    await writeFile(target, "KEY=value\n", { mode: 0o600 });
    await symlink(target, join(home, "daemon.env"));
    await expect(loadDaemonEnvironment(home, {})).rejects.toThrow("regular file");
    await rm(join(home, "daemon.env"));
    await writeFile(join(home, "daemon.env"), "KEY=value\n", { mode: 0o600 });
    await chmod(join(home, "daemon.env"), 0o644);
    await expect(loadDaemonEnvironment(home, {})).rejects.toThrow("permissions");
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
  const path = await mkdtemp(join(tmpdir(), prefix));
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
