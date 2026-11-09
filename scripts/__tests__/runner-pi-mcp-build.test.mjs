import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveInstalledDependencyPackage } from "../portable/runtime-dependencies.mjs";
import { buildPiMcpAdapter } from "../runner/build-pi-mcp-adapter.mjs";

const exec = promisify(execFile);
const manifest = fileURLToPath(new URL("../../packages/client/package.json", import.meta.url));
const pi = resolveInstalledDependencyPackage(manifest, "@earendil-works/pi-coding-agent");

test("the precompiled adapter loads eager and lazy modules without a TypeScript loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-pi-adapter-"));
  try {
    await mkdir(join(root, "node_modules", "fixture-dependency"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "node_modules", "fixture-dependency", "package.json"),
      '{"type":"module","exports":"./index.js"}',
    );
    await writeFile(join(root, "node_modules", "fixture-dependency", "index.js"), 'export const value = "external";');
    await writeFile(join(root, "asset.txt"), "adjacent asset");
    await writeFile(join(root, "eager.ts"), 'export const value: string = "eager";');
    await writeFile(join(root, "lazy.ts"), 'export const value: string = "lazy";');
    await writeFile(
      join(root, "index.ts"),
      `import { readFileSync } from "node:fs";
import { value as dependency } from "fixture-dependency";
import { value as eager } from "./eager.ts";
export async function inspect(): Promise<string[]> {
  const lazy = await import("./lazy.ts");
  return [dependency, eager, lazy.value, readFileSync(new URL("./asset.txt", import.meta.url), "utf8")];
}
`,
    );
    const entry = await buildPiMcpAdapter(root, pi.root);
    await Promise.all(["index.ts", "eager.ts", "lazy.ts"].map((name) => rm(join(root, name))));
    const { stdout } = await exec(process.execPath, [
      "--no-experimental-strip-types",
      "--input-type=module",
      "-e",
      `const { inspect } = await import(${JSON.stringify(entry)}); console.log(JSON.stringify(await inspect()));`,
    ]);
    assert.deepEqual(JSON.parse(stdout), ["external", "eager", "lazy", "adjacent asset"]);
    assert.equal(await readFile(join(root, "asset.txt"), "utf8"), "adjacent asset");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pinned MCP adapter imports natively with its installed dependency versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-pi-pinned-adapter-"));
  try {
    const installed = resolveInstalledDependencyPackage(manifest, "pi-mcp-adapter");
    const packageDirectory = join(root, "adapter");
    await cp(installed.root, packageDirectory, { recursive: true });
    const names = Object.keys(installed.manifest.dependencies ?? {});
    for (const name of names) {
      const dependency = resolveInstalledDependencyPackage(installed.manifestPath, name);
      const destination = join(root, "node_modules", name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(dependency.root, destination, "dir");
    }
    const entry = await buildPiMcpAdapter(packageDirectory, pi.root);
    const { stdout } = await exec(process.execPath, [
      "--no-experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module"; const m = createRequire(import.meta.url)(${JSON.stringify(entry)}); console.log([typeof m.createMcpAdapter, typeof m.registerMcpServer].join(","));`,
    ]);
    assert.equal(stdout.trim(), "function,function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
