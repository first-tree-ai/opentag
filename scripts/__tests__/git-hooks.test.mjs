import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLogger, resolveLogLevel } from "../hook-logging.mjs";
import {
  classifyInstallation,
  installManagedHook,
  MANAGED_HOOK_MARKER,
  MANAGED_HOOKS,
  resolveHooksDirectory,
} from "../install-git-hooks.mjs";
import { childEnvironment, classifyCheckout } from "../worktree-bootstrap.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const NULL_OBJECT_ID = "0".repeat(40);
const HEAD_OBJECT_ID = "1".repeat(40);

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "opentag-hooks-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("only a checkout without a previous HEAD bootstraps a worktree", () => {
  assert.equal(classifyCheckout({ argv: [NULL_OBJECT_ID, HEAD_OBJECT_ID, "1"], env: {} }).bootstrap, true);
  assert.equal(classifyCheckout({ argv: [HEAD_OBJECT_ID, HEAD_OBJECT_ID, "1"], env: {} }).bootstrap, false);
  assert.equal(classifyCheckout({ argv: [NULL_OBJECT_ID, HEAD_OBJECT_ID, "0"], env: {} }).bootstrap, false);
  assert.equal(classifyCheckout({ argv: [], env: {} }).bootstrap, false);
});

test("the worktree bootstrap stays out of automated and opted-out environments", () => {
  const worktreeArguments = [NULL_OBJECT_ID, HEAD_OBJECT_ID, "1"];
  assert.equal(classifyCheckout({ argv: worktreeArguments, env: { CI: "true" } }).bootstrap, false);
  assert.equal(
    classifyCheckout({ argv: worktreeArguments, env: { OPENTAG_SKIP_WORKTREE_BOOTSTRAP: "1" } }).bootstrap,
    false,
  );
  assert.equal(classifyCheckout({ argv: ["--force"], env: { CI: "true" } }).bootstrap, true);
});

test("nested commands do not inherit the hook's Git environment", () => {
  const childEnv = childEnvironment({
    GIT_DIR: "/repo/.git/worktrees/feature",
    GIT_INDEX_FILE: "/repo/.git/worktrees/feature/index",
    GIT_COMMON_DIR: "/repo/.git",
    PATH: "/usr/bin",
  });
  assert.deepEqual(childEnv, { PATH: "/usr/bin" });
});

test("hook installation is skipped where local hooks are pointless", () => {
  assert.equal(classifyInstallation({ env: {} }).install, true);
  assert.equal(classifyInstallation({ env: { CI: "true" } }).install, false);
  assert.equal(classifyInstallation({ env: { OPENTAG_SKIP_GIT_HOOKS: "1" } }).install, false);
});

test("core.hooksPath wins and relative paths resolve against the working tree", () => {
  assert.equal(
    resolveHooksDirectory({ repositoryRoot: "/repo", configuredHooksPath: "", gitHooksPath: ".git/hooks" }),
    "/repo/.git/hooks",
  );
  assert.equal(
    resolveHooksDirectory({ repositoryRoot: "/repo", configuredHooksPath: ".githooks", gitHooksPath: ".git/hooks" }),
    "/repo/.githooks",
  );
  assert.equal(
    resolveHooksDirectory({ repositoryRoot: "/repo", gitHooksPath: "/repo/.git/worktrees/feature/hooks" }),
    "/repo/.git/worktrees/feature/hooks",
  );
  assert.throws(() => resolveHooksDirectory({ repositoryRoot: "/repo", gitHooksPath: "  " }), /hooks directory/);
});

