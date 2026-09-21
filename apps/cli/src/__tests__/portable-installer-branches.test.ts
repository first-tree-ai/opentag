import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ rename: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rename: fsMocks.rename,
}));

import {
  DEFAULT_DOWNLOAD_BASE_URL,
  detectPortablePlatform,
  installPortableTarget,
  PortableInstallError,
  portableInstallIsCurrent,
} from "../core/update/portable-installer.js";

// Real `tar` extraction and the embedded-runtime smoke check spawn child processes.
vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);
const PLATFORM = "linux-x64";
const CHANNEL = "staging" as const;
const VERSION = "0.0.3-staging.1.1";
const BIN_NAME = "opentag-staging";
const PACKAGE_NAME = "open-tag-staging";

const directories: string[] = [];
let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsMocks.rename.mockImplementation(actualFs.rename);
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => actualFs.rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function installMetadata(overrides: Record<string, unknown> = {}, platform = PLATFORM): Record<string, unknown> {
  return {
    schemaVersion: 1,
    channel: CHANNEL,
    version: VERSION,
    packageName: PACKAGE_NAME,
    binName: BIN_NAME,
    platform,
    installMode: "portable",
    appEntry: "app/cli/index.mjs",
    ...overrides,
  };
}

/** A payload laid out like a released portable tarball; `nodeScript` is the fake embedded runtime. */
async function createPayloadFixture(options: {
  install?: string;
  nodeScript?: string;
  platform?: string;
}): Promise<string> {
  const fixture = await tempDir("opentag-payload-branches-");
  const root = join(fixture, "payload");
  await mkdir(join(root, "node", "bin"), { recursive: true });
  await mkdir(join(root, "app", "cli"), { recursive: true });
  await writeFile(join(root, "node", "bin", "node"), options.nodeScript ?? "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, "app", "cli", "index.mjs"), "// cli\n");
  await writeFile(
    join(root, "INSTALL.json"),
    options.install ?? JSON.stringify(installMetadata({}, options.platform ?? PLATFORM)),
  );
  return root;
}

function manifestFor(payload: Buffer, platform = PLATFORM) {
  return {
    schemaVersion: 1,
    channel: CHANNEL,
    version: VERSION,
    packageName: PACKAGE_NAME,
    binName: BIN_NAME,
    assets: [
      {
        platform,
        fileName: `${PACKAGE_NAME}-${VERSION}-${platform}.tar.gz`,
        url: "https://download.test/releases/staging/payload.tar.gz",
        sha256: createHash("sha256").update(payload).digest("hex"),
        size: payload.byteLength,
      },
    ],
  };
}

function fetchFor(payload: Buffer, requested: string[] = [], platform = PLATFORM): typeof fetch {
  const manifest = manifestFor(payload, platform);
  return (async (url: string | URL | Request) => {
    const value = String(url);
    requested.push(value);
    if (value.endsWith("/manifest.json")) return new Response(JSON.stringify(manifest), { status: 200 });
    if (value.endsWith("/payload.tar.gz")) return new Response(new Uint8Array(payload), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function layout(): Promise<{ root: string; binDir: string }> {
  const base = await tempDir("opentag-portable-branches-");
  return { root: join(base, "portable"), binDir: join(base, "bin") };
}

/** Build a real gzip tarball of the fixture so the default `tar -xzf` extraction runs. */
async function tarball(fixture: string): Promise<Buffer> {
  const out = join(await tempDir("opentag-tarball-"), "payload.tar.gz");
  await execFileAsync("tar", ["-czf", out, "-C", fixture, "."]);
  return readFile(out);
}

async function writeCurrentInstall(root: string, binDir: string, options: { install?: string; nodeMode?: number }) {
  const versionDir = join(root, "versions", VERSION);
  await mkdir(join(versionDir, "node", "bin"), { recursive: true });
  await mkdir(join(versionDir, "app", "cli"), { recursive: true });
  await writeFile(join(versionDir, "node", "bin", "node"), "#!/bin/sh\nexit 0\n", { mode: options.nodeMode ?? 0o755 });
  await writeFile(join(versionDir, "app", "cli", "index.mjs"), "// cli\n");
  await writeFile(join(versionDir, "INSTALL.json"), options.install ?? JSON.stringify(installMetadata()));
  await symlink(versionDir, join(root, "current"));
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, BIN_NAME), `#!/bin/sh\nroot='${join(root, "current")}'\n`, { mode: 0o755 });
  return versionDir;
}

describe("detectPortablePlatform", () => {
  it.each([
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["darwin", "arm64", "darwin-arm64"],
  ] as const)("maps %s/%s to %s", (platform, arch, expected) => {
    expect(detectPortablePlatform(platform, arch)).toBe(expected);
  });

  it.each([
    ["win32", "x64"],
    ["linux", "ia32"],
    ["freebsd", "arm64"],
  ] as const)("rejects %s/%s", (platform, arch) => {
    expect(() => detectPortablePlatform(platform, arch)).toThrow(
      new PortableInstallError(`Portable upgrades are unsupported on ${platform}-${arch}`),
    );
  });

  it("defaults to the running process", () => {
    expect(detectPortablePlatform()).toBe(`${process.platform}-${process.arch}`);
  });
});

describe("portable installer INSTALL.json validation", () => {
  it.each([
    ["{", "INSTALL.json is malformed"],
    ["[]", "INSTALL.json is malformed"],
    [JSON.stringify(installMetadata({ version: "0.0.4" })), "version does not match"],
    [JSON.stringify(installMetadata({ packageName: "open-tag" })), "identity does not match"],
    [JSON.stringify(installMetadata({ binName: "opentag" })), "identity does not match"],
    [JSON.stringify(installMetadata({ platform: "linux-arm64" })), "platform does not match"],
    [JSON.stringify(installMetadata({ installMode: "npm-global" })), "does not describe a portable install"],
    [JSON.stringify(installMetadata({ appEntry: "other.mjs" })), "appEntry is unsupported"],
  ])("rejects %j with %s and leaves no activation behind", async (install, message) => {
    const fixture = await createPayloadFixture({ install });
    const { root, binDir } = await layout();
    const payload = Buffer.from("payload-bytes");
    const smoke = vi.fn();
    await expect(
      installPortableTarget({
        channel: CHANNEL,
        targetVersion: VERSION,
        root,
        binDir,
        binName: BIN_NAME,
        packageName: PACKAGE_NAME,
        downloadBaseUrl: "https://download.test/releases///",
        platform: PLATFORM,
        fetchFn: fetchFor(payload),
        extractTarball: async (_tarball, destination) => {
          await cp(fixture, destination, { recursive: true });
        },
        runSmokeCheck: smoke,
      }),
    ).rejects.toThrow(message);
    expect(smoke).not.toHaveBeenCalled();
    await expect(lstat(join(root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "versions", VERSION))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, ".tmp", `${VERSION}.${process.pid}`))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("portable installer default extraction and smoke check", () => {
  it("extracts a real tarball with tar and smoke-checks the embedded runtime", async () => {
    const platform = detectPortablePlatform();
    const fixture = await createPayloadFixture({
      platform,
      nodeScript: '#!/bin/sh\ntest "$2" = "--version" && test -f "$1"\n',
    });
    const payload = await tarball(fixture);
    const { root, binDir } = await layout();
    const requested: string[] = [];
    const result = await installPortableTarget({
      channel: CHANNEL,
      targetVersion: VERSION,
      root,
      binDir,
      binName: BIN_NAME,
      packageName: PACKAGE_NAME,
      fetchFn: fetchFor(payload, requested, platform),
    });
    expect(result).toEqual({ alreadyCurrent: false, versionDir: join(root, "versions", VERSION) });
    expect(requested[0]).toBe(`${DEFAULT_DOWNLOAD_BASE_URL}/${CHANNEL}/${VERSION}/manifest.json`);
    expect(await readlink(join(root, "current"))).toBe(join(root, "versions", VERSION));
    expect(await readFile(join(root, "versions", VERSION, "app", "cli", "index.mjs"), "utf8")).toBe("// cli\n");
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, platform)).toBe(true);
  });

  it("fails before activation when the payload is not a tarball", async () => {
    const payload = Buffer.from("definitely not gzip");
    const { root, binDir } = await layout();
    await expect(
      installPortableTarget({
        channel: CHANNEL,
        targetVersion: VERSION,
        root,
        binDir,
        binName: BIN_NAME,
        packageName: PACKAGE_NAME,
        platform: PLATFORM,
        fetchFn: fetchFor(payload),
      }),
    ).rejects.toThrow(/Portable payload extraction failed/u);
    await expect(lstat(join(root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before activation when the embedded runtime smoke check exits non-zero", async () => {
    const fixture = await createPayloadFixture({ nodeScript: "#!/bin/sh\nexit 7\n" });
    const payload = await tarball(fixture);
    const { root, binDir } = await layout();
    await expect(
      installPortableTarget({
        channel: CHANNEL,
        targetVersion: VERSION,
        root,
        binDir,
        binName: BIN_NAME,
        packageName: PACKAGE_NAME,
        platform: PLATFORM,
        fetchFn: fetchFor(payload),
      }),
    ).rejects.toThrow(/failed the pre-commit runtime smoke check/u);
    await expect(lstat(join(root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "versions", VERSION))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("portableInstallIsCurrent", () => {
  it("is false when current is not a symlink", async () => {
    const { root, binDir } = await layout();
    await mkdir(join(root, "current"), { recursive: true });
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(false);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["a string", '"portable"'],
  ])("is false when INSTALL.json is %s", async (_label, install) => {
    const { root, binDir } = await layout();
    await writeCurrentInstall(root, binDir, { install });
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(false);
  });

  it("is false when the embedded runtime is not executable", async () => {
    const { root, binDir } = await layout();
    await writeCurrentInstall(root, binDir, { nodeMode: 0o644 });
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(false);
  });

  it("is false when the shim is missing or not executable, and true once repaired", async () => {
    const { root, binDir } = await layout();
    await writeCurrentInstall(root, binDir, {});
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(true);

    await rm(join(binDir, BIN_NAME));
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(false);

    await writeFile(join(binDir, BIN_NAME), `#!/bin/sh\nroot='${join(root, "current")}'\n`, { mode: 0o644 });
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(false);
  });

  it("falls back to the default app entry when INSTALL.json omits appEntry", async () => {
    const { root, binDir } = await layout();
    const metadata = installMetadata();
    delete metadata.appEntry;
    const versionDir = await writeCurrentInstall(root, binDir, { install: JSON.stringify(metadata) });
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(true);
    await rm(join(versionDir, "app", "cli", "index.mjs"));
    expect(await portableInstallIsCurrent(root, binDir, BIN_NAME, VERSION, PLATFORM)).toBe(false);
  });
});

describe("portable installer rename failures", () => {
  async function installWithRenameFailure(failWhen: (from: string, to: string) => boolean) {
    const fixture = await createPayloadFixture({});
    const { root, binDir } = await layout();
    const oldVersion = join(root, "versions", "0.0.2-staging.1.0");
    await mkdir(oldVersion, { recursive: true });
    await symlink(oldVersion, join(root, "current"));
    fsMocks.rename.mockImplementation(async (from, to) => {
      if (failWhen(String(from), String(to))) throw new Error("EXDEV: rename refused");
      return actualFs.rename(from, to);
    });
    const payload = Buffer.from("payload-bytes");
    const install = installPortableTarget({
      channel: CHANNEL,
      targetVersion: VERSION,
      root,
      binDir,
      binName: BIN_NAME,
      packageName: PACKAGE_NAME,
      platform: PLATFORM,
      fetchFn: fetchFor(payload),
      extractTarball: async (_tarball, destination) => {
        await cp(fixture, destination, { recursive: true });
      },
      runSmokeCheck: async () => undefined,
    });
    return { install, root, binDir, oldVersion };
  }

  it("reports a failure to move the payload into place and keeps current on the old version", async () => {
    const { install, root, oldVersion } = await installWithRenameFailure((_from, to) =>
      to.endsWith(join("versions", VERSION)),
    );
    await expect(install).rejects.toThrow(/Could not move the portable payload into place: EXDEV/u);
    expect(await readlink(join(root, "current"))).toBe(oldVersion);
    await expect(lstat(join(root, "versions", VERSION))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, ".tmp", `${VERSION}.${process.pid}`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a failed atomic switch and keeps current on the old version", async () => {
    const { install, root, binDir, oldVersion } = await installWithRenameFailure(
      (_from, to) => to === join(root, "current"),
    );
    await expect(install).rejects.toThrow(/Could not atomically switch the current portable version: EXDEV/u);
    expect(await readlink(join(root, "current"))).toBe(oldVersion);
    // The version directory and shim were prepared before the commit point; the staging link is gone.
    await access(join(root, "versions", VERSION, "INSTALL.json"));
    await access(join(binDir, BIN_NAME));
    await expect(lstat(join(root, `.current.${process.pid}`))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
