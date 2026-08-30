import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProviderCliInstallError,
  ProviderCliInstaller,
  readProviderCliSelection,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "../index.js";
import {
  buildTarGz,
  makeFixtureCatalog,
  makeTempDir,
  sha256Hex,
  startFixtureHttpServer,
} from "./fixtures/provider-cli.js";

const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";

async function makeLayout() {
  const accountHome = await makeTempDir("opentag-installer-");
  return resolveProviderCliAccountLayout(accountHome);
}

type RouteValue = Uint8Array | { body: Uint8Array; truncateTo: number } | null;

async function serveFixture(
  options: Omit<Parameters<typeof makeFixtureCatalog>[0], "baseUrl"> & { route?: RouteValue },
) {
  const routes = new Map<string, RouteValue>();
  const server = await startFixtureHttpServer(routes);
  const { route, ...fixtureOptions } = options;
  const fixture = makeFixtureCatalog({ ...fixtureOptions, baseUrl: server.baseUrl });
  routes.set(fixture.routePath, route === undefined ? fixture.archive : route);
  return { server, fixture };
}

describe("ProviderCliInstaller", () => {
  it("publishes a valid artifact to a digest-addressed immutable version directory", async () => {
    const layout = await makeLayout();
    const routes = new Map<string, Uint8Array | { body: Uint8Array; truncateTo: number } | null>();
    const server = await startFixtureHttpServer(routes);
    try {
      const fixture = makeFixtureCatalog({ provider: "feishu", version: "1.0.92", baseUrl: server.baseUrl });
      routes.set(fixture.routePath, fixture.archive);
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      const installed = await installer.install(fixture.entry, "feishu");
      expect(installed.reused).toBe(false);
      expect(installed.artifactId).toBe(`1.0.92/${PLATFORM}-${ARCH}/${fixture.artifact.sha256}`);
      expect(installed.executablePath).toBe(
        join(layout.versions, "feishu", installed.artifactId, fixture.artifact.executablePath),
      );
      const published = await readFile(installed.executablePath, "utf8");
      expect(published).toBe(fixture.executableContent);
      // Immutable: version dir and executable are read-only.
      expect((await stat(installed.executablePath)).mode & 0o222).toBe(0);
      // Staging is cleaned up.
      await expect(readdir(layout.staging)).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("reuses an existing version directory with matching content", async () => {
    const layout = await makeLayout();
    const { server, fixture } = await serveFixture({ provider: "feishu", version: "1.0.92" });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await installer.install(fixture.entry, "feishu");
      const again = await installer.install(fixture.entry, "feishu");
      expect(again.reused).toBe(true);
      expect(server.requests.filter((path) => path === fixture.routePath)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("fails closed on a digest mismatch and publishes nothing", async () => {
    const layout = await makeLayout();
    const tampered = buildTarGz([{ name: "lark-cli", content: "#!/bin/sh\necho pwned\n", mode: 0o755 }]);
    const { server, fixture } = await serveFixture({ provider: "feishu", version: "1.0.92", route: tampered });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await expect(installer.install(fixture.entry, "feishu")).rejects.toMatchObject({
        name: "ProviderCliInstallError",
        code: "integrity_failed",
      });
      await expect(readdir(layout.versions).catch(() => [])).resolves.toEqual([]);
      await expect(readdir(layout.staging)).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails closed on a truncated download", async () => {
    const layout = await makeLayout();
    const routes = new Map<string, RouteValue>();
    const server = await startFixtureHttpServer(routes);
    const fixture = makeFixtureCatalog({ provider: "feishu", version: "1.0.92", baseUrl: server.baseUrl });
    routes.set(fixture.routePath, { body: fixture.archive, truncateTo: Math.floor(fixture.archive.byteLength / 2) });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await expect(installer.install(fixture.entry, "feishu")).rejects.toMatchObject({ code: "integrity_failed" });
      await expect(readdir(layout.versions).catch(() => [])).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails closed on a malicious archive with traversal members", async () => {
    const layout = await makeLayout();
    const malicious = buildTarGz([
      { name: "../escape", content: "x" },
      { name: "lark-cli", content: "#!/bin/sh\necho ok\n", mode: 0o755 },
    ]);
    const { server, fixture } = await serveFixture({
      provider: "feishu",
      version: "1.0.92",
      archiveBody: malicious,
    });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await expect(installer.install(fixture.entry, "feishu")).rejects.toMatchObject({ code: "integrity_failed" });
      // Nothing escaped the staging root.
      await expect(readdir(layout.staging)).resolves.toEqual([]);
      await expect(readdir(layout.versions).catch(() => [])).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails closed when the published executable cannot run on this architecture", async () => {
    const layout = await makeLayout();
    // A real ELF/Mach-O header for the wrong host; it can never execute here.
    const foreign =
      PLATFORM === "darwin"
        ? "7f454c4602010100000000000000000002003e0001000000600d4900000000004000000000000000900100"
        : "cffaedfe0c0000010000000002000000110000006008000004002000000000001900000048000000";
    const blob = new Uint8Array(foreign.length / 2);
    for (let index = 0; index < blob.length; index += 1)
      blob[index] = Number.parseInt(foreign.slice(index * 2, index * 2 + 2), 16);
    const { server, fixture } = await serveFixture({
      provider: "feishu",
      version: "1.0.92",
      executableContent: String.fromCharCode(...blob),
    });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await expect(installer.install(fixture.entry, "feishu")).rejects.toMatchObject({ code: "probe_failed" });
    } finally {
      await server.close();
    }
  });

  it("fails closed when the probe fails and preserves a prior selection", async () => {
    const layout = await makeLayout();
    const { server, fixture: failing } = await serveFixture({
      provider: "feishu",
      version: "1.0.92",
      executableContent: "#!/bin/sh\nexit 1\n",
    });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await expect(installer.install(failing.entry, "feishu")).rejects.toMatchObject({ code: "probe_failed" });
      // The version dir exists (published before probing) but no selection points at it.
      await expect(readProviderCliSelection(layout, "feishu")).resolves.toBeUndefined();
      // A later run must probe the digest-matching published directory again instead
      // of treating its mere existence as a successful installation.
      await expect(installer.install(failing.entry, "feishu")).rejects.toMatchObject({ code: "probe_failed" });
      await expect(readProviderCliSelection(layout, "feishu")).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("recovers recognized stale staging directories from an interrupted operation", async () => {
    const layout = await makeLayout();
    const stale = join(layout.staging, "feishu", "5f3a2b9c-0000-4000-8000-000000000000");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "partial.tar.gz"), "partial");
    const keep = join(layout.staging, "feishu", "not-an-operation-id");
    await mkdir(keep);
    const otherProvider = join(layout.staging, "slack", "5f3a2b9c-2222-4000-8000-000000000000");
    await mkdir(otherProvider, { recursive: true });

    const { server, fixture } = await serveFixture({ provider: "feishu", version: "1.0.92" });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await installer.install(fixture.entry, "feishu");
      await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(keep)).resolves.toBeTruthy();
      await expect(stat(otherProvider)).resolves.toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it("fails with unsupported_platform when the catalog has no artifact for the host", async () => {
    const layout = await makeLayout();
    // No server is needed: the platform mismatch is detected before any download.
    const fixture = makeFixtureCatalog({ provider: "feishu", version: "1.0.92", baseUrl: "http://127.0.0.1:9" });
    const other = PLATFORM === "darwin" ? "linux" : "darwin";
    const installer = new ProviderCliInstaller({ layout, platform: other, arch: ARCH });
    await expect(installer.install(fixture.entry, "feishu")).rejects.toMatchObject({ code: "unsupported_platform" });
  });

  it("reports an HTTP failure as an incomplete install", async () => {
    const layout = await makeLayout();
    const { server, fixture } = await serveFixture({ provider: "feishu", version: "1.0.92", route: null });
    try {
      const installer = new ProviderCliInstaller({ layout, platform: PLATFORM, arch: ARCH });
      await expect(installer.install(fixture.entry, "feishu")).rejects.toMatchObject({ code: "install_incomplete" });
    } finally {
      await server.close();
    }
  });

  it("has the ProviderCliInstallError name", () => {
    expect(new ProviderCliInstallError("integrity_failed", "x").name).toBe("ProviderCliInstallError");
  });

  it("keeps sha256 fixtures honest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("selection store", () => {
  it("round-trips records with a monotonic generation", async () => {
    const layout = await makeLayout();
    const first = await writeProviderCliSelection(
      layout,
      "feishu",
      {
        kind: "external",
        executablePath: "/opt/lark/bin/lark-cli",
        fingerprint: `v1:${"a".repeat(64)}`,
        trust: "compatible-unverified",
        version: "1.0.92",
      },
      undefined,
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(first.generation).toBe(1);
    const second = await writeProviderCliSelection(
      layout,
      "feishu",
      {
        kind: "managed",
        artifactId: `1.0.92/${PLATFORM}-${ARCH}/${"0".repeat(64)}`,
        version: "1.0.92",
        targetPath: "/managed/lark-cli",
        fingerprint: `v1:${"d".repeat(64)}`,
      },
      first,
      new Date("2026-08-30T01:00:00Z"),
    );
    expect(second.generation).toBe(2);
    const read = await readProviderCliSelection(layout, "feishu");
    expect(read?.generation).toBe(2);
    expect(read?.selection.kind).toBe("managed");
    expect(read?.updatedAt).toBe("2026-08-30T01:00:00.000Z");
    // 0600 permissions on the record.
    const mode = (await stat(join(layout.state, "feishu.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns undefined for missing state and throws for malformed state", async () => {
    const layout = await makeLayout();
    await expect(readProviderCliSelection(layout, "slack")).resolves.toBeUndefined();
    await mkdir(layout.state, { recursive: true });
    await writeFile(join(layout.state, "slack.json"), '{"schemaVersion":99}\n');
    await expect(readProviderCliSelection(layout, "slack")).rejects.toMatchObject({ name: "RuntimeStorageError" });
  });

  it("rejects a selection stored under the wrong provider or with a relative target", async () => {
    const layout = await makeLayout();
    await mkdir(layout.state, { recursive: true });
    const base = {
      schemaVersion: 1,
      provider: "feishu",
      generation: 1,
      updatedAt: "2026-08-30T00:00:00.000Z",
      selection: {
        kind: "external",
        executablePath: "/opt/lark-cli",
        fingerprint: `v1:${"a".repeat(64)}`,
        trust: "compatible-unverified",
        version: "1.0.92",
      },
    };
    await writeFile(join(layout.state, "slack.json"), `${JSON.stringify(base)}\n`);
    await expect(readProviderCliSelection(layout, "slack")).rejects.toMatchObject({ name: "RuntimeStorageError" });

    await writeFile(
      join(layout.state, "feishu.json"),
      `${JSON.stringify({ ...base, selection: { ...base.selection, executablePath: "relative/lark-cli" } })}\n`,
    );
    await expect(readProviderCliSelection(layout, "feishu")).rejects.toMatchObject({ name: "RuntimeStorageError" });
  });
});
