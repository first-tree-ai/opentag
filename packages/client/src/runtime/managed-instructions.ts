import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
import { contextTreeName, contextTreeSelector } from "@opentag/shared";
import type { ContextTreeStatus as ManagedContextTreeStatus } from "./context-tree-connections.js";
import { GITHUB_MCP_INSTRUCTIONS, renderProviderOutboxGuidance } from "./provider-outbox-instructions.js";

export type ManagedEnvironment = "local" | "cloud";

export type { ContextTreeStatus as ManagedContextTreeStatus } from "./context-tree-connections.js";

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
    "- Credentials are execution-scoped and short-lived; the managed IM CLIs reach providers through the platform proxy. Never ask the user for tokens. Never persist execution-scoped handles or Session proof. Explicitly requested Slack App management uses a separate native login and private files as described below.",
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
    "Context Tree stays the separately configured shared tree managed by its matching CLI and skills. When running Context Tree project commands from a task subdirectory, pass the explicit `--project-path` shown with the selected tree; do not create or reconnect a tree just because the task cwd changed. Follow the matching skill write protocol. Do not invent an independent Git policy for Tree writes.",
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
 * The Agent may tune its own instructions, model, and reasoning effort through the Session proof.
 * Those fields feed the effective snapshot hash, so a change applies from the next Turn and that
 * Turn starts a new provider conversation instead of resuming the old one. The Agent is told so it
 * does not change them casually mid-task.
 *
 * MCP configuration is a separate section (`renderMcpInChat`). It used to be one sentence inside
 * this paragraph, which the model skipped when the user named a product or asked to connect a
 * service without saying "MCP".
 */
function renderSelfConfiguration(cliCommand: string): readonly string[] {
  return [
    "## Self-configuration",
    "",
    `Inspect your own configuration with \`${cliCommand} agent self show\`. When a user asks you to change how you work, you may update your own instructions, model, or reasoning effort with \`${cliCommand} agent self update\`. Instruction, model, and reasoning-effort changes apply from your next Turn and start a new provider conversation in every existing Session, so earlier conversation context is not carried over; change them only when asked, not mid-task. Replacing instructions overwrites them entirely, so read the current value first and keep what still applies.`,
    "",
  ];
}

/**
 * How the Agent configures MCP inside this Session, on Local and Cloud.
 *
 * The section is always present when the Session CLI and the self-configuration opt-in are both
 * available, including when the `mcp-onboarding` skill is not installed. The skill holds the
 * command detail. This section is the rule that has to fire from the user message alone.
 */
function renderMcpInChat(cliCommand: string): readonly string[] {
  return [
    "## MCP",
    "",
    `When a user wants to connect, configure, authorize, enable, disable, or remove a product, service, connector, or MCP Server — including "configure X's MCP" and "我想配置 X 的 MCP" — you execute it in this chat. Run \`${cliCommand} self mcp\` before you reply.`,
    "Do not answer with a setup guide. Do not offer two methods. Do not tell the user to open the web console, log in, open Agent settings, or use the Connectors page, Discover, or Add custom MCP. That page exists, and it is still the wrong reply in this conversation. Do not claim the catalog contains a connector, an action count, or a tool list until a command in this turn returned that fact.",
    "Branch on the operation before you search or add.",
    `Existing binding. When they ask to enable, disable, remove, detach, or reauthorize a Server — including "disable Notion" — the first command is \`${cliCommand} self mcp list --json\`. Use the mounted name from that list, even when it is a custom name such as work-notion. Then run enable, disable, or delete on that binding. generate_oauth_url only when they explicitly ask to replace the link. Do not call it while the status is pending. Do not search the catalog and do not run add. add only creates a definition; it does not change an existing one.`,
    `New connection. When they ask to connect or configure a product, including "configure X's MCP", run \`${cliCommand} self mcp list --json\` and \`${cliCommand} self mcp available --json\` first. A mounted row is not a finished setup: create and attach can return an enabled binding with authorization: null. Reuse the mounted name. Do not add a second definition. If enabled is false, run enable on that name. Then run \`${cliCommand} self mcp check_oauth_status <server>\`.`,
    `A Bearer key for a Server this Agent already mounts is written with \`${cliCommand} self mcp use <server> --api-key-stdin\`. That command does not create a definition. Do not run add to store a key for an existing name.`,
    `authorization: null means no OAuth flow has started. Send the URL from \`${cliCommand} self mcp generate_oauth_url <server>\` once. status pending means that link is still live: run check_oauth_status and wait. Do not call generate_oauth_url while the status is pending. That call replaces the flow and invalidates the link. Call it again only when the status is expired, revoked, or error, or when the user says the link was refused or already used. Stop only when the observed state is enabled, the authorization status is active, and probeState is succeeded.`,
    `If the Account already defines it and this Agent does not mount it, attach that definition and run the same check. Search the catalog only when neither list has it: \`${cliCommand} self mcp search <query> --json\`, using their words as the query. Add a match that is installable and has a url, using its name, url, and auth kind. Then tell them what the command returned.`,
    "When the search has no installable match, ask them to paste the MCP configuration into this chat. Accept a remote HTTP URL, or JSON or YAML whose servers sit under mcpServers, mcp, servers, or mcp_servers. Read the name, the HTTP endpoint, and oauth or bearer from that paste. Do not invent an endpoint.",
    "A paste that is only a local process (stdio, command, args, or npx) has no endpoint you can register. Ask for the remote HTTP URL.",
    `Register a new Server with \`${cliCommand} self mcp add <name> <url> [oauth|bearer]\`. Pass a bearer key with --api-key-stdin. Do not repeat the key in the chat or in a command argument.`,
    `The user opens the consent screen. An explicit reauthorize replaces the flow on the mounted name. A status that is still pending does not. Follow the mcp-onboarding skill when it is installed.`,
    "A Server you add or enable is available on the next execution. This surface refuses anonymous (none) servers.",
    "",
  ];
}

