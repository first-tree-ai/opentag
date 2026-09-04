import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAppTemplate, getPortableChannelConfig } from "../portable/build-portable.mjs";
import {
  CONTEXT_TREE_SKILL_DIRECTORIES,
  CONTEXT_TREE_TEMPLATE_FILES,
  collectRuntimeDependencyClosure,
  DEPENDENCY_CLOSURE_FILE,
  materializeRuntimeDependencyClosure,
  readPortableDirectDependencyPins,
  runContextTreeRuntimeProbe,
  verifyPortableDependencyGraph,
  writeDependencyClosureFile,
} from "../portable/runtime-dependencies.mjs";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(scriptsDir, "..");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fakeCliEntry(version, binName) {
  return [
    `if (process.argv[2] === "--version") {`,
    `  console.log(${JSON.stringify(version)});`,
    "  process.exit(0);",
    "}",
    `if (process.argv[2] === "--help") {`,
    `  console.log("Usage: ${binName} [command]");`,
    "  process.exit(0);",
    "}",
    "process.exit(3);",
    "",
  ].join("\n");
}

function writeContextTreePackage(
  nodeModulesDir,
  { assets = true, dependencies = { commander: "^15.0.0" }, extra = {}, version = "0.1.8" } = {},
) {
  const packageDir = join(nodeModulesDir, "@first-tree-ai", "context-tree");
  writeJson(join(packageDir, "package.json"), {
    name: "@first-tree-ai/context-tree",
    version,
    type: "module",
    scripts: { postinstall: "node ./scripts/postinstall.mjs" },
    dependencies,
    ...extra,
  });
  writeText(join(packageDir, "dist", "cli", "index.mjs"), "export const cli = true;\n");
  writeText(
    join(packageDir, "scripts", "postinstall.mjs"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./postinstall-ran.marker", import.meta.url), "ran");\n',
  );
  writeText(join(packageDir, "LICENSE"), "Apache-2.0 fixture license\n");
  if (assets) {
    for (const skill of CONTEXT_TREE_SKILL_DIRECTORIES) {
      writeText(join(packageDir, "skills", skill, "SKILL.md"), `# ${skill}\n`);
    }
    for (const template of CONTEXT_TREE_TEMPLATE_FILES) {
      writeText(join(packageDir, "templates", template), `template ${template}\n`);
    }
  }
  return packageDir;
}

/** An offline `apps/cli` stand-in whose dist entry answers the identity smoke correctly. */
function fixtureCliRoot(root, { version = "0.0.2" } = {}) {
  const cliRoot = join(root, "cli");
  writeJson(join(cliRoot, "package.json"), {
    name: "open-tag",
    version,
    private: true,
    type: "module",
    license: "Apache-2.0",
    description: "portable fixture CLI",
    bin: { opentag: "./dist/cli/index.mjs" },
    dependencies: { "@first-tree-ai/context-tree": "0.1.8" },
  });
  writeText(join(cliRoot, "dist", "cli", "index.mjs"), fakeCliEntry(version, "opentag"));
  writeText(join(cliRoot, "dist", "index.mjs"), "export {};\n");
  writeText(join(cliRoot, "LICENSE"), "fixture license\n");
  writeText(join(cliRoot, "README.md"), "fixture readme\n");
  writeText(join(cliRoot, "THIRD_PARTY_NOTICES"), "fixture notices\n");
  return cliRoot;
}

function writeChildPackage(nodeModulesDir, name, { dependencies = {}, extra = {}, version = "1.0.0" } = {}) {
  const packageDir = join(nodeModulesDir, ...name.split("/"));
  writeJson(join(packageDir, "package.json"), { name, version, dependencies, ...extra });
  writeText(join(packageDir, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
  return packageDir;
}

/** A complete offline CLI root with the supported direct dependency and one transitive child. */
function fixtureTree(root) {
  const cliRoot = fixtureCliRoot(root);
  const nodeModulesDir = join(cliRoot, "node_modules");
  writeContextTreePackage(nodeModulesDir);
  writeChildPackage(nodeModulesDir, "commander", { version: "15.0.0" });
  return cliRoot;
}

/** Assembles a verifiable offline app: manifest, materialized node_modules, and closure record. */
function assembleFixtureApp(root) {
  const cliRoot = fixtureTree(root);
  const appDir = join(root, "app");
  const closure = materializeRuntimeDependencyClosure({
    nodeModulesDir: join(appDir, "node_modules"),
    sourceManifestPath: join(cliRoot, "package.json"),
  });
  writeJson(join(appDir, "package.json"), {
    name: "open-tag",
    version: "0.0.2",
    type: "module",
    dependencies: { "@first-tree-ai/context-tree": "0.1.8" },
  });
  writeDependencyClosureFile(appDir, closure);
  return appDir;
}

test("the portable runtime dependency contract accepts only the supported exact pin", () => {
  assert.deepEqual(readPortableDirectDependencyPins({ dependencies: { "@first-tree-ai/context-tree": "0.1.8" } }), [
    { name: "@first-tree-ai/context-tree", version: "0.1.8" },
  ]);
  assert.deepEqual(readPortableDirectDependencyPins({}), []);
  assert.deepEqual(readPortableDirectDependencyPins({ dependencies: {} }), []);
  assert.throws(
    () => readPortableDirectDependencyPins({ dependencies: { commander: "^15.0.0" } }),
    /unsupported runtime dependency/,
  );
  assert.throws(
    () => readPortableDirectDependencyPins({ dependencies: { "@first-tree-ai/context-tree": "^0.1.8" } }),
    /exact x\.y\.z/,
  );
  assert.throws(
    () => readPortableDirectDependencyPins({ dependencies: { "@first-tree-ai/context-tree": "workspace:*" } }),
    /exact x\.y\.z/,
  );
  assert.throws(
    () =>
      readPortableDirectDependencyPins({
        dependencies: { "@first-tree-ai/context-tree": "0.1.8" },
        optionalDependencies: { bufferutil: "^4.0.0" },
      }),
    /non-empty optionalDependencies/,
  );
  assert.throws(
    () =>
      readPortableDirectDependencyPins({
        dependencies: { "@first-tree-ai/context-tree": "0.1.8" },
        peerDependencies: { react: "^19.0.0" },
      }),
    /non-empty peerDependencies/,
  );
});

test("the checked-in apps/cli manifest is accepted under the portable shipping contract", () => {
  const cliManifest = JSON.parse(readFileSync(join(repoRoot, "apps", "cli", "package.json"), "utf8"));
  assert.deepEqual(readPortableDirectDependencyPins(cliManifest), [
    { name: "@first-tree-ai/context-tree", version: "0.1.8" },
  ]);
});

test("materializing the closure copies published content and never runs lifecycle scripts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureTree(root);
  const treePackageDir = join(cliRoot, "node_modules", "@first-tree-ai", "context-tree");
  // pnpm-style bin droppings inside the installed package must never be copied.
  writeText(join(treePackageDir, "node_modules", ".bin", "context-tree"), "ignored\n");

  const appDir = join(root, "app");
  const closure = materializeRuntimeDependencyClosure({
    nodeModulesDir: join(appDir, "node_modules"),
    sourceManifestPath: join(cliRoot, "package.json"),
  });
  assert.deepEqual(closure.direct, [{ name: "@first-tree-ai/context-tree", version: "0.1.8" }]);
  assert.deepEqual(
    closure.packages.map((entry) => entry.name),
    ["@first-tree-ai/context-tree", "commander"],
  );

  const embeddedRoot = join(appDir, "node_modules", "@first-tree-ai", "context-tree");
  assert.equal(readFileSync(join(embeddedRoot, "LICENSE"), "utf8"), "Apache-2.0 fixture license\n");
  assert.equal(readFileSync(join(embeddedRoot, "dist", "cli", "index.mjs"), "utf8"), "export const cli = true;\n");
  assert.equal(
    readFileSync(join(embeddedRoot, "skills", "context-tree-read", "SKILL.md"), "utf8"),
    "# context-tree-read\n",
  );
  assert.equal(existsSync(join(embeddedRoot, "scripts", "postinstall.mjs")), true);
  assert.equal(
    existsSync(join(embeddedRoot, "scripts", "postinstall-ran.marker")),
    false,
    "lifecycle scripts must never execute",
  );
  assert.equal(existsSync(join(embeddedRoot, "node_modules")), false, "a package's own node_modules must not ship");
  assert.equal(existsSync(join(appDir, "node_modules", "commander", "index.js")), true);
  assert.deepEqual(readdirSync(join(appDir, "node_modules")).sort(), ["@first-tree-ai", "commander"]);
});

test("the installed direct dependency must match the exact source pin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureCliRoot(root);
  writeContextTreePackage(join(cliRoot, "node_modules"), { version: "0.1.9" });
  assert.throws(
    () => collectRuntimeDependencyClosure({ sourceManifestPath: join(cliRoot, "package.json") }),
    /installed package @first-tree-ai\/context-tree is version 0\.1\.9, but the source pins 0\.1\.8/,
  );
});

test("a declared dependency that is not installed fails closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureCliRoot(root);
  writeContextTreePackage(join(cliRoot, "node_modules"));
  assert.throws(
    () => collectRuntimeDependencyClosure({ sourceManifestPath: join(cliRoot, "package.json") }),
    /could not be resolved from/,
  );
});

