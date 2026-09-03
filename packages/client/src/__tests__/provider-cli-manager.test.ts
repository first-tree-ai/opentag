import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

// Real child-process lifecycle cases need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import {
  type ProviderCliCatalogEntry,
  ProviderCliManager,
  type ProviderCliManagerDeps,
  readProviderCliSelection,
  requireProviderCliCatalogEntry,
  resolveProviderCliAccountLayout,
} from "../index.js";
import {
  fakeCliScript,
  loopbackFetcher,
  makeFixtureCatalog,
  makeTempDir,
  sha256Hex,
  startFixtureHttpServer,
  writeFakeCli,
} from "./fixtures/provider-cli.js";

const canon = (path: string): string => realpathSync(path);

const execFileAsync = promisify(execFile);

interface ManagerFixture {
  readonly accountHome: string;
  readonly layout: ReturnType<typeof resolveProviderCliAccountLayout>;
  readonly manager: ProviderCliManager;
  readonly pathDirs: string[];
}

async function makeManager(options: {
  pathDirs?: readonly string[];
  catalog?: readonly ProviderCliCatalogEntry[];
  env?: NodeJS.ProcessEnv;
  beforeWinnerReverify?: ProviderCliManagerDeps["beforeWinnerReverify"];
}): Promise<ManagerFixture> {
  const accountHome = await makeTempDir("opentag-manager-");
  const layout = resolveProviderCliAccountLayout(accountHome);
  const pathDirs = [...(options.pathDirs ?? [])];
  const env = options.env ?? { PATH: pathDirs.join(delimiter) };
  const manager = new ProviderCliManager({
    accountHome,
    fetcher: loopbackFetcher,
    env,
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.beforeWinnerReverify ? { beforeWinnerReverify: options.beforeWinnerReverify } : {}),
  });
  return { accountHome, layout, manager, pathDirs };
}

async function makeManagedCatalog(provider: "feishu" | "slack", version: string) {
  const routes = new Map<string, Uint8Array | { body: Uint8Array; truncateTo: number } | null>();
  const server = await startFixtureHttpServer(routes);
  const fixture = makeFixtureCatalog({ provider, version, baseUrl: server.baseUrl });
  routes.set(fixture.routePath, fixture.archive);
  return { server, fixture, catalog: [fixture.entry] };
}

describe("ProviderCliManager inspect", () => {
  it("reports absent on a fresh account root", async () => {
    const { manager } = await makeManager({});
    const inspection = await manager.inspect("feishu");
    expect(inspection.state).toBe("absent");
    expect(inspection.readiness).toBe("install");
    expect(inspection.diagnostic?.code).toBe("not_installed");
  });

  it("fails closed on an unsupported platform", async () => {
    const accountHome = await makeTempDir("opentag-manager-");
    const manager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, platform: "win32" });
    const inspection = await manager.inspect("feishu");
    expect(inspection.state).toBe("unavailable");
    expect(inspection.diagnostic?.code).toBe("unsupported_platform");
  });
});

