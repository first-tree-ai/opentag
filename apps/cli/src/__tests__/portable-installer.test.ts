import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installPortableTarget,
  PortableInstallError,
  portableInstallIsCurrent,
  renderPortableShim,
} from "../core/update/portable-installer.js";

const PLATFORM = "linux-x64";
const CHANNEL = "staging" as const;
const VERSION = "0.0.3-staging.1.1";
const BIN_NAME = "opentag-staging";
const PACKAGE_NAME = "open-tag-staging";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A payload fixture laid out exactly like a released portable tarball's contents. */
async function createPayloadFixture(version: string): Promise<string> {
  const fixture = await tempDir("opentag-payload-fixture-");
  const root = join(fixture, "payload");
  await mkdir(join(root, "node", "bin"), { recursive: true });
  await mkdir(join(root, "app", "cli"), { recursive: true });
  await writeFile(join(root, "node", "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, "app", "cli", "index.mjs"), "// cli\n");
  await writeFile(join(root, "VERSION"), `${version}\n`);
  await writeFile(
    join(root, "INSTALL.json"),
    JSON.stringify({
      schemaVersion: 1,
      channel: CHANNEL,
      version,
      gitSha: "abc123",
      nodeVersion: "v24.0.0",
      packageName: PACKAGE_NAME,
      binName: BIN_NAME,
      serviceId: "opentag-staging",
      generatedAt: "2023-11-14T22:13:20.000Z",
      platform: PLATFORM,
      installMode: "portable",
      appEntry: "app/cli/index.mjs",
    }),
  );
  return root;
}

function manifestFor(version: string, payload: Buffer, url: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    channel: CHANNEL,
    version,
    gitSha: "abc123",
    nodeVersion: "v24.0.0",
    packageName: PACKAGE_NAME,
    binName: BIN_NAME,
    serviceId: "opentag-staging",
    generatedAt: "2023-11-14T22:13:20.000Z",
    ...overrides,
    assets: [
      {
        platform: PLATFORM,
        fileName: `${PACKAGE_NAME}-${version}-${PLATFORM}.tar.gz`,
        url,
        sha256: createHash("sha256").update(payload).digest("hex"),
        size: payload.byteLength,
      },
    ],
  };
}

interface InstallHarness {
  root: string;
  binDir: string;
  home: string;
  payloadBytes: Buffer;
  fetchFn: typeof fetch;
  requested: string[];
  smokeChecks: string[];
  install(target?: string): Promise<unknown>;
}

async function installHarness(payloadFixture: string): Promise<InstallHarness> {
  const base = await tempDir("opentag-portable-install-");
  const root = join(base, "portable");
  const binDir = join(base, "bin");
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  const payloadBytes = Buffer.from("fake-tarball-bytes");
  const requested: string[] = [];
  const smokeChecks: string[] = [];
  const manifest = manifestFor(
    VERSION,
    payloadBytes,
    "https://download.test/releases/staging/0.0.3-staging.1.1/payload.tar.gz",
  );
  const fetchFn = (async (url: string | URL | Request) => {
    const value = String(url);
    requested.push(value);
    if (value.endsWith("/manifest.json")) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    if (value.endsWith("/payload.tar.gz")) {
      return new Response(new Uint8Array(payloadBytes), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    root,
    binDir,
    home,
    payloadBytes,
    fetchFn,
    requested,
    smokeChecks,
    install: async (target = VERSION) =>
      installPortableTarget({
        channel: CHANNEL,
        targetVersion: target,
        root,
        binDir,
        binName: BIN_NAME,
        packageName: PACKAGE_NAME,
        downloadBaseUrl: "https://download.test/releases",
        platform: PLATFORM,
        fetchFn,
        extractTarball: async (_tarball, destination) => {
          await cp(payloadFixture, destination, { recursive: true });
        },
        runSmokeCheck: async (payloadDir) => {
          smokeChecks.push(payloadDir);
        },
      }),
  };
}

describe("portable installer", () => {
  it("installs an immutable version, writes the stable shim, and switches current atomically", async () => {
    const fixture = await createPayloadFixture(VERSION);
    const h = await installHarness(fixture);
    await writeFile(join(h.home, "computer-identity.json"), "preserved");

    const result = (await h.install()) as { alreadyCurrent: boolean; versionDir: string };
    expect(result).toMatchObject({ alreadyCurrent: false, versionDir: join(h.root, "versions", VERSION) });

    // Immutable version directory with the payload contents.
    const install = JSON.parse(await readFile(join(h.root, "versions", VERSION, "INSTALL.json"), "utf8"));
    expect(install).toMatchObject({ version: VERSION, installMode: "portable", binName: BIN_NAME });

    // The current symlink is a symlink and resolves to the new version directory.
    const currentStats = await lstat(join(h.root, "current"));
    expect(currentStats.isSymbolicLink()).toBe(true);
    expect(await readlink(join(h.root, "current"))).toBe(join(h.root, "versions", VERSION));

    // The stable shim resolves through current and exports the portable environment, exactly like
    // the shell installer's shim.
    const shim = await readFile(join(h.binDir, BIN_NAME), "utf8");
    expect(shim).toBe(renderPortableShim(join(h.root, "current"), h.binDir));
    expect(shim).toContain("export OPENTAG_INSTALL_MODE=portable");
    expect(shim).toContain('exec "$root/node/bin/node" "$root/app/cli/index.mjs" "$@"');
    const shimStats = await lstat(join(h.binDir, BIN_NAME));
    expect(shimStats.mode & 0o111).not.toBe(0);

    // The payload was smoke-checked where it was extracted, before the commit point.
    expect(h.smokeChecks).toHaveLength(1);
    expect(h.smokeChecks[0]).toContain(join(h.root, ".tmp"));
    expect(h.smokeChecks[0]).toContain(VERSION);

    // The OpenTag home is untouched: durable identity survives the upgrade.
    expect(await readFile(join(h.home, "computer-identity.json"), "utf8")).toBe("preserved");

    // A second install of the same target is a no-op: no downloads, no rewrites.
    const requestsBefore = h.requested.length;
    const second = (await h.install()) as { alreadyCurrent: boolean };
    expect(second.alreadyCurrent).toBe(true);
    expect(h.requested.length).toBe(requestsBefore);
  });

  it("verifies the payload checksum and leaves the live install untouched on mismatch", async () => {
    const fixture = await createPayloadFixture(VERSION);
    const h = await installHarness(fixture);
    const oldVersion = join(h.root, "versions", "0.0.2-staging.1.0");
    await mkdir(oldVersion, { recursive: true });
    await symlink(oldVersion, join(h.root, "current"));

    const base = await tempDir("opentag-portable-bad-");
    const root = join(base, "portable");
    const binDir = join(base, "bin");
    const payloadBytes = Buffer.from("tampered-payload");
    const manifest = manifestFor(VERSION, payloadBytes, "https://download.test/x/payload.tar.gz");
    const fetchFn = (async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/manifest.json")) return new Response(JSON.stringify(manifest), { status: 200 });
      return new Response(new Uint8Array(Buffer.from("tampered-payloaX")), { status: 200 });
    }) as typeof fetch;
    await mkdir(join(h.root, "versions"), { recursive: true });
    await expect(
      installPortableTarget({
        channel: CHANNEL,
        targetVersion: VERSION,
        root: h.root,
        binDir: h.binDir,
        binName: BIN_NAME,
        packageName: PACKAGE_NAME,
        downloadBaseUrl: "https://download.test/releases",
        platform: PLATFORM,
        fetchFn,
        extractTarball: async () => undefined,
      }),
    ).rejects.toThrow(PortableInstallError);
    await expect(
      installPortableTarget({
        channel: CHANNEL,
        targetVersion: VERSION,
        root,
        binDir,
        binName: BIN_NAME,
        packageName: PACKAGE_NAME,
        downloadBaseUrl: "https://download.test/releases",
        platform: PLATFORM,
        fetchFn,
        extractTarball: async () => undefined,
      }),
    ).rejects.toThrow(/checksum mismatch/u);

    // `current` still resolves to the previous version; no new version directory was committed.
    expect(await readlink(join(h.root, "current"))).toBe(oldVersion);
    await expect(lstat(join(h.root, "versions", VERSION))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects metadata for another channel, version, or identity", async () => {
    const fixture = await createPayloadFixture(VERSION);
    const h = await installHarness(fixture);
    for (const [overrides, message] of [
      [{ channel: "prod" }, "another channel"],
      [{ version: "0.0.4" }, "does not match the upgrade target"],
      [{ packageName: "open-tag" }, "identity does not match"],
    ] as const) {
      const manifest = manifestFor(VERSION, h.payloadBytes, "https://download.test/x/payload.tar.gz", overrides);
      const fetchFn = (async () => new Response(JSON.stringify(manifest), { status: 200 })) as typeof fetch;
      await expect(
        installPortableTarget({
          channel: CHANNEL,
          targetVersion: VERSION,
          root: h.root,
          binDir: h.binDir,
          binName: BIN_NAME,
          packageName: PACKAGE_NAME,
          downloadBaseUrl: "https://download.test/releases",
          platform: PLATFORM,
          fetchFn,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("reuses an existing canonical version directory without rewriting it", async () => {
    const fixture = await createPayloadFixture(VERSION);
    const h = await installHarness(fixture);
    const canonical = join(h.root, "versions", VERSION);
    await mkdir(join(h.root, "versions"), { recursive: true });
    await cp(fixture, canonical, { recursive: true });
    await writeFile(join(canonical, "marker.txt"), "original");

    const result = (await h.install()) as { alreadyCurrent: boolean };
    expect(result.alreadyCurrent).toBe(false);
    expect(await readFile(join(canonical, "marker.txt"), "utf8")).toBe("original");
    expect(await readlink(join(h.root, "current"))).toBe(canonical);
    expect(h.smokeChecks).toEqual([canonical]);
  });

  it("detects a live install only when the shim resolves through current", async () => {
    const fixture = await createPayloadFixture(VERSION);
    const h = await installHarness(fixture);
    await h.install();
    expect(await portableInstallIsCurrent(h.root, h.binDir, BIN_NAME, VERSION, PLATFORM)).toBe(true);

    // A hand-edited shim fails the check and is repaired by a reinstall.
    await writeFile(join(h.binDir, BIN_NAME), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await portableInstallIsCurrent(h.root, h.binDir, BIN_NAME, VERSION, PLATFORM)).toBe(false);
    await chmod(join(h.binDir, BIN_NAME), 0o755);
    expect(await portableInstallIsCurrent(h.root, h.binDir, BIN_NAME, "0.0.4", PLATFORM)).toBe(false);
  });
});
