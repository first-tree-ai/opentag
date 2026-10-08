import { z } from "zod";
import { CloudCallResultSchema } from "../cloud-call-contracts.js";
import type { CloudModelConfig } from "../cloud-model-config.js";
import type { CloudModelRequestSchema } from "../cloud-model-request.js";
import { readBoundedResponseText } from "./sandboxes/cloud-model-catalog.js";

const identity = { requestId: z.uuid(), idempotencyKey: z.string().min(1).max(200), model: z.string().min(1).max(128) };
const RouterUsageSchema = z.discriminatedUnion("status", [
  CloudCallResultSchema.options[0].extend(identity),
  CloudCallResultSchema.options[1].extend(identity),
  z.object({ ...identity, status: z.literal("pending") }).strict(),
]);
/** Tenant-scoped router transport. Model content is forwarded without metering it here. */
export class RouterClient {
  constructor(
    readonly config: Extract<CloudModelConfig, { enabled: true }>,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}
  complete(body: z.infer<typeof CloudModelRequestSchema>, key: string, signal: AbortSignal) {
    return this.fetchImpl(`${this.config.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${this.config.masterKey}`,
        "content-type": "application/json",
        "accept-encoding": "identity",
        accept: body.stream ? "text/event-stream" : "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });
  }
  async usage(key: string, signal: AbortSignal) {
    const response = await this.fetchImpl(
      `${this.config.upstreamBaseUrl}/requests/usage?idempotency_key=${encodeURIComponent(key)}`,
      {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        headers: { authorization: `Bearer ${this.config.masterKey}`, "accept-encoding": "identity" },
      },
    );
    const text = await readBoundedResponseText(response, 16 * 1024);
    if (
      response.status === 404 &&
      text &&
      z.object({ error: z.object({ code: z.literal("request_not_found") }) }).safeParse(JSON.parse(text)).success
    )
      return undefined;
    if (!response.ok || !text) throw new Error("Router usage unavailable");
    const result = RouterUsageSchema.parse(JSON.parse(text));
    if (result.idempotencyKey !== key) throw new Error("Router usage correlation mismatch");
    return result;
  }
}
