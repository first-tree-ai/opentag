import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareContextTreeHome, resolveContextTreeHome } from "../storage/context-tree-home.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function account(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opentag-ct-home-")));
  roots.push(root);
  return root;
}

describe("shared Context Tree account home", () => {
  it("canonicalizes the account home independently of OPENTAG_HOME", async () => {
    const home = await account();
    const alias = join(await account(), "alias");
    await symlink(home, alias);
    const expected = {
      directory: join(home, ".context-tree"),
      configFile: join(home, ".context-tree", "opentag.json"),
    };
    expect(resolveContextTreeHome({ HOME: alias, OPENTAG_HOME: "/one" })).toEqual(expected);
    expect(resolveContextTreeHome({ HOME: home, OPENTAG_HOME: "/two" })).toEqual(expected);
    await expect(stat(expected.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await prepareContextTreeHome({ HOME: alias })).toBe(expected.directory);
    expect((await stat(expected.directory)).mode & 0o777).toBe(0o700);
    expect(await prepareContextTreeHome({ HOME: home })).toBe(expected.directory);
  });

  it("tightens a pre-existing managed directory to 0700", async () => {
    const home = await account();
    const directory = join(home, ".context-tree");
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    expect(await prepareContextTreeHome({ HOME: home })).toBe(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it.each(["file", "symlink"])("rejects a managed directory that is a %s", async (kind) => {
    const home = await account();
    const directory = join(home, ".context-tree");
    if (kind === "file") await writeFile(directory, "blocked");
    else {
      const target = join(home, "target");
      await mkdir(target);
      await symlink(target, directory);
    }
    await expect(prepareContextTreeHome({ HOME: home })).rejects.toThrow("must be a real directory");
  });
});
