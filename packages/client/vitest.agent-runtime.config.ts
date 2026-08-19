import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/agent-runtime-contract.test.ts",
      "src/__tests__/agent-runtime-exhaustive.test.ts",
      "src/__tests__/agent-runtime-validation.test.ts",
      "src/__tests__/codex-agent-runtime.test.ts",
      "src/__tests__/codex-agent-runtime-exhaustive.test.ts",
      "src/__tests__/codex-app-server.test.ts",
      "src/__tests__/codex-app-server-exhaustive.test.ts",
    ],
    maxWorkers: 1,
    coverage: {
      enabled: true,
      provider: "v8",
      include: [
        "src/agent-runtime/**/*.ts",
        "src/providers/codex/agent-runtime.ts",
        "src/providers/codex/app-server-wire.ts",
      ],
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
