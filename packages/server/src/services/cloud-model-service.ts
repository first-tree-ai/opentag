import type { CloudBilling } from "../cloud-billing.js";
import type { CloudCallContext, CloudCallResult } from "../cloud-call-contracts.js";
import type { CloudModelConfig } from "../cloud-model-config.js";
import {
  CLOUD_MODEL_ERROR_BODY_MAX_BYTES,
  CloudModelRequestSchema,
  type CloudModelTransportLimits,
} from "../cloud-model-request.js";
import { CLOUD_USAGE_FAST_RETRY_SECONDS, type CloudCall, type CloudCallStore } from "./cloud-call-store.js";
import { RouterClient } from "./router-client.js";

export interface CloudModelServiceOptions {
  billing?: CloudBilling;
  calls: CloudCallStore;
  fetchImpl?: typeof fetch;
  onError?: (event: string, details?: { callId: string; accountId: string; pendingSeconds: number }) => void;
}
/** One gateway request lifecycle, shared by execution routes and connectivity probes. */
export class CloudModelService {
  readonly active = new Map<AbortController, Promise<void>>();
  readonly router: RouterClient;
  readonly workerAbort = new AbortController();
  timer: ReturnType<typeof setInterval> | undefined;
  job: Promise<void> | undefined;
  stopped = false;
  constructor(
    readonly config: Extract<CloudModelConfig, { enabled: true }>,
    readonly options: CloudModelServiceOptions,
  ) {
    this.router = new RouterClient(config, options.fetchImpl);
  }
  get gateway() {
    return this.config.gatewayId ?? "llm-router";
  }
  async initialize(): Promise<void> {
    await this.options.calls.abandon();
    this.startRecovery();
    this.timer = setInterval(() => this.startRecovery(), 5_000);
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
  async applyResult(id: string, result: CloudCallResult, billed: boolean): Promise<void> {
    if (billed) {
      if (!this.options.billing) throw new Error("Priced call requires billing");
      await this.options.billing.finishCall(id, result);
    } else await this.options.calls.finalize(id, result, { resolution: "unbilled", pricedMicros: 0, debitedMicros: 0 });
  }
  async finish(id: string | undefined, model: string, sent: boolean): Promise<void> {
    if (!id) return;
    try {
      const result = sent ? await this.router.usage(id, this.workerAbort.signal) : { status: "no_charge" as const };
      if (!result || result.status === "pending") {
        await this.options.calls.markPending(id);
        return;
      }
      if ("model" in result && result.model !== model) throw new Error("Router usage model mismatch");
      await this.applyResult(
        id,
        result.status === "complete" ? { status: "complete", usage: result.usage } : { status: "no_charge" },
        Boolean(this.options.billing),
      );
    } catch {
      await this.options.calls.markPending(id);
      this.report("cloud_usage_pending");
    }
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
    const settle = () =>
      (settled ??= (async () => {
        try {
          await this.finish(id, body.model, sent);
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
      const response = await this.router.complete(body, id, controller.signal);
      if (!response.ok && response.headers.get("x-router-dispatch") === "not_dispatched") sent = false;
      if (!response.body) {
        await settle();
        return response;
      }
      reader = response.body.getReader();
      const type = response.headers.get("content-type") ?? "";
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
                await settle();
                controllerSignalCleanup();
                controller.close();
                return;
              }
              total += chunk.value.byteLength;
              if (total > (response.ok ? limits.maxResponseBytes : CLOUD_MODEL_ERROR_BODY_MAX_BYTES))
                throw new Error("Cloud model response exceeds limit");
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
    const { calls } = this.options;
    if (this.stopped) return;
    await calls.expire(new Date(Date.now() - this.config.requestTimeoutMs - 60_000));
    for (const call of await calls.pending()) {
      await this.reconcileCall(call);
    }
  }
  private async reconcileCall(call: CloudCall): Promise<void> {
    try {
      if (call.gateway !== this.gateway) throw new Error("Pending call belongs to another gateway");
      const result = await this.router.usage(call.id, this.workerAbort.signal);
      if (result && result.status !== "pending") {
        if (result.model !== call.model) throw new Error("Router usage model mismatch");
        await this.applyResult(
          call.id,
          result.status === "complete" ? { status: "complete", usage: result.usage } : { status: "no_charge" },
          call.rates !== null,
        );
        return;
      }
    } catch {
      this.report("cloud_usage_recovery_pending");
    }
    const pendingSeconds = Math.floor((Date.now() - (call.finished_at?.getTime() ?? Date.now())) / 1000);
    if (call.reconcile_failures === 0 && pendingSeconds >= CLOUD_USAGE_FAST_RETRY_SECONDS) {
      this.options.onError?.("cloud_usage_unresolved", { callId: call.id, accountId: call.account, pendingSeconds });
    }
    await this.options.calls.defer(call.id);
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
