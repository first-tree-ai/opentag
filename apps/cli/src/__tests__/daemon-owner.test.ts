import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDaemonOwner } from "../core/daemon/ownership.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "opentag-owner-"));
  directories.push(path);
  return path;
}

describe("daemon ownership", () => {
  it("allows only one owner per home and releases only itself", async () => {
    const path = await home();
    const first = await acquireDaemonOwner(path, crypto.randomUUID());
    await expect(acquireDaemonOwner(path, crypto.randomUUID())).rejects.toThrow("already running");
    await first.release();
    const second = await acquireDaemonOwner(path, crypto.randomUUID());
    await second.release();
  });

  it("fails closed for malformed owner state", async () => {
    const path = await home();
    await writeFile(join(path, "daemon-owner.json"), "not-json");
    await expect(acquireDaemonOwner(path, crypto.randomUUID())).rejects.toThrow("malformed");
  });
});
