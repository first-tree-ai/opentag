import { ApiError } from "./transport.js";

export function createSystemApi(fetchImpl: typeof fetch) {
  return {
    async health(path: "/healthz" | "/readyz"): Promise<{ latencyMs: number; observedAt: string; status: string }> {
      const startedAt = performance.now();
      const response = await fetchImpl(path, { credentials: "same-origin" });
      const body = (await response.json().catch(() => undefined)) as { status?: unknown } | undefined;
      if (!response.ok || typeof body?.status !== "string") throw new ApiError(response.status, "Health check failed");
      return {
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        observedAt: new Date().toISOString(),
        status: body.status,
      };
    },
  };
}
