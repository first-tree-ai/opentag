import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github/workflows/runner-toolchain.yml");

test("dedicated runner workflow builds linux/amd64 offline and never publishes", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /linux\/amd64/);
  assert.match(workflow, /scripts\/e2e\/runner-toolchain\/run.mjs/);
  assert.doesNotMatch(workflow, /docker\/login-action/);
  assert.doesNotMatch(workflow, /push:\s*true/);
  assert.doesNotMatch(workflow, /DEEPSEEK|API_KEY|ghcr\.io/);
  assert.match(workflow, /contents: read/);
});
