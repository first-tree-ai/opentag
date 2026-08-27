import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDaemonOwner, inspectDaemonOwner } from "../core/daemon/ownership.js";
import { resolveDaemonPaths } from "../core/daemon/paths.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon owner inspection", () => {
  it("reports a live owner and releases it", async () => {
    const home = await temporaryDirectory();
    const lease = await acquireDaemonOwner(home, "instance");
    expect(await inspectDaemonOwner(home)).toMatchObject({ state: "live", record: { instanceId: "instance" } });
    await lease.release();
    expect(await inspectDaemonOwner(home)).toEqual({ state: "missing" });
  });

  it("allows only one live owner per home", async () => {
    const home = await temporaryDirectory();
    const first = await acquireDaemonOwner(home, crypto.randomUUID());
    await expect(acquireDaemonOwner(home, crypto.randomUUID())).rejects.toThrow("already running");
    await first.release();
    const second = await acquireDaemonOwner(home, crypto.randomUUID());
    await second.release();
  });

  it("quarantines a stale owner when acquiring the next lease", async () => {
    const home = await temporaryDirectory();
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.daemonState, { mode: 0o700, recursive: true });
    await writeFile(
      paths.daemonOwner,
      `${JSON.stringify({
        home,
        instanceId: "stale-instance",
        ownerId: "stale-owner",
        pid: 2_147_483_647,
        processStartId: "dead-process",
        startedAt: new Date(0).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    expect(await inspectDaemonOwner(home)).toMatchObject({ state: "stale" });
    const lease = await acquireDaemonOwner(home, "new-instance");
    expect(lease.owner.instanceId).toBe("new-instance");
    await lease.release();
  });

  it("fails closed on malformed owner records", async () => {
    const home = await temporaryDirectory();
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.daemonState, { mode: 0o700, recursive: true });
    await writeFile(paths.daemonOwner, "{}\n", { mode: 0o600 });
    await expect(inspectDaemonOwner(home)).rejects.toThrow("malformed");
  });

  it("rejects a symlinked nested daemon state directory", async () => {
    const home = await temporaryDirectory();
    const external = await temporaryDirectory();
    await symlink(external, join(home, "state"), "dir");

    await expect(acquireDaemonOwner(home, "instance")).rejects.toThrow(/real director/i);
    expect(await readdir(external)).toEqual([]);
  });

  it.each([
    ["a non-positive PID", { pid: 0, processStartId: "process-start" }],
    ["an empty process start identity", { pid: process.pid, processStartId: "" }],
  ])("rejects %s in an owner record", async (_label, invalid) => {
    const home = await temporaryDirectory();
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.daemonState, { mode: 0o700, recursive: true });
    await writeFile(
      paths.daemonOwner,
      `${JSON.stringify({
        home,
        instanceId: "instance",
        ownerId: "owner",
        startedAt: new Date(0).toISOString(),
        ...invalid,
      })}\n`,
      { mode: 0o600 },
    );
    await expect(inspectDaemonOwner(home)).rejects.toThrow("malformed");
  });
});

async function temporaryDirectory(): Promise<string> {
  // Temp roots are symlinked on macOS, so canonicalize to match the paths the code under test resolves.
  const path = await realpath(await mkdtemp(join(tmpdir(), "opentag-owner-")));
  directories.push(path);
  return path;
}
