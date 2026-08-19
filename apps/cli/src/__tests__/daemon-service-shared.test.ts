import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannelConfig } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { loadDaemonEnvironment } from "../core/daemon/environment.js";
import {
  acquireServiceOperationLease,
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

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}
