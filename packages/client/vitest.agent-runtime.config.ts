import { defineConfig } from "vitest/config";

/**
 * The Agent Runtime 100% gate is authoritative on ubuntu-latest (the platform
 * used by CI). Runtime discovery and process ownership intentionally retain
 * host-specific paths that are not meaningful to execute on every host:
 * `agent-runtime-installation.ts` handles Windows `PATHEXT`, macOS desktop
 * locations, and the Windows login-shell skip; `login-shell-path.ts` selects
 * zsh versus bash, skips Windows, and applies macOS protected-root handling;
 * provider process adapters and the watchdog choose platform-specific process
 * groups; and `client-runtime-composition.ts` has a Windows-only executable
 * suffix probe. Tests inject a platform for discovery/login-shell logic where
 * possible, while the remaining process branches are covered by the Ubuntu
 * CI authority boundary.
 */
export default defineConfig({
  test: {
    include: [
      "src/__tests__/agent-runtime-contract.test.ts",
      "src/__tests__/agent-runtime-event-validator.test.ts",
      "src/__tests__/agent-runtime-exhaustive.test.ts",
      "src/__tests__/agent-runtime-validation.test.ts",
      "src/__tests__/agent-runtime-provider-registry.test.ts",
      "src/__tests__/agent-turn-runner.test.ts",
      "src/__tests__/claude-code-agent-runtime.test.ts",
      "src/__tests__/claude-code-agent-runtime-exhaustive.test.ts",
      "src/__tests__/claude-code-hosted-tool-bridge.test.ts",
      "src/__tests__/claude-code-process.test.ts",
      "src/__tests__/codex-agent-runtime.test.ts",
      "src/__tests__/codex-agent-runtime-exhaustive.test.ts",
      "src/__tests__/codex-app-server.test.ts",
      "src/__tests__/codex-app-server-exhaustive.test.ts",
      "src/__tests__/pi-agent-runtime.test.ts",
      "src/__tests__/pi-agent-runtime-exhaustive.test.ts",
      "src/__tests__/pi-rpc-wire.test.ts",
      "src/__tests__/client-turn.integration.test.ts",
      "src/__tests__/client-runtime-composition.test.ts",
      "src/__tests__/probe-failure.test.ts",
      "src/__tests__/resolved-runtime-factory.test.ts",
      "src/__tests__/runtime-durability.test.ts",
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
        "src/providers/claude-code/hosted-tool-bridge.ts",
        "src/providers/claude-code/process-wire.ts",
        "src/providers/claude-code/runtime-policy.ts",
        "src/providers/codex/agent-runtime.ts",
        "src/providers/codex/app-server-wire.ts",
        "src/providers/codex/runtime-policy.ts",
        "src/providers/pi/agent-runtime.ts",
        "src/providers/pi/rpc-wire.ts",
        "src/providers/process-owner.ts",
        "src/runtime/agent-turn-runner.ts",
        "src/runtime/client-runtime-composition.ts",
        "src/runtime/runtime-durability.ts",
        "src/runtime/agent-runtime-provider-registry.ts",
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
