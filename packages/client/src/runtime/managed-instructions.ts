import type { ContextTreeConnection, EffectiveRuntimeSnapshot } from "@opentag/shared";

export type ManagedEnvironment = "local" | "cloud";

/**
 * Both runtime tree statuses are structurally assignable to this prompt context.
 */
export type ManagedContextTreeStatus =
  | { status: "configured"; connections: readonly ManagedContextTreeResult[] }
  | { status: "ready"; treePath: string; branch?: string; sha?: string }
  | { status: "stale"; treePath: string; reason: string }
  | { status: "unconfigured" }
  | { status: "unavailable"; reason: string };

export type ManagedContextTreeResult = ContextTreeConnection &
  Exclude<ManagedContextTreeStatus, { status: "configured" } | { status: "unconfigured" }>;

/** Runtime facts supplied by either the Local manager or the Cloud worker. */
export interface ManagedSessionContext {
  environment: ManagedEnvironment;
  sessionId: string;
  sessionKind: "visible" | "internal";
  /** The Session that created this one; omitted entirely when the caller does not carry one. */
  creatorSessionId?: string;
  cliCommand: string;
  /** True only with real Session-CLI proof material behind the commands. */
  sessionCliAvailable: boolean;
  selfConfigurationEnabled: boolean;
  contextTree?: ManagedContextTreeStatus;
  /** Local only: the Agent's persistent Home on this Computer. */
  agentHome?: string;
}

/**
 * Extract the current Agent slug from the rendered platform instructions. The Server renders
 * them through `renderPlatformInstructions` (`OpenTag Agent slug: <slug>`) and fails closed on a
 * malformed name, so an anchored, charset-strict match is exactly the identity the Server vetted.
 */
export function managedAgentSlug(platformInstructions: string): string | undefined {
  return /(?:^|\n)OpenTag Agent slug: ([a-z0-9][a-z0-9-]*)(?=\n|$)/.exec(platformInstructions)?.[1];
}

function renderCloudExecutionContext(): readonly string[] {
  return [
    "## Cloud execution context",
    "",
    "- You run inside a Session-scoped Cloud Sandbox. The workspace is this Session's own; it is not shared with other Sessions.",
    "- The workspace and Pi conversation for this Session recover from the last successful save when the environment is replaced. Unsaved changes can be lost; running processes and background services do not survive Turn cleanup or replacement.",
    "- Saved workspaces are limited to 256 MiB of file content, 50,000 entries and a 128 MiB compressed archive. Hard links, sockets, FIFOs and links outside the workspace cannot be saved. Keep dependency caches, large installs and disposable build output outside the workspace (for example /tmp); recreate them on later Turns. Exceeding these limits blocks further execution and requires recovery or explicit discard of unsaved changes.",
    "- Credentials are execution-scoped and short-lived; the managed IM/Git CLIs reach providers through the platform proxy. Never ask the user for tokens and never persist credential material.",
    "",
  ];
}

function renderAgentHome(agentHome?: string): readonly string[] {
  const location = agentHome
    ? `Your Agent Home is ${agentHome}. One persistent Home is shared across this Agent's Sessions on this Computer.`
    : "One persistent Home is shared across this Agent's Sessions on this Computer.";
  return [
    "## Agent Home",
    "",
    location,
    "Files survive tasks. Use absolute paths; resolve the directories below from Agent Home, not the task cwd.",
    "",
    "These directories are prompt conventions, not platform-managed resources or automatic cleanup policies. Create them only as needed:",
    "- `source-repos/<unique-repo-key>/` — agent-managed bare source clones. Repository identity comes from the user or task, not from platform bindings. Before reusing an existing clone, verify it belongs to the intended repository. Preserve existing files. Do not clone into the Home root.",
    "- `worktrees/<unique-task-key>/` — agent-managed checkouts for source access and code work. Concurrent code tasks each use a distinct worktree (and a distinct branch when editing). Keep later operations for the same task in its own worktree. No two code tasks edit one checkout.",
    "- `files/<unique-task-key>/` — non-repository task artifacts, created only when needed.",
    "",
    "OpenTag provides the bundled `context-tree` command. If it cannot run, report a runtime setup problem; do not install it globally.",
    'Context Tree stays the separately configured shared tree managed by its matching CLI and skills. When running Context Tree project commands from a task subdirectory, pass `--project-path "<Agent Home>"` to use the connected Home; do not create or reconnect a tree just because the task cwd changed. Follow the matching skill write protocol. Do not invent an independent Git policy for Tree writes.',
    "",
  ];
}

