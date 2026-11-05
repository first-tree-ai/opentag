import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("local IM acceptance control refuses unsafe switches using isolated processes", { timeout: 60_000 }, () => {
  const result = spawnSync(
    "python3",
    [fileURLToPath(new URL("../local-im-control/test_control.py", import.meta.url)), "-v"],
    {
      encoding: "utf8",
      timeout: 55_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 14 tests/);
});
