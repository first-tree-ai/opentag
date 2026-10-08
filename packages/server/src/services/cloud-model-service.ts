import { z } from "zod";
import type { CloudBilling } from "../cloud-billing.js";
import {
  type CloudCallContext,
  type CloudUsageObservation,
  CloudUsageObservationSchema,
} from "../cloud-call-contracts.js";
import type { CloudModelConfig } from "../cloud-model-config.js";
import {
  CLOUD_MODEL_ERROR_BODY_MAX_BYTES,
  CloudModelRequestSchema,
  type CloudModelTransportLimits,
} from "../cloud-model-request.js";
import type { CloudCallStore } from "./cloud-call-store.js";
import { readBoundedResponseText } from "./sandboxes/cloud-model-catalog.js";

const count = z.number().int().safe().nonnegative();
const UsageSchema = z.object({
  prompt_tokens: z.unknown().optional(),
  completion_tokens: z.unknown().optional(),
  prompt_tokens_details: z.unknown().optional(),
});

/** LiteLLM normalizes provider usage to OpenAI counts. Cache and reasoning details are subsets. */
export function parseCloudUsage(raw: unknown): CloudUsageObservation | undefined {
  const parsed = z.object({ id: z.string().min(1).max(256).optional(), usage: z.unknown().optional() }).safeParse(raw);
  if (!parsed.success) return undefined;
  const usage = UsageSchema.safeParse(parsed.data.usage);
  const input = count.safeParse(usage.data?.prompt_tokens);
  const output = count.safeParse(usage.data?.completion_tokens);
  const cache = z.object({ cached_tokens: count }).safeParse(usage.data?.prompt_tokens_details);
  const value: CloudUsageObservation = {
    ...(parsed.data.id ? { responseId: parsed.data.id } : {}),
    ...(input.success ? { inputTokens: input.data } : {}),
    ...(output.success ? { outputTokens: output.data } : {}),
    ...(cache.success && input.success && cache.data.cached_tokens <= input.data
      ? { cachedInputTokens: cache.data.cached_tokens }
      : {}),
    complete: input.success && output.success,
  };
  return value.responseId || value.inputTokens !== undefined || value.outputTokens !== undefined ? value : undefined;
}

/** Inspect the same bytes that are relayed; never retain prompts or response content. */
export class CloudUsageObserver {
  readonly decoder = new TextDecoder();
  buffer = "";
  last: string | undefined;
  constructor(
    readonly streaming: boolean,
    readonly observe: (value: CloudUsageObservation) => Promise<void>,
    readonly maxBytes: number,
  ) {}
  async parse(text: string) {
    if (!text || text === "[DONE]") return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const value = parseCloudUsage(raw);
    if (!value) return;
    const signature = JSON.stringify(value);
    if (this.last === signature) return;
    await this.observe(value);
    this.last = signature;
  }
  async push(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.streaming) {
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("data:")) await this.parse(line.slice(5).trim());
    }
    if (this.buffer.length > this.maxBytes) throw new Error("Cloud usage frame exceeds limit");
  }
  async finish() {
    this.buffer += this.decoder.decode();
    if (this.streaming) {
      if (this.buffer.startsWith("data:")) await this.parse(this.buffer.slice(5).trim());
    } else await this.parse(this.buffer);
  }
}

