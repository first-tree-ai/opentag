import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
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
    expect(prompt).toContain('--project-path "<Agent Home>"');
    expect(prompt).toContain("do not create or reconnect a tree just because the task cwd changed");
    expect(prompt).toContain("matching skill write protocol");
    expect(prompt).not.toContain("sandbox");
    expect(prompt).not.toContain("manifest");
    expect(prompt).not.toMatch(/\bGC\b/);
    expect(prompt).not.toContain("migration");
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
    expect(prompt).toContain("`opentag-dev agent self mcp`");
    expect(prompt).toContain("apply from your next Turn and start a new provider conversation");
    expect(prompt).toContain("An Agent that had no usable MCP Server gets MCP access at its next execution.");
    expect(prompt).not.toContain("MCP mount changes apply to your next MCP request");
    expect(prompt).toContain("read the current value first");

    const unavailable = renderManagedSystemPrompt(snapshot, { ...session, sessionCliAvailable: false });
    expect(unavailable).not.toContain("## Self-configuration");
    expect(unavailable).not.toContain("agent self");

    const disabled = renderManagedSystemPrompt(snapshot, { ...session, selfConfigurationEnabled: false });
    expect(disabled).not.toContain("## Self-configuration");
    expect(disabled).not.toContain("agent self");

    const disabledUnavailable = renderManagedSystemPrompt(snapshot, {
      ...session,
      sessionCliAvailable: false,
      selfConfigurationEnabled: false,
    });
    expect(disabledUnavailable).not.toContain("## Self-configuration");
    expect(disabledUnavailable).not.toContain("agent self");
  });

  it("still describes Agent Home conventions when the concrete path is omitted", () => {
    const prompt = renderManagedSystemPrompt(snapshot, session);
    expect(prompt).toContain("## Agent Home");
    expect(prompt).toContain("source-repos/<unique-repo-key>/");
    expect(prompt).toContain('--project-path "<Agent Home>"');
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
      contextTree: { status: "unavailable", reason: "DIRTY_TREE" },
    });
    expect(unavailable).toContain("Context Tree unavailable (DIRTY_TREE)");
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

it("attributes partial memory results to aliases without disabling healthy trees", () => {
  const prompt = renderManagedSystemPrompt(snapshot, {
    ...session,
    contextTree: {
      status: "configured",
      connections: [
        { alias: "team", repository: "acme/team", status: "ready", treePath: "/trees/team" },
        { alias: "product", repository: "acme/product", status: "unavailable", reason: "GITHUB_AUTH" },
      ],
    },
  });
  expect(prompt).toContain("Alias team — acme/team");
  expect(prompt).toContain("Alias product — acme/product");
  expect(prompt).toContain("Other ready trees remain usable");
  expect(prompt).toContain("explicit alias for every write");
  expect(prompt).not.toContain("Durable memory is not active for this Session");
});

