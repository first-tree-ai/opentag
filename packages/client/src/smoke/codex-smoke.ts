import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DirectImMessageDeliveryRequest, EffectiveRuntimeSnapshot } from "@opentag/shared";
import { CodexAdapter } from "../providers/codex/adapter.js";

const root = await mkdtemp(resolve(tmpdir(), "opentag-codex-smoke-"));

try {
  const workspace = resolve(root, "agent-workspace");
  const files = resolve(workspace, "files");
  const agentsFile = resolve(workspace, "AGENTS.md");
  await mkdir(files, { recursive: true, mode: 0o700 });
  await writeFile(agentsFile, "# OpenTag smoke\n\nReply concisely and do not use tools.\n", { mode: 0o444 });
  await chmod(agentsFile, 0o444);
  const cwd = await realpath(files);
  const canonicalAgentsFile = resolve(cwd, "..", "AGENTS.md");
  const adapter = new CodexAdapter({ clientVersion: "0.0.1-smoke" });
  let providerThreadId: string | undefined;

  for (const [index, text] of [
    "Reply with exactly OPENTAG_SMOKE_OK_1.",
    "Reply with exactly OPENTAG_SMOKE_OK_2.",
  ].entries()) {
    const result = await adapter.runTurn({
      request: delivery(index + 1, text),
      cwd,
      agentsFile: canonicalAgentsFile,
      providerThreadId,
      signal: AbortSignal.timeout(120_000),
      onThreadReady: (threadId) => {
        providerThreadId = threadId;
      },
      onTurnStarted: () => undefined,
    });
    if (result.outcome !== "completed" || result.finalText?.trim() !== `OPENTAG_SMOKE_OK_${index + 1}`) {
      throw new Error(`Codex smoke Turn ${index + 1} returned an unexpected result`);
    }
  }
  process.stdout.write("Codex first-Turn and Resume smoke passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

function runtime(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-smoke",
    provider: "codex",
    instructions: { platform: "OpenTag smoke", agent: "Return only the requested marker." },
    allowedTools: [],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-smoke", mode: "empty_on_create", sharing: "agent" },
  };
}

function delivery(sequence: number, text: string): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: `delivery-smoke-${sequence}`,
    imMessageId: `message-smoke-${sequence}`,
    imMessageRevision: 1,
    sessionId: "session-smoke",
    agentId: "agent-smoke",
    placementGeneration: 1,
    attention: "direct",
    content: { kind: "text", text },
    runtime: runtime(),
  };
}
