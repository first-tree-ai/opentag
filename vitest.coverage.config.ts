import { configDefaults, coverageConfigDefaults, defineConfig, defineProject } from "vitest/config";

export default defineConfig({
  test: {
    // Default worker count. `scripts/unit-coverage.mjs` narrows `cli` and `client` to one worker because
    // their suites assert on fixed windows around spawned child processes and their own test scripts
    // already run with `--maxWorkers=1`; every other project keeps this default.
    maxWorkers: 4,
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
          name: "skill-presets",
          root: "packages/skill-presets",
          sequence: { groupOrder: 3 },
        },
      }),
      defineProject({
        test: {
          name: "mcp-presets",
          root: "packages/mcp-presets",
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
      // Resolved against each project's own `root`, not against this file's directory, so each pattern
      // is workspace-relative and covers every project at once. A repository-relative pattern such
      // as `packages/shared/src/**` would be looked up under `packages/shared/packages/shared/src/**`
      // and silently measure nothing. `scripts/unit-coverage.mjs` applies the same rule per project;
      // its own repository-relative list there is the source-tree ownership manifest, not this include.
      // `scripts` is listed because a package's own verification scripts are executable source too:
      // `unit-coverage-gate.mjs` already treats `packages/server/scripts/*.ts` as coverable, so leaving
      // them uninstrumented reported every changed line there as "missing coverage entry". A project
      // without a `scripts` directory simply matches nothing.
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportOnFailure: true,
      reportsDirectory: "coverage/unit",
    },
  },
});