function renderSlackProvisioning(context: ManagedSessionContext): readonly string[] {
  if (!context.sessionCliAvailable || context.sessionKind === "internal") return [];
  const cli = context.cliCommand;
  return [
    "## Creating an Agent with its own Slack App",
    "",
    `Only when the user asks, use \`${cli} slack --help\` and \`${cli} agent provision-slack --help\`. The official management CLI is \`${cli} slack manage -- <official CLI arguments>\`; ordinary \`slack api\` still uses the current Bot's messaging proxy.`,
    `Run management commands sequentially. Use a distinct --project-dir project-<creationIntentId> for each creation intent, including link and deploy, and keep its temporary files in that directory. Keep one creationIntentId, App ID, Team and configuration in context; keep secrets only under \`${cli} slack home\`, outside per-Turn HOME and archived workspace. The new Agent uses the current Computer, source Agent Runtime Provider and default permissions/duration; do not set computerId, permissions or maxDurationMs. Choose an explicit model for Cloud. The CLI help describes native ticket/challenge login, remote manifest installation and the capture-deploy hook. Wait for Slack administrator approval and complete credentials before requesting Account confirmation. Never repeat an uncertain App creation.`,
    `Run \`${cli} agent provision-slack --request-file <path> --credentials-file <private-path> --json\` without --code-file to obtain the confirmation link locally. The owner opens it on their own device and returns one operation code. Never request a normal Account login code or run Account login in Cloud. Save the operation code privately and submit the same command with --code-file <private-path>; it makes one proof-authenticated request and receives no Account Tokens.`,
    `Save successful provision-slack --json stdout privately. Only after binding, export the same App's remote manifest and use \`${cli} slack callbacks --help\` to prepare its callback update from that export and the provision result. The CLI supplies the exact required events and returned URLs; do not guess events or rebuild the App manifest. Validate, update the same App and re-export to verify, preserving other settings. Native command help is \`${cli} slack manage -- api --help\` (or -h), without --team or --output-file. Return the actual slack.binding.identity.botUserId mention and the App/Team DM link; display slack.binding.bot.displayName only when present. On a spent code or lost response, use a fresh operation code with the same intent and configuration. Callback failure retries only that update. Remove completed temporary secrets but keep valid native management login; Sandbox replacement can require reauthorization. Do not print credentials or claim real messaging without observing it.`,
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
    ...(context.sessionCliAvailable && context.selfConfigurationEnabled ? renderMcpInChat(context.cliCommand) : []),
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
          "When you speak, be warm and natural, adapting to the user and the situation. Speaking rarely is part of being a good teammate.",
          'When you take on a lengthy task, first add one emoji reaction meaning "received, working on it" to the original message via the provider CLI before starting task work (for example, Feishu OnIt or the provider\'s equivalent). Do not use approval or completion reactions such as thumbs-up or check marks. Do not react to messages you are not acting on, duplicate acknowledgments, or observer deliveries.',
        ]),
    "OpenTag internal Sessions and Provider-native subagents are separate mechanisms and are not interchangeable.",
    `When a user explicitly requests an OpenTag internal Session and Session collaboration is available, use ${context.cliCommand} session create; do not substitute a Provider-native subagent.`,
    "",
    ...renderSessionCollaboration(context),
    ...renderSlackProvisioning(context),
    "",
    ...(context.sessionKind === "visible" ? renderWhenToSpeak() : []),
  ];
}

