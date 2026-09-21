import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupNow, registerCleanup, registerTempDir, runWithCleanup } from "../runner/cleanup.mjs";

test("runWithCleanup removes registered temp dirs after success and failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opentag-clean-"));
  await writeFile(join(dir, "x"), "1");
  registerTempDir(dir);
  await runWithCleanup(async () => {
    assert.equal((await stat(dir)).isDirectory(), true);
  });
  await assert.rejects(() => stat(dir), { code: "ENOENT" });

  const failed = await mkdtemp(join(tmpdir(), "opentag-clean-fail-"));
  registerTempDir(failed);
  await assert.rejects(
    () =>
      runWithCleanup(async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  await assert.rejects(() => stat(failed), { code: "ENOENT" });
});

test("cleanup runs registered callbacks in reverse and has no keep-secrets option", async () => {
  const seen = [];
  registerCleanup(() => seen.push("a"));
  registerCleanup(() => seen.push("b"));
  cleanupNow();
  assert.deepEqual(seen, ["b", "a"]);
  const source = await import("../runner/cleanup.mjs");
  assert.equal("keepSecrets" in source, false);
});
