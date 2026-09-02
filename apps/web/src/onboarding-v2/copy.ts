import type { Runtime } from "./flow.js";

export const RUNTIME_COPY: Record<Runtime, { readonly title: string; readonly description: string }> = {
  codex: { title: "Codex", description: "OpenAI" },
  "claude-code": { title: "Claude Code", description: "Anthropic" },
};

export const COPY = {
  check: { repairCommand: "opentag doctor --fix" },
} as const;
