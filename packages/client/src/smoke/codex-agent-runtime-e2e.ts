import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunResult, AgentRuntime, AgentRuntimeEvent } from "../agent-runtime/types.js";
import { CodexAgentRuntimeFactory } from "../providers/codex/agent-runtime.js";

const FIRST_TOKEN = "OPENTAG_AGENT_RUNTIME_E2E_ONE";
const SECOND_TOKEN = "OPENTAG_AGENT_RUNTIME_E2E_TWO";
const RUN_TIMEOUT_MS = 180_000;

const workspace = await mkdtemp(join(tmpdir(), "opentag-agent-runtime-e2e-"));
const events: AgentRuntimeEvent[] = [];
const factory = new CodexAgentRuntimeFactory({ clientVersion: "0.0.1-e2e" });
let runtime: AgentRuntime | undefined;

try {
  const probe = await factory.probe({});
  if (!probe.ready) {
    throw new Error(`Codex Agent Runtime probe failed: ${JSON.stringify(probe.issues)}`);
  }

  const request = {
    eventSink: (event: AgentRuntimeEvent) => {
      events.push(event);
    },
    workspace: { cwd: workspace },
    policy: {
      fileSystem: "read-only" as const,
      network: "disabled" as const,
      approvals: "never" as const,
      tools: { mode: "provider-default" as const },
    },
  };

  runtime = await factory.create(request);
  const binding = runtime.binding;
  if (!binding) throw new Error("Codex create did not produce a binding");

  const first = await runtime.prompt({
    runId: "e2e-create-run",
    input: {
      items: [
        {
          type: "text",
          text: `Reply with exactly ${FIRST_TOKEN}. Do not use tools and do not add punctuation.`,
        },
      ],
    },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  assertCompletedWithToken(first, FIRST_TOKEN);
  assertTerminalOrdering(events, first.runId);
  await runtime.close();
  runtime = undefined;

  const resumedEvents: AgentRuntimeEvent[] = [];
  runtime = await factory.resume({
    ...request,
    binding,
    eventSink: (event) => {
      resumedEvents.push(event);
    },
  });
  if (JSON.stringify(runtime.binding) !== JSON.stringify(binding)) {
    throw new Error("Codex exact resume changed the binding");
  }

  const second = await runtime.prompt({
    runId: "e2e-resume-run",
    input: {
      items: [
        {
          type: "text",
          text: `You previously returned ${FIRST_TOKEN}. Reply with exactly ${SECOND_TOKEN}. Do not use tools and do not add punctuation.`,
        },
      ],
    },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  assertCompletedWithToken(second, SECOND_TOKEN);
  assertTerminalOrdering(resumedEvents, second.runId);
  await runtime.close();
  runtime = undefined;

  process.stdout.write(
    `${JSON.stringify({
      ready: probe.ready,
      version: probe.version,
      providerId: binding.providerId,
      bindingPreserved: true,
      createRun: first.status,
      resumeRun: second.status,
      createEvents: events.length,
      resumeEvents: resumedEvents.length,
    })}\n`,
  );
} finally {
  await runtime?.close().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
}

function assertCompletedWithToken(result: AgentRunResult, token: string): void {
  if (result.status !== "completed") {
    throw new Error(`Agent Run ${result.runId} did not complete: ${JSON.stringify(result.error)}`);
  }
  const text = result.output
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .join("\n");
  if (text !== token) {
    throw new Error(`Agent Run ${result.runId} returned unexpected text: ${JSON.stringify(text)}`);
  }
}

function assertTerminalOrdering(eventsToCheck: readonly AgentRuntimeEvent[], runId: string): void {
  const runEvents = eventsToCheck.filter((event) => "runId" in event && event.runId === runId);
  if (runEvents[0]?.type !== "run_started" || runEvents.at(-1)?.type !== "run_completed") {
    throw new Error(`Agent Run ${runId} event ordering is invalid`);
  }
  if (runEvents.filter((event) => event.type.startsWith("run_") && event.type !== "run_started").length !== 1) {
    throw new Error(`Agent Run ${runId} did not emit exactly one terminal event`);
  }
}
