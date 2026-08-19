import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunResult, AgentRuntimeEvent } from "../agent-runtime/types.js";
import { ClaudeCodeAgentRuntimeFactory } from "../providers/claude-code/agent-runtime.js";

const RUN_TIMEOUT_MS = 180_000;

const workspace = await mkdtemp(join(tmpdir(), "opentag-claude-code-e2e-"));
const nonce = `opentag-${Date.now().toString(36)}`;

try {
  const factory = new ClaudeCodeAgentRuntimeFactory();
  const probe = await factory.probe({});
  if (!probe.ready) {
    throw new Error(
      `Claude Code is not ready: ${probe.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`,
    );
  }

  const firstEvents: AgentRuntimeEvent[] = [];
  const first = await factory.create({
    eventSink: (event) => {
      firstEvents.push(event);
    },
    workspace: { cwd: workspace },
    policy: {
      fileSystem: "read-only",
      network: "disabled",
      approvals: "never",
      tools: { mode: "provider-default" },
    },
  });
  const firstResult = await first.prompt({
    runId: "claude-code-e2e-create",
    input: {
      items: [
        {
          type: "text",
          text: `Remember the exact token ${nonce}. Reply with exactly: stored`,
        },
      ],
    },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  assertCompleted(firstResult, "create");
  const binding = first.binding;
  if (!binding) throw new Error("Claude Code create Run produced no binding");
  assertOrderedTerminal(firstEvents, "run_completed");
  await first.close();

  const resumedEvents: AgentRuntimeEvent[] = [];
  const resumed = await factory.resume({
    binding,
    eventSink: (event) => {
      resumedEvents.push(event);
    },
    workspace: { cwd: workspace },
    policy: {
      fileSystem: "read-only",
      network: "disabled",
      approvals: "never",
      tools: { mode: "provider-default" },
    },
  });
  const resumedResult = await resumed.prompt({
    runId: "claude-code-e2e-resume",
    input: { items: [{ type: "text", text: "Reply with only the exact token I asked you to remember." }] },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  assertCompleted(resumedResult, "resume");
  const text = resumedResult.output
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (text !== nonce) throw new Error(`Claude Code resume lost conversation continuity: ${JSON.stringify(text)}`);
  if (JSON.stringify(resumed.binding) !== JSON.stringify(binding)) {
    throw new Error("Claude Code resume changed the opaque binding");
  }
  assertOrderedTerminal(resumedEvents, "run_completed");
  await resumed.close();

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: probe.version,
      binding,
      createEvents: firstEvents.length,
      resumeEvents: resumedEvents.length,
    })}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function assertCompleted(result: AgentRunResult, phase: string): void {
  if (result.status !== "completed") {
    throw new Error(`Claude Code ${phase} Run failed: ${result.error?.code}: ${result.error?.message}`);
  }
}

function assertOrderedTerminal(events: readonly AgentRuntimeEvent[], expected: AgentRuntimeEvent["type"]): void {
  const started = events.findIndex((event) => event.type === "run_started");
  const terminal = events.findIndex((event) => event.type === expected);
  if (started < 0 || terminal <= started || terminal !== events.length - 1) {
    throw new Error(`Claude Code emitted an invalid ordered Run event sequence: ${events.map((event) => event.type)}`);
  }
}
