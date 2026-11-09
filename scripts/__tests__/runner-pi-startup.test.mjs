import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveInstalledDependencyPackage } from "../portable/runtime-dependencies.mjs";
import { RUNNER_PINS } from "../runner/pins.mjs";

const exec = promisify(execFile);
const manifest = fileURLToPath(new URL("../../packages/client/package.json", import.meta.url));
const patch = fileURLToPath(new URL("../runner/pi/defer-syntax-highlighting.patch", import.meta.url));

test("the pinned Runner Pi patch loads the same highlighter on first use", async () => {
  const pi = resolveInstalledDependencyPackage(manifest, RUNNER_PINS.piPackage);
  assert.equal(pi.manifest.version, RUNNER_PINS.piVersion);
  const highlight = resolveInstalledDependencyPackage(pi.manifestPath, "highlight.js");
  const root = await mkdtemp(join(tmpdir(), "opentag-pi-highlighting-"));
  try {
    const utils = join(root, "dist/utils");
    await mkdir(utils, { recursive: true });
    await mkdir(join(root, "node_modules"));
    await symlink(highlight.root, join(root, "node_modules/highlight.js"), "dir");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    const syntax = "syntax-highlight.js";
    await cp(join(pi.root, "dist/utils", syntax), join(utils, syntax));
    await cp(join(pi.root, "dist/utils/html.js"), join(utils, "html.js"));
    await cp(join(utils, syntax), join(utils, "baseline.js"));
    await exec("patch", ["--batch", "--forward", "--fuzz=0", "-p1", "-i", patch], { cwd: root });
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
         import { createRequire } from "node:module";
         import * as candidate from "./dist/utils/syntax-highlight.js";
         const require = createRequire(import.meta.url);
         const entry = require.resolve("highlight.js/lib/index.js");
         assert.equal(require.cache[entry], undefined);
         assert.equal(candidate.supportsLanguage("xquery"), true);
         assert.ok(require.cache[entry]);
         const baseline = await import("./dist/utils/baseline.js");
         const code = "let value = 42;";
         const options = { language: "javascript", theme: { keyword: (text) => "[" + text + "]" } };
         assert.equal(candidate.highlight(code, options), baseline.highlight(code, options));
         assert.equal(candidate.highlight(code), baseline.highlight(code));`,
      ],
      { cwd: root },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