describe("ProviderCliManager ensure", () => {
  it("installs the managed artifact when no external candidate exists", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { manager, layout } = await makeManager({ catalog });
      const phases: string[] = [];
      const result = await manager.ensure("feishu", {
        onPhase: (event) => phases.push(`${event.phase}:${event.status}`),
      });
      expect(result.ok).toBe(true);
      expect(result.action).toBe("installed-managed");
      expect(result.readiness).toBe("ready");
      expect(result.selected?.version).toBe("1.0.92");
      expect(result.selected?.trust).toBe("catalog-verified");
      expect(phases).toContain("detect:completed");
      expect(phases).toContain("managed-install:started");
      expect(phases).toContain("managed-install:completed");
      expect(phases).toContain("verify:completed");

      // The launcher executes the managed target exactly.
      const launcher = join(layout.bin, "lark-cli");
      const { stdout } = await execFileAsync(launcher, ["--version"]);
      expect(stdout.trim()).toBe("lark-cli version 1.0.92");

      // The selection record and immutable version directory exist.
      const selection = await readProviderCliSelection(layout, "feishu");
      expect(selection?.selection.kind).toBe("managed");
      expect(selection?.generation).toBe(1);
      const target = result.selected?.path ?? "";
      expect((await stat(target)).mode & 0o222).toBe(0);

      // Rerunning is an idempotent noop.
      const again = await manager.ensure("feishu", {});
      expect(again.ok).toBe(true);
      expect(again.action).toBe("noop");
    } finally {
      await server.close();
    }
  });

  it("upgrades an older managed selection when no eligible external candidate exists", async () => {
    const older = await makeManagedCatalog("feishu", "1.0.91");
    const newer = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome, layout } = await makeManager({});
      const oldManager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: "" },
        catalog: older.catalog,
      });
      expect((await oldManager.ensure("feishu")).ok).toBe(true);

      const newManager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: "" },
        catalog: newer.catalog,
      });
      const result = await newManager.ensure("feishu");
      expect(result).toMatchObject({ ok: true, action: "installed-managed" });
      expect(result.selected?.version).toBe("1.0.92");
      expect(result.candidates).toContainEqual(
        expect.objectContaining({ version: "1.0.91", disposition: "ignored", reason: "older-managed-version" }),
      );
      const selection = await readProviderCliSelection(layout, "feishu");
      expect(selection?.selection.version).toBe("1.0.92");
      expect(selection?.generation).toBe(2);
    } finally {
      await older.server.close();
      await newer.server.close();
    }
  });

  it("selects the only external candidate and warns about unverified trust", async () => {
    const { accountHome, manager } = await makeManager({});
    const bin = join(accountHome, "tools");
    await writeFakeCli(bin, "feishu", { version: "1.0.92" });
    const withPath = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: bin } });

    const result = await withPath.ensure("feishu", {});
    expect(result.ok).toBe(true);
    expect(result.action).toBe("selected-existing");
    expect(result.selected?.source).toBe(canon(bin));
    expect(result.selected?.trust).toBe("compatible-unverified");
    expect(result.warnings.map((entry) => entry.code)).toContain("external_candidate_unverified");
    expect(result.candidates.find((candidate) => candidate.disposition === "selected")?.reason).toBe(
      "newest compatible version",
    );
    void manager;
  });

  it("selects the newest version among multiple external candidates and reports the rest", async () => {
    const { accountHome } = await makeManager({});
    const older = join(accountHome, "older");
    const newer = join(accountHome, "newer");
    const oldest = join(accountHome, "oldest");
    await writeFakeCli(older, "feishu", { version: "1.0.90" });
    await writeFakeCli(newer, "feishu", { version: "1.0.92" });
    await writeFakeCli(oldest, "feishu", { version: "1.0.89" });
    const manager = new ProviderCliManager({
      accountHome,
      fetcher: loopbackFetcher,
      env: { PATH: [older, newer, oldest].join(delimiter) },
    });
    const result = await manager.ensure("feishu", {});
    expect(result.action).toBe("selected-existing");
    expect(result.selected?.version).toBe("1.0.92");
    expect(result.selected?.path).toBe(canon(join(newer, "lark-cli")));
    const ignored = result.candidates.filter((candidate) => candidate.disposition === "ignored");
    expect(ignored.map((candidate) => candidate.version).sort()).toEqual(["1.0.89", "1.0.90"]);
    expect(ignored.every((candidate) => candidate.reason === "older compatible version")).toBe(true);
  });

  it("breaks version ties by catalog-verified trust, then PATH order", async () => {
    const { accountHome } = await makeManager({});
    const verifiedDir = join(accountHome, "verified");
    const plainDir = join(accountHome, "plain");
    // "Verified" fixture: digest matches the fixture catalog entry.
    const content = fakeCliScript("feishu", { version: "1.0.92" });
    await writeFakeCli(verifiedDir, "feishu", { version: "1.0.92" });
    await writeFakeCli(plainDir, "feishu", { version: "1.0.92", versionOutput: "lark-cli version 1.0.92 (custom)" });
    const entry = requireProviderCliCatalogEntry("feishu");
    const catalogEntry: ProviderCliCatalogEntry = {
      ...entry,
      artifacts: entry.artifacts.map((artifact) => ({ ...artifact, executableSha256: sha256Hex(content) })),
    };
    const manager = new ProviderCliManager({
      accountHome,
      fetcher: loopbackFetcher,
      env: { PATH: [plainDir, verifiedDir].join(delimiter) },
      catalog: [catalogEntry],
    });
    const result = await manager.ensure("feishu", {});
    expect(result.selected?.path).toBe(canon(join(verifiedDir, "lark-cli")));
    expect(result.selected?.trust).toBe("catalog-verified");
    expect(result.candidates.find((candidate) => candidate.disposition === "selected")?.reason).toBe(
      "catalog-verified trust",
    );
  });

  it("keeps the incumbent on exact ties and reports noop on reruns", async () => {
    const { accountHome } = await makeManager({});
    const first = join(accountHome, "first");
    const second = join(accountHome, "second");
    await writeFakeCli(first, "feishu", { version: "1.0.92" });
    const manager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: first } });
    const initial = await manager.ensure("feishu", {});
    expect(initial.action).toBe("selected-existing");

    // A same-version candidate earlier in PATH does not displace the incumbent.
    await writeFakeCli(second, "feishu", { version: "1.0.92" });
    const withBoth = new ProviderCliManager({
      accountHome,
      fetcher: loopbackFetcher,
      env: { PATH: [second, first].join(delimiter) },
    });
    const rerun = await withBoth.ensure("feishu", {});
    expect(rerun.ok).toBe(true);
    expect(rerun.action).toBe("noop");
    expect(rerun.selected?.path).toBe(canon(join(first, "lark-cli")));
  });

  it("notices a newer external installation over a managed incumbent", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome } = await makeManager({});
      const managedManager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: "" },
        catalog,
      });
      const installed = await managedManager.ensure("feishu", {});
      expect(installed.action).toBe("installed-managed");

      const newer = join(accountHome, "newer");
      await writeFakeCli(newer, "feishu", { version: "1.0.93" });
      const withExternal = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: newer },
        catalog,
      });
      const switched = await withExternal.ensure("feishu", {});
      expect(switched.action).toBe("selected-existing");
      expect(switched.selected?.version).toBe("1.0.93");
      expect(switched.selected?.source).toBe(canon(newer));
    } finally {
      await server.close();
    }
  });

  it("never falls back to managed install while an eligible external candidate exists", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome } = await makeManager({});
      const external = join(accountHome, "external");
      await writeFakeCli(external, "feishu", { version: "1.0.80" }); // older than the catalog version
      const manager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: external },
        catalog,
      });
      const result = await manager.ensure("feishu", {});
      expect(result.action).toBe("selected-existing");
      expect(result.selected?.version).toBe("1.0.80");
      expect(server.requests).toEqual([]); // no download happened
    } finally {
      await server.close();
    }
  });

  it("managed-only skips external candidates and installs the reviewed artifact", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome } = await makeManager({});
      const external = join(accountHome, "external");
      await writeFakeCli(external, "feishu", { version: "1.0.99" });
      const manager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: external },
        catalog,
      });
      const result = await manager.ensure("feishu", { mode: "managed-only" });
      expect(result.action).toBe("installed-managed");
      expect(result.selected?.version).toBe("1.0.92");
      expect(result.selected?.trust).toBe("catalog-verified");
    } finally {
      await server.close();
    }
  });

  it("dry-run detects and ranks without writing anything", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome, layout } = await makeManager({});
      const external = join(accountHome, "external");
      await writeFakeCli(external, "feishu", { version: "1.0.90" });

      const withExternal = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: external },
        catalog,
      });
      const dryExternal = await withExternal.ensure("feishu", { dryRun: true });
      expect(dryExternal.ok).toBe(true);
      expect(dryExternal.action).toBe("selected-existing");
      expect(dryExternal.dryRun).toBe(true);

      const empty = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: "" }, catalog });
      const dryManaged = await empty.ensure("feishu", { dryRun: true });
      expect(dryManaged.action).toBe("installed-managed");

      // No selection, version dirs, launchers, or downloads happened.
      await expect(readProviderCliSelection(layout, "feishu")).resolves.toBeUndefined();
      await expect(stat(layout.versions)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(layout.bin)).rejects.toMatchObject({ code: "ENOENT" });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("re-ranks when the winner changes before persistence", async () => {
    const { accountHome } = await makeManager({});
    const first = join(accountHome, "first");
    const second = join(accountHome, "second");
    const firstTarget = await writeFakeCli(first, "feishu", { version: "1.0.92" });
    await writeFakeCli(second, "feishu", { version: "1.0.91" });

    let swaps = 0;
    const manager = new ProviderCliManager({
      accountHome,
      fetcher: loopbackFetcher,
      env: { PATH: [first, second].join(delimiter) },
      beforeWinnerReverify: async (winner) => {
        if (swaps === 0) {
          swaps += 1;
          // Replace the winning file between detection and persistence.
          await writeFile(
            winner.path,
            fakeCliScript("feishu", { version: "1.0.92", versionOutput: "lark-cli version 9.9.9" }),
            {
              mode: 0o755,
            },
          );
          await chmod(winner.path, 0o755);
        }
      },
    });
    const result = await manager.ensure("feishu", {});
    expect(swaps).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("selected-existing");
    expect(result.selected?.path).toBe(canon(join(second, "lark-cli")));
    expect(
      result.candidates.some(
        (candidate) => candidate.path === canon(firstTarget) && candidate.reason === "external-candidate-changed",
      ),
    ).toBe(true);
  });

  it("preserves the prior selection when a managed install fails before publication", async () => {
    const { accountHome, layout } = await makeManager({});
    const external = join(accountHome, "external");
    await writeFakeCli(external, "feishu", { version: "1.0.90" });
    const externalManager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: external } });
    const selected = await externalManager.ensure("feishu", {});
    expect(selected.action).toBe("selected-existing");
    const before = await readProviderCliSelection(layout, "feishu");

    // Remove the external candidate and serve a broken archive.
    await writeFile(join(external, "lark-cli"), fakeCliScript("feishu", { version: "1.0.90", surfaceExit: 9 }), {
      mode: 0o755,
    });
    const routes = new Map<string, Uint8Array | { body: Uint8Array; truncateTo: number } | null>();
    const server = await startFixtureHttpServer(routes);
    try {
      const fixture = makeFixtureCatalog({ provider: "feishu", version: "1.0.92", baseUrl: server.baseUrl });
      routes.set(fixture.routePath, null); // HTTP 500
      const broken = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: external },
        catalog: [fixture.entry],
      });
      const result = await broken.ensure("feishu", {});
      expect(result.ok).toBe(false);
      expect(result.diagnostic?.code).toBe("install_incomplete");
      expect(result.phases).toContainEqual({
        phase: "managed-install",
        status: "failed",
        detail: "install_incomplete",
      });
      expect(result.candidates).toContainEqual(
        expect.objectContaining({ path: canon(join(external, "lark-cli")), disposition: "ignored" }),
      );

      const after = await readProviderCliSelection(layout, "feishu");
      expect(after).toEqual(before);
    } finally {
      await server.close();
    }
  });

  it("reports global_command_shadowed without failing readiness", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome, layout } = await makeManager({});
      // A foreign lark-cli earlier in PATH than the OpenTag shim directory.
      const foreign = join(accountHome, "foreign");
      await mkdir(foreign, { recursive: true });
      await writeFile(join(foreign, "lark-cli"), "#!/bin/sh\necho foreign\n", { mode: 0o755 });
      await chmod(join(foreign, "lark-cli"), 0o755);
      const manager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: [foreign, layout.publicBinDir].join(delimiter) },
        catalog,
      });
      const result = await manager.ensure("feishu", { mode: "managed-only" });
      expect(result.ok).toBe(true);
      expect(result.action).toBe("installed-managed");
      expect(result.warnings.map((entry) => entry.code)).toContain("global_command_shadowed");
      expect(result.globalCommand.active).toBe(false);
      expect(result.globalCommand.resolvedPath).toBe(canon(join(foreign, "lark-cli")));
      // The shim still exists and points at the internal launcher.
      const shim = await readFile(join(layout.publicBinDir, "lark-cli"), "utf8");
      expect(shim).toContain("opentag-provider-cli-shim");
    } finally {
      await server.close();
    }
  });

  it("does not overwrite an unmanaged public command", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome, layout } = await makeManager({});
      await mkdir(layout.publicBinDir, { recursive: true });
      const occupied = join(layout.publicBinDir, "lark-cli");
      await writeFile(occupied, "#!/bin/sh\necho user-owned\n", { mode: 0o755 });
      await chmod(occupied, 0o755);
      const manager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: layout.publicBinDir },
        catalog,
      });
      const result = await manager.ensure("feishu", {});
      expect(result.ok).toBe(true);
      // The unmanaged file is untouched.
      expect(await readFile(occupied, "utf8")).toBe("#!/bin/sh\necho user-owned\n");
      expect(result.warnings.map((entry) => entry.code)).toContain("global_command_shadowed");
    } finally {
      await server.close();
    }
  });

  it("reports the managed installation as globally active through the shim", async () => {
    const { server, catalog } = await makeManagedCatalog("slack", "4.7.0");
    try {
      const { accountHome, layout } = await makeManager({});
      const manager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: layout.publicBinDir },
        catalog,
      });
      const result = await manager.ensure("slack", {});
      expect(result.ok).toBe(true);
      expect(result.action).toBe("installed-managed");
      expect(result.globalCommand.active).toBe(true);
      // The launcher runs the managed slack target with the skip-update flag handled.
      const { stdout } = await execFileAsync(join(layout.bin, "slack"), ["version"]);
      expect(stdout.trim()).toBe("Using slack v4.7.0");
      const shimmed = await execFileAsync(join(layout.publicBinDir, "slack"), ["version"]);
      expect(shimmed.stdout.trim()).toBe("Using slack v4.7.0");
    } finally {
      await server.close();
    }
  });

  it("--no-path-update leaves the command globally inactive without a warning downgrade", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome, layout } = await makeManager({});
      const manager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: "" }, catalog });
      const result = await manager.ensure("feishu", { pathUpdate: false });
      expect(result.ok).toBe(true);
      expect(result.globalCommand.active).toBe(false);
      await expect(stat(join(layout.publicBinDir, "lark-cli"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
    }
  });

  it("refuses to silently replace a managed installation outside the catalog range", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome, layout } = await makeManager({});
      const manager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: "" }, catalog });
      await manager.ensure("feishu", {});

      // The catalog narrows so the installed managed version is no longer compatible.
      const base = catalog[0];
      expect(base).toBeDefined();
      const narrowed: ProviderCliCatalogEntry = {
        ...(base as ProviderCliCatalogEntry),
        compatibility: ">=1.1.0 <2.0.0",
      };
      const olderManager = new ProviderCliManager({
        accountHome,
        fetcher: loopbackFetcher,
        env: { PATH: "" },
        catalog: [narrowed],
      });
      const result = await olderManager.ensure("feishu", {});
      expect(result.ok).toBe(false);
      expect(result.diagnostic?.code).toBe("version_incompatible");
      // The selection still points at the existing managed install.
      const selection = await readProviderCliSelection(layout, "feishu");
      expect(selection?.selection.kind).toBe("managed");
      expect(selection?.selection.version).toBe("1.0.92");
    } finally {
      await server.close();
    }
  });

  it("recovers from a crash that left stale staging behind", async () => {
    const { server, catalog } = await makeManagedCatalog("feishu", "1.0.92");
    try {
      const { accountHome, layout } = await makeManager({});
      const stale = join(layout.staging, "feishu", "5f3a2b9c-1111-4000-8000-000000000000");
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "leftover"), "partial");
      const manager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: "" }, catalog });
      const result = await manager.ensure("feishu", {});
      expect(result.ok).toBe(true);
      await expect(readdir(layout.staging)).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails with operation_in_progress when the provider lock is held", async () => {
    const { accountHome, layout } = await makeManager({});
    await mkdir(layout.state, { recursive: true });
    // A live lock holder: this process itself owns the pid.
    await writeFile(join(layout.state, "feishu.lock"), JSON.stringify({ pid: process.pid, token: "other-token" }));
    const manager = new ProviderCliManager({
      accountHome,
      fetcher: loopbackFetcher,
      env: { PATH: "" },
      sleep: async () => {},
    });
    const result = await manager.ensure("feishu", {});
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.code).toBe("operation_in_progress");
  });
});

