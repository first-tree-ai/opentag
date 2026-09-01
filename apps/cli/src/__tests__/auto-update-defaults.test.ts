import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdaterStateSnapshot } from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL } from "../build-info.js";
import { channelConfig } from "../core/channel/config.js";
import { readUpdaterState } from "../core/update/updater-state.js";

const installerMocks = vi.hoisted(() => ({ installPortableTarget: vi.fn() }));

vi.mock("../core/update/portable-installer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/update/portable-installer.js")>()),
  installPortableTarget: installerMocks.installPortableTarget,
}));

import { createPortableAutoUpdater } from "../core/update/auto-update.js";

const directories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempLayout(): Promise<{ binDir: string; home: string; root: string }> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-auto-update-"));
  directories.push(directory);
  const binDir = join(directory, "bin");
  const home = join(directory, "home");
  const root = join(directory, "portable");
  await mkdir(binDir, { recursive: true });
  return { binDir, home, root };
}

function memoryStore() {
  let stored: UpdaterStateSnapshot | undefined;
  return {
    state: () => stored,
    loadState: async () => stored,
    saveState: async (state: UpdaterStateSnapshot) => {
      stored = structuredClone(state);
    },
  };
}

function targetVersion(): string {
  return "999.0.0";
}

describe("portable automatic-upgrade defaults", () => {
  it("passes the exact advertised target and configured download base to the portable installer", async () => {
    const layout = await tempLayout();
    const store = memoryStore();
    const onHandoff = vi.fn();
    installerMocks.installPortableTarget.mockResolvedValue({ alreadyCurrent: false });
    const manager = createPortableAutoUpdater({
      home: layout.home,
      installMode: { mode: "portable", root: layout.root, binDir: layout.binDir },
      environment: { OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: "https://download.test/releases" },
      protectedWork: () => ({ total: 0 }),
      quiesce: () => () => undefined,
      onHandoff,
      refreshService: async () => undefined,
      stateStore: store,
    });

    manager.observe({ channel: CHANNEL, version: targetVersion() });
    await vi.waitFor(() => expect(store.state()?.state).toBe("installed"));

    expect(installerMocks.installPortableTarget).toHaveBeenCalledWith({
      channel: CHANNEL,
      targetVersion: targetVersion(),
      root: layout.root,
      binDir: layout.binDir,
      binName: channelConfig.binName,
      packageName: channelConfig.packageName,
      downloadBaseUrl: "https://download.test/releases",
    });
    expect(onHandoff).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("uses the default download base and durable filesystem state store when no overrides are supplied", async () => {
    const layout = await tempLayout();
    const onHandoff = vi.fn();
    installerMocks.installPortableTarget.mockResolvedValue({ alreadyCurrent: false });
    const manager = createPortableAutoUpdater({
      home: layout.home,
      installMode: { mode: "portable", root: layout.root, binDir: layout.binDir },
      environment: {},
      protectedWork: () => ({ total: 0 }),
      quiesce: () => () => undefined,
      onHandoff,
      refreshService: async () => undefined,
    });

    manager.observe({ channel: CHANNEL, version: targetVersion() });
    await vi.waitFor(() => expect(onHandoff).toHaveBeenCalledOnce());

    expect(installerMocks.installPortableTarget).toHaveBeenCalledWith({
      channel: CHANNEL,
      targetVersion: targetVersion(),
      root: layout.root,
      binDir: layout.binDir,
      binName: channelConfig.binName,
      packageName: channelConfig.packageName,
    });
    const loaded = await readUpdaterState(layout.home);
    expect(loaded).toMatchObject({ status: "ok", state: { state: "installed", target: targetVersion() } });
    manager.stop();
  });

  it("refreshes the daemon service through the stable shim after an injected install", async () => {
    const layout = await tempLayout();
    const store = memoryStore();
    await writeFile(
      join(layout.binDir, channelConfig.binName),
      '#!/bin/sh\n[ "$1" = "daemon" ] && [ "$2" = "refresh-service" ]\n',
      { mode: 0o755 },
    );
    const manager = createPortableAutoUpdater({
      home: layout.home,
      installMode: { mode: "portable", root: layout.root, binDir: layout.binDir },
      protectedWork: () => ({ total: 0 }),
      quiesce: () => () => undefined,
      onHandoff: () => undefined,
      installTarget: async () => undefined,
      stateStore: store,
    });

    manager.observe({ channel: CHANNEL, version: targetVersion() });
    await vi.waitFor(() => expect(store.state()?.state).toBe("installed"));
    manager.stop();
  });

  it("blocks the target when the new shim cannot refresh the daemon service", async () => {
    const layout = await tempLayout();
    const store = memoryStore();
    await writeFile(join(layout.binDir, channelConfig.binName), "#!/bin/sh\nexit 23\n", { mode: 0o755 });
    const manager = createPortableAutoUpdater({
      home: layout.home,
      installMode: { mode: "portable", root: layout.root, binDir: layout.binDir },
      protectedWork: () => ({ total: 0 }),
      quiesce: () => () => undefined,
      onHandoff: () => undefined,
      installTarget: async () => undefined,
      stateStore: store,
    });

    manager.observe({ channel: CHANNEL, version: targetVersion() });
    await vi.waitFor(() => expect(store.state()?.state).toBe("blocked"));
    expect(store.state()?.attempts[targetVersion()]).toMatchObject({
      result: "failed",
      failureReason: expect.stringContaining("exit code 23"),
    });
    manager.stop();
  });

  it("reports an executable error when the stable shim is missing", async () => {
    const layout = await tempLayout();
    const store = memoryStore();
    const manager = createPortableAutoUpdater({
      home: layout.home,
      installMode: { mode: "portable", root: layout.root, binDir: layout.binDir },
      protectedWork: () => ({ total: 0 }),
      quiesce: () => () => undefined,
      onHandoff: () => undefined,
      installTarget: async () => undefined,
      stateStore: store,
    });

    manager.observe({ channel: CHANNEL, version: targetVersion() });
    await vi.waitFor(() => expect(store.state()?.state).toBe("blocked"));
    expect(store.state()?.attempts[targetVersion()]?.failureReason).toContain("ENOENT");
    manager.stop();
  });
});