/**
 * Reusable know-how an Agent discovers can be saved to its own platform account and restored on
 * every Computer it runs on. This retains the existing Local capability guidance.
 */
function renderSkills(cliCommand: string): readonly string[] {
  return [
    "## Skills",
    "",
    `Reusable routines can be captured as a skill: a directory with a \`SKILL.md\` whose frontmatter has \`name\` and \`description\`. Save one to the platform with \`${cliCommand} skill push <dir>\`. Saved skills are restored on every Computer this Agent runs on.`,
    "",
  ];
}

/**
 * The Agent may tune its own configuration through the Session proof. Instructions, model, and
 * reasoning effort feed the effective snapshot hash, so a change applies from the next Turn and that
 * Turn starts a new provider conversation instead of resuming the old one. The Agent is told so it
 * does not change them casually mid-task.
 */
function renderSelfConfiguration(cliCommand: string): readonly string[] {
  return [
    "## Self-configuration",
    "",
    `Inspect your own configuration with \`${cliCommand} agent self show\`. When a user asks you to change how you work, you may update your own instructions, model, or reasoning effort with \`${cliCommand} agent self update\`, and mount or enable Account MCP Servers with \`${cliCommand} agent self mcp\`. Instruction, model, and reasoning-effort changes apply from your next Turn and start a new provider conversation in every existing Session, so earlier conversation context is not carried over; change them only when asked, not mid-task. An Agent that had no usable MCP Server gets MCP access at its next execution. Replacing instructions overwrites them entirely, so read the current value first and keep what still applies.`,
    "",
  ];
}

function renderSession(context: ManagedSessionContext): readonly string[] {
  const local = context.environment === "local";
  return [
    ...(local ? renderAgentHome(context.agentHome) : []),
    ...(local ? renderSkills(context.cliCommand) : []),
    ...(local && context.sessionCliAvailable && context.selfConfigurationEnabled
      ? renderSelfConfiguration(context.cliCommand)
      : []),
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
          "Lean toward a lively, friendly tone, adapting naturally to the user and the situation.",
          'For a lengthy user task, add one emoji reaction meaning "received, working on it" to the original user message via the provider CLI before starting task work (for example, Feishu OnIt or the provider\'s equivalent). Do not use approval or completion reactions such as thumbs-up or check marks. Skip it only for duplicate acknowledgments and observer deliveries.',
        ]),
    "OpenTag internal Sessions and Provider-native subagents are separate mechanisms and are not interchangeable.",
    `When a user explicitly requests an OpenTag internal Session and Session collaboration is available, use ${context.cliCommand} session create; do not substitute a Provider-native subagent.`,
    "",
    ...renderSessionCollaboration(context),
    "",
  ];
}

function renderSessionCollaboration(context: ManagedSessionContext): readonly string[] {
  if (!context.sessionCliAvailable) {
    return ["Session collaboration commands are unavailable because managed Session context is missing."];
  }
  return [
    "Session collaboration is available through these commands:",
    `- ${context.cliCommand} session create --message <task>`,
    `- ${context.cliCommand} session send <target-session-id> --message <text>`,
    `- ${context.cliCommand} session list`,
    context.environment === "cloud"
      ? "Your source Session identity is supplied by this execution. Do not copy or persist its temporary proof."
      : "The current Session identity is supplied by runtime-managed CLI context. Do not pass or look for agentId or sourceSessionId arguments.",
    ...(context.environment === "cloud"
      ? [
          "Each Cloud Session has its own workspace and history. Send relevant information explicitly; another Session cannot read this workspace. Only published Context Tree knowledge is shared.",
        ]
      : []),
    "An accepted result means the target accepted the message for processing; it does not mean the delegated task is complete.",
    "If a command result is uncertain, retry with the same messageId and exactly the same semantic input.",
    ...(context.environment === "cloud"
      ? [
          `A child Session reports through \`${context.cliCommand} session send\`; its final text is not automatically returned to its parent.`,
        ]
      : []),
  ];
}