test("a managed hook is installed executable and refreshed in place", async () => {
  await withTemporaryDirectory(async (hooksDirectory) => {
    const source = `#!/bin/sh\n# ${MANAGED_HOOK_MARKER}\nexit 0\n`;
    const created = await installManagedHook({
      hooksDirectory,
      name: "post-checkout",
      source,
      logger: silentLogger,
    });
    assert.equal(created, "created");

    const target = join(hooksDirectory, "post-checkout");
    await access(target, constants.X_OK);
    assert.equal(await readFile(target, "utf8"), source);
    assert.equal(
      await installManagedHook({ hooksDirectory, name: "post-checkout", source, logger: silentLogger }),
      "unchanged",
    );

    const updatedSource = `${source}# revised\n`;
    assert.equal(
      await installManagedHook({ hooksDirectory, name: "post-checkout", source: updatedSource, logger: silentLogger }),
      "updated",
    );
    assert.equal(await readFile(target, "utf8"), updatedSource);
    await assert.rejects(stat(`${target}.old`));
  });
});

test("an unrelated hook is preserved instead of being overwritten", async () => {
  await withTemporaryDirectory(async (hooksDirectory) => {
    const target = join(hooksDirectory, "post-checkout");
    await writeFile(target, "#!/bin/sh\necho mine\n", "utf8");

    const outcome = await installManagedHook({
      hooksDirectory,
      name: "post-checkout",
      source: `#!/bin/sh\n# ${MANAGED_HOOK_MARKER}\nexit 0\n`,
      logger: silentLogger,
    });

    assert.equal(outcome, "updated");
    assert.equal(await readFile(`${target}.old`, "utf8"), "#!/bin/sh\necho mine\n");
  });
});

test("the post-checkout payload bootstraps without depending on node_modules", async () => {
  const hookPath = join(repoRoot, "scripts", "git-hooks", "post-checkout");
  assert.deepEqual(MANAGED_HOOKS, ["post-checkout"]);

  const source = await readFile(hookPath, "utf8");
  assert.ok(source.includes(MANAGED_HOOK_MARKER), "the payload must identify itself as managed");
  assert.match(source, /exec node "\$bootstrap_script" "\$@"/);
  assert.doesNotMatch(source, /lefthook|pnpm|npx/);
});

test("lefthook owns the commit and push gates and leaves post-checkout alone", async () => {
  const config = await readFile(join(repoRoot, "lefthook.yml"), "utf8");
  assert.match(config, /^pre-commit:$/m);
  assert.match(config, /^pre-push:$/m);
  assert.doesNotMatch(config, /^post-checkout:$/m);
  assert.match(config, /biome check --write .* \{staged_files\}/);
  assert.match(config, /stage_fixed: true/);
  assert.match(config, /biome lint \./);
  assert.match(config, /biome format \./);
});

test("image builds install without the hook-installing prepare lifecycle", async () => {
  const dockerfiles = ["Dockerfile", join("scripts", "e2e", "doctor-docker", "Dockerfile")];
  for (const dockerfile of dockerfiles) {
    const source = await readFile(join(repoRoot, dockerfile), "utf8");
    const installations = source.split("\n").filter((line) => line.includes("pnpm install"));
    assert.ok(installations.length > 0, `${dockerfile} should install dependencies`);
    for (const installation of installations) {
      assert.ok(
        installation.includes("--ignore-scripts"),
        `${dockerfile} copies manifests only, so "${installation.trim()}" must not run the root prepare script`,
      );
    }
  }
});

test("hook logging honors the configured level", () => {
  assert.equal(resolveLogLevel(undefined), "info");
  assert.equal(resolveLogLevel("DEBUG"), "debug");
  assert.equal(resolveLogLevel("nonsense"), "info");

  const lines = [];
  const logger = createLogger({
    scope: "test",
    env: { OPENTAG_HOOKS_LOG_LEVEL: "warn" },
    streams: { out: (line) => lines.push(`out:${line}`), error: (line) => lines.push(`err:${line}`) },
  });
  logger.debug("hidden");
  logger.info("hidden");
  logger.warn("shown");
  logger.error("shown too");
  assert.deepEqual(lines, ["err:[test] shown", "err:[test] shown too"]);
});