/**
 * The single statement of the reply decision. Each Turn's managed context states only the message's
 * attention and points here, so the rule cannot drift between the system prompt and per-Turn text.
 * The same rules apply to people and other agents: one side declining to acknowledge an
 * acknowledgement is what stops two agents from echoing each other.
 */
function renderWhenToSpeak(): readonly string[] {
  return [
    "## When to speak",
    "",
    "You share conversations with people and other agents. Most messages are not for you; listening without replying is normal and expected. Each Turn's managed context states the message's attention. Apply the same rules whoever the sender is, a person or another agent.",
    "",
    '- `direct` (a DM or an @-mention of you): reply by default. End the Turn without sending only when the message just closes the loop on something you already finished ("thanks", "ok", 👍) and asks nothing new, the sender asks for no reply or says it is FYI, or it duplicates a message you already handled. When unsure, reply.',
    "- `ambient` (a channel message you overheard, or a follow-up in a Thread you were brought into earlier): stay silent by default. Reply only when the message is clearly meant for you: it names you and asks you to do or answer something, it answers a question you asked, or it continues a task you own in this conversation. People talking to each other, even about your topic or with a question you could answer, is not meant for you. Being in a Thread is not being addressed; judge every message on its own. When unsure, stay silent.",
    "- Never send a message only to acknowledge, thank, agree, restate, or summarize what was just said, or to offer unrequested help. Never answer another agent's acknowledgement.",
    '- When you do reply, send one self-contained message and stop. Do not follow up with check-ins or "anything else?".',
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
        `${contextTreeName(entry)} — ${entry.repository}/${entry.path} (${entry.ref}):`,
        `Tree selector: ${contextTreeSelector(entry)}`,
        ...renderContextTreeFacts(environment, entry),
        "",
      ]),
      ...new Set(status.connections.flatMap((entry) => renderContextTreeGuidance(environment, snapshot, entry))),
      "Use the upstream Context Tree skills to select relevant trees, attribute disagreements to their sources, and use the exact tree selector for every write.",
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
        `Use --project-path ${JSON.stringify(status.projectPath)} for managed tree commands.`,
        `Context Tree: ${status.treePath} — synchronized at the start of this Turn${
          status.branch && status.sha ? ` (branch ${status.branch}, commit ${status.sha.slice(0, 12)})` : ""
        }.`,
      ];
    }
    return [
      `Context Tree: ${status.treePath}`,
      `Use --project-path ${JSON.stringify(status.projectPath)} for managed tree commands.`,
    ];
  }
  if (status.status === "stale") {
    return [
      `Use --project-path ${JSON.stringify(status.projectPath)} for managed tree commands.`,
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
  if (status.status === "stale") return renderStaleTreeGuidance();
  if (status.status === "unconfigured") return renderUnconfiguredTreeGuidance(environment);
  return renderUnavailableTreeGuidance(environment, status.reason);
}

function renderReadyTreeGuidance(
  environment: ManagedEnvironment,
  snapshot: EffectiveRuntimeSnapshot,
): readonly string[] {
  return [
    "Ready Context Trees are connected on this Agent's Context Tree page.",
    "Remote tree paths are read-only snapshots. Use context-tree write prepare for an isolated worktree, then write finish to commit and optionally publish. Never edit snapshots.",
    "Agents share published memory only when they select the same repository, directory, and branch. Unpublished work remains in the prepared worktree.",
    "Read relevant context before changing code, and record durable decisions using the context-tree-read and context-tree-write skills.",
    "Repository-owned directory trees use their own project configuration and normal host Git workflow.",
    ...(environment === "cloud" ? ["Do not install native cleanup schedules in this ephemeral sandbox."] : []),
    renderMemberDirectoryGuidance(environment, snapshot),
    "",
  ];
}

function renderStaleTreeGuidance(): readonly string[] {
  return [
    "The cached snapshot may be outdated. Read it as stale context. Preserve existing write sessions and unpublished work; do not reset or discard them. Retry sync when available.",
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
    `Agent ID: ${snapshot.agentId}`,
    "",
    "## GitHub MCP",
    "",
    GITHUB_MCP_INSTRUCTIONS,
    "",
    ...(context?.sessionKind === "visible" ? ["## IM outbox", "", ...renderProviderOutboxGuidance(), ""] : []),
    ...(context ? renderSession(context) : []),
    ...(context?.contextTree ? renderContextTree(context.environment, snapshot, context.contextTree) : []),
    ...(snapshot.instructions.session ? ["## Session instructions", "", snapshot.instructions.session, ""] : []),
  ].join("\n");
}