test("same-name packages from different installed roots fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureCliRoot(root);
  const nodeModulesDir = join(cliRoot, "node_modules");
  writeContextTreePackage(nodeModulesDir, { dependencies: { a: "^1.0.0", b: "^1.0.0" } });
  for (const [name, xVersion] of [
    ["a", "1.0.0"],
    ["b", "2.0.0"],
  ]) {
    writeChildPackage(nodeModulesDir, name, { dependencies: { x: "^1.0.0" } });
    writeJson(join(nodeModulesDir, name, "node_modules", "x", "package.json"), {
      name: "x",
      version: xVersion,
      dependencies: {},
    });
    writeText(join(nodeModulesDir, name, "node_modules", "x", "index.js"), `module.exports = "x@${xVersion}";\n`);
  }
  assert.throws(
    () => collectRuntimeDependencyClosure({ sourceManifestPath: join(cliRoot, "package.json") }),
    /cannot ship both versions/,
  );
});

test("dependency cycles deduplicate against the visited graph", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureCliRoot(root);
  const nodeModulesDir = join(cliRoot, "node_modules");
  writeContextTreePackage(nodeModulesDir, { dependencies: { commander: "^15.0.0" } });
  writeChildPackage(nodeModulesDir, "commander", {
    dependencies: { "@first-tree-ai/context-tree": "^0.1.0" },
    version: "15.0.0",
  });
  const closure = collectRuntimeDependencyClosure({ sourceManifestPath: join(cliRoot, "package.json") });
  assert.deepEqual(
    closure.packages.map((entry) => entry.name),
    ["@first-tree-ai/context-tree", "commander"],
  );
});

