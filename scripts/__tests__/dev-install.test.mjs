import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(repoRoot, "scripts", "dev-install.sh");

test("dev installer is executable and keeps login separate", async () => {
  await access(scriptPath, constants.X_OK);
  const result = spawnSync(scriptPath, ["--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /service setup is deferred until the separate login command/);
  assert.doesNotMatch(result.stdout, /dev-install\.sh login/);
});

test("dev installer builds, links the configured binary, and reconciles the service", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /packages\/shared\/src\/channel-config\.json/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(source, /pnpm build/);
  assert.match(source, /ln -sfn "\$CLI_DIST" "\$BIN_PATH"/);
  assert.match(source, /PATH="\$BIN_DIR\$\{PATH:\+:\$PATH\}" "\$BIN_PATH" daemon ensure-service/);
  const reconcileInvocation = `PATH="$BIN_DIR\${PATH:+:$PATH}" "$BIN_PATH" daemon ensure-service`;
  assert.ok(
    source.indexOf(reconcileInvocation) > source.indexOf("pnpm build"),
    "the OpenTag-specific PATH binding must not affect dependency installation or build tools",
  );
  assert.doesNotMatch(source, /exec "\$BIN_PATH" "\$@"/);
});
