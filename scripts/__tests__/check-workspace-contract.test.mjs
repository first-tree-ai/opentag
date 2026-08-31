import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyWorkspaceContract } from "../check-workspace-contract.mjs";

const manifests = {
  "apps/cli": {
    name: "@opentag/cli",
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./dist/index.mjs" },
    files: ["dist"],
    dependencies: { "@opentag/client": "workspace:*", "@opentag/shared": "workspace:*" },
  },
  "apps/web": {
    name: "@opentag/web",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { "@opentag/shared": "workspace:*" },
  },
  "packages/client": {
    name: "@opentag/client",
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./dist/index.mjs" },
    files: ["dist"],
    dependencies: { "@opentag/shared": "workspace:*" },
  },
  "packages/server": {
    name: "@opentag/server",
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./dist/index.mjs" },
    files: ["dist"],
    dependencies: { "@opentag/shared": "workspace:*" },
  },
  "packages/shared": {
    name: "@opentag/shared",
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./dist/index.mjs", "./browser": "./dist/browser.mjs" },
    files: ["dist"],
  },
  e2e: {
    name: "@opentag/e2e",
    version: "0.0.0",
    private: true,
    type: "module",
  },
};

const contract = {
  schemaVersion: 1,
  workspaces: {
    "apps/cli": {
      name: "@opentag/cli",
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: ["@opentag/client", "@opentag/shared"],
    },
    "apps/web": {
      name: "@opentag/web",
      requiresRootExport: false,
      requiresFiles: false,
      allowedWorkspaceDependencies: ["@opentag/shared"],
    },
    "packages/client": {
      name: "@opentag/client",
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: ["@opentag/shared"],
    },
    "packages/server": {
      name: "@opentag/server",
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: ["@opentag/shared"],
    },
    "packages/shared": {
      name: "@opentag/shared",
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: [],
    },
    e2e: { name: "@opentag/e2e", requiresRootExport: false, requiresFiles: false, allowedWorkspaceDependencies: [] },
  },
};

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "opentag-workspace-contract-"));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n  - e2e\n", "utf8");
  await writeJson(join(root, "workspace-contracts.json"), contract);
  for (const [workspacePath, manifest] of Object.entries(manifests)) {
    await writeJson(join(root, workspacePath, "package.json"), manifest);
    await mkdir(join(root, workspacePath, "src"), { recursive: true });
    await writeFile(join(root, workspacePath, "src/index.ts"), "export {};\n", "utf8");
  }
  await writeFile(
    join(root, "apps/cli/src/index.ts"),
    'import "@opentag/client";\nimport "@opentag/shared";\n',
    "utf8",
  );
  await writeFile(join(root, "apps/web/src/index.ts"), 'import "@opentag/shared/browser";\n', "utf8");
  await writeFile(join(root, "packages/client/src/index.ts"), 'import "@opentag/shared";\n', "utf8");
  await writeFile(join(root, "packages/server/src/index.ts"), 'import "@opentag/shared";\n', "utf8");
  return root;
}

async function withFixture(run) {
  const root = await createFixture();
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function updateManifest(root, workspacePath, update) {
  const path = join(root, workspacePath, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeJson(path, update(manifest));
}

test("accepts a clean graph, including the intentional e2e workspace", async () => {
  await withFixture(async (root) => {
    assert.deepEqual(await verifyWorkspaceContract({ rootDirectory: root }), {
      workspaceCount: 6,
      allowedDependencyCount: 5,
    });
  });
});

test("rejects a forbidden dependency edge with source and target", async () => {
  await withFixture(async (root) => {
    await updateManifest(root, "packages/client", (manifest) => ({
      ...manifest,
      dependencies: { ...manifest.dependencies, "@opentag/server": "workspace:*" },
    }));
    await assert.rejects(
      verifyWorkspaceContract({ rootDirectory: root }),
      /packages\/client\/package\.json.*@opentag\/server/,
    );
  });
});

test("rejects an unregistered workspace", async () => {
  await withFixture(async (root) => {
    await writeJson(join(root, "packages/rogue/package.json"), { name: "@opentag/rogue", version: "0.0.0" });
    await assert.rejects(
      verifyWorkspaceContract({ rootDirectory: root }),
      /packages\/rogue\/package\.json.*not registered/,
    );
  });
});

test("rejects non-workspace ranges for internal dependencies", async () => {
  await withFixture(async (root) => {
    await updateManifest(root, "packages/client", (manifest) => ({
      ...manifest,
      dependencies: { ...manifest.dependencies, "@opentag/shared": "^0.0.0" },
    }));
    await assert.rejects(
      verifyWorkspaceContract({ rootDirectory: root }),
      /packages\/client\/package\.json.*@opentag\/shared.*workspace:\*/,
    );
  });
});

test("rejects deep imports while naming the imported target", async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, "apps/cli/src/index.ts"), 'import "@opentag/client/src/private.js";\n', "utf8");
    await assert.rejects(
      verifyWorkspaceContract({ rootDirectory: root }),
      /apps\/cli\/src\/index\.ts.*@opentag\/client\/src\/private\.js/,
    );
    await writeFile(join(root, "apps/cli/src/index.ts"), 'import "@opentag/client/dist/private.mjs";\n', "utf8");
    await assert.rejects(verifyWorkspaceContract({ rootDirectory: root }), /@opentag\/client\/dist\/private\.mjs/);
  });
});

test("rejects relative cross-workspace imports", async () => {
  await withFixture(async (root) => {
    await writeFile(join(root, "apps/cli/src/index.ts"), 'import "../../../packages/shared/src/private.js";\n', "utf8");
    await assert.rejects(
      verifyWorkspaceContract({ rootDirectory: root }),
      /apps\/cli\/src\/index\.ts.*relative import.*@opentag\/shared/,
    );
  });
});

test("rejects a missing public export surface", async () => {
  await withFixture(async (root) => {
    await updateManifest(root, "packages/client", (manifest) => {
      const { exports: _exports, ...withoutExports } = manifest;
      return withoutExports;
    });
    await assert.rejects(
      verifyWorkspaceContract({ rootDirectory: root }),
      /packages\/client\/package\.json.*public.*\./,
    );
  });
});
