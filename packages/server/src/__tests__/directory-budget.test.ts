import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDirectoryBudget } from "../services/github-proxy/directory-budget.js";

const scan = vi.hoisted(() => ({
  afterRead: undefined as ((path: string) => Promise<void>) | undefined,
  deniedFile: "",
  deniedDirectory: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: async (path: string, options: { withFileTypes: true }) => {
      if (path === scan.deniedDirectory) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      const entries = await original.readdir(path, options);
      await scan.afterRead?.(path);
      return entries;
    },
    lstat: async (path: string) => {
      if (path === scan.deniedFile) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      return original.lstat(path);
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opentag-directory-budget-"));
});
afterEach(async () => {
  scan.afterRead = undefined;
  scan.deniedFile = "";
  scan.deniedDirectory = "";
  await rm(root, { recursive: true, force: true });
});

describe("Git staging directory budget", () => {
  it("counts nested files and rejects bytes above the limit", async () => {
    await mkdir(join(root, "objects"));
    await writeFile(join(root, "objects", "pack"), "1234");
    await expect(assertDirectoryBudget(root, 4)).resolves.toBeUndefined();
    await expect(assertDirectoryBudget(root, 3)).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("continues when Git removes a lock file after enumeration without skipping surviving bytes", async () => {
    const lock = join(root, "config.lock");
    await writeFile(lock, "temporary");
    await writeFile(join(root, "config"), "1234");
    scan.afterRead = async (path) => {
      if (path === root) await rm(lock, { force: true });
    };
    await expect(assertDirectoryBudget(root, 4)).resolves.toBeUndefined();
    await expect(assertDirectoryBudget(root, 3)).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("continues when an enumerated child directory disappears", async () => {
    const child = join(root, "objects");
    await mkdir(child);
    await writeFile(join(root, "HEAD"), "1234");
    scan.afterRead = async (path) => {
      if (path === root) await rm(child, { recursive: true, force: true });
    };
    await expect(assertDirectoryBudget(root, 4)).resolves.toBeUndefined();
    await expect(assertDirectoryBudget(root, 3)).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("still rejects a missing requested root", async () => {
    await expect(assertDirectoryBudget(join(root, "missing"), 4)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not ignore a file permission failure", async () => {
    scan.deniedFile = join(root, "config");
    await writeFile(scan.deniedFile, "1234");
    await expect(assertDirectoryBudget(root, 4)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not ignore an enumerated directory's permission failure", async () => {
    scan.deniedDirectory = join(root, "objects");
    await mkdir(scan.deniedDirectory);
    await expect(assertDirectoryBudget(root, 4)).rejects.toMatchObject({ code: "EACCES" });
  });
});
