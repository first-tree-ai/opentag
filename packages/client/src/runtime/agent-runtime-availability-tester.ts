import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRuntimeTestFailureCode,
  type AgentRuntimeTestRequestFrame,
  type AgentRuntimeTestResultFrame,
  RUNTIME_AGENT_RUNTIME_TEST_CLEANUP_MS,
  RUNTIME_AGENT_RUNTIME_TEST_TIMEOUT_MS,
} from "@opentag/shared";
import { AgentProviderError, AgentRuntimeError } from "../agent-runtime/errors.js";
import type {
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeFactory,
  AgentRuntimePolicy,
} from "../agent-runtime/types.js";
import { createLogger } from "../observability/logger.js";

const TEST_SYSTEM_PROMPT = "You are running a bounded OpenTag availability test. Reply with only the requested token.";
const logger = createLogger("runtime-availability-tester");

export interface AgentRuntimeAvailabilityTesterOptions {
  readonly cleanupMs?: number;
  readonly factories: ReadonlyMap<string, AgentRuntimeFactory>;
  readonly timeoutMs?: number;
}

export function agentRuntimeAvailabilityPolicy(provider: "codex" | "claude-code"): AgentRuntimePolicy {
  if (provider === "claude-code") {
    return {
      fileSystem: "unrestricted",
      network: "enabled",
      approvals: "never",
      tools: { mode: "allow-list", names: [] },
    };
  }
  return {
    fileSystem: "workspace-write",
    network: "enabled",
    approvals: "never",
    tools: { mode: "provider-default" },
  };
}

function failed(requestId: string, code: AgentRuntimeTestFailureCode): AgentRuntimeTestResultFrame {
  return { type: "agent-runtime:test:result", requestId, status: "failed", code };
}

