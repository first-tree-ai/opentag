import { type EffectiveRuntimeSnapshot, SESSION_RUN_OUTCOME_NOTICE_HEADER } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { type ManagedSessionContext, renderManagedSystemPrompt } from "../runtime/managed-instructions.js";

const snapshot: EffectiveRuntimeSnapshot = {
  contextTrees: [],
  revision: {
    agent: { sequence: 1, id: "agent-revision-1" },
    session: { sequence: 1, id: "session-revision-1" },
  },
  agentId: "agent-1",
  provider: "codex",
  model: "model-1",
  instructions: { platform: "platform", agent: "agent" },
  execution: { approvalPolicy: "never", networkAccess: true },
  workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  selfConfigurationEnabled: true,
};

const session: ManagedSessionContext = {
  environment: "local",
  sessionId: "session-1",
  sessionKind: "visible",
  cliCommand: "opentag-dev",
  sessionCliAvailable: true,
  selfConfigurationEnabled: true,
};

const cloudSession: ManagedSessionContext = {
  environment: "cloud",
  sessionId: "cloud-session-1",
  sessionKind: "visible",
  cliCommand: "opentag",
  sessionCliAvailable: true,
  selfConfigurationEnabled: true,
};

describe("renderManagedSystemPrompt Agent Home", () => {
  it("describes native configuration only for Local Codex, independently of Server self-configuration", () => {
    const prompt = renderManagedSystemPrompt(snapshot, { ...session, selfConfigurationEnabled: false });
    expect(prompt).toContain("## Native Codex configuration");
    expect(prompt).toContain("Prefer Agent Home's project configuration");
    expect(prompt).toContain("Native local and stdio MCP configuration does not use opentag self mcp");
    expect(renderManagedSystemPrompt({ ...snapshot, provider: "pi" }, session)).not.toContain(
      "## Native Codex configuration",
    );
    expect(renderManagedSystemPrompt(snapshot, cloudSession)).not.toContain("## Native Codex configuration");
  });
  it("describes native configuration only for Local Claude, independently of Server self-configuration", () => {
    const claude = { ...snapshot, provider: "claude-code" as const };
    const prompt = renderManagedSystemPrompt(claude, { ...session, selfConfigurationEnabled: false });
    expect(prompt).toContain("## Native Claude configuration");
    expect(prompt).toContain("Prefer project scope under Agent Home");
    expect(prompt).toContain("Native local and stdio MCP configuration does not use opentag self mcp");
    expect(renderManagedSystemPrompt(snapshot, session)).not.toContain("## Native Claude configuration");
    expect(renderManagedSystemPrompt(claude, cloudSession)).not.toContain("## Native Claude configuration");
  });

  it.each([session, cloudSession])(
    "provides fixed CLI manuals in the $environment visible Session prompt",
    (context) => {
      const prompt = renderManagedSystemPrompt(snapshot, context);
      expect(prompt).toContain("Agent ID: agent-1");
      expect(prompt).toContain("Use this Agent's connected GitHub MCP tools");
      expect(prompt).toContain("slack api chat.postMessage --json");
      expect(prompt).toContain("lark-cli im +messages-reply");
      expect(prompt).toContain("files.getUploadURLExternal");
      expect(prompt).toContain("messages-resources-download");
      expect(prompt).toContain("If a provider result is unknown, query the provider");
      expect(prompt.match(/slack api chat.postMessage --json/g)).toHaveLength(1);
    },
  );

  it("keeps internal Session prompts free of IM outbox manuals", () => {
    const prompt = renderManagedSystemPrompt(snapshot, { ...session, sessionKind: "internal" });
    expect(prompt).toContain("Use this Agent's connected GitHub MCP tools");
    expect(prompt).not.toContain("slack api chat.postMessage");
    expect(prompt).not.toContain("messages-resources-download");
  });

  it("describes one persistent Home with prompt-only source-repos, worktrees, and files conventions", () => {
    const prompt = renderManagedSystemPrompt(snapshot, { ...session, agentHome: "/tmp/agent-home" });

    expect(prompt).toContain("## Agent Home");
    expect(prompt).toContain("Your Agent Home is /tmp/agent-home.");
    expect(prompt).toContain("shared across this Agent's Sessions on this Computer");
    expect(prompt).toContain("Files survive tasks");
    expect(prompt).toContain("absolute paths");
    expect(prompt).toContain("from Agent Home, not the task cwd");
    expect(prompt).toContain("prompt conventions, not platform-managed resources or automatic cleanup policies");
    expect(prompt).toContain("source-repos/<unique-repo-key>/");
    expect(prompt).toContain("not from platform bindings");
    expect(prompt).toContain("verify it belongs to the intended repository");
    expect(prompt).toContain("Preserve existing files");
    expect(prompt).toContain("Do not clone into the Home root");
    expect(prompt).toContain("worktrees/<unique-task-key>/");
    expect(prompt).toContain("distinct worktree");
    expect(prompt).toContain("Keep later operations for the same task in its own worktree");
    expect(prompt).toContain("No two code tasks edit one checkout");
    expect(prompt).toContain("files/<unique-task-key>/");
    expect(prompt).toContain("created only when needed");
    expect(prompt).toContain("explicit `--project-path`");
    expect(prompt).toContain("do not create or reconnect a tree just because the task cwd changed");
    expect(prompt).toContain("matching skill write protocol");
    const homeInstructions = prompt.slice(prompt.indexOf("## Agent Home"), prompt.indexOf("## Skills"));
    expect(homeInstructions).not.toContain("sandbox");
    expect(homeInstructions).not.toContain("manifest");
    expect(homeInstructions).not.toMatch(/\bGC\b/);
    expect(homeInstructions).not.toContain("migration");
  });

  it("tells the Agent how to save a reusable routine as a Skill", () => {
    const prompt = renderManagedSystemPrompt(snapshot, { ...session, agentHome: "/tmp/agent-home" });
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("a directory with a `SKILL.md` whose frontmatter has `name` and `description`");
    expect(prompt).toContain("opentag-dev skill push <dir>");
    expect(prompt).toContain("restored on every Computer this Agent runs on");
  });

  it("describes self-configuration only when the owner enables it and the Session CLI is available", () => {
    const prompt = renderManagedSystemPrompt(snapshot, session);
    expect(prompt).toContain("## Self-configuration");
    expect(prompt).toContain("`opentag-dev agent self show`");
    expect(prompt).toContain("`opentag-dev agent self update`");
    expect(prompt).toContain("apply from your next Turn and start a new provider conversation");
    expect(prompt).toContain("read the current value first");
    expect(prompt).toContain("## MCP");
    expect(prompt).toContain("Run `opentag-dev self mcp` before you reply.");
    expect(prompt).toContain("Do not answer with a setup guide.");
    expect(prompt).toContain("Connectors page");
    expect(prompt).toContain("Branch on the operation before you search or add.");
    expect(prompt).toContain("disable Notion");
    expect(prompt).toContain("Do not search the catalog and do not run add.");
    expect(prompt).toContain("`opentag-dev self mcp list --json`");
    expect(prompt).toContain("Search the catalog only when neither list has it");
    expect(prompt).toContain("authorization: null");
    expect(prompt).toContain("Do not add a second definition.");
    expect(prompt).toContain("Stop only when the observed state is enabled");
    expect(prompt).toContain("Do not call generate_oauth_url while the status is pending.");
    expect(prompt).toContain("`opentag-dev self mcp use <server> --api-key-stdin`");
    expect(prompt).not.toContain("report it and stop");
    expect(prompt).toContain("`opentag-dev self mcp search <query> --json`");
    expect(prompt).toContain("paste the MCP configuration into this chat");
    expect(prompt).toContain("`opentag-dev self mcp add <name> <url> [oauth|bearer]`");
    expect(prompt).toContain("`opentag-dev self mcp generate_oauth_url <server>`");
    expect(prompt).toContain("`opentag-dev self mcp check_oauth_status <server>`");
    expect(prompt).toContain("available on the next execution");
    expect(prompt).not.toContain("MCP mount changes apply to your next MCP request");

    const unavailable = renderManagedSystemPrompt(snapshot, { ...session, sessionCliAvailable: false });
    expect(unavailable).not.toContain("## Self-configuration");
    expect(unavailable).not.toContain("## MCP");
    expect(unavailable).not.toContain("agent self");

    const disabled = renderManagedSystemPrompt(snapshot, { ...session, selfConfigurationEnabled: false });
    expect(disabled).not.toContain("## Self-configuration");
    expect(disabled).not.toContain("## MCP");
    expect(disabled).not.toContain("agent self");

    const disabledUnavailable = renderManagedSystemPrompt(snapshot, {
      ...session,
      sessionCliAvailable: false,
      selfConfigurationEnabled: false,
    });
    expect(disabledUnavailable).not.toContain("## Self-configuration");
    expect(disabledUnavailable).not.toContain("## MCP");
    expect(disabledUnavailable).not.toContain("agent self");
  });

  it("still describes Agent Home conventions when the concrete path is omitted", () => {
    const prompt = renderManagedSystemPrompt(snapshot, session);
    expect(prompt).toContain("## Agent Home");
    expect(prompt).toContain("source-repos/<unique-repo-key>/");
    expect(prompt).toContain("explicit `--project-path`");
    expect(prompt).not.toContain("Your Agent Home is");
  });

  it("keeps missing Context Tree wording unchanged", () => {
    const unconfigured = renderManagedSystemPrompt(snapshot, {
      ...session,
      agentHome: "/tmp/agent-home",
      contextTree: { status: "unconfigured" },
    });
    expect(unconfigured).toContain(
      "Context Tree: disabled for this Agent. Connect one on the Agent's Context Tree page.",
    );
    expect(unconfigured).toContain("do not attempt to create a tree yourself");

    const unavailable = renderManagedSystemPrompt(snapshot, {
      ...session,
      contextTree: { status: "unavailable", reason: "SHIM_UNAVAILABLE" },
    });
    expect(unavailable).toContain("Context Tree unavailable (SHIM_UNAVAILABLE)");
    expect(unavailable).toContain("Do not assume earlier decisions were recorded");
    expect(unavailable).toContain("do not attempt to repair the tree yourself");
  });

  it("omits Agent Home when no Session context is supplied", () => {
    const prompt = renderManagedSystemPrompt(snapshot);
    expect(prompt).not.toContain("## Agent Home");
    expect(prompt).toContain("## Platform\n\nplatform");
    expect(prompt).toContain("## Agent\n\nagent");
  });
});