/**
 * The Context Tree section. The Agent is told plainly when durable memory is absent or stale, so
 * it cannot mistake a failed connection for an empty tree or a failed synchronization for the
 * newest published state.
 */
function renderContextTree(
  environment: ManagedEnvironment,
  snapshot: EffectiveRuntimeSnapshot,
  status: ManagedContextTreeStatus,
): readonly string[] {
  if (status.status === "configured") {
    return [
      "## Context Trees",
      "",
      "Context Trees (no precedence is implied by their order):",
      "",
      ...status.connections.flatMap((entry) => [
        `Alias ${entry.alias} — ${entry.repository}:`,
        ...renderContextTreeFacts(environment, entry),
        "",
      ]),
      ...new Set(status.connections.flatMap((entry) => renderContextTreeGuidance(environment, snapshot, entry))),
      "Use the upstream Context Tree skills to select relevant trees, attribute disagreements to their aliases, and choose an explicit alias for every write.",
      "",
    ];
  }
  return [
    "## Context Tree",
    "",
    ...renderContextTreeFacts(environment, status),
    "",
    ...renderContextTreeGuidance(environment, snapshot, status),
  ];
}

function renderContextTreeFacts(
  environment: ManagedEnvironment,
  status: Exclude<ManagedContextTreeStatus, { status: "configured" }>,
): readonly string[] {
  if (status.status === "ready") {
    if (environment === "cloud") {
      return [
        `Context Tree: ${status.treePath} — synchronized at the start of this Turn${
          status.branch && status.sha ? ` (branch ${status.branch}, commit ${status.sha.slice(0, 12)})` : ""
        }.`,
      ];
    }
    return [`Context Tree: ${status.treePath}`];
  }
  if (status.status === "stale") {
    return [
      `Context Tree: ${status.treePath} — ${
        status.reason === "DIRTY_TREE"
          ? "the preserved checkout has unpublished changes"
          : `this Turn's synchronization failed (${status.reason})`
      }.`,
    ];
  }
  if (status.status === "unconfigured") {
    return environment === "cloud"
      ? [
          "Context Tree: disabled for this Agent (no Context Tree repository is selected on the Agent's Context Tree page).",
        ]
      : ["Context Tree: disabled for this Agent. Connect one on the Agent's Context Tree page."];
  }
  return [
    status.reason === "PREPARING"
      ? "Context Tree preparation is continuing in the background."
      : `Context Tree unavailable (${status.reason}).`,
  ];
}

function renderContextTreeGuidance(
  environment: ManagedEnvironment,
  snapshot: EffectiveRuntimeSnapshot,
  status: Exclude<ManagedContextTreeStatus, { status: "configured" }>,
): readonly string[] {
  if (status.status === "ready") return renderReadyTreeGuidance(environment, snapshot);
  if (status.status === "stale") return renderStaleTreeGuidance(status);
  if (status.status === "unconfigured") return renderUnconfiguredTreeGuidance(environment);
  return renderUnavailableTreeGuidance(environment, status.reason);
}

function renderReadyTreeGuidance(
  environment: ManagedEnvironment,
  snapshot: EffectiveRuntimeSnapshot,
): readonly string[] {
  return [
    "Ready Context Trees are connected on this Agent's Context Tree page.",
    environment === "cloud"
      ? "Each checkout lives inside this Session's own workspace and is saved and restored with it, including unpublished drafts. Only the published tree is shared with other Agents that select the same repository; your files and Pi conversation stay private to this Session."
      : "Other Agents share this memory only when they select the same repository.",
    "Read the decisions that bear on a task before planning or changing code, and record durable decisions there.",
    environment === "cloud"
      ? "Use the context-tree-read and context-tree-write skills; the `context-tree` command is on PATH."
      : "Use the context-tree-read and context-tree-write skills rather than editing the tree by hand.",
    renderMemberDirectoryGuidance(environment, snapshot),
    "",
  ];
}

/** Stale checkouts exist only in Cloud: a Local connection reports connect failures as unavailable. */
function renderStaleTreeGuidance(status: { treePath: string; reason: string }): readonly string[] {
  return [
    status.reason === "DIRTY_TREE"
      ? "For stale trees with unpublished changes: the changes were left untouched. Inspect them with the `context-tree` command (`context-tree read --tree-path <tree> …`, `context-tree verify --tree-path <tree>`) or with `git`, and continue any prepared write worktree. Synchronizing or publishing will keep failing until the changes are committed or otherwise resolved; do not reset or discard them silently."
      : "For other stale trees, the on-disk copy may be outdated: it is not confirmed to be the newest published state. Unpublished drafts were left untouched. You may read the local copy as potentially stale context, and expect synchronizing or publishing to fail until a later Turn succeeds.",
    "",
  ];
}

function renderUnconfiguredTreeGuidance(environment: ManagedEnvironment): readonly string[] {
  return [
    environment === "cloud"
      ? "Durable memory is not active. Do not assume earlier decisions were recorded, and do not create or connect a tree yourself."
      : "Durable memory is not active. Do not assume earlier decisions were recorded, and do not attempt to create a tree yourself.",
    "",
  ];
}

function renderUnavailableTreeGuidance(environment: ManagedEnvironment, reason: string): readonly string[] {
  if (environment === "cloud") {
    return [
      "Unavailable trees are not active for this Turn; other ready trees remain usable. Continue the task without those trees. Do not assume earlier decisions were recorded, and do not attempt to repair, create, or connect a tree yourself. Any unpublished drafts from earlier Turns remain preserved in this Session's workspace.",
      ...(reason === "GITHUB_PERMISSION"
        ? [
            "The current execution does not grant this Session the selected repository, so the managed connection stays detached until the grant returns.",
          ]
        : []),
      ...(reason === "DIRTY_TREE"
        ? [
            "The preserved checkout contains unpublished changes from an earlier Turn. They were left untouched; do not commit, reset, or discard them silently — report their presence.",
          ]
        : []),
      "",
    ];
  }
  return [
    "Unavailable trees are not active for this Session. Other ready trees remain usable.",
    reason === "PREPARING"
      ? "Trees still preparing may become usable in a later Session."
      : "Do not assume earlier decisions were recorded in unavailable trees, and do not attempt to repair the tree yourself.",
    "",
  ];
}

function renderMemberDirectoryGuidance(environment: ManagedEnvironment, snapshot: EffectiveRuntimeSnapshot): string {
  if (environment === "cloud") {
    const slug = managedAgentSlug(snapshot.instructions.platform);
    if (slug) {
      return `Your Agent slug is \`${slug}\` (also stated in the Platform section above): \`members/${slug}/\` is your own private working memory in the tree. Do not write to another Agent's member directory.`;
    }
  }
  return "`members/<your Agent slug>/` is your own private working memory; the Agent slug is stated in the Platform section above. Do not write to another Agent's member directory.";
}

/** One template for both runtimes; only environment facts use Local/Cloud branches. */
export function renderManagedSystemPrompt(snapshot: EffectiveRuntimeSnapshot, context?: ManagedSessionContext): string {
  return [
    "# OpenTag managed instructions",
    "",
    "These trusted instructions are injected through the Agent Runtime Provider's native system prompt.",
    "Session-specific instructions and message context are injected for each Turn.",
    "",
    ...(context?.environment === "cloud" ? renderCloudExecutionContext() : []),
    "## Platform",
    "",
    snapshot.instructions.platform,
    "",
    "## Agent",
    "",
    snapshot.instructions.agent,
    "",
    ...(context ? renderSession(context) : []),
    ...(context?.contextTree ? renderContextTree(context.environment, snapshot, context.contextTree) : []),
    ...(snapshot.instructions.session ? ["## Session instructions", "", snapshot.instructions.session, ""] : []),
  ].join("\n");
}
