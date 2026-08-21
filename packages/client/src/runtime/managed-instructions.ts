import type { EffectiveRuntimeSnapshot } from "@opentag/shared";

export function renderManagedSystemPrompt(snapshot: EffectiveRuntimeSnapshot): string {
  return [
    "# OpenTag managed instructions",
    "",
    "These trusted instructions are injected through the Agent Runtime Provider's native system prompt.",
    "Session-specific instructions and message context are injected for each Turn.",
    "",
    "## Platform",
    "",
    snapshot.instructions.platform,
    "",
    "## Agent",
    "",
    snapshot.instructions.agent,
    "",
  ].join("\n");
}