it("attributes partial memory results to sources without disabling healthy trees", () => {
  const prompt = renderManagedSystemPrompt(snapshot, {
    ...session,
    contextTree: {
      status: "configured",
      connections: [
        {
          kind: "git" as const,
          path: ".",
          ref: "main",
          repository: "acme/team",
          status: "available",
          projectPath: "/managed/project",
        },
        {
          kind: "git" as const,
          path: ".",
          ref: "main",
          repository: "acme/product",
          status: "unavailable",
          reason: "GITHUB_AUTH",
        },
      ],
    },
  });
  expect(prompt).toContain("team — acme/team");
  expect(prompt).toContain("product — acme/product");
  expect(prompt).toContain("Other available trees remain usable");
  expect(prompt).toContain("exact tree selector for every write");
  expect(prompt).not.toContain("Durable memory is not active for this Session");
});

it("renders shared multi-tree instructions once while preserving each selector and reason", () => {
  const prompt = renderManagedSystemPrompt(snapshot, {
    ...session,
    contextTree: {
      status: "configured",
      connections: [
        {
          kind: "git" as const,
          path: ".",
          ref: "main",
          repository: "acme/team",
          status: "available",
          projectPath: "/managed/project",
        },
        {
          kind: "git" as const,
          path: "docs",
          ref: "release",
          repository: "acme/product",
          status: "available",
          projectPath: "/managed/project",
        },
        {
          kind: "git" as const,
          path: ".",
          ref: "main",
          repository: "acme/denied",
          status: "unavailable",
          reason: "GITHUB_PERMISSION",
        },
      ],
    },
  });
  expect(prompt).toContain("team — acme/team/. (main):");
  expect(prompt).toContain("acme/product/docs (release):");
  expect(prompt).toContain("Tree selector: ");
  expect(prompt.match(/Use --project-path "\/managed\/project" for managed tree commands\./g)).toHaveLength(2);
  expect(prompt).toContain("GITHUB_PERMISSION");
  expect(prompt.match(/context-tree sync --project-path "\/managed\/project"/g)).toHaveLength(1);
  expect(prompt.match(/context-tree-read and context-tree-write skills/g)).toHaveLength(1);
  expect(prompt.match(/Do not write to another Agent's member directory/g)).toHaveLength(1);
  expect(prompt.match(/Other available trees remain usable/g)).toHaveLength(1);
});

it("tells the Agent to sync through the read skill and carries no snapshot path or commit", () => {
  for (const context of [session, cloudSession]) {
    const prompt = renderManagedSystemPrompt(snapshot, {
      ...context,
      contextTree: {
        status: "configured",
        connections: [
          {
            kind: "git" as const,
            path: "docs",
            ref: "main",
            repository: "acme/team",
            status: "available",
            projectPath: "/managed/project",
          },
        ],
      },
    });
    expect(prompt).toContain("Read Context through the context-tree-read skill");
    expect(prompt).toContain('`context-tree sync --project-path "/managed/project"`');
    expect(prompt).toContain("keep the returned treeRoot for that task");
    expect(prompt).not.toMatch(/synchronized at the start of this Turn|commit [0-9a-f]{7,}|\/snapshots\//);
    expect(prompt).not.toContain("Context Tree: /");
  }
});

describe("renderManagedSystemPrompt shared visible/internal behavior", () => {
  it("renders the same visible Session behavior and shared sections on Local and Cloud", () => {
    const local = renderManagedSystemPrompt(snapshot, session);
    const cloud = renderManagedSystemPrompt(snapshot, cloudSession);
    for (const prompt of [local, cloud]) {
      expect(prompt).toContain("# OpenTag managed instructions");
      expect(prompt).toContain("## Platform\n\nplatform");
      expect(prompt).toContain("## Agent\n\nagent");
      expect(prompt).toContain("You are a visible Session");
      expect(prompt).toContain("Session kind: visible");
      expect(prompt).toContain("When you speak, be warm and natural");
      expect(prompt).not.toContain("lively");
      expect(prompt).toContain("OpenTag manages the working and error reactions on incoming messages.");
      expect(prompt).toContain("Do not add, change, or remove these status reactions yourself");
      expect(prompt).toContain(
        "While working, do not send intermediate progress messages, status cards, steps, or todo lists to IM, or change the working reaction mid-task.",
      );
      expect(prompt).toContain("Questions needed to proceed and required approval requests are still allowed.");
      expect(prompt).not.toContain("optionally");
      expect(prompt).not.toContain("unnecessary");
      expect(prompt).toContain("OpenTag internal Sessions and Provider-native subagents are separate mechanisms");
      expect(prompt).toContain(
        "Long-running delegated or multi-step work is the exception: post a short new IM message at each meaningful milestone (started, key finding, blocked and needs input, done).",
      );
      expect(prompt).toContain("Never edit an earlier message for progress, because edits do not notify");
      expect(prompt).toContain("Short work stays silent until the final reply.");
      expect(prompt).toContain(
        "Long work adds only the milestone messages described above, and its final result, which is the done milestone, is still one self-contained message.",
      );
      expect(prompt).toContain(
        "The done milestone is the one self-contained final result, not a separate completion message.",
      );
    }
    for (const [prompt, cli] of [
      [local, "opentag-dev"],
      [cloud, "opentag"],
    ] as const) {
      expect(prompt).toContain("You are a visible Session. Handle quick work directly.");
      expect(prompt).toContain(
        `roughly over 10 minutes) or that should continue on its own, create an OpenTag internal Session with \`${cli} session create\` and a \`--max-duration-ms\` sized to the task, reply in IM promptly that the work has started, and publish the result when the child reports back.`,
      );
      expect(prompt).toContain("use them only for short, bounded side tasks within the current Run.");
      expect(prompt).toContain(`use ${cli} session create; do not substitute a Provider-native subagent.`);
    }
    expect(local).toContain("Current Session: session-1");
    expect(cloud).toContain("Current Session: cloud-session-1");
  });

  it("omits user acknowledgment and direct IM publication from internal Sessions on both environments", () => {
    for (const base of [session, cloudSession]) {
      const prompt = renderManagedSystemPrompt(snapshot, {
        ...base,
        sessionKind: "internal",
        creatorSessionId: "session-parent-1",
      });
      expect(prompt).toContain("You are an internal Session");
      expect(prompt).toContain("Session kind: internal");
      expect(prompt).toContain("do not publish directly to IM");
      expect(prompt).toContain(
        `Report to the creating or coordinating Session with \`${base.cliCommand} session send\`: milestones only when useful`,
      );
      expect(prompt).toContain("questions, and the final result.");
      expect(prompt).toContain("You may create further internal Sessions");
      expect(prompt).toContain("agent self schedule create` fires back into this Session");
      expect(prompt).toContain("It has no IM outlet");
      expect(prompt).not.toContain("Handle quick work directly");
      expect(prompt).not.toContain("post a short new IM message at each meaningful milestone");
      expect(prompt).toContain("Creator Session: session-parent-1");
      expect(prompt).not.toContain("emoji");
      expect(prompt).not.toContain("be warm and natural");
      expect(prompt).not.toContain("do not send intermediate progress messages");
      expect(prompt).not.toContain("## When to speak");
    }
  });

  it("states the reply decision once for visible Sessions, the same for people and agents", () => {
    for (const base of [session, cloudSession]) {
      const prompt = renderManagedSystemPrompt(snapshot, base);
      expect(prompt.match(/## When to speak/g)).toHaveLength(1);
      expect(prompt).toContain("Apply the same rules whoever the sender is, a person or another agent.");
      // Addressed: reply by default, with narrow exceptions.
      expect(prompt).toContain("`direct` (a DM or an @-mention of you): reply by default.");
      expect(prompt).toContain('closes the loop on something you already finished ("thanks", "ok", 👍)');
      expect(prompt).toContain("the sender asks for no reply or says it is FYI");
      expect(prompt).toContain("When unsure, reply.");
      // Listening: Thread follow-ups and overheard channel messages default to silence.
      expect(prompt).toContain("or a follow-up in a Thread you were brought into earlier): stay silent by default.");
      expect(prompt).toContain(
        "People talking to each other, even about your topic or with a question you could answer",
      );
      expect(prompt).toContain("Being in a Thread is not being addressed; judge every message on its own.");
      expect(prompt).toContain("When unsure, stay silent.");
      // Loop brake: no courtesy sends, never answer another agent's acknowledgement.
      expect(prompt).toContain("Never send a message only to acknowledge, thank, agree, restate, or summarize");
      expect(prompt).toContain("Never answer another agent's acknowledgement.");
      expect(prompt).toContain("send one self-contained message and stop");
    }
  });

  it("omits the Creator Session line entirely when the request carries none", () => {
    const prompt = renderManagedSystemPrompt(snapshot, cloudSession);
    expect(prompt).not.toContain("Creator Session");
  });

  it("advertises Session collaboration only with real proof material", () => {
    for (const base of [session, cloudSession]) {
      const unavailable = renderManagedSystemPrompt(snapshot, { ...base, sessionCliAvailable: false });
      expect(unavailable).toContain(
        "Session collaboration commands are unavailable because managed Session context is missing.",
      );
      expect(unavailable).not.toContain("session create --message");
      expect(unavailable).toContain("You are a visible Session. Handle quick work directly.");
      expect(unavailable).toContain("OpenTag internal Sessions are unavailable in this Run");
      expect(unavailable).toContain("this conversation stays busy until it finishes");
      expect(unavailable).toContain("split it into parts the user can request in separate messages");
      expect(unavailable).toContain("use them only for short, bounded side tasks within the current Run");
      expect(unavailable).toContain("post a short new IM message at each meaningful milestone");
      expect(unavailable).not.toContain("use Provider-native subagents when available");
      expect(unavailable).not.toContain("create an OpenTag internal Session with");
    }

    const local = renderManagedSystemPrompt(snapshot, session);
    expect(local).toContain("Session collaboration is available through these commands:");
    expect(local).toContain("- opentag-dev session create --message <task>");
    expect(local).toContain("- opentag-dev session send <target-session-id> --message <text>");
    expect(local).toContain("send it again shortly with `--message-id` set to the returned message ID");
    expect(local).toContain("- opentag-dev session list");
    expect(local).toContain("- opentag-dev session list --agent");
    expect(local).toContain("not repeated to people who could not see it");
    expect(local).toContain("only a chain started in the owner's direct message is the owner's instruction");
    expect(local).toContain("Never answer just to acknowledge");
    expect(local).toContain("Do not pass or look for agentId or sourceSessionId arguments");
    expect(local).toContain("An accepted result means the target accepted the message for processing");
    expect(local).toContain("To retry, use the same arguments and set `--message-id` to the original message ID.");
    expect(local).not.toContain("its final text is not automatically returned to its parent");
    expect(local).toContain("pass `--max-duration-ms` with headroom");

    const cloud = renderManagedSystemPrompt(snapshot, cloudSession);
    expect(cloud).toContain("Session collaboration is available through these commands:");
    expect(cloud).toContain("- opentag session create --message <task>");
    expect(cloud).toContain("- opentag session send <target-session-id> --message <text>");
    expect(cloud).toContain("- opentag session list");
    expect(cloud).toContain("Do not copy or persist its temporary proof");
    expect(cloud).toContain("another Session cannot read this workspace");
    expect(cloud).toContain("An accepted result means the target accepted the message for processing");
    expect(cloud).toContain("To retry, use the same arguments and set `--message-id` to the original message ID.");
    expect(cloud).toContain("its final text is not automatically returned to its parent");
    expect(cloud).toContain("pass `--max-duration-ms` with headroom");

    // Both environments explain the Server-written creator notice and how to continue the child.
    for (const [prompt, cli] of [
      [local, "opentag-dev"],
      [cloud, "opentag"],
    ] as const) {
      expect(prompt).toContain(
        `A message that begins with "${SESSION_RUN_OUTCOME_NOTICE_HEADER}" is written by openTag`,
      );
      expect(prompt).toContain("openTag does not rerun it");
      expect(prompt).toContain(`\`${cli} session send <child-session-id> --message <text>\``);
    }
  });

  it("renders session-specific instructions from the snapshot on both environments", () => {
    const withSession: EffectiveRuntimeSnapshot = {
      ...snapshot,
      instructions: { ...snapshot.instructions, session: "Session child instruction." },
    };
    for (const context of [session, cloudSession]) {
      const prompt = renderManagedSystemPrompt(withSession, context);
      expect(prompt).toContain("## Session instructions\n\nSession child instruction.");
    }
  });
});

describe("renderManagedSystemPrompt Cloud environment", () => {
  it("describes the Cloud workspace and omits Local-only Home, Skill, and self-configuration capabilities", () => {
    const prompt = renderManagedSystemPrompt(snapshot, cloudSession);
    expect(prompt).toContain("## Cloud execution context");
    expect(prompt).toContain("Session-scoped Cloud Sandbox");
    expect(prompt).toContain("recover from the last successful save");
    expect(prompt).toContain("512 MiB of file content");
    expect(prompt).toContain("50,000 entries");
    expect(prompt).toContain("512 MiB compressed archive");
    expect(prompt).toContain("Hard links, sockets, FIFOs");
    expect(prompt).toContain("execution-scoped and short-lived");
    expect(prompt).not.toContain("## Agent Home");
    expect(prompt).not.toContain("shared across this Agent's Sessions");
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("skill push");
    expect(prompt).not.toContain("## Self-configuration");
    expect(prompt).not.toContain("agent self");
    expect(prompt).toContain("## MCP");
    expect(prompt).toContain("Branch on the operation before you search or add.");
    expect(prompt).toContain("Do not search the catalog and do not run add.");
    expect(prompt).toContain("authorization: null");
    expect(prompt).toContain("Do not add a second definition.");
    expect(prompt).toContain("Do not call generate_oauth_url while the status is pending.");
    expect(prompt).toContain("`opentag self mcp use <server> --api-key-stdin`");
    expect(prompt).toContain("`opentag self mcp search <query> --json`");
    expect(prompt).toContain("paste the MCP configuration into this chat");
  });

  it("renders the Cloud Context Tree with the Agent slug and project path", () => {
    const slugSnapshot: EffectiveRuntimeSnapshot = {
      ...snapshot,
      instructions: { ...snapshot.instructions, platform: "OpenTag Agent slug: tree-agent" },
    };
    const available = renderManagedSystemPrompt(slugSnapshot, {
      ...cloudSession,
      contextTree: {
        status: "configured",
        connections: [
          {
            kind: "git" as const,
            path: ".",
            ref: "master",
            repository: "acme/team",
            status: "available",
            projectPath: "/managed/project",
          },
        ],
      },
    });
    expect(available).toContain('Use --project-path "/managed/project" for managed tree commands.');
    expect(available).toContain("tree-agent");
    expect(available).toContain("members/tree-agent/");
    expect(available).toContain("Unpublished work remains in the prepared worktree.");
    expect(available).toContain("may be outdated");
    expect(available).toContain("do not reset or discard");
    expect(available).toContain("Do not install native cleanup schedules");

    const unconfigured = renderManagedSystemPrompt(snapshot, {
      ...cloudSession,
      contextTree: { status: "unconfigured" },
    });
    expect(unconfigured).toContain("disabled for this Agent");

    const denied = renderManagedSystemPrompt(snapshot, {
      ...cloudSession,
      contextTree: { status: "unavailable", reason: "GITHUB_PERMISSION" },
    });
    expect(denied).toContain("Context Tree unavailable (GITHUB_PERMISSION)");
    expect(denied).toContain("does not grant this Session the selected repository");
  });

  it("renders one Cloud tree section and shared guidance for multiple sources", () => {
    const prompt = renderManagedSystemPrompt(snapshot, {
      ...cloudSession,
      contextTree: {
        status: "configured",
        connections: [
          {
            kind: "git" as const,
            path: ".",
            ref: "main",
            repository: "acme/team",
            status: "available",
            projectPath: "/managed/project",
          },
          {
            kind: "git" as const,
            path: ".",
            ref: "main",
            repository: "acme/product",
            status: "available",
            projectPath: "/managed/project",
          },
          {
            kind: "git" as const,
            path: ".",
            ref: "main",
            repository: "acme/denied",
            status: "unavailable",
            reason: "GITHUB_PERMISSION",
          },
          {
            kind: "git" as const,
            path: ".",
            ref: "main",
            repository: "acme/timeout",
            status: "unavailable",
            reason: "TIMEOUT",
          },
        ],
      },
    });
    expect(prompt.match(/^## Context Trees$/gm)).toHaveLength(1);
    expect(prompt).not.toMatch(/^## Context Tree$/m);
    expect(prompt).toContain("team — acme/team");
    expect(prompt).toContain("product — acme/product");
    expect(prompt).toContain("GITHUB_PERMISSION");
    expect(prompt).toContain("TIMEOUT");
    expect(prompt.match(/context-tree-read and context-tree-write skills/g)).toHaveLength(1);
    expect(prompt.match(/Read Context through the context-tree-read skill/g)).toHaveLength(1);
    expect(prompt.match(/Do not write to another Agent's member directory/g)).toHaveLength(1);
    expect(prompt.match(/Continue the task without those trees/g)).toHaveLength(1);
  });
});

it("describes one-code Slack provisioning for visible managed Sessions without granting self-configuration", () => {
  const prompt = renderManagedSystemPrompt(snapshot, { ...cloudSession, selfConfigurationEnabled: false });
  expect(prompt).toContain("opentag slack --help");
  expect(prompt).toContain("--project-dir project-<creationIntentId>");
  expect(prompt).toContain("without --code-file");
  expect(prompt).toContain("Never request a normal Account login code");
  expect(prompt).toContain("Callback failure retries only that update");
  expect(prompt).toContain("opentag slack callbacks --help");
  expect(prompt).toContain("do not guess events or rebuild the App manifest");
  expect(prompt).toContain("opentag slack manage -- api --help");
  expect(prompt).not.toContain("## Self-configuration");
  expect(prompt).not.toContain("## MCP");
  expect(renderManagedSystemPrompt(snapshot, { ...cloudSession, sessionCliAvailable: false })).not.toContain(
    "agent provision-slack",
  );
  expect(renderManagedSystemPrompt(snapshot, { ...cloudSession, sessionCliAvailable: false })).not.toContain("## MCP");
  expect(renderManagedSystemPrompt(snapshot, { ...cloudSession, sessionKind: "internal" })).not.toContain(
    "agent provision-slack",
  );
});
