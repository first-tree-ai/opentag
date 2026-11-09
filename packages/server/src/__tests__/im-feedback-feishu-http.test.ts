import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import { ImFeedbackMessenger } from "../services/im/im-feedback-messenger.js";
import type { FeedbackTarget } from "../services/im/im-feedback-store.js";
import type { ImBindingService } from "../services/im-bindings/im-binding-service.js";

const http = vi.hoisted(() => ({ request: vi.fn(), post: vi.fn() }));
vi.mock("@larksuiteoapi/node-sdk", async (original) => ({
  ...(await original<typeof import("@larksuiteoapi/node-sdk")>()),
  defaultHttpInstance: http,
}));

interface Request {
  url: string;
  method: string;
  params?: { reaction_type?: string; page_token?: string };
  data?: { reaction_type?: { emoji_type: string } };
  headers?: { Authorization?: string };
  signal: AbortSignal;
}
interface Reaction {
  reaction_id: string;
  operator: { operator_type: string; operator_id: string };
  reaction_type: { emoji_type: string };
}

function harness(rtt = 480) {
  const appId = randomUUID();
  const material = { generation: 2, appId, appSecret: "test-secret", teamBrand: "feishu" };
  const binding = vi.fn(async () => material as typeof material | undefined);
  const policy = new ExternalCallPolicy({ allowedHosts: [], circuitFailureThreshold: 100 });
  const messenger = new ImFeedbackMessenger(
    { getFeishuConnectionMaterial: binding } as unknown as ImBindingService,
    policy,
    "https://app.example.test",
    {
      slackCooldownRemaining: async () => 0,
      deferSlackInstallation: async () => true,
      messageLanguage: async () => "en" as const,
    },
  );
  const target = {
    bindingId: randomUUID(),
    bindingGeneration: 2,
    provider: "feishu",
    inputExternalId: "input",
  } as FeedbackTarget;
  const requests: Request[] = [];
  const reactions: Reaction[] = [];
  const owned = (emoji: string, id: string = randomUUID()): Reaction => ({
    reaction_id: id,
    operator: { operator_type: "app", operator_id: appId },
    reaction_type: { emoji_type: emoji },
  });
  const response = (request: Request) => {
    if (request.url.includes("/auth/")) return { code: 0, tenant_access_token: "test-token", expire: 7200 };
    if (request.method === "GET") {
      return {
        code: 0,
        data: {
          items: reactions.filter(
            (item) => !request.params?.reaction_type || item.reaction_type.emoji_type === request.params.reaction_type,
          ),
          has_more: false,
        },
      };
    }
    if (request.method === "POST") reactions.push(owned(request.data?.reaction_type?.emoji_type ?? ""));
    if (request.method === "DELETE") {
      const index = reactions.findIndex((item) => request.url.endsWith(`/${item.reaction_id}`));
      if (index >= 0) reactions.splice(index, 1);
    }
    return { code: 0 };
  };
  const send = async (request: Request) => {
    requests.push(request);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(request.signal.reason);
      };
      const timer = setTimeout(() => {
        request.signal.removeEventListener("abort", onAbort);
        resolve();
      }, rtt);
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    });
    return response(request);
  };
  http.request.mockImplementation(send);
  http.post.mockImplementation((url, data, options) => send({ url, data, method: "POST", ...options }));
  return { messenger, target, material, binding, requests, reactions, owned, policy, response };
}

