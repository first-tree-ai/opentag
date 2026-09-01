import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ rm: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm: fsMocks.rm,
}));

import { installPortableTarget } from "../core/update/portable-installer.js";

const directories: string[] = [];
let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsMocks.rm.mockImplementation(actualFs.rm);
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((path) => actualFs.rm(path, { recursive: true, force: true })));
});

async function cleanupFailureInstall(smokeFailure?: Error): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-portable-cleanup-"));
  directories.push(directory);
  const root = join(directory, "portable");
  const binDir = join(directory, "bin");
  const payload = Buffer.from("portable-payload");
  const version = "0.0.3-staging.1.1";
  const manifest = {
    schemaVersion: 1,
    channel: "staging",
    version,
    packageName: "open-tag-staging",
    binName: "opentag-staging",
    assets: [
      {
        platform: "linux-x64",
        fileName: "payload.tar.gz",
        url: "https://download.test/payload.tar.gz",
        sha256: createHash("sha256").update(payload).digest("hex"),
        size: payload.byteLength,
      },
    ],
  };
  fsMocks.rm.mockImplementation(async (path, options) => {
    if (String(path).endsWith(".tar.gz")) throw new Error("cleanup disk failure");
    return actualFs.rm(path, options);
  });

  return installPortableTarget({
    channel: "staging",
    targetVersion: version,
    root,
    binDir,
    binName: "opentag-staging",
    packageName: "open-tag-staging",
    platform: "linux-x64",
    fetchFn: (async (url: string | URL | Request) =>
      String(url).endsWith("manifest.json")
        ? new Response(JSON.stringify(manifest))
        : new Response(new Uint8Array(payload))) as typeof fetch,
    extractTarball: async (_tarball, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(
        join(destination, "INSTALL.json"),
        JSON.stringify({
          version,
          packageName: "open-tag-staging",
          binName: "opentag-staging",
          platform: "linux-x64",
          installMode: "portable",
          appEntry: "app/cli/index.mjs",
        }),
      );
    },
    runSmokeCheck: async () => {
      if (smokeFailure) throw smokeFailure;
    },
  });
}

describe("portable installer cleanup failures", () => {
  it("attempts every cleanup and reports a cleanup failure after a successful activation", async () => {
    await expect(cleanupFailureInstall()).rejects.toMatchObject({
      name: "AggregateError",
      message: "Portable staging cleanup failed",
    });
    const removedPaths = fsMocks.rm.mock.calls.map(([path]) => String(path));
    expect(removedPaths.some((path) => path.includes("/.tmp/0.0.3-staging.1.1."))).toBe(true);
    expect(removedPaths.some((path) => path.endsWith(".tar.gz"))).toBe(true);
    expect(removedPaths.some((path) => path.includes("/.current."))).toBe(true);
  });

  it("preserves both the primary install failure and the cleanup failure", async () => {
    const primary = new Error("payload smoke failure");
    const error = await cleanupFailureInstall(primary).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "AggregateError",
      message: "Portable installation failed and staging cleanup also failed",
      cause: primary,
    });
    expect((error as AggregateError).errors[0]).toBe(primary);
    expect((error as AggregateError).errors[1]).toMatchObject({
      name: "AggregateError",
      message: "Portable staging cleanup failed",
    });
  });
});
