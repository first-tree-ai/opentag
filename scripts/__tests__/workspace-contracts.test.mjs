import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyWorkspaceContracts } from "../verify-workspace-contracts.mjs";

const workspaceContracts = {
  schemaVersion: 1,
  workspaces: {
    "apps/cli": {
      name: "open-tag",
      private: true,
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: ["@opentag/client", "@opentag/shared"],
    },
    "packages/client": {
      name: "@opentag/client",
      private: true,
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: ["@opentag/shared"],
    },
    "packages/server": {
      name: "@opentag/server",
      private: true,
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: ["@opentag/shared"],
    },
    "packages/shared": {
      name: "@opentag/shared",
      private: true,
      requiresRootExport: true,
      requiresFiles: true,
      allowedWorkspaceDependencies: [],
    },
  },
};

const workspaceManifests = {
  "apps/cli": {
    name: "open-tag",
    version: "0.0.1",
    private: true,
    type: "module",
    exports: { ".": "./dist/index.mjs" },
    files: ["dist"],
    devDependencies: {
      "@opentag/client": "workspace:*",
      "@opentag/shared": "workspace:*",
    },
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
    exports: { ".": "./dist/index.mjs" },
    files: ["dist"],
  },
};

const workspaceReferences = {
  "apps/cli": [{ path: "../../packages/client" }, { path: "../../packages/shared" }],
  "packages/client": [{ path: "../shared" }],
  "packages/server": [{ path: "../shared" }],
  "packages/shared": [],
};

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "opentag-workspace-contracts-"));
  await writeFile(join(rootDirectory, "pnpm-workspace.yaml"), "packages:\n  - apps/cli\n  - packages/*\n");
  await writeJson(join(rootDirectory, "workspace-contracts.json"), workspaceContracts);

  for (const [workspacePath, manifest] of Object.entries(workspaceManifests)) {
    await writeJson(join(rootDirectory, workspacePath, "package.json"), manifest);
    await writeJson(join(rootDirectory, workspacePath, "tsconfig.json"), {
      references: workspaceReferences[workspacePath],
    });
    await mkdir(join(rootDirectory, workspacePath, "src"), { recursive: true });
    await writeFile(join(rootDirectory, workspacePath, "src/index.ts"), "export {};\n");
  }

  return rootDirectory;
}

async function withFixture(callback) {
  const rootDirectory = await createFixture();
  try {
    await callback(rootDirectory);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

test("accepts the declared OpenTag workspace graph", async () => {
  await withFixture(async (rootDirectory) => {
    assert.deepEqual(await verifyWorkspaceContracts({ rootDirectory }), {
      allowedDependencyCount: 4,
      workspaceCount: 4,
    });
  });
});

test("rejects unregistered workspaces", async () => {
  await withFixture(async (rootDirectory) => {
    await writeJson(join(rootDirectory, "packages/rogue/package.json"), {
      name: "@opentag/rogue",
      version: "0.0.0",
    });

    await assert.rejects(
      verifyWorkspaceContracts({ rootDirectory }),
      /packages\/rogue\/package\.json: workspace is not registered/,
    );
  });
});

test("rejects forbidden workspace dependencies and non-workspace ranges", async () => {
  await withFixture(async (rootDirectory) => {
    const manifestPath = join(rootDirectory, "packages/client/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies["@opentag/server"] = "^0.0.0";
    await writeJson(manifestPath, manifest);

    await assert.rejects(verifyWorkspaceContracts({ rootDirectory }), (error) => {
      assert.match(error.message, /cannot depend on workspace package "@opentag\/server"/);
      assert.match(error.message, /must use the workspace: protocol/);
      return true;
    });
  });
});

test("rejects TypeScript project references that drift from the contract", async () => {
  await withFixture(async (rootDirectory) => {
    await writeJson(join(rootDirectory, "packages/client/tsconfig.json"), {
      references: [{ path: "../server" }],
    });

    await assert.rejects(verifyWorkspaceContracts({ rootDirectory }), (error) => {
      assert.match(error.message, /references forbidden workspace package "@opentag\/server"/);
      assert.match(error.message, /missing reference to allowed workspace package "@opentag\/shared"/);
      return true;
    });
  });
});

test("rejects package metadata that weakens the artifact boundary", async () => {
  await withFixture(async (rootDirectory) => {
    const manifestPath = join(rootDirectory, "packages/shared/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.exports;
    delete manifest.files;
    await writeJson(manifestPath, manifest);

    await assert.rejects(verifyWorkspaceContracts({ rootDirectory }), (error) => {
      assert.match(error.message, /exports must define the public "\." entry point/);
      assert.match(error.message, /files must declare the published artifact boundary/);
      return true;
    });
  });
});

test("rejects a null root export", async () => {
  await withFixture(async (rootDirectory) => {
    const manifestPath = join(rootDirectory, "packages/shared/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.exports["."] = null;
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      verifyWorkspaceContracts({ rootDirectory }),
      /exports "\." must resolve to at least one artifact target/,
    );
  });
});

test("rejects root export targets outside the files boundary", async () => {
  await withFixture(async (rootDirectory) => {
    const manifestPath = join(rootDirectory, "packages/shared/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files = ["README.md"];
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      verifyWorkspaceContracts({ rootDirectory }),
      /root export target "\.\/dist\/index\.mjs" is not covered by files/,
    );
  });
});

test("rejects package deep imports", async () => {
  await withFixture(async (rootDirectory) => {
    await writeFile(
      join(rootDirectory, "packages/client/src/index.ts"),
      'export { value } from "@opentag/shared/internal";\n',
    );

    await assert.rejects(
      verifyWorkspaceContracts({ rootDirectory }),
      /import "@opentag\/shared\/internal" bypasses the public root export/,
    );
  });
});

test("rejects deep imports in TypeScript import types", async () => {
  await withFixture(async (rootDirectory) => {
    await writeFile(
      join(rootDirectory, "packages/client/src/index.ts"),
      'export type SharedValue = import("@opentag/shared/internal").SharedValue;\n',
    );

    await assert.rejects(
      verifyWorkspaceContracts({ rootDirectory }),
      /import "@opentag\/shared\/internal" bypasses the public root export/,
    );
  });
});

test("rejects dynamic imports with an options argument", async () => {
  await withFixture(async (rootDirectory) => {
    await writeFile(
      join(rootDirectory, "packages/client/src/index.ts"),
      'void import("@opentag/server/internal", { with: { type: "json" } });\n',
    );

    await assert.rejects(verifyWorkspaceContracts({ rootDirectory }), (error) => {
      assert.match(error.message, /import "@opentag\/server\/internal" bypasses the public root export/);
      assert.match(error.message, /imports forbidden workspace package "@opentag\/server"/);
      return true;
    });
  });
});

test("rejects relative imports that cross workspace boundaries", async () => {
  await withFixture(async (rootDirectory) => {
    await writeFile(
      join(rootDirectory, "packages/client/src/index.ts"),
      'export { value } from "../../shared/src/index.ts";\n',
    );

    await assert.rejects(
      verifyWorkspaceContracts({ rootDirectory }),
      /relative import "\.\.\/\.\.\/shared\/src\/index\.ts" crosses into workspace "@opentag\/shared"/,
    );
  });
});
