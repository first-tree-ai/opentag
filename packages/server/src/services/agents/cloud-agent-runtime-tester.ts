import {
  type AgentRuntimeTestFailureCode,
  type AgentRuntimeTestResponse,
  RUNTIME_AGENT_RUNTIME_TEST_MAX_PENDING,
} from "@opentag/shared";
import { z } from "zod";
import type { CloudModelConfig } from "../../cloud-model-config.js";
import { type CloudModelCatalog, readBoundedResponseText } from "../sandboxes/cloud-model-catalog.js";

/**
 * The Cloud branch of the Agent runtime test: one bounded Server-to-model connectivity probe
 * against the deployment Router, using the Agent's saved model or the current Router default (the
 * first Router model). This answers "can the hosted model path run this model right now" — it is
 * deliberately NOT a Sandbox, Pi, IM, or workspace check, and it creates no Session, Sandbox, or
 * Instance and writes no product history.
 *
 * The probe reuses the model path's fixed upstream coordinates and platform master key (never the
 * execution-grant machinery and never a caller-supplied URL): one non-streaming chat completion
 * with a fixed prompt, a 16-token output budget, and no tools. Model admission is the shared
 * Router catalog, exactly like dispatch: an explicit saved model the Router no longer offers — or
 * a catalog that cannot confirm one — is never probed. Success requires a valid completion
 * (an assistant text or reasoning message with no tool calls), not any 200. The upstream
 * body, the master key, and error details never cross into the response. Concurrency is bounded
 * exactly like the Local owner: one pending probe per Cloud Computer and a bounded total; a
 * caller disconnect or server close aborts the probe, including while the shared catalog read is
 * still pending.
 */

/** The fixed connectivity prompt; the answer content is never inspected beyond being present. */
const CLOUD_AGENT_RUNTIME_TEST_PROMPT = "Reply with the single word: ok";
/** The probe is a quick connectivity answer, far below a real Turn's budget. */
const CLOUD_AGENT_RUNTIME_TEST_MAX_OUTPUT_TOKENS = 16;
/** Bounded wait for the whole probe, including the shared catalog read. */
export const CLOUD_AGENT_RUNTIME_TEST_TIMEOUT_MS = 45_000;
/** A valid completion to a 16-token probe is tiny; anything larger is not an answer to it. */
const CLOUD_AGENT_RUNTIME_TEST_MAX_RESPONSE_BYTES = 64 * 1024;

type CloudTestFailureCode = Extract<
  AgentRuntimeTestFailureCode,
  "busy" | "cancelled" | "provider_failed" | "provider_start_failed" | "timeout"
>;

function failure(code: CloudTestFailureCode): AgentRuntimeTestResponse {
  return { status: "failed", code };
}

/** Reasoning-only output is valid when the small probe budget is exhausted before the answer. */
const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            role: z.literal("assistant"),
            content: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            tool_calls: z.array(z.never()).nullable().optional(),
            function_call: z.null().optional(),
          })
          .refine((message) => Boolean(message.content?.trim() || message.reasoning_content?.trim())),
      }),
    )
    .min(1)
    .max(4),
});

