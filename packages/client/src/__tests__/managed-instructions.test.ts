import type { EffectiveRuntimeSnapshot } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { type ManagedSessionContext, renderManagedSystemPrompt } from "../runtime/managed-instructions.js";

const snapshot: EffectiveRuntimeSnapshot = {
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
};

const session: ManagedSessionContext = {
  sessionId: "session-1",
  sessionKind: "visible",
  cliCommand: "opentag-dev",
  sessionCliAvailable: true,
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
    expect(unconfigured).toContain("Context Tree: not configured on this Computer (opentag-dev context-tree connect).");
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