describe("ProviderCliManager drift and repair", () => {
  it("reports artifact_drifted when the selected external executable changes", async () => {
    const { accountHome } = await makeManager({});
    const external = join(accountHome, "external");
    const target = await writeFakeCli(external, "feishu", { version: "1.0.92" });
    const manager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: external } });
    await manager.ensure("feishu", {});

    await writeFile(target, fakeCliScript("feishu", { version: "1.0.92", versionOutput: "lark-cli version 9.9.9" }), {
      mode: 0o755,
    });
    await chmod(target, 0o755);
    const inspection = await manager.inspect("feishu");
    expect(inspection.state).toBe("unavailable");
    expect(inspection.diagnostic?.code).toBe("artifact_drifted");
  });

  it("repairs a replaced launcher on the next ensure", async () => {
    const { accountHome, layout } = await makeManager({});
    const external = join(accountHome, "external");
    await writeFakeCli(external, "feishu", { version: "1.0.92" });
    const manager = new ProviderCliManager({ accountHome, fetcher: loopbackFetcher, env: { PATH: external } });
    await manager.ensure("feishu", {});

    await writeFile(join(layout.bin, "lark-cli"), "#!/bin/sh\necho forged\n", { mode: 0o755 });
    const drifted = await manager.inspect("feishu");
    expect(drifted.state).toBe("unavailable");
    expect(drifted.diagnostic?.code).toBe("launcher_invalid");

    const repaired = await manager.ensure("feishu", {});
    expect(repaired.ok).toBe(true);
    expect(repaired.action).toBe("noop");
    expect((await manager.inspect("feishu")).state).toBe("ready");
  });
});
