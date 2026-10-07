import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("private deployment authority gates both public deployment jobs, including manual runs", async () => {
  for (const name of ["deploy-staging", "deploy-runner"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    const gate = workflow.slice(workflow.indexOf("    if:"), workflow.indexOf("    runs-on:"));
    assert.match(gate, /vars\.OPENTAG_DEPLOYMENT_AUTHORITY != 'private' &&/);
    assert.match(gate, /github\.repository == 'first-tree-ai\/opentag'/);
  }
});
