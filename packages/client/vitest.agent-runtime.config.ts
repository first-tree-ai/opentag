import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/agent-runtime-contract.test.ts",
      "src/__tests__/agent-runtime-exhaustive.test.ts",
      "src/__tests__/agent-runtime-validation.test.ts",
      "src/__tests__/agent-turn-runner.test.ts",
      "src/__tests__/claude-code-agent-runtime.test.ts",
      "src/__tests__/claude-code-agent-runtime-exhaustive.test.ts",
      "src/__tests__/claude-code-process.test.ts",
      "src/__tests__/codex-agent-runtime.test.ts",
      "src/__tests__/codex-agent-runtime-exhaustive.test.ts",
      "src/__tests__/codex-app-server.test.ts",
      "src/__tests__/codex-app-server-exhaustive.test.ts",
      "src/__tests__/pi-agent-runtime.test.ts",
      "src/__tests__/pi-agent-runtime-exhaustive.test.ts",
      "src/__tests__/pi-rpc-wire.test.ts",
      "src/__tests__/client-turn.integration.test.ts",
      "src/__tests__/runtime-tool-host.test.ts",
      "src/__tests__/session-runtime-manager.test.ts",
    ],
    maxWorkers: 1,
    coverage: {
      enabled: true,
      provider: "v8",
      include: [
        "src/agent-runtime/**/*.ts",
        "src/providers/claude-code/agent-runtime.ts",
        "src/providers/claude-code/process-wire.ts",
        "src/providers/codex/agent-runtime.ts",
        "src/providers/codex/app-server-wire.ts",
        "src/providers/pi/agent-runtime.ts",
        "src/providers/pi/rpc-wire.ts",
        "src/runtime/agent-turn-runner.ts",
        "src/runtime/runtime-tool-host.ts",
        "src/runtime/session-runtime-manager.ts",
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
