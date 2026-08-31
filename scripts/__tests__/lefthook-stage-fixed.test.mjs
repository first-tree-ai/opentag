import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lefthookPath = join(repoRoot, "node_modules", ".bin", "lefthook");

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test("pre-commit stage_fixed stages only files Biome fixed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opentag-stage-fixed-"));
  try {
    const fakeBinDirectory = join(directory, "fake-bin");
    const fakePnpmPath = join(fakeBinDirectory, "pnpm");
    await mkdir(fakeBinDirectory, { recursive: true });
    await writeFile(
      fakePnpmPath,
      `#!/bin/sh
set -eu
for argument in "$@"; do
  case "$argument" in
    *.js) printf 'const fixed = true;\\n' > "$argument" ;;
  esac
done
`,
      { encoding: "utf8", mode: 0o755 },
    );
    await chmod(fakePnpmPath, 0o755);
    await writeFile(
      join(directory, "lefthook.yml"),
      `pre-commit:
  parallel: false
  jobs:
    - name: biome
      glob:
        - "*.js"
      run: pnpm exec biome check --write --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
      stage_fixed: true
`,
      "utf8",
    );

    runGit(directory, ["init", "-q"]);
    runGit(directory, ["config", "user.email", "test@example.com"]);
    runGit(directory, ["config", "user.name", "OpenTag Test"]);
    await writeFile(join(directory, "fixed.js"), "const fixed = false;\n", "utf8");
    await writeFile(join(directory, "unrelated.js"), "const unrelated = false;\n", "utf8");
    runGit(directory, ["add", "fixed.js", "unrelated.js", "lefthook.yml"]);
    runGit(directory, ["commit", "-qm", "baseline"]);

    await writeFile(join(directory, "fixed.js"), "const fixed = needs_work;\n", "utf8");
    await writeFile(join(directory, "unrelated.js"), "const unrelated = dirty;\n", "utf8");
    runGit(directory, ["add", "fixed.js"]);

    const result = spawnSync(lefthookPath, ["run", "pre-commit"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDirectory}:${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.deepEqual(runGit(directory, ["diff", "--cached", "--name-only"]).split("\n"), ["fixed.js"]);
    assert.equal(await readFile(join(directory, "fixed.js"), "utf8"), "const fixed = true;\n");
    assert.equal(await readFile(join(directory, "unrelated.js"), "utf8"), "const unrelated = dirty;\n");
    assert.equal(runGit(directory, ["diff", "--name-only"]), "unrelated.js");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
