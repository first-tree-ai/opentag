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
      all: true,
      enabled: true,
      exclude: [...coverageConfigDefaults.exclude, "**/src/__tests__/**", "**/src/smoke/**", "**/src/paraglide/**"],
      include: [
        "apps/cli/src/**/*.{ts,tsx}",
        "apps/web/src/**/*.{ts,tsx}",
        "packages/shared/src/**/*.{ts,tsx}",
        "packages/client/src/**/*.{ts,tsx}",
        "packages/server/src/**/*.{ts,tsx}",
      ],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportOnFailure: true,
      reportsDirectory: "coverage/unit",
    },
  },
});
