import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudModelConfig } from "../cloud-model-config.js";
import {
  CLOUD_AGENT_RUNTIME_TEST_TIMEOUT_MS,
  CloudAgentRuntimeTester,
} from "../services/agents/cloud-agent-runtime-tester.js";
import { createStaticCloudModelCatalog } from "../services/sandboxes/cloud-model-catalog.js";
import {
  type CloudModelUpstream,
  FIXTURE_ERROR_BODY_MARKER,
  FIXTURE_MASTER_KEY,
  startCloudModelUpstream,
} from "./fixtures/cloud-model-upstream.js";

const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const VALID_COMPLETION = {
  id: "chatcmpl-fixture",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
};

function testConfig(upstreamBaseUrl: string): Extract<CloudModelConfig, { enabled: true }> {
  return {
    enabled: true,
    upstreamBaseUrl,
    masterKey: FIXTURE_MASTER_KEY,
    tokenTtlSeconds: 60,
    requestTimeoutMs: 600_000,
    maxRequestBytes: 2 * 1024 * 1024,
    maxResponseBytes: 16 * 1024 * 1024,
    maxStreamsPerToken: 4,
  };
}

const upstreams: CloudModelUpstream[] = [];
const testers: CloudAgentRuntimeTester[] = [];
afterEach(async () => {
  for (const tester of testers.splice(0)) tester.close();
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

async function makeTester(
  handler: Parameters<typeof startCloudModelUpstream>[0],
  options: { maxPending?: number; models?: string[]; timeoutMs?: number } = {},
) {
  const upstream = await startCloudModelUpstream(handler);
  upstreams.push(upstream);
  const tester = new CloudAgentRuntimeTester({
    config: testConfig(upstream.baseUrl),
    catalog: createStaticCloudModelCatalog(options.models ?? ["router-model-a", "router-model-b"]),
    ...(options.maxPending !== undefined ? { maxPending: options.maxPending } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  testers.push(tester);
  return { tester, upstream };
}

describe("CloudAgentRuntimeTester", () => {
  it("probes the fixed chat-completions path with the saved model and the master key", async () => {
    const { tester, upstream } = await makeTester({ kind: "json", payload: VALID_COMPLETION });
    await expect(tester.test({ computerId: COMPUTER_ID, model: "router-model-b" })).resolves.toEqual({
      status: "passed",
    });
    expect(upstream.stats.methods).toEqual(["POST"]);
    expect(upstream.stats.paths).toEqual(["/chat/completions"]);
    expect(upstream.stats.authorizations).toEqual([`Bearer ${FIXTURE_MASTER_KEY}`]);
    // The fixed bounded probe: saved model, fixed prompt, 16-token budget, no stream, no tools.
    expect(upstream.stats.lastRequestBody).toEqual({
      model: "router-model-b",
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      max_tokens: 16,
      stream: false,
    });
    expect(upstream.stats.lastRequestBody).not.toHaveProperty("tools");
  });

  it("resolves an unsaved model to the current Router default", async () => {
    const { tester, upstream } = await makeTester({ kind: "json", payload: VALID_COMPLETION });
    await expect(tester.test({ computerId: COMPUTER_ID, model: null })).resolves.toEqual({ status: "passed" });
    expect(upstream.stats.lastRequestBody).toMatchObject({ model: "router-model-a" });
  });

  it("fails provider_start_failed when no Router default is available", async () => {
    const { tester, upstream } = await makeTester({ kind: "json", payload: VALID_COMPLETION }, { models: [] });
    await expect(tester.test({ computerId: COMPUTER_ID, model: null })).resolves.toEqual({
      status: "failed",
      code: "provider_start_failed",
    });
    expect(upstream.stats.hits).toBe(0);
  });

  it("requires a valid completion shape, not any 200, and never relays upstream material", async () => {
    for (const payload of [{ choices: [] }, { object: "list", data: [] }, { choices: [{ index: 0 }] }, "not-json"]) {
      const { tester } = await makeTester({ kind: "json", payload });
      await expect(tester.test({ computerId: COMPUTER_ID, model: "router-model-a" })).resolves.toEqual({
        status: "failed",
        code: "provider_failed",
      });
    }
    const { tester, upstream } = await makeTester({ kind: "error", status: 400 });
    const result = await tester.test({ computerId: COMPUTER_ID, model: "router-model-a" });
    expect(result).toEqual({ status: "failed", code: "provider_failed" });
    // The fixture echoes auth material in its error body; nothing of it reached the result.
    expect(upstream.stats.sawFixtureMasterKey).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_ERROR_BODY_MARKER);
    expect(JSON.stringify(result)).not.toContain(FIXTURE_MASTER_KEY);
  });

  it("bounds the response and the wait, and reports a stalled body as timeout", async () => {
    const { tester: overflowing } = await makeTester({
      kind: "overflow",
      totalBytes: 256 * 1024,
      chunkBytes: 8 * 1024,
    });
    await expect(overflowing.test({ computerId: COMPUTER_ID, model: "router-model-a" })).resolves.toEqual({
      status: "failed",
      code: "provider_failed",
    });

    const { tester: stalled } = await makeTester({ kind: "stall" }, { timeoutMs: 60 });
    await expect(stalled.test({ computerId: COMPUTER_ID, model: "router-model-a" })).resolves.toEqual({
      status: "failed",
      code: "timeout",
    });
  });

  it("enforces one pending probe per Cloud Computer and a bounded total", async () => {
    const { tester } = await makeTester({ kind: "stall" }, { timeoutMs: 5_000, maxPending: 2 });
    const first = tester.test({ computerId: COMPUTER_ID, model: "router-model-a" });
    await vi.waitFor(() => expect(tester.pendingCount).toBe(1));
    await expect(tester.test({ computerId: COMPUTER_ID, model: "router-model-a" })).resolves.toEqual({
      status: "failed",
      code: "busy",
    });
    const secondComputer = "11111111-1111-4111-8111-111111111111";
    const second = tester.test({ computerId: secondComputer, model: "router-model-a" });
    await vi.waitFor(() => expect(tester.pendingCount).toBe(2));
    await expect(
      tester.test({ computerId: "22222222-2222-4222-8222-222222222222", model: "router-model-a" }),
    ).resolves.toEqual({ status: "failed", code: "busy" });
    tester.close();
    await expect(first).resolves.toEqual({ status: "failed", code: "cancelled" });
    await expect(second).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(tester.pendingCount).toBe(0);
  });

  it("aborts the probe when the caller disconnects", async () => {
    const { tester, upstream } = await makeTester({ kind: "stall" }, { timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = tester.test({ computerId: COMPUTER_ID, model: "router-model-a", signal: controller.signal });
    // Wait for the probe to actually reach the Router before disconnecting: pending registration
    // is synchronous and precedes the fetch dispatch.
    await vi.waitFor(() => expect(upstream.stats.hits).toBe(1));
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(tester.pendingCount).toBe(0);
    await vi.waitFor(() => expect(upstream.stats.prematureClose).toBe(true), { interval: 10, timeout: 2_000 });
  });

  it("resolves an already-aborted caller without touching the upstream", async () => {
    const { tester, upstream } = await makeTester({ kind: "json", payload: VALID_COMPLETION });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tester.test({ computerId: COMPUTER_ID, model: "router-model-a", signal: controller.signal }),
    ).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(upstream.stats.hits).toBe(0);
  });

  it("exposes a bounded default timeout and pending limit", () => {
    expect(CLOUD_AGENT_RUNTIME_TEST_TIMEOUT_MS).toBe(45_000);
    const { tester } = makeTesterSync();
    expect(tester.pendingCount).toBe(0);
  });

  function makeTesterSync() {
    const tester = new CloudAgentRuntimeTester({
      config: testConfig("https://router.example.com/v1"),
      catalog: createStaticCloudModelCatalog(["router-model-a"]),
    });
    testers.push(tester);
    return { tester };
  }
});
