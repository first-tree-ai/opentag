import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDaemonOwner, inspectDaemonOwner } from "../core/daemon/ownership.js";

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
    await writeFile(
      join(home, "daemon-owner.json"),
      `${JSON.stringify({
        home,
        instanceId: "stale-instance",
        ownerId: "stale-owner",
        pid: 2_147_483_647,
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
    await writeFile(join(home, "daemon-owner.json"), "{}\n", { mode: 0o600 });
    await expect(inspectDaemonOwner(home)).rejects.toThrow("malformed");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opentag-owner-"));
  directories.push(path);
  return path;
}
