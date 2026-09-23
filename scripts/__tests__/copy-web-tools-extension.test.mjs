import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyWebToolsExtension,
  WEB_TOOLS_EXTENSION_DESTINATIONS,
  WEB_TOOLS_EXTENSION_FILES,
} from "../copy-web-tools-extension.mjs";

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "opentag-web-tools-copy-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceDirectory = join(root, "client-dist", "pi-extensions");
  await mkdir(sourceDirectory, { recursive: true });
  return { root, sourceDirectory, cliRoot: join(root, "cli") };
}

test("the extension module and its source map land beside every CLI entry", async (t) => {
  const { sourceDirectory, cliRoot } = await scratch(t);
  await writeFile(join(sourceDirectory, "web-tools.mjs"), "export {};\n//# sourceMappingURL=web-tools.mjs.map\n");
  await writeFile(join(sourceDirectory, "web-tools.mjs.map"), '{"version":3,"sources":[],"mappings":""}\n');

  const copied = copyWebToolsExtension({ sourceDirectory, cliRoot });

  assert.deepEqual(WEB_TOOLS_EXTENSION_FILES, ["web-tools.mjs", "web-tools.mjs.map"]);
  assert.deepEqual(WEB_TOOLS_EXTENSION_DESTINATIONS, ["dist/pi-extensions", "dist/cli/pi-extensions"]);
  assert.equal(copied.length, 4);
  for (const destination of ["dist/pi-extensions", "dist/cli/pi-extensions"]) {
    const module = await readFile(join(cliRoot, destination, "web-tools.mjs"), "utf8");
    assert.match(module, /sourceMappingURL=web-tools\.mjs\.map/);
    // The footer names a sibling that exists, so an enabled source map resolver finds it.
    const map = await readFile(join(cliRoot, destination, "web-tools.mjs.map"), "utf8");
    assert.equal(JSON.parse(map).version, 3);
  }
});

test("a missing map is as fatal as a missing module, and nothing is copied first", async (t) => {
  const { sourceDirectory, cliRoot } = await scratch(t);
  await writeFile(join(sourceDirectory, "web-tools.mjs"), "export {};\n");

  assert.throws(() => copyWebToolsExtension({ sourceDirectory, cliRoot }), /missing \(web-tools\.mjs\.map\)/);
  await assert.rejects(readFile(join(cliRoot, "dist", "pi-extensions", "web-tools.mjs")), { code: "ENOENT" });

  await rm(join(sourceDirectory, "web-tools.mjs"));
  assert.throws(
    () => copyWebToolsExtension({ sourceDirectory, cliRoot }),
    /missing \(web-tools\.mjs, web-tools\.mjs\.map\); build @opentag\/client/,
  );
});