async function measured(task: () => Promise<void>) {
  const start = Date.now();
  const result = task().then(() => Date.now() - start);
  await vi.runAllTimersAsync();
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
  http.request.mockReset();
  http.post.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("Feishu feedback with the real SDK and controlled HTTP", () => {
  it("measures cold, warm, no-op and expired-token request counts at 480 ms RTT", async () => {
    const h = harness();
    expect(await measured(() => h.messenger.reaction(h.target, "working"))).toBe(1440);
    expect(h.requests).toHaveLength(3);
    expect(http.post).toHaveBeenCalledTimes(1);
    h.requests.length = 0;
    expect(await measured(() => h.messenger.reaction(h.target, "working"))).toBe(480);
    expect(h.requests).toHaveLength(1);
    expect(http.post).toHaveBeenCalledTimes(1);
    h.requests.length = 0;
    expect(await measured(() => h.messenger.reaction(h.target, "warning"))).toBe(960);
    expect(h.requests).toHaveLength(3);
    expect(h.reactions.map((item) => item.reaction_type.emoji_type)).toEqual(["CrossMark"]);
    expect(http.post).toHaveBeenCalledTimes(1);
    h.requests.length = 0;
    vi.setSystemTime(Date.now() + 7_020_000);
    expect(await measured(() => h.messenger.reaction(h.target, "none"))).toBe(1440);
    expect(h.requests).toHaveLength(3);
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(h.reactions).toEqual([]);
  });

  it("characterizes the SDK's shared App cache and uncoalesced concurrent cold requests", async () => {
    const h = harness();
    await measured(() =>
      Promise.all([
        h.messenger.reaction(h.target, "none"),
        h.messenger.reaction({ ...h.target, inputExternalId: "other-input" }, "none"),
      ]).then(() => undefined),
    );
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(h.requests).toHaveLength(4);
    await measured(() => h.messenger.reaction(h.target, "none"));
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it("rechecks material on a cache hit and rejects removed or stale bindings without HTTP", async () => {
    const h = harness();
    await measured(() => h.messenger.reaction(h.target, "none"));
    h.requests.length = 0;
    h.material.generation = 3;
    await expect(h.messenger.reaction(h.target, "working")).rejects.toMatchObject({
      code: "IM_FEEDBACK_BINDING_STALE",
    });
    h.binding.mockResolvedValueOnce(undefined);
    await expect(h.messenger.reaction(h.target, "working")).rejects.toMatchObject({
      code: "IM_FEEDBACK_BINDING_STALE",
    });
    expect(h.requests).toHaveLength(0);
    await measured(() => h.messenger.reaction({ ...h.target, bindingGeneration: 3 }, "working"));
    expect(h.binding).toHaveBeenCalledTimes(4);
    expect(h.requests.every((request) => request.headers?.Authorization === "Bearer test-token")).toBe(true);
  });

  it("uses the newly authorized App and brand for a replacement generation", async () => {
    const h = harness();
    await measured(() => h.messenger.reaction(h.target, "none"));
    h.requests.length = 0;
    h.material.generation = 3;
    h.material.appId = randomUUID();
    h.material.teamBrand = "lark";
    await measured(() => h.messenger.reaction({ ...h.target, bindingGeneration: 3 }, "none"));
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(http.post.mock.calls.at(-1)?.[1]).toMatchObject({ app_id: h.material.appId });
    expect(h.requests.every((request) => request.url.startsWith("https://open.larksuite.com/"))).toBe(true);
  });

  it.each(["transport", "rejection", "missing-token"])("does not cache or retry a %s token failure", async (mode) => {
    const h = harness();
    http.post.mockImplementationOnce(async () => {
      if (mode === "transport") throw new Error("token transport failed");
      return { code: mode === "rejection" ? 10015 : 0 };
    });
    await expect(h.messenger.reaction(h.target, "working")).rejects.toThrow();
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.request).not.toHaveBeenCalled();
    await measured(() => h.messenger.reaction(h.target, "working"));
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it("cancels a slow token exchange at the existing deadline without starting reactions", async () => {
    const h = harness(20_000);
    const result = expect(h.messenger.reaction(h.target, "working")).rejects.toMatchObject({
      code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await result;
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.signal.aborted).toBe(true);
    expect(http.request).not.toHaveBeenCalled();
  });

  it("keeps concurrent operation signals independent and never retains a timed-out Client", async () => {
    const h = harness();
    await measured(() => h.messenger.reaction(h.target, "none"));
    h.requests.length = 0;
    const slow = h.messenger.reaction(h.target, "working");
    const rejected = expect(slow).rejects.toMatchObject({ code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED" });
    http.request.mockImplementation(async (request: Request) => {
      h.requests.push(request);
      if (request.url.includes("/input/")) {
        await new Promise<void>((_, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
        );
      }
      return h.response(request);
    });
    await vi.advanceTimersByTimeAsync(0);
    await h.messenger.reaction({ ...h.target, inputExternalId: "fast" }, "none");
    const slowSignal = h.requests.find((request) => request.url.includes("/input/"))?.signal;
    const fastSignal = h.requests.find((request) => request.url.includes("/fast/"))?.signal;
    expect(slowSignal).not.toBe(fastSignal);
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(slowSignal?.aborted).toBe(true);
    expect(fastSignal?.aborted).toBe(false);
    await h.messenger.reaction({ ...h.target, inputExternalId: "fresh" }, "none");
    expect(h.requests.at(-1)?.signal.aborted).toBe(false);
  });

  it("reads all pages once, preserves foreign reactions and deduplicates owned IDs", async () => {
    const h = harness();
    const mine = h.owned("OnIt", "mine");
    const foreign = { ...h.owned("OnIt", "foreign"), operator: { operator_type: "app", operator_id: "other-app" } };
    const human = {
      ...h.owned("CrossMark", "human"),
      operator: { operator_type: "user", operator_id: h.material.appId },
    };
    h.reactions.push(
      mine,
      h.owned("OnIt", "duplicate"),
      h.owned("CrossMark", "existing-warning"),
      foreign,
      human,
      h.owned("SMILE", "unrelated"),
    );
    http.request.mockImplementation(async (request: Request) => {
      h.requests.push(request);
      if (request.method !== "GET") return h.response(request);
      expect(request.params).not.toHaveProperty("reaction_type");
      return request.params?.page_token
        ? { code: 0, data: { items: [...h.reactions, mine], has_more: false } }
        : { code: 0, data: { items: [foreign, human], has_more: true, page_token: "second" } };
    });
    await measured(() => h.messenger.reaction(h.target, "warning"));
    expect(h.requests.filter((request) => request.method === "GET")).toHaveLength(2);
    expect(
      h.requests.filter((request) => request.method === "DELETE").map((request) => request.url.split("/").at(-1)),
    ).toEqual(["mine", "duplicate"]);
    expect(h.reactions.map((item) => item.reaction_id)).toEqual(["existing-warning", "foreign", "human", "unrelated"]);
    expect(h.requests.filter((request) => request.method === "POST" && !request.url.includes("/auth/"))).toEqual([]);
  });

  it.each(["working", "warning", "none"] as const)("converges to %s without repeating a write", async (desired) => {
    const h = harness();
    h.reactions.push(h.owned("OnIt"), h.owned("CrossMark"));
    await measured(() => h.messenger.reaction(h.target, desired));
    expect(h.reactions.map((item) => item.reaction_type.emoji_type)).toEqual(
      desired === "none" ? [] : [desired === "working" ? "OnIt" : "CrossMark"],
    );
    h.requests.length = 0;
    await measured(() => h.messenger.reaction(h.target, desired));
    expect(h.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it.each(["failure", "missing-cursor", "looping-cursor", "page-limit"])(
    "refuses %s pagination before either writer starts",
    async (mode) => {
      const h = harness();
      http.request.mockImplementation(async (request: Request) => {
        h.requests.push(request);
        const page = h.requests.length;
        return mode === "failure" && page > 1
          ? { code: 999, data: undefined }
          : {
              code: 0,
              data: {
                items: [h.owned("OnIt")],
                has_more: true,
                page_token: mode === "missing-cursor" ? "" : mode === "page-limit" ? String(page) : "same",
              },
            };
      });
      const result = expect(h.messenger.reaction(h.target, "warning")).rejects.toThrow(
        mode === "failure" ? "REACTION_READ_FAILED" : "PAGINATION_INVALID",
      );
      await vi.runAllTimersAsync();
      await result;
      expect(h.requests.filter((request) => request.method !== "GET" && !request.url.includes("/auth/"))).toEqual([]);
      expect(h.requests.length).toBeLessThanOrEqual(102);
    },
  );

  it("joins both writers after a failure and reconciles an unknown create by reading first", async () => {
    const h = harness();
    h.reactions.push(h.owned("OnIt", "working"));
    await measured(() => h.messenger.reaction(h.target, "working"));
    h.requests.length = 0;
    let releaseDelete: (() => void) | undefined;
    let active = 0;
    let peak = 0;
    http.request.mockImplementation(async (request: Request) => {
      h.requests.push(request);
      if (request.method === "GET") return h.response(request);
      active++;
      peak = Math.max(peak, active);
      try {
        if (request.method === "DELETE")
          await new Promise<void>((resolve) => {
            releaseDelete = resolve;
          });
        h.response(request);
        if (request.method === "POST") throw new Error("lost acknowledgement");
        return { code: 0 };
      } finally {
        active--;
      }
    });
    let settled = false;
    const operation = h.messenger.reaction(h.target, "warning");
    const result = expect(operation).rejects.toThrow("lost acknowledgement");
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(2);
    expect(settled).toBe(false);
    releaseDelete?.();
    await result;
    expect(active).toBe(0);
    expect(h.reactions.map((item) => item.reaction_type.emoji_type)).toEqual(["CrossMark"]);
    h.requests.length = 0;
    await h.messenger.reaction(h.target, "warning");
    expect(h.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it.each(["POST", "DELETE"])(
    "propagates a provider %s rejection and leaves the next projection repairable",
    async (method) => {
      const h = harness();
      if (method === "DELETE") h.reactions.push(h.owned("OnIt"));
      http.request.mockImplementation(async (request: Request) => {
        h.requests.push(request);
        return request.method === method ? { code: 999 } : h.response(request);
      });
      const result = expect(h.messenger.reaction(h.target, "warning")).rejects.toThrow("REACTION_WRITE_FAILED");
      await vi.runAllTimersAsync();
      await result;
      expect(h.requests.filter((request) => request.method === method && !request.url.includes("/auth/"))).toHaveLength(
        1,
      );
      http.request.mockImplementation(async (request: Request) => {
        h.requests.push(request);
        return h.response(request);
      });
      h.requests.length = 0;
      await h.messenger.reaction(h.target, "warning");
      expect(h.reactions.map((item) => item.reaction_type.emoji_type)).toEqual(["CrossMark"]);
      expect(h.requests.filter((request) => request.method === "POST")).toHaveLength(method === "POST" ? 1 : 0);
    },
  );

  it.each(["page", "delete"] as const)("starts no further request after a timed-out %s resolves late", async (kind) => {
    const h = harness();
    await measured(() => h.messenger.reaction(h.target, "none"));
    if (kind === "delete") h.reactions.push(h.owned("OnIt"), h.owned("OnIt"));
    h.requests.length = 0;
    let releaseRequest: (() => void) | undefined;
    http.request.mockImplementation(async (request: Request) => {
      h.requests.push(request);
      if (request.method === (kind === "page" ? "GET" : "DELETE") && !releaseRequest) {
        await new Promise<void>((resolve) => {
          releaseRequest = resolve;
        });
        if (kind === "page") return { code: 0, data: { items: [], has_more: true, page_token: "next" } };
      }
      return h.response(request);
    });
    const result = expect(h.messenger.reaction(h.target, "none")).rejects.toMatchObject({
      code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await result;
    expect(releaseRequest).toBeTypeOf("function");
    expect(h.requests).toHaveLength(kind === "page" ? 1 : 2);
    expect(h.requests.at(-1)?.signal.aborted).toBe(true);
    const calls = http.request.mock.calls.length;
    releaseRequest?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.request).toHaveBeenCalledTimes(calls);
    expect(h.reactions).toHaveLength(kind === "page" ? 0 : 1);
  });

  it("starts no mutation after a timed-out read resolves late", async () => {
    const h = harness();
    await measured(() => h.messenger.reaction(h.target, "none"));
    let releaseRead: (() => void) | undefined;
    http.request.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return { code: 0, data: { items: [h.owned("OnIt")], has_more: false } };
    });
    const result = expect(h.messenger.reaction(h.target, "warning")).rejects.toMatchObject({
      code: "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await result;
    const calls = http.request.mock.calls.length;
    releaseRead?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(http.request).toHaveBeenCalledTimes(calls);
  });
});