test("embedded metadata that the portable layout cannot express is rejected", async () => {
  const rejections = [
    [{ optionalDependencies: { fsevents: "^2.3.3" } }, /non-empty optionalDependencies/],
    [{ peerDependencies: { react: "^19.0.0" } }, /non-empty peerDependencies/],
    [{ os: ["linux"] }, /declares os/],
    [{ scripts: { postinstall: "node x" } }, /lifecycle scripts/],
    [{ dependencies: [] }, /dependencies must be an object/],
    [{ dependencies: { x: null } }, /invalid dependency specifier/],
    [{ bundleDependencies: ["hidden"] }, /non-empty bundleDependencies/],
  ];
  for (const [extra, pattern] of rejections) {
    const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
    try {
      const cliRoot = fixtureCliRoot(root);
      const nodeModulesDir = join(cliRoot, "node_modules");
      writeContextTreePackage(nodeModulesDir);
      writeChildPackage(nodeModulesDir, "commander", { extra, version: "15.0.0" });
      assert.throws(
        () => collectRuntimeDependencyClosure({ sourceManifestPath: join(cliRoot, "package.json") }),
        pattern,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("optional-only peer metadata (empty peers) stays shippable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureCliRoot(root);
  const nodeModulesDir = join(cliRoot, "node_modules");
  writeContextTreePackage(nodeModulesDir);
  writeChildPackage(nodeModulesDir, "commander", {
    extra: { peerDependenciesMeta: { "supports-color": { optional: true } } },
    version: "15.0.0",
  });
  const closure = collectRuntimeDependencyClosure({ sourceManifestPath: join(cliRoot, "package.json") });
  assert.equal(closure.packages.length, 2);
});

test("published symlinks and native addons fail closed during materialization", async () => {
  for (const variant of ["symlink", "native"]) {
    const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
    try {
      const cliRoot = fixtureTree(root);
      const commanderDir = join(cliRoot, "node_modules", "commander");
      if (variant === "symlink") {
        symlinkSync(join(root, "outside-target"), join(commanderDir, "tool"));
      } else {
        writeText(join(commanderDir, "binding.node"), "\u0000binary");
      }
      assert.throws(
        () =>
          materializeRuntimeDependencyClosure({
            nodeModulesDir: join(root, "app", "node_modules"),
            sourceManifestPath: join(cliRoot, "package.json"),
          }),
        variant === "symlink" ? /symbolic link/ : /native addon/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("the graph verifier accepts a complete offline app", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const appDir = assembleFixtureApp(root);
  assert.equal(verifyPortableDependencyGraph(appDir).packageCount, 2);
  assert.equal(existsSync(join(appDir, DEPENDENCY_CLOSURE_FILE)), true);
});

test("the graph verifier rejects extra, missing, and unreferenced packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const withExtra = assembleFixtureApp(join(root, "extra"));
  writeChildPackage(join(withExtra, "node_modules"), "lodash", { version: "4.0.0" });
  assert.throws(() => verifyPortableDependencyGraph(withExtra), /unreferenced dependency package/);

  const withMissing = assembleFixtureApp(join(root, "missing"));
  rmSync(join(withMissing, "node_modules", "commander"), { force: true, recursive: true });
  assert.throws(() => verifyPortableDependencyGraph(withMissing), /missing dependency package commander/);

  const withDroppedLink = assembleFixtureApp(join(root, "dropped"));
  writeJson(join(withDroppedLink, "node_modules", "@first-tree-ai", "context-tree", "package.json"), {
    name: "@first-tree-ai/context-tree",
    version: "0.1.8",
    dependencies: {},
  });
  assert.throws(() => verifyPortableDependencyGraph(withDroppedLink), /unreferenced dependency package/);
});

test("the graph verifier rejects direct pin drift and deleted Context Tree assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const drifted = assembleFixtureApp(join(root, "drifted"));
  writeJson(join(drifted, "package.json"), {
    name: "open-tag",
    version: "0.0.2",
    type: "module",
    dependencies: { "@first-tree-ai/context-tree": "0.1.9" },
  });
  assert.throws(() => verifyPortableDependencyGraph(drifted), /do not match the recorded direct pins/);

  const withDeletedAsset = assembleFixtureApp(join(root, "assets"));
  rmSync(join(withDeletedAsset, "node_modules", "@first-tree-ai", "context-tree", "skills", "context-tree-read"), {
    force: true,
    recursive: true,
  });
  assert.throws(() => verifyPortableDependencyGraph(withDeletedAsset), /missing packaged asset/);
});

test("the resolver cannot borrow packages from outside the frozen install", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureCliRoot(join(root, "isolated"));
  writeContextTreePackage(join(root, "node_modules"), { dependencies: {} });
  const sourceManifestPath = join(cliRoot, "package.json");
  assert.throws(() => collectRuntimeDependencyClosure({ sourceManifestPath }), /could not be resolved from/);
  mkdirSync(join(cliRoot, "node_modules", "@first-tree-ai"), { recursive: true });
  symlinkSync(
    join(root, "node_modules", "@first-tree-ai", "context-tree"),
    join(cliRoot, "node_modules", "@first-tree-ai", "context-tree"),
  );
  assert.throws(() => collectRuntimeDependencyClosure({ sourceManifestPath }), /outside the frozen install root/);
});

test("the verifier rejects nested dependencies, symlinked roots, and inconsistent records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const nested = assembleFixtureApp(join(root, "nested"));
  mkdirSync(join(nested, "node_modules", "commander", "node_modules"));
  assert.throws(() => verifyPortableDependencyGraph(nested), /nested node_modules/);

  const linked = assembleFixtureApp(join(root, "linked"));
  const linkedModules = join(linked, "node_modules");
  rmSync(linkedModules, { force: true, recursive: true });
  symlinkSync(join(nested, "node_modules"), linkedModules);
  assert.throws(() => verifyPortableDependencyGraph(linked), /missing its node_modules/);

  const duplicate = assembleFixtureApp(join(root, "duplicate"));
  const duplicatePath = join(duplicate, DEPENDENCY_CLOSURE_FILE);
  const duplicateRecord = JSON.parse(readFileSync(duplicatePath, "utf8"));
  duplicateRecord.packages.push(duplicateRecord.packages[0]);
  writeJson(duplicatePath, duplicateRecord);
  assert.throws(() => verifyPortableDependencyGraph(duplicate), /duplicate package/);

  const drift = assembleFixtureApp(join(root, "drift"));
  const driftPath = join(drift, DEPENDENCY_CLOSURE_FILE);
  const driftRecord = JSON.parse(readFileSync(driftPath, "utf8"));
  driftRecord.packages[0].version = "0.1.9";
  writeJson(driftPath, driftRecord);
  writeJson(join(drift, "node_modules", "@first-tree-ai", "context-tree", "package.json"), {
    name: "@first-tree-ai/context-tree",
    version: "0.1.9",
    dependencies: { commander: "^15.0.0" },
  });
  assert.throws(() => verifyPortableDependencyGraph(drift), /does not match the direct pin/);
});

test("dependency-free apps keep the legacy shape and verify clean", () => {
  const root = mkdtempSync(join(tmpdir(), "opentag-portable-rdep-"));
  try {
    const appDir = join(root, "app");
    mkdirSync(appDir, { recursive: true });
    writeJson(join(appDir, "package.json"), { name: "open-tag", version: "0.0.2", type: "module" });
    assert.equal(verifyPortableDependencyGraph(appDir).packageCount, 0);
    writeJson(join(appDir, "package.json"), {
      name: "open-tag",
      version: "0.0.2",
      type: "module",
      dependencies: { "@first-tree-ai/context-tree": "0.1.8" },
    });
    assert.throws(() => verifyPortableDependencyGraph(appDir), /missing dependency-closure\.json/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("createAppTemplate assembles a verified app from an offline fixture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureTree(root);
  const template = await createAppTemplate({
    channelConfig: getPortableChannelConfig("prod"),
    cliRoot,
    version: "0.0.2",
  });
  t.after(() => rm(template.root, { force: true, recursive: true }));
  const appPackage = JSON.parse(readFileSync(join(template.appDir, "package.json"), "utf8"));
  assert.equal(appPackage.name, "open-tag");
  assert.deepEqual(appPackage.dependencies, { "@first-tree-ai/context-tree": "0.1.8" });
  assert.equal(
    existsSync(join(template.appDir, "node_modules", "@first-tree-ai", "context-tree", "dist", "cli", "index.mjs")),
    true,
  );
  assert.equal(existsSync(join(template.appDir, DEPENDENCY_CLOSURE_FILE)), true);
  assert.ok(!template.appDir.startsWith(repoRoot), "the template must live outside the build checkout");
  verifyPortableDependencyGraph(template.appDir);
});

test("a failed template assembly cleans up its temporary tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = fixtureTree(root);
  writeJson(join(cliRoot, "package.json"), {
    ...JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")),
    version: "9.9.9",
  });
  writeText(join(cliRoot, "dist", "cli", "index.mjs"), fakeCliEntry("9.9.9", "opentag"));
  const before = readdirSync(root).sort();
  await assert.rejects(
    createAppTemplate({
      channelConfig: getPortableChannelConfig("prod"),
      cliRoot,
      version: "0.0.2",
      temporaryParent: root,
    }),
    /reports version 9\.9\.9, expected 0\.0\.2/,
  );
  assert.deepEqual(readdirSync(root).sort(), before, "a failed assembly must remove its temporary app tree");
});

test("the real frozen install closure assembles, verifies, and runs the embedded Context Tree CLI", {
  skip:
    !existsSync(join(repoRoot, "apps", "cli", "node_modules", "@first-tree-ai", "context-tree", "package.json")) &&
    "apps/cli frozen install is not present",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opentag-portable-rdep-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const appDir = join(root, "app");
  const sourceManifestPath = join(repoRoot, "apps", "cli", "package.json");
  const closure = materializeRuntimeDependencyClosure({
    nodeModulesDir: join(appDir, "node_modules"),
    sourceManifestPath,
  });
  assert.equal(closure.direct.length, 1);
  assert.equal(closure.packages[0].name, "@first-tree-ai/context-tree");
  assert.equal(closure.packages[0].version, "0.1.8");
  assert.ok(closure.packages.length >= 20, `real closure is unexpectedly small: ${closure.packages.length}`);
  writeJson(join(appDir, "package.json"), {
    name: "open-tag",
    version: "0.0.2",
    type: "module",
    dependencies: { "@first-tree-ai/context-tree": "0.1.8" },
  });
  writeDependencyClosureFile(appDir, closure);
  writeText(join(appDir, "cli", "index.mjs"), "export {};\n");
  assert.equal(verifyPortableDependencyGraph(appDir).packageCount, closure.packages.length);
  const homeDir = join(root, "context-tree-home");
  runContextTreeRuntimeProbe({ appDir, homeDir, nodePath: process.execPath });
  assert.deepEqual(readdirSync(homeDir), [], "the probe must leave its isolated home untouched");
});