export interface CloudAgentRuntimeTesterOptions {
  /** The enabled Cloud model configuration: fixed Router base URL and platform master key. */
  config: Extract<CloudModelConfig, { enabled: true }>;
  /** The one shared Router model catalog; admits explicit models and resolves the default. */
  catalog: CloudModelCatalog;
  fetchImpl?: typeof fetch;
  maxPending?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export class CloudAgentRuntimeTester {
  readonly #catalog: CloudModelCatalog;
  readonly #config: Extract<CloudModelConfig, { enabled: true }>;
  readonly #fetchImpl: typeof fetch;
  readonly #maxPending: number;
  readonly #maxResponseBytes: number;
  readonly #timeoutMs: number;
  /** One pending probe per Cloud Computer; the map's size is the total bound. */
  readonly #pending = new Map<string, { abort(): void }>();
  #closed = false;

  constructor(options: CloudAgentRuntimeTesterOptions) {
    this.#catalog = options.catalog;
    this.#config = options.config;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#maxPending = options.maxPending ?? RUNTIME_AGENT_RUNTIME_TEST_MAX_PENDING;
    this.#maxResponseBytes = options.maxResponseBytes ?? CLOUD_AGENT_RUNTIME_TEST_MAX_RESPONSE_BYTES;
    this.#timeoutMs = options.timeoutMs ?? CLOUD_AGENT_RUNTIME_TEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#maxPending) || this.#maxPending < 1) {
      throw new Error("Cloud Agent runtime test pending limit must be a positive safe integer");
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Run one connectivity probe for the Agent's bound Cloud Computer. `model` is the Agent's saved
   * model (null resolves to the current Router default); the Router catalog admits or refuses the
   * choice first, so a stale saved model reports the same refusal its next real Turn would hit —
   * without spending a model request on it.
   */
  async test(input: {
    computerId: string;
    model: string | null;
    signal?: AbortSignal;
  }): Promise<AgentRuntimeTestResponse> {
    if (this.#closed || input.signal?.aborted) return failure("cancelled");
    if (this.#pending.has(input.computerId) || this.#pending.size >= this.#maxPending) return failure("busy");
    const controller = new AbortController();
    this.#pending.set(input.computerId, {
      abort: () => controller.abort(new Error("cloud_agent_runtime_test_shutdown")),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("cloud_agent_runtime_test_timeout"));
    }, this.#timeoutMs);
    timer.unref?.();
    const onCallerAbort = () => controller.abort(new Error("cloud_agent_runtime_test_cancelled"));
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const snapshot = await waitForCatalog(this.#catalog.list(), controller.signal);
      if (controller.signal.aborted) return this.#mapAborted(() => timedOut, input.signal) ?? failure("cancelled");
      const model = input.model ?? snapshot.defaultModel;
      if (!snapshot.available || model === null || !snapshot.models.includes(model))
        return failure("provider_start_failed");
      return await this.#probe(model, controller.signal, () => timedOut, input.signal);
    } catch {
      return this.#mapAborted(() => timedOut, input.signal) ?? failure("provider_failed");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onCallerAbort);
      this.#pending.delete(input.computerId);
    }
  }

  /** Abort every pending probe (server shutdown); in-flight callers resolve `cancelled`. */
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.abort();
  }

  async #probe(
    model: string,
    signal: AbortSignal,
    timedOut: () => boolean,
    callerSignal: AbortSignal | undefined,
  ): Promise<AgentRuntimeTestResponse> {
    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#config.upstreamBaseUrl}/chat/completions`, {
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: CLOUD_AGENT_RUNTIME_TEST_PROMPT }],
          max_tokens: CLOUD_AGENT_RUNTIME_TEST_MAX_OUTPUT_TOKENS,
          stream: false,
        }),
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          authorization: `Bearer ${this.#config.masterKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        // A redirect from the fixed upstream must never steer the probe to another origin.
        redirect: "error",
        signal,
      });
    } catch {
      return this.#mapAborted(timedOut, callerSignal) ?? failure("provider_failed");
    }
    if (response.status < 200 || response.status >= 300) {
      // The upstream status/body is never relayed: a broken upstream may echo the platform key.
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort release of the fixed-upstream socket.
      }
      return failure("provider_failed");
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort release of the fixed-upstream socket.
      }
      return failure("provider_failed");
    }
    const text = await readBoundedResponseText(response, this.#maxResponseBytes);
    if (signal.aborted || text === undefined)
      return this.#mapAborted(timedOut, callerSignal) ?? failure("provider_failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return failure("provider_failed");
    }
    return CompletionSchema.safeParse(parsed).success ? { status: "passed" } : failure("provider_failed");
  }

  /** The aborted-outcome mapping; undefined when nothing aborted (an ordinary upstream failure). */
  #mapAborted(timedOut: () => boolean, callerSignal: AbortSignal | undefined): AgentRuntimeTestResponse | undefined {
    if (callerSignal?.aborted || this.#closed) return failure("cancelled");
    if (timedOut()) return failure("timeout");
    return undefined;
  }
}

/** Cancelling one probe does not cancel the catalog shared by other readers. */
function waitForCatalog<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
