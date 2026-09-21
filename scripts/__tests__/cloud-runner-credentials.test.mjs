import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preparePiInput } from "../e2e/cloud-runner/credential-input.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("cloud acceptance forwards only DeepSeek and proves host configuration unchanged", async () => {
  const source = await mkdtemp(join(tmpdir(), "e3-config-test-"));
  try {
    const original = JSON.stringify({
      deepseek: { type: "api_key", key: "deepseek-synthetic-only" },
      other: { key: "unrelated-synthetic-only" },
    });
    await writeFile(join(source, "auth.json"), original);
    await writeFile(
      join(source, "models.json"),
      JSON.stringify({
        providers: { deepseek: { apiKey: "model-synthetic-only", models: [] }, other: { apiKey: "unrelated-model" } },
      }),
    );
    await writeFile(
      join(source, "settings.json"),
      JSON.stringify({ defaultProvider: "deepseek", extensions: ["untrusted-extension"] }),
    );
    const secrets = [];
    const beforeSignals = process.listenerCount("SIGTERM");
    const input = await preparePiInput({ repositoryRoot, source, secrets });
    assert.equal(process.listenerCount("SIGTERM"), beforeSignals);
    assert.deepEqual(Object.keys(JSON.parse(input.config.authJson)), ["deepseek"]);
    assert.equal(JSON.stringify(input.config).includes("unrelated"), false);
    assert.equal(JSON.stringify(input.config).includes("untrusted-extension"), false);
    assert.equal(secrets.includes("deepseek-synthetic-only"), true);
    assert.equal(secrets.includes("model-synthetic-only"), true);
    assert.equal(await input.verifyUnchanged(), true);
    assert.equal(await readFile(join(source, "auth.json"), "utf8"), original);
    await writeFile(join(source, "auth.json"), "{}");
    assert.equal(await input.verifyUnchanged(), false);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
test("cloud credential input rejects symlinks and shell credential indirection", async () => {
  const source = await mkdtemp(join(tmpdir(), "e3-config-test-"));
  try {
    await writeFile(join(source, "auth.json"), JSON.stringify({ deepseek: { key: "!echo must-not-run" } }));
    await assert.rejects(() => preparePiInput({ repositoryRoot, source, secrets: [] }), /indirection/);
    await rm(join(source, "auth.json"));
    await writeFile(join(source, "actual.json"), "{}");
    await symlink(join(source, "actual.json"), join(source, "auth.json"));
    await assert.rejects(() => preparePiInput({ repositoryRoot, source, secrets: [] }), /regular files/);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
