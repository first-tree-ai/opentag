import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunResult, AgentRuntime, AgentRuntimeEvent } from "../agent-runtime/types.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";

const STORED_TOKEN = "PI_MEMORY_STORED";
const RUN_TIMEOUT_MS = 180_000;

const root = await mkdtemp(join(tmpdir(), "opentag-pi-runtime-e2e-"));
const workspace = join(root, "workspace");
const sessions = join(root, "sessions");
const projectCodename = `OPENTAG_PI_${randomUUID().replaceAll("-", "").toUpperCase()}`;
await Promise.all([mkdir(workspace), mkdir(sessions)]);

const events: AgentRuntimeEvent[] = [];
const factory = new PiAgentRuntimeFactory({ process: { sessionDirectory: sessions } });
let runtime: AgentRuntime | undefined;

try {
  const probe = await factory.probe({});
  if (!probe.ready) throw new Error(`Pi Agent Runtime probe failed: ${JSON.stringify(probe.issues)}`);

  const request = {
    eventSink: (event: AgentRuntimeEvent) => {
      events.push(event);
    },
    systemPrompt: "Follow the user's exact response-format request.",
    workspace: { cwd: workspace },
    policy: {
      fileSystem: "read-only" as const,
      network: "disabled" as const,
      approvals: "never" as const,
      tools: { mode: "provider-default" as const },
    },
  };

  runtime = await factory.create(request);
  if (!runtime.binding) throw new Error("Pi create did not produce a binding");

  const first = await runtime.prompt({
    runId: "pi-e2e-create-run",
    input: {
      items: [
        {
          type: "text",
          text: `We are testing session continuity. The project codename in this conversation is ${projectCodename}. Reply with exactly ${STORED_TOKEN}. Do not use tools or add punctuation.`,
        },
      ],
    },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  assertCompletedWithToken(first, STORED_TOKEN);
  assertTerminalOrdering(events, first.runId);
  const binding = runtime.binding;
  if (!binding || typeof binding.payload !== "object" || binding.payload === null) {
    throw new Error("Pi create did not materialize its binding");
  }
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
    throw new Error("Pi exact resume changed the binding");
  }

  const second = await runtime.prompt({
    runId: "pi-e2e-resume-run",
    input: {
      items: [
        {
          type: "text",
          text: "What project codename did I give you in the previous message? Reply only with it. Do not use tools.",
        },
      ],
    },
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  assertCompletedWithToken(second, projectCodename);
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
  await rm(root, { recursive: true, force: true });
}

function assertCompletedWithToken(result: AgentRunResult, token: string): void {
  if (result.status !== "completed") {
    throw new Error(`Agent Run ${result.runId} did not complete: ${JSON.stringify(result.error)}`);
  }
  const text = result.output
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .join("\n");
  if (text !== token) throw new Error(`Agent Run ${result.runId} returned unexpected text: ${JSON.stringify(text)}`);
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