function passed(requestId: string): AgentRuntimeTestResultFrame {
  return { type: "agent-runtime:test:result", requestId, status: "passed" };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "ABORT_ERR")
  );
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export class AgentRuntimeAvailabilityTester {
  readonly #cleanupMs: number;
  readonly #factories: ReadonlyMap<string, AgentRuntimeFactory>;
  readonly #timeoutMs: number;

  constructor(options: AgentRuntimeAvailabilityTesterOptions) {
    this.#factories = options.factories;
    this.#timeoutMs = options.timeoutMs ?? RUNTIME_AGENT_RUNTIME_TEST_TIMEOUT_MS;
    this.#cleanupMs = options.cleanupMs ?? RUNTIME_AGENT_RUNTIME_TEST_CLEANUP_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error("Agent Runtime availability test timeout must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#cleanupMs) || this.#cleanupMs < 1) {
      throw new Error("Agent Runtime availability test cleanup budget must be a positive safe integer");
    }
  }

  async run(request: AgentRuntimeTestRequestFrame, signal: AbortSignal): Promise<AgentRuntimeTestResultFrame> {
    if (signal.aborted) return failed(request.requestId, "cancelled");
    const factory = this.#factories.get(request.provider);
    if (!factory) return failed(request.requestId, "provider_start_failed");

    const sentinel = randomBytes(16).toString("hex");
    const workspace = await mkdtemp(join(tmpdir(), "opentag-runtime-test-"));
    const started = { current: false };
    let runtime: AgentRuntime | undefined;
    let acceptingRuntime = true;
    const execution = new AbortController();
    const onCancel = () => execution.abort();
    signal.addEventListener("abort", onCancel);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<AgentRuntimeTestResultFrame>((resolve) => {
      timeoutHandle = setTimeout(() => {
        execution.abort();
        resolve(failed(request.requestId, "timeout"));
      }, this.#timeoutMs);
      timeoutHandle.unref();
    });
    let resolveFastFail: ((result: AgentRuntimeTestResultFrame) => void) | undefined;
    const fastFail = new Promise<AgentRuntimeTestResultFrame>((resolve) => {
      resolveFastFail = resolve;
    });
    try {
      const work = this.#execute(
        factory,
        request,
        sentinel,
        workspace,
        execution.signal,
        started,
        (created) => {
          if (acceptingRuntime) {
            runtime = created;
          } else {
            /* v8 ignore next -- closing a runtime that arrived after cancellation is best-effort. */
            void created.close().catch((error: unknown) => {
              logger.debug(
                { code: "late_runtime_close_failed", error: String(error) },
                "Late availability-test runtime close failed",
              );
            });
          }
        },
        (code) => {
          execution.abort();
          resolveFastFail?.(failed(request.requestId, code));
        },
      ).then(
        (result) => ({ kind: "work" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const outcome = await Promise.race([
        work,
        timeoutResult.then((result) => ({ kind: "timeout" as const, result })),
        fastFail.then((result) => ({ kind: "fast" as const, result })),
        whenAborted(signal).then(() => ({ kind: "cancel" as const })),
      ]);
      if (signal.aborted || outcome.kind === "cancel") return failed(request.requestId, "cancelled");
      if (outcome.kind === "timeout" || outcome.kind === "fast") return outcome.result;
      if (outcome.kind === "error") {
        const error = outcome.error;
        if (isAbortError(error)) return failed(request.requestId, "timeout");
        return failed(request.requestId, classifyStartFailure(error, started.current));
      }
      return outcome.result;
    } finally {
      acceptingRuntime = false;
      /* v8 ignore else -- the timeout handle is always armed before the probe settles. */
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onCancel);
      await budgetedCleanup(async () => {
        /* v8 ignore next -- probe runtime teardown is best-effort. */
        await runtime?.close().catch((error: unknown) => {
          logger.debug(
            { code: "runtime_cleanup_failed", error: String(error) },
            "Availability-test runtime cleanup failed",
          );
        });
        await rm(workspace, { recursive: true, force: true }).catch((error: unknown) => {
          /* v8 ignore next -- filesystem cleanup rejection is an OS-level fault; keep its debug evidence in production. */
          logger.debug(
            { code: "workspace_cleanup_failed", error: String(error) },
            "Availability-test workspace cleanup failed",
          );
        });
      }, this.#cleanupMs);
    }
  }

  async #execute(
    factory: AgentRuntimeFactory,
    request: AgentRuntimeTestRequestFrame,
    sentinel: string,
    workspace: string,
    signal: AbortSignal,
    started: { current: boolean },
    onCreated: (runtime: AgentRuntime) => void,
    onToolOrInteraction: (code: AgentRuntimeTestFailureCode) => void,
  ): Promise<AgentRuntimeTestResultFrame> {
    let toolOrInteraction = false;
    const runtime = await factory.create({
      eventSink: (event: AgentRuntimeEvent) => {
        /* v8 ignore else -- other event types are deliberately ignored by the probe sink. */
        if (event.type === "tool_started" || event.type === "interaction_requested") {
          toolOrInteraction = true;
          onToolOrInteraction("interaction_or_tool");
        }
      },
      systemPrompt: TEST_SYSTEM_PROMPT,
      workspace: { cwd: workspace },
      policy: agentRuntimeAvailabilityPolicy(request.provider),
      configuration: {
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      },
    });
    started.current = true;
    onCreated(runtime);
    try {
      const run = await runtime.prompt({
        runId: randomUUID(),
        input: {
          items: [
            {
              type: "text",
              text: `Reply with exactly ${sentinel} and nothing else. Do not use tools and do not add punctuation.`,
            },
          ],
        },
        signal,
      });
      if (toolOrInteraction) return failed(request.requestId, "interaction_or_tool");
      return settleRun(request.requestId, run, sentinel);
    } catch (error) {
      if (toolOrInteraction) return failed(request.requestId, "interaction_or_tool");
      logger.debug(
        { code: "availability_prompt_failed", error: String(error) },
        "Agent Runtime availability prompt failed",
      );
      throw error;
    }
  }
}

function settleRun(requestId: string, run: AgentRunResult, sentinel: string): AgentRuntimeTestResultFrame {
  if (run.error?.code === "provider_start_failed") return failed(requestId, "provider_start_failed");
  if (run.status !== "completed") return failed(requestId, "provider_failed");
  const text = run.output
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
  if (text !== sentinel) return failed(requestId, "provider_failed");
  return passed(requestId);
}

function classifyStartFailure(error: unknown, started: boolean): AgentRuntimeTestFailureCode {
  if (
    (error instanceof AgentProviderError && error.code === "provider_start_failed") ||
    (error instanceof AgentRuntimeError && (error.code === "create_failed" || error.code === "configuration_invalid"))
  ) {
    return "provider_start_failed";
  }
  return started ? "provider_failed" : "provider_start_failed";
}

async function budgetedCleanup(cleanup: () => Promise<void>, cleanupMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup().catch((error: unknown) => {
        /* v8 ignore next -- cleanup callback rejection is an OS-level fault; keep its debug evidence in production. */
        logger.debug(
          { code: "budgeted_cleanup_failed", error: String(error) },
          "Availability-test budgeted cleanup failed",
        );
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, cleanupMs);
        timer.unref();
      }),
    ]);
  } finally {
    /* v8 ignore else -- the budget timer is always armed before the race settles. */
    if (timer) clearTimeout(timer);
  }
}
