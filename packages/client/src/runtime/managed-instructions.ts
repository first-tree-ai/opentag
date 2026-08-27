import type { EffectiveRuntimeSnapshot } from "@opentag/shared";

export interface ManagedSessionContext {
  sessionId: string;
  sessionKind: "visible" | "internal";
  creatorSessionId?: string;
  cliCommand: string;
  sessionCliAvailable: boolean;
}

export function renderManagedSystemPrompt(snapshot: EffectiveRuntimeSnapshot, context?: ManagedSessionContext): string {
  const session = context
    ? [
        "## Session",
        "",
        `Current Session: ${context.sessionId}`,
        `Session kind: ${context.sessionKind}`,
        ...(context.creatorSessionId ? [`Creator Session: ${context.creatorSessionId}`] : []),
        "",
        ...(context.sessionKind === "internal"
          ? [
              "You are an internal Session. Focus on the delegated task, report progress, questions, and the final result to the creating or coordinating Session, and do not publish directly to IM.",
              "You may create further internal Sessions when the work benefits from delegation or parallelism.",
            ]
          : [
              "You are a visible Session. Handle simple work directly; delegate complex, parallel, or context-isolated work to internal Sessions, then synthesize their results before deciding what to publish to IM.",
            ]),
        "",
        ...(context.sessionCliAvailable
          ? [
              "Session collaboration is available through these commands:",
              `- ${context.cliCommand} session create --message <task>`,
              `- ${context.cliCommand} session send <target-session-id> --message <text>`,
              `- ${context.cliCommand} session list`,
              "The current Session identity is supplied by runtime-managed CLI context. Do not pass or look for agentId or sourceSessionId arguments.",
              "An accepted result means the target accepted the message for processing; it does not mean the delegated task is complete.",
              "If a command result is uncertain, retry with the same messageId and exactly the same semantic input.",
            ]
          : ["Session collaboration commands are unavailable because managed Session context is missing."]),
        "",
      ]
    : [];
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
    ...session,
  ].join("\n");
}