it("renders shared multi-tree instructions once while preserving each path and reason", () => {
  const prompt = renderManagedSystemPrompt(snapshot, {
    ...session,
    contextTree: {
      status: "configured",
      connections: [
        { alias: "team", repository: "acme/team", status: "ready", treePath: "/trees/team" },
        { alias: "product", repository: "acme/product", status: "ready", treePath: "/trees/product" },
        { alias: "pending", repository: "acme/pending", status: "unavailable", reason: "PREPARING" },
        { alias: "denied", repository: "acme/denied", status: "unavailable", reason: "GITHUB_PERMISSION" },
      ],
    },
  });
  expect(prompt).toContain("Context Tree: /trees/team");
  expect(prompt).toContain("Context Tree: /trees/product");
  expect(prompt).toContain("Alias pending — acme/pending");
  expect(prompt).toContain("preparation is continuing");
  expect(prompt).toContain("GITHUB_PERMISSION");
  expect(prompt.match(/Use the context-tree-read and context-tree-write skills/g)).toHaveLength(1);
  expect(prompt.match(/Do not write to another Agent's member directory/g)).toHaveLength(1);
  expect(prompt.match(/Other ready trees remain usable/g)).toHaveLength(1);
});

it("keeps preparation guidance separate from failures in a configured tree list", () => {
  const prompt = renderManagedSystemPrompt(snapshot, {
    ...session,
    contextTree: {
      status: "configured",
      connections: [
        { alias: "team", repository: "acme/team", status: "ready", treePath: "/trees/team" },
        { alias: "pending", repository: "acme/pending", status: "unavailable", reason: "PREPARING" },
      ],
    },
  });
  expect(prompt).toContain("preparation is continuing in the background");
  expect(prompt).toContain("not active for this Session");
  expect(prompt).toContain("Other ready trees remain usable");
  expect(prompt).not.toContain("repair the tree");
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
      expect(prompt).toContain("Lean toward a lively, friendly tone");
      expect(prompt).toContain(
        'For a lengthy user task, add one emoji reaction meaning "received, working on it" to the original user message via the provider CLI before starting task work (for example, Feishu OnIt or the provider\'s equivalent).',
      );
      expect(prompt).toContain("Do not use approval or completion reactions such as thumbs-up or check marks");
      expect(prompt).toContain("Skip it only for duplicate acknowledgments and observer deliveries");
      expect(prompt).not.toContain("optionally");
      expect(prompt).not.toContain("unnecessary");
      expect(prompt).toContain("OpenTag internal Sessions and Provider-native subagents are separate mechanisms");
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
        "report progress, questions, and the final result to the creating or coordinating Session",
      );
      expect(prompt).toContain("Creator Session: session-parent-1");
      expect(prompt).not.toContain("emoji");
      expect(prompt).not.toContain("lively, friendly tone");
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
    }

    const local = renderManagedSystemPrompt(snapshot, session);
    expect(local).toContain("Session collaboration is available through these commands:");
    expect(local).toContain("- opentag-dev session create --message <task>");
    expect(local).toContain("- opentag-dev session send <target-session-id> --message <text>");
    expect(local).toContain("- opentag-dev session list");
    expect(local).toContain("Do not pass or look for agentId or sourceSessionId arguments");
    expect(local).toContain("An accepted result means the target accepted the message for processing");
    expect(local).toContain("retry with the same messageId and exactly the same semantic input");
    expect(local).not.toContain("its final text is not automatically returned to its parent");

    const cloud = renderManagedSystemPrompt(snapshot, cloudSession);
    expect(cloud).toContain("Session collaboration is available through these commands:");
    expect(cloud).toContain("- opentag session create --message <task>");
    expect(cloud).toContain("- opentag session send <target-session-id> --message <text>");
    expect(cloud).toContain("- opentag session list");
    expect(cloud).toContain("Do not copy or persist its temporary proof");
    expect(cloud).toContain("another Session cannot read this workspace");
    expect(cloud).toContain("An accepted result means the target accepted the message for processing");
    expect(cloud).toContain("retry with the same messageId and exactly the same semantic input");
    expect(cloud).toContain("its final text is not automatically returned to its parent");
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
    expect(prompt).toContain("256 MiB");
    expect(prompt).toContain("50,000 entries");
    expect(prompt).toContain("128 MiB");
    expect(prompt).toContain("Hard links, sockets, FIFOs");
    expect(prompt).toContain("execution-scoped and short-lived");
    expect(prompt).not.toContain("## Agent Home");
    expect(prompt).not.toContain("shared across this Agent's Sessions");
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("skill push");
    expect(prompt).not.toContain("## Self-configuration");
    expect(prompt).not.toContain("agent self");
  });

  it("renders the current Context Tree truthfully with the Agent slug and exact path", () => {
    const slugSnapshot: EffectiveRuntimeSnapshot = {
      ...snapshot,
      instructions: { ...snapshot.instructions, platform: "OpenTag Agent slug: tree-agent" },
    };
    const ready = renderManagedSystemPrompt(slugSnapshot, {
      ...cloudSession,
      contextTree: { status: "ready", treePath: "/ws/tree", branch: "master", sha: "a".repeat(40) },
    });
    expect(ready).toContain(
      "Context Tree: /ws/tree — synchronized at the start of this Turn (branch master, commit aaaaaaaaaaaa).",
    );
    expect(ready).toContain("tree-agent");
    expect(ready).toContain("members/tree-agent/");
    expect(ready).toContain("saved and restored with it");

    const dirty = renderManagedSystemPrompt(snapshot, {
      ...cloudSession,
      contextTree: { status: "stale", treePath: "/ws/tree", reason: "DIRTY_TREE" },
    });
    expect(dirty).toContain("Context Tree: /ws/tree");
    expect(dirty).toContain("unpublished changes");
    expect(dirty).toContain("do not reset or discard");

    const stale = renderManagedSystemPrompt(snapshot, {
      ...cloudSession,
      contextTree: { status: "stale", treePath: "/ws/tree", reason: "TIMEOUT" },
    });
    expect(stale).toContain("may be outdated");
    expect(stale).toContain("TIMEOUT");

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

  it("renders one Cloud tree section and shared guidance for multiple aliases", () => {
    const prompt = renderManagedSystemPrompt(snapshot, {
      ...cloudSession,
      contextTree: {
        status: "configured",
        connections: [
          {
            alias: "team",
            repository: "acme/team",
            status: "ready",
            treePath: "/trees/team",
            branch: "main",
            sha: "a".repeat(40),
          },
          { alias: "product", repository: "acme/product", status: "ready", treePath: "/trees/product" },
          { alias: "stale", repository: "acme/stale", status: "stale", treePath: "/trees/stale", reason: "DIRTY_TREE" },
          { alias: "denied", repository: "acme/denied", status: "unavailable", reason: "GITHUB_PERMISSION" },
          { alias: "timeout", repository: "acme/timeout", status: "unavailable", reason: "TIMEOUT" },
        ],
      },
    });
    expect(prompt.match(/^## Context Trees$/gm)).toHaveLength(1);
    expect(prompt).not.toMatch(/^## Context Tree$/m);
    expect(prompt).toContain("Alias team — acme/team");
    expect(prompt).toContain("Context Tree: /trees/product");
    expect(prompt).toContain("branch main, commit aaaaaaaaaaaa");
    expect(prompt).toContain("Context Tree: /trees/stale");
    expect(prompt).toContain("do not reset or discard");
    expect(prompt).toContain("GITHUB_PERMISSION");
    expect(prompt.match(/Use the context-tree-read and context-tree-write skills/g)).toHaveLength(1);
    expect(prompt.match(/Do not write to another Agent's member directory/g)).toHaveLength(1);
    expect(prompt.match(/Continue the task without those trees/g)).toHaveLength(1);
  });
});
