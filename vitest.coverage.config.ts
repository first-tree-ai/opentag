import { configDefaults, coverageConfigDefaults, defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 1,
    projects: [
      defineProject({
        test: {
          name: "cli",
          root: "apps/cli",
          sequence: { groupOrder: 1 },
        },
      }),
      "apps/web/vite.config.ts",
      defineProject({
        test: {
          name: "shared",
          root: "packages/shared",
          sequence: { groupOrder: 3 },
        },
      }),
      defineProject({
        test: {
          name: "client",
          root: "packages/client",
          sequence: { groupOrder: 4 },
        },
      }),
      defineProject({
        test: {
          exclude: [...configDefaults.exclude, "src/__tests__/integration/**"],
          name: "server",
          root: "packages/server",
          sequence: { groupOrder: 5 },
        },
      }),
    ],
    coverage: {
      enabled: true,
      exclude: [...coverageConfigDefaults.exclude, "**/src/__tests__/**", "**/src/smoke/**", "**/src/paraglide/**"],
      // Resolved against each project's own `root`, not against this file's directory, so the pattern
      // is workspace-relative and covers all five projects at once. A repository-relative pattern such
      // as `packages/shared/src/**` would be looked up under `packages/shared/packages/shared/src/**`
      // and silently measure nothing. `scripts/unit-coverage.mjs` applies the same rule per project;
      // its own repository-relative list there is the source-tree ownership manifest, not this include.
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportOnFailure: true,
      reportsDirectory: "coverage/unit",
    },
  },
});
