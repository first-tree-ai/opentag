import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdaterStateSnapshot } from "@opentag/client";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDaemonPaths } from "../core/daemon/paths.js";
import { createUpdaterStateStore, readUpdaterState, UpdaterStateInvalidError } from "../core/update/updater-state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-updater-state-"));
  directories.push(home);
  return home;
}

function state(overrides: Partial<UpdaterStateSnapshot> = {}): UpdaterStateSnapshot {
  return {
    schemaVersion: 1,
    currentVersion: "0.0.2",
    state: "blocked",
    target: "0.0.3",
    attempts: {
      "0.0.3": {
        target: "0.0.3",
        startedAt: "2023-11-14T22:13:20.000Z",
        finishedAt: "2023-11-14T22:13:30.000Z",
        result: "failed",
        failureReason: "checksum mismatch",
      },
    },
    lastAttempt: {
      target: "0.0.3",
      startedAt: "2023-11-14T22:13:20.000Z",
      finishedAt: "2023-11-14T22:13:30.000Z",
      result: "failed",
      failureReason: "checksum mismatch",
    },
    ...overrides,
  };
}

describe("updater state store", () => {
  it("round-trips the durable state and reports a missing file", async () => {
    const home = await tempHome();
    expect((await readUpdaterState(home)).status).toBe("missing");
    const store = createUpdaterStateStore(home);
    expect(await store.loadState()).toBeUndefined();

    await store.saveState(state());
    const loaded = await readUpdaterState(home);
    expect(loaded).toEqual({ status: "ok", state: state() });
    expect(await store.loadState()).toEqual(state());
  });

  it("fails closed on malformed state instead of rewriting it", async () => {
    const home = await tempHome();
    const paths = resolveDaemonPaths(home);
    await mkdir(paths.daemonState, { recursive: true, mode: 0o700 });
    await writeFile(join(paths.daemonState, "updater.json"), "not json", { mode: 0o600 });
    expect((await readUpdaterState(home)).status).toBe("invalid");

    await writeFile(
      join(paths.daemonState, "updater.json"),
      JSON.stringify({ schemaVersion: 1, currentVersion: "0.0.2", state: "exploding", attempts: {} }),
      { mode: 0o600 },
    );
    expect((await readUpdaterState(home)).status).toBe("invalid");

    await writeFile(
      join(paths.daemonState, "updater.json"),
      JSON.stringify({ schemaVersion: 1, currentVersion: "not-semver", state: "idle", attempts: {} }),
      { mode: 0o600 },
    );
    expect((await readUpdaterState(home)).status).toBe("invalid");

    await writeFile(
      join(paths.daemonState, "updater.json"),
      JSON.stringify({ schemaVersion: 2, currentVersion: "0.0.2", state: "idle", attempts: {} }),
      { mode: 0o600 },
    );
    const store = createUpdaterStateStore(home);
    await expect(store.loadState()).rejects.toThrow(UpdaterStateInvalidError);
  });
});
