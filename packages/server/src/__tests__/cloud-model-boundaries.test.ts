import { describe, expect, it, vi } from "vitest";
import { CloudAgentRuntimeTester } from "../services/agents/cloud-agent-runtime-tester.js";
import { createStaticCloudModelCatalog, readBoundedResponseText } from "../services/sandboxes/cloud-model-catalog.js";

const completion = { choices: [{ message: { role: "assistant", content: "ok" } }] };
const config = {
  enabled: true as const,
  upstreamBaseUrl: "https://router.example.test/v1",
  masterKey: "fixture-only-key",
  tokenTtlSeconds: 60,
  requestTimeoutMs: 60_000,
  maxRequestBytes: 1024,
  maxResponseBytes: 1024,
  maxStreamsPerToken: 1,
};

describe("Cloud model admission and cancellation boundaries", () => {
  it("accepts a reasoning-only assistant response within the short probe budget", async () => {
    const tester = new CloudAgentRuntimeTester({
      config,
      catalog: createStaticCloudModelCatalog(["current"]),
      fetchImpl: async () =>
        Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "Checking the request.",
                tool_calls: null,
              },
              finish_reason: "length",
            },
          ],
        }),
    });
    await expect(tester.test({ computerId: "cloud", model: "current" })).resolves.toEqual({ status: "passed" });
    tester.close();
  });

  it("does not report success when cancellation precedes the upstream response", async () => {
    const caller = new AbortController();
    const tester = new CloudAgentRuntimeTester({
      config,
      catalog: createStaticCloudModelCatalog(["current"]),
      fetchImpl: async () => {
        caller.abort();
        return Response.json(completion);
      },
    });
    await expect(tester.test({ computerId: "cloud", model: "current", signal: caller.signal })).resolves.toEqual({
      status: "failed",
      code: "cancelled",
    });
    tester.close();
  });

  it("does not probe an explicit model missing from the Router list", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(completion));
    const tester = new CloudAgentRuntimeTester({
      config,
      catalog: createStaticCloudModelCatalog(["current"]),
      fetchImpl,
    });
    await expect(tester.test({ computerId: "cloud", model: "retired" })).resolves.toEqual({
      status: "failed",
      code: "provider_start_failed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    tester.close();
  });

  it.each([
    { role: "user", content: "ok" },
    { role: "assistant" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "ok", tool_calls: [{ id: "unexpected" }] },
  ])("rejects a malformed or tool completion: %j", async (message) => {
    const tester = new CloudAgentRuntimeTester({
      config,
      catalog: createStaticCloudModelCatalog(["current"]),
      fetchImpl: async () => Response.json({ choices: [{ message }] }),
    });
    await expect(tester.test({ computerId: "cloud", model: "current" })).resolves.toEqual({
      status: "failed",
      code: "provider_failed",
    });
    tester.close();
  });

  it.each(["caller", "shutdown", "timeout"] as const)(
    "settles %s while the shared catalog is still pending",
    async (kind) => {
      const catalog = createStaticCloudModelCatalog(["current"]);
      let resolveCatalog!: (snapshot: Awaited<ReturnType<typeof catalog.list>>) => void;
      const pendingCatalog = new Promise<Awaited<ReturnType<typeof catalog.list>>>((resolve) => {
        resolveCatalog = resolve;
      });
      const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(completion));
      const tester = new CloudAgentRuntimeTester({
        config,
        catalog: { ...catalog, list: () => pendingCatalog, defaultModel: () => new Promise(() => {}) },
        fetchImpl,
        timeoutMs: kind === "timeout" ? 20 : 5_000,
      });
      const caller = new AbortController();
      const result = tester.test({ computerId: "cloud", model: null, signal: caller.signal });
      if (kind === "caller") caller.abort();
      if (kind === "shutdown") tester.close();
      await expect(result).resolves.toEqual({ status: "failed", code: kind === "timeout" ? "timeout" : "cancelled" });
      expect(tester.pendingCount).toBe(0);
      resolveCatalog(await catalog.list());
      await Promise.resolve();
      expect(fetchImpl).not.toHaveBeenCalled();
      tester.close();
    },
  );

  it("cancels a response rejected by Content-Length before reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": "1024" } });
    expect(await readBoundedResponseText(response, 64)).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