export interface CloudModelServiceOptions {
  billing?: CloudBilling;
  calls: CloudCallStore;
  fetchImpl?: typeof fetch;
  onError?: (event: string) => void;
}
/** One gateway request lifecycle, shared by execution routes and connectivity probes. */
export class CloudModelService {
  readonly active = new Map<AbortController, Promise<void>>();
  readonly fetchImpl: typeof fetch;
  readonly workerAbort = new AbortController();
  timer: ReturnType<typeof setInterval> | undefined;
  job: Promise<void> | undefined;
  stopped = false;
  constructor(
    readonly config: Extract<CloudModelConfig, { enabled: true }>,
    readonly options: CloudModelServiceOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  get gateway() {
    return this.config.gatewayId ?? "litellm";
  }
  async initialize(): Promise<void> {
    await this.options.calls.abandon();
    if (!this.options.billing) return;
    this.startRecovery();
    this.timer = setInterval(() => this.startRecovery(), 30_000);
    this.timer.unref();
  }
  startRecovery(): void {
    this.job ??= this.reconcile()
      .catch(() => this.report("cloud_usage_recovery_failed"))
      .finally(() => {
        this.job = undefined;
      });
  }
  report(event: string) {
    this.options.onError?.(event);
  }
  async begin(context: CloudCallContext, model: string): Promise<string> {
    if (!context) throw new Error("Cloud usage requires trusted attribution");
    const reference = { gateway: this.gateway, model };
    return this.options.billing
      ? this.options.billing.beginCall(context, reference)
      : this.options.calls.create(context, reference, null);
  }
  async finish(id: string | undefined, sent: boolean): Promise<void> {
    if (!id) return;
    if (this.options.billing) await this.options.billing.finishCall(id, sent ? "finished" : "not_sent");
    else await this.options.calls.finishUnbilled(id);
  }
  async request(
    raw: unknown,
    signal: AbortSignal,
    limits: CloudModelTransportLimits,
    context: CloudCallContext,
  ): Promise<Response> {
    if (this.stopped) throw new Error("Cloud models stopped");
    const body = CloudModelRequestSchema.parse(raw);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let release!: () => void;
    this.active.set(
      controller,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const timer = setTimeout(abort, limits.requestTimeoutMs);
    timer.unref();
    let id: string | undefined;
    let sent = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let processing: Promise<void> | undefined;
    let settled: Promise<void> | undefined;
    const observe = async (value: CloudUsageObservation) => {
      if (!id) return;
      await this.options.calls.observe(id, value);
    };
    const settle = () =>
      (settled ??= (async () => {
        try {
          await this.finish(id, sent);
        } catch {
          this.report("cloud_usage_settlement_failed");
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.active.delete(controller);
          release();
        }
      })());
    const cancel = async () => {
      try {
        await reader?.cancel();
      } catch {
        this.report("cloud_model_cancel_failed");
      }
    };
    try {
      if (controller.signal.aborted) throw new Error("Cloud call cancelled");
      id = await this.begin(context, body.model);
      if (controller.signal.aborted) throw new Error("Cloud call cancelled");
      sent = true;
      const response = await this.fetchImpl(`${this.config.upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.masterKey}`,
          "content-type": "application/json",
          "accept-encoding": "identity",
          accept: body.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify({ ...body, ...(body.stream ? { stream_options: { include_usage: true } } : {}) }),
      });
      const providerCallId = response.headers.get("x-litellm-call-id");
      if (providerCallId) await observe(CloudUsageObservationSchema.parse({ providerCallId, complete: false }));
      if (!response.body) {
        await settle();
        return response;
      }
      reader = response.body.getReader();
      const type = response.headers.get("content-type") ?? "";
      const observer = response.ok
        ? new CloudUsageObserver(type.startsWith("text/event-stream"), observe, limits.maxResponseBytes)
        : undefined;
      let total = 0;
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      const cancelAndSettle = async () => {
        await cancel();
        await processing;
        await settle();
      };
      const abortStream = () => {
        streamController.error(new Error("Cloud model request stopped"));
        void cancelAndSettle();
      };
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streamController = controller;
        },
        pull: (controller) =>
          (processing = (async () => {
            try {
              const chunk = await reader?.read();
              if (!chunk || chunk.done) {
                await observer?.finish();
                await settle();
                controllerSignalCleanup();
                controller.close();
                return;
              }
              total += chunk.value.byteLength;
              if (total > (response.ok ? limits.maxResponseBytes : CLOUD_MODEL_ERROR_BODY_MAX_BYTES))
                throw new Error("Cloud model response exceeds limit");
              await observer?.push(chunk.value);
              controller.enqueue(chunk.value);
            } catch {
              controllerSignalCleanup();
              await cancel();
              await settle();
              controller.error(new Error("Cloud model stream failed"));
            }
          })()),
        cancel: async () => {
          controllerSignalCleanup();
          controller.abort();
          await cancelAndSettle();
        },
      });
      const controllerSignalCleanup = () => controller.signal.removeEventListener("abort", abortStream);
      controller.signal.addEventListener("abort", abortStream, { once: true });
      if (controller.signal.aborted) abortStream();
      return new Response(stream, {
        status: response.status,
        headers: {
          "content-type": type,
          ...(response.headers.has("content-length")
            ? { "content-length": response.headers.get("content-length") ?? "" }
            : {}),
        },
      });
    } catch (error) {
      controller.abort();
      await cancel();
      await settle();
      throw error;
    }
  }
  async reconcile(): Promise<void> {
    const { calls, billing } = this.options;
    if (!billing || this.stopped) return;
    await calls.expire(new Date(Date.now() - this.config.requestTimeoutMs - 60_000));
    for (const call of await calls.pending()) {
      try {
        if (call.gateway !== this.gateway) throw new Error("Pending call belongs to another gateway");
        if (call.usage_complete) await billing.finishCall(call.id, "finished");
        if ((await calls.get(call.id)).state === "finalized") continue;
        {
          const usage = await this.lookup(call.provider_call_id, call.response_id, call.model);
          if (!usage) throw new Error("Final cloud usage unavailable");
          await calls.observe(call.id, usage);
        }
        await billing.finishCall(call.id, "finished");
      } catch {
        this.report("cloud_usage_recovery_pending");
      }
      await calls.defer(call.id);
    }
  }
  /** Spend logs are asynchronous. Empty, ambiguous, or incomplete results remain pending. */
  async lookup(
    callId: string | null,
    responseId: string | null,
    model: string,
  ): Promise<CloudUsageObservation | undefined> {
    for (const id of new Set([callId, responseId].filter((value): value is string => Boolean(value)))) {
      const base = this.config.upstreamBaseUrl.replace(/\/v1$/, "");
      const response = await this.fetchImpl(`${base}/spend/logs?request_id=${encodeURIComponent(id)}`, {
        headers: {
          authorization: `Bearer ${this.config.usageKey ?? this.config.masterKey}`,
          "accept-encoding": "identity",
        },
        redirect: "error",
        signal: AbortSignal.any([this.workerAbort.signal, AbortSignal.timeout(5_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Cloud usage lookup unavailable");
      }
      const text = await readBoundedResponseText(response, 256 * 1024);
      if (!text) continue;
      const rows = z
        .array(
          z.object({
            request_id: z.string(),
            litellm_call_id: z.string().nullish(),
            model_group: z.string().optional(),
            prompt_tokens: count,
            completion_tokens: count,
            prompt_tokens_details: z.object({ cached_tokens: count.optional() }).nullish(),
            status: z.string().optional(),
          }),
        )
        .safeParse(JSON.parse(text));
      if (!rows.success) continue;
      const matches = rows.data.filter(
        (row) =>
          (row.request_id === id || row.litellm_call_id === id) &&
          (row.status === "success" || (row.status === undefined && row.prompt_tokens + row.completion_tokens > 0)) &&
          (!row.model_group || row.model_group === model),
      );
      if (matches.length !== 1) continue;
      const row = matches[0];
      if (!row) continue;
      return parseCloudUsage({ id: responseId ?? row.request_id, usage: row });
    }
    return undefined;
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.workerAbort.abort();
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
    await this.job;
  }
}
