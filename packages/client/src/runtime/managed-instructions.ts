import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
import type { ContextTreeStatus } from "./context-tree.js";

export interface ManagedSessionContext {
  sessionId: string;
  sessionKind: "visible" | "internal";
  creatorSessionId?: string;
  cliCommand: string;
  sessionCliAvailable: boolean;
  contextTree?: ContextTreeStatus;
}

/**
 * The Agent is told plainly when durable memory is absent, so it cannot mistake a failed
 * connection for an empty tree and start re-deriving decisions. Its own slug is not repeated
 * here — the trusted Platform section above already states it.
 */
function renderContextTree(status: ContextTreeStatus, cliCommand: string): readonly string[] {
  if (status.status === "ready") {
    return [
      `Context Tree: ${status.treePath}`,
      "This is durable shared memory for every Agent on this Computer. Read the decisions that bear on a task before planning or changing code, and record durable decisions there.",
      "Use the context-tree-read and context-tree-write skills rather than editing the tree by hand.",
      "`members/<your Agent slug>/` is your own private working memory; the Agent slug is stated in the Platform section above. Do not write to another Agent's member directory.",
      "",
    ];
  }
  if (status.status === "unconfigured") {
    return [
      `Context Tree: not configured on this Computer (${cliCommand} context-tree connect).`,
      "Durable memory is not active. Do not assume earlier decisions were recorded, and do not attempt to create a tree yourself.",
      "",
    ];
  }
  return [
    `Context Tree unavailable (${status.reason}).`,
    "Durable memory is not active for this Session. Do not assume earlier decisions were recorded, and do not attempt to repair the tree yourself.",
    "",
  ];
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
              "You may create further internal Sessions when platform-level Session collaboration is useful.",
            ]
          : [
              "You are a visible Session. You may handle work directly, use Provider-native subagents when available, or create OpenTag internal Sessions when platform-level Session collaboration is useful.",
            ]),
        "OpenTag internal Sessions and Provider-native subagents are separate mechanisms and are not interchangeable.",
        `When a user explicitly requests an OpenTag internal Session and Session collaboration is available, use ${context.cliCommand} session create; do not substitute a Provider-native subagent.`,
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
        ...(context.contextTree ? renderContextTree(context.contextTree, context.cliCommand) : []),
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
