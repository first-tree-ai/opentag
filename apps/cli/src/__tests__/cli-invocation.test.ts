import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliInvocation } from "../core/daemon/service/shared.js";
import { renderPortableShim } from "../core/update/portable-installer.js";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opentag-cli-entry-"));
  directories.push(root);
  const staleBin = join(root, "old global");
  const entry = join(root, "current npm's package", "cli.mjs");
  await mkdir(staleBin);
  await mkdir(dirname(entry));
  await writeFile(entry, "console.log(JSON.stringify(process.argv.slice(2)))\n");
  await writeFile(join(staleBin, "opentag-staging"), "#!/bin/sh\necho stale\n", { mode: 0o755 });
  return { root, entry, staleBin };
}

async function portableFixture() {
  const base = await fixture();
  const root = join(base.root, "portable's install");
  const binDir = join(base.root, "portable bin");
  await mkdir(binDir);
  const version = async (name: string) => {
    const payload = join(root, "versions", name);
    const node = join(payload, "node/bin/node");
    const entry = join(payload, "app/cli/index.mjs");
    await mkdir(dirname(node), { recursive: true });
    await mkdir(dirname(entry), { recursive: true });
    await symlink(process.execPath, node);
    await writeFile(
      entry,
      `console.log(JSON.stringify({version:${JSON.stringify(name)},args:process.argv.slice(2)}))\n`,
    );
    await writeFile(
      join(payload, "INSTALL.json"),
      JSON.stringify({ installMode: "portable", binName: "opentag-staging", appEntry: "app/cli/index.mjs" }),
    );
    return { payload, node, entry };
  };
  const first = await version("v1");
  const current = join(root, "current");
  await symlink(first.payload, current);
  const launcher = join(binDir, "opentag-staging");
  await writeFile(launcher, renderPortableShim(current, binDir), { mode: 0o755 });
  const options = {
    binName: "opentag-staging",
    execPath: first.node,
    argv: [first.node, first.entry],
    env: {
      PATH: base.staleBin,
      OPENTAG_INSTALL_MODE: "portable",
      OPENTAG_PORTABLE_ROOT: current,
      OPENTAG_PORTABLE_BIN_DIR: binDir,
    },
  };
  return { ...base, root, current, launcher, first, options, version };
}

describe("installation-owned CLI invocation", () => {
  it("keeps the running Node and CLI entry when an older same-name installation is first on PATH", async () => {
    const { entry, staleBin } = await fixture();
    const invocation = await resolveCliInvocation({
      binName: "opentag-staging",
      argv: [process.execPath, entry],
      execPath: process.execPath,
      env: { PATH: staleBin },
    });
    expect(invocation).toEqual({ program: await realpath(process.execPath), args: [await realpath(entry)] });
    const { stdout } = await execute(invocation.program, [...invocation.args, "session", "send", "a b'c"]);
    expect(JSON.parse(stdout)).toEqual(["session", "send", "a b'c"]);
  });

  it("does not fall back to PATH when the intended entry is missing or is a directory", async () => {
    const { entry, staleBin } = await fixture();
    const options = { binName: "opentag-staging", argv: [process.execPath, entry], env: { PATH: staleBin } };
    await rm(entry);
    await expect(resolveCliInvocation(options)).rejects.toThrow(/CLI|entry/i);
    await mkdir(entry);
    await expect(resolveCliInvocation(options)).rejects.toThrow(/CLI|entry/i);
  });

  it("rejects a missing Node executable instead of returning an unusable invocation", async () => {
    const { root, entry } = await fixture();
    await expect(
      resolveCliInvocation({ binName: "opentag-staging", argv: ["node", entry], execPath: join(root, "missing-node") }),
    ).rejects.toThrow(/Node|executable/i);
  });

  it("uses the existing Portable launcher and follows its atomic current switch", async () => {
    const { options, launcher, current, version } = await portableFixture();
    const invocation = await resolveCliInvocation(options);
    expect(invocation).toEqual({ program: launcher, args: [] });
    expect(JSON.parse((await execute(invocation.program, ["session", "send", "first"])).stdout)).toEqual({
      version: "v1",
      args: ["session", "send", "first"],
    });
    const second = await version("v2");
    const next = join(dirname(current), "next-current");
    await symlink(second.payload, next);
    await rename(next, current);
    await expect(
      resolveCliInvocation({ ...options, execPath: second.node, argv: [second.node, second.entry] }),
    ).resolves.toEqual(invocation);
    expect(JSON.parse((await execute(invocation.program, ["daemon", "refresh-service"])).stdout)).toEqual({
      version: "v2",
      args: ["daemon", "refresh-service"],
    });
  });

  it("rejects incomplete Portable metadata rather than silently treating it as npm", async () => {
    const { options } = await portableFixture();
    delete (options.env as NodeJS.ProcessEnv).OPENTAG_PORTABLE_BIN_DIR;
    await expect(resolveCliInvocation(options)).rejects.toThrow(/portable/i);
  });

  it("rejects a missing, non-executable, or replaced Portable launcher", async () => {
    const { options, launcher } = await portableFixture();
    const original = await readFile(launcher, "utf8");
    await rm(launcher);
    await expect(resolveCliInvocation(options)).rejects.toThrow(/portable/i);
    await writeFile(launcher, original, { mode: 0o600 });
    await expect(resolveCliInvocation(options)).rejects.toThrow(/portable/i);
    await chmod(launcher, 0o755);
    await writeFile(launcher, "#!/bin/sh\necho another-installation\n");
    await expect(resolveCliInvocation(options)).rejects.toThrow(/portable/i);
  });

  it("rejects a Portable payload for another channel", async () => {
    const { options, first } = await portableFixture();
    await writeFile(
      join(first.payload, "INSTALL.json"),
      JSON.stringify({ installMode: "portable", binName: "opentag", appEntry: "app/cli/index.mjs" }),
    );
    await expect(resolveCliInvocation(options)).rejects.toThrow(/portable/i);
  });

  it("does not let inherited Portable metadata select an unrelated installation", async () => {
    const { options, entry } = await portableFixture();
    await expect(
      resolveCliInvocation({ ...options, execPath: process.execPath, argv: [process.execPath, entry] }),
    ).rejects.toThrow(/portable/i);
  });

  it("accepts the Portable layout root as well as the historical current-link environment", async () => {
    const { root, launcher, options } = await portableFixture();
    await expect(
      resolveCliInvocation({ ...options, env: { ...options.env, OPENTAG_PORTABLE_ROOT: root } }),
    ).resolves.toEqual({ program: launcher, args: [] });
  });
});
