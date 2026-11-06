import { describe, expect, it, vi } from "vitest";
import type { CloudRunAdminConfig } from "../services/cloud-run/cloud-run-admin.js";
import { RunnerImagePrewarmer } from "../services/cloud-run/runner-image-prewarmer.js";
import { createMetadataServerTokenProvider } from "../services/cloud-run/token-provider.js";

const config: CloudRunAdminConfig = {
  image: `us-west1-docker.pkg.dev/opentag-test/runners/runner@sha256:${"a".repeat(64)}`,
  project: "opentag-test",
  region: "us-west1",
  serviceAccount: "runner@opentag-test.iam.gserviceaccount.com",
  vpc: { network: "sandbox-net", subnetwork: "sandbox-subnet", executionTag: "sandbox-runner" },
  apiTimeoutMs: 30_000,
};
type View = {
  metadata: Record<string, unknown>;
  spec: { containers: Record<string, unknown>[]; serviceAccountName: string };
  status?: unknown;
};

function harness(options: { readyAt?: number; preparationTimeoutMs?: number; cleanupTimeoutMs?: number } = {}) {
  let clock = 0;
  let current: View | undefined;
  let sequence = 0;
  let deleting = false;
  const hooks: {
    before?: (method: string, v2: boolean) => Response | undefined;
    after?: (method: string) => void;
    sleep?: (signal?: AbortSignal) => void;
    delayDelete?: boolean;
  } = {};
  const tokenProvider = vi.fn(async () => "unit-token");
  function read(v2: boolean): Response {
    if (!current) return new Response(null, { status: 404 });
    if (v2)
      return Response.json({
        ...current.metadata,
        name: prewarmer.resourceName,
        containers: current.spec.containers,
        serviceAccount: current.spec.serviceAccountName,
        etag: "probe-etag",
        ...(deleting ? { deleteTime: "2026-10-09T00:00:00Z" } : {}),
      });
    return Response.json({
      ...current,
      status: {
        conditions: [
          { type: "ContainerReady", status: "True", lastTransitionTime: "imported" },
          {
            type: "Running",
            status: clock >= (options.readyAt ?? 0) ? "True" : "False",
            lastTransitionTime: "running",
          },
        ],
      },
    });
  }
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const method = init?.method ?? "GET";
    const v2 = String(input).includes("/v2/");
    const override = hooks.before?.(method, v2);
    if (override) return override;
    let response: Response;
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as View;
      current = { ...body, metadata: { ...body.metadata, uid: `probe-${++sequence}` } };
      deleting = false;
      response = Response.json(current);
    } else if (method === "DELETE" && current) {
      deleting = true;
      current.metadata.deletionTimestamp = "2026-10-09T00:00:00Z";
      if (!hooks.delayDelete) current = undefined;
      response = Response.json({ name: "operations/delete-probe" });
    } else {
      response = read(v2);
    }
    hooks.after?.(method);
    return response;
  });
  const prewarmer = new RunnerImagePrewarmer("staging", config, {
    tokenProvider,
    fetchImpl,
    now: () => clock,
    sleep: async (ms, signal) => {
      clock += ms;
      hooks.sleep?.(signal);
      signal?.throwIfAborted();
    },
    ...options,
  });
  return {
    prewarmer,
    fetchImpl,
    tokenProvider,
    hooks,
    seed(image = config.image) {
      current = structuredClone(prewarmer.body()) as View;
      current.metadata.uid = `probe-${++sequence}`;
      (current.spec.containers[0] as Record<string, unknown>).image = image;
      return current;
    },
    clear() {
      current = undefined;
    },
    now: () => clock,
    deleted: () => !current,
    calls: (method: string) => fetchImpl.mock.calls.filter(([, init]) => init?.method === method),
  };
}

describe("Runner image preparation", () => {
  it("imports the exact image with isolated networking and no business credentials, then confirms deletion", async () => {
    const h = harness({ readyAt: 4_000 });
    const result = await h.prewarmer.prepare();
    const body = JSON.parse(String(h.calls("POST")[0]?.[1]?.body));
    expect(body.metadata.annotations).toMatchObject({
      "run.googleapis.com/ingress": "internal",
      "run.googleapis.com/default-url-disabled": "true",
      "run.googleapis.com/invoker-iam-disabled": "false",
      "run.googleapis.com/vpc-access-egress": "all-traffic",
    });
    expect(JSON.parse(body.metadata.annotations["run.googleapis.com/network-interfaces"])).toEqual([
      { network: config.vpc.network, subnetwork: config.vpc.subnetwork, tags: [config.vpc.executionTag] },
    ]);
    expect(body.spec).toMatchObject({ serviceAccountName: config.serviceAccount, restartPolicy: "Never" });
    expect(body.spec.containers[0]).toMatchObject({
      image: config.image,
      command: ["/usr/local/bin/runner-entrypoint"],
    });
    expect(body.spec.containers[0].env).toBeUndefined();
    expect(body.spec.containers[0].args.join(" ")).toContain("setTimeout(()=>process.exit(0),120000)");
    expect(result).toMatchObject({
      preparationMs: 4_000,
      importedAt: "imported",
      runningAt: "running",
      cacheRetentionGuaranteed: false,
    });
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.calls("DELETE")[0]?.[0]).toContain("?etag=probe-etag");
    expect(h.deleted()).toBe(true);
    expect(h.tokenProvider).toHaveBeenCalledTimes(h.fetchImpl.mock.calls.length);
  });

  it("does not accept ContainerReady alone and cleans up after a readiness timeout", async () => {
    const h = harness({ readyAt: 20_000, preparationTimeoutMs: 3_000 });
    await expect(h.prewarmer.prepare()).rejects.toThrow("readiness deadline exceeded");
    expect(h.now()).toBe(3_000);
    expect(h.deleted()).toBe(true);
  });

  it("keeps polling after a successful readiness read followed by HTTP 503", async () => {
    const h = harness({ readyAt: 4_000 });
    let reads = 0;
    let deletedAt: number | undefined;
    h.hooks.before = (method, v2) => {
      if (method === "GET" && !v2 && ++reads === 3) return new Response(null, { status: 503 });
      if (method === "DELETE") deletedAt = h.now();
    };
    await expect(h.prewarmer.prepare()).resolves.toMatchObject({ preparationMs: 4_000 });
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.calls("DELETE")).toHaveLength(1);
    expect(deletedAt).toBe(4_000);
    expect(h.deleted()).toBe(true);
  });

  it.each([429, 500, 502, 503, 504])("retries initial HTTP %s reads before creating a probe", async (status) => {
    const h = harness();
    h.fetchImpl.mockResolvedValueOnce(new Response(null, { status }));
    await expect(h.prewarmer.prepare()).resolves.toMatchObject({ preparationMs: 2_000 });
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.calls("DELETE")).toHaveLength(1);
    expect(h.tokenProvider).toHaveBeenCalledTimes(h.fetchImpl.mock.calls.length);
  });

  it.each(["transport", "request timeout"])("retries a GET %s failure", async (failure) => {
    const h = harness();
    h.hooks.after = (method) => {
      if (method === "POST") {
        const error =
          failure === "transport" ? new TypeError("private network error") : new DOMException("", "TimeoutError");
        h.fetchImpl.mockRejectedValueOnce(error);
      }
    };
    await expect(h.prewarmer.prepare()).resolves.toMatchObject({ preparationMs: 2_000 });
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.deleted()).toBe(true);
  });

  it.each([503, "transport"] as const)(
    "bounds repeated readiness %s failures by the original preparation deadline",
    async (failure) => {
      const h = harness({ preparationTimeoutMs: 5_000 });
      h.hooks.before = (method, v2) => {
        if (method === "GET" && !v2 && h.calls("POST").length > 0) {
          if (failure === "transport") throw new TypeError("private network error");
          return new Response(null, { status: failure });
        }
      };
      await expect(h.prewarmer.prepare()).rejects.toThrow("deadline exceeded");
      expect(h.now()).toBe(5_000);
      expect(h.calls("GET").filter(([url]) => !String(url).includes("/v2/"))).toHaveLength(4);
      expect(h.calls("POST")).toHaveLength(1);
      expect(h.calls("DELETE")).toHaveLength(1);
      expect(h.deleted()).toBe(true);
    },
  );

  it("does not create a probe when initial GET retries exhaust the preparation budget", async () => {
    const h = harness({ preparationTimeoutMs: 3_000 });
    h.fetchImpl.mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(h.prewarmer.prepare()).rejects.toThrow("deadline exceeded");
    expect(h.now()).toBe(3_000);
    expect(h.calls("GET")).toHaveLength(2);
    expect(h.calls("POST")).toHaveLength(0);
    expect(h.calls("DELETE")).toHaveLength(0);
  });

  it.each([400, 401, 403, 409, 501])("fails immediately on readiness HTTP %s and cleans up", async (status) => {
    const h = harness();
    h.hooks.after = (method) => {
      if (method === "POST") h.fetchImpl.mockResolvedValueOnce(new Response("private provider body", { status }));
    };
    await expect(h.prewarmer.prepare()).rejects.toThrow(`GET failed with HTTP ${status}`);
    expect(h.now()).toBe(0);
    expect(h.calls("GET")).toHaveLength(4);
    expect(h.deleted()).toBe(true);
  });

  it("keeps waiting on readiness 404 without repeating creation", async () => {
    const h = harness();
    h.hooks.after = (method) => {
      if (method === "POST") h.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 404 }));
    };
    await expect(h.prewarmer.prepare()).resolves.toMatchObject({ preparationMs: 2_000 });
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.deleted()).toBe(true);
  });

  it("does not retry invalid GET JSON", async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValueOnce(new Response("private invalid JSON"));
    await expect(h.prewarmer.prepare()).rejects.toThrow("GET returned invalid JSON");
    expect(h.now()).toBe(0);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["fetch", "retry wait"])("aborts preparation during a failed GET %s and drains cleanup", async (phase) => {
    const h = harness();
    const controller = new AbortController();
    h.hooks.before = (method, v2) => {
      if (method === "GET" && !v2 && h.calls("POST").length > 0) {
        if (phase === "fetch") controller.abort();
        return new Response(null, { status: 503 });
      }
    };
    h.hooks.sleep = (signal) => {
      if (signal) controller.abort();
    };
    await expect(h.prewarmer.prepare(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.calls("DELETE")).toHaveLength(1);
    expect(h.now()).toBe(phase === "fetch" ? 0 : 2_000);
    expect(h.deleted()).toBe(true);
  });

  it.each(["ownership read", "deletion poll"])(
    "retries a cleanup %s failure without repeating DELETE",
    async (phase) => {
      const h = harness();
      let failed = false;
      h.hooks.before = (method, v2) => {
        const deletionStarted = h.calls("DELETE").length > 0;
        if (method === "GET" && v2 && deletionStarted === (phase === "deletion poll") && !failed) {
          failed = true;
          return new Response(null, { status: 503 });
        }
      };
      await expect(h.prewarmer.prepare()).resolves.toMatchObject({ preparationMs: 0 });
      expect(h.now()).toBe(2_000);
      expect(h.calls("DELETE")).toHaveLength(1);
      expect(h.deleted()).toBe(true);
    },
  );

  it.each(["ownership read", "deletion poll"])(
    "bounds repeated cleanup %s failures by its own deadline",
    async (phase) => {
      const h = harness({ readyAt: 2_000, cleanupTimeoutMs: 3_000 });
      h.hooks.delayDelete = true;
      h.hooks.before = (method, v2) => {
        if (method === "GET" && v2 && (phase === "ownership read" || h.calls("DELETE").length > 0))
          return new Response(null, { status: 503 });
      };
      await expect(h.prewarmer.prepare()).rejects.toMatchObject({
        message: "Runner image prewarm cleanup failed",
        errors: [expect.objectContaining({ message: "Runner image prewarm request deadline exceeded" })],
      });
      expect(h.now()).toBe(5_000);
      expect(h.calls("DELETE")).toHaveLength(phase === "ownership read" ? 0 : 1);
      expect(h.deleted()).toBe(false);
    },
  );

  it("still checks cleanup UID after a transient read failure", async () => {
    const h = harness();
    let reads = 0;
    h.hooks.before = (method, v2) => {
      if (method === "GET" && v2) {
        if (++reads === 1) return new Response(null, { status: 503 });
        h.seed();
      }
    };
    await expect(h.prewarmer.prepare()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "Runner image prewarm cleanup UID changed" })],
    });
    expect(h.calls("DELETE")).toHaveLength(0);
    expect(h.deleted()).toBe(false);
  });

  it.each(["POST", "DELETE"])("does not retry HTTP 503 for %s", async (writeMethod) => {
    const h = harness();
    h.hooks.before = (method) => {
      if (method === writeMethod) return new Response(null, { status: 503 });
    };
    await expect(h.prewarmer.prepare()).rejects.toThrow(
      writeMethod === "POST" ? "POST failed with HTTP 503" : "cleanup failed",
    );
    expect(h.calls(writeMethod)).toHaveLength(1);
    expect(h.now()).toBe(0);
  });

  it("requires final 404 after a soft delete and retries cleanup on the next preparation", async () => {
    const h = harness({ cleanupTimeoutMs: 3_000 });
    h.hooks.delayDelete = true;
    await expect(h.prewarmer.prepare()).rejects.toThrow("cleanup failed");
    expect(h.deleted()).toBe(false);
    expect(h.calls("DELETE")).toHaveLength(1);
    h.hooks.delayDelete = false;
    h.hooks.before = (method, v2) => {
      if (method === "GET" && v2) {
        h.clear();
        h.hooks.before = undefined;
      }
    };
    await h.prewarmer.prepare();
    expect(h.calls("POST")).toHaveLength(2);
    expect(h.deleted()).toBe(true);
  });

  it("never retries an unknown create response and still reconciles cleanup", async () => {
    const h = harness();
    h.hooks.after = (method) => {
      if (method === "POST") throw new Error("private provider response");
    };
    await expect(h.prewarmer.prepare()).rejects.toThrow("POST transport failure");
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.calls("DELETE")).toHaveLength(1);
    expect(h.deleted()).toBe(true);
  });

  it("never retries an unknown delete response", async () => {
    const h = harness();
    h.hooks.after = (method) => {
      if (method === "DELETE") throw new TypeError("private provider response");
    };
    await expect(h.prewarmer.prepare()).rejects.toMatchObject({
      message: "Runner image prewarm cleanup failed",
      errors: [expect.objectContaining({ message: "Runner image prewarm DELETE transport failure" })],
    });
    expect(h.calls("DELETE")).toHaveLength(1);
    expect(h.now()).toBe(0);
  });

  it("adopts its current probe after restart without posting again", async () => {
    const h = harness();
    h.seed();
    await h.prewarmer.prepare();
    expect(h.calls("POST")).toHaveLength(0);
    expect(h.deleted()).toBe(true);
  });

  it("removes an owned previous digest before importing the configured image", async () => {
    const h = harness();
    h.seed(config.image.replace(/a{64}$/, "b".repeat(64)));
    await h.prewarmer.prepare();
    expect(h.calls("DELETE")).toHaveLength(2);
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.deleted()).toBe(true);
    expect(
      new RunnerImagePrewarmer(
        "staging",
        { ...config, image: config.image.replace(/a{64}$/, "b".repeat(64)) },
        { tokenProvider: h.tokenProvider },
      ).resourceName,
    ).toBe(h.prewarmer.resourceName);
  });

  it.each(["labels", "command", "args", "env", "account", "image", "uid"])(
    "rejects a foreign probe with mismatched %s without deletion",
    async (field) => {
      const h = harness();
      const view = h.seed();
      const container = view.spec.containers[0] as Record<string, unknown>;
      if (field === "labels") view.metadata.labels = { "opentag-purpose": "business-sandbox" };
      if (field === "command") container.command = ["serve"];
      if (field === "args") container.args = ["private-business-command"];
      if (field === "env") container.env = [{ name: "SESSION_TOKEN", value: "private-value" }];
      if (field === "account") view.spec.serviceAccountName = "other@opentag-test.iam.gserviceaccount.com";
      if (field === "image") container.image = config.image.replace("/runner@", "/business@");
      if (field === "uid") delete view.metadata.uid;
      await expect(h.prewarmer.prepare()).rejects.toThrow(/ownership mismatch|no UID/);
      expect(h.calls("POST")).toHaveLength(0);
      expect(h.calls("DELETE")).toHaveLength(0);
    },
  );

  it("refuses cleanup if the UID was replaced during readiness polling", async () => {
    const h = harness();
    const view = h.seed();
    let reads = 0;
    h.hooks.before = (method, v2) => {
      if (method === "GET" && !v2 && ++reads === 2) view.metadata.uid = "replacement-uid";
    };
    await expect(h.prewarmer.prepare()).rejects.toThrow("cleanup failed");
    expect(h.calls("DELETE")).toHaveLength(0);
  });

  it("drains cleanup using an independent deadline after shutdown aborts polling", async () => {
    const h = harness({ readyAt: 20_000 });
    const controller = new AbortController();
    h.hooks.sleep = (signal) => {
      if (signal) controller.abort();
    };
    await expect(h.prewarmer.prepare(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(h.deleted()).toBe(true);
  });

  it("leaves recovery to the next leader if leadership is lost before deletion", async () => {
    const h = harness();
    const assertLeadership = vi.fn(async () => {
      if (assertLeadership.mock.calls.length > 1) throw new Error("leadership lost");
    });
    await expect(h.prewarmer.prepare(undefined, assertLeadership)).rejects.toThrow("cleanup failed");
    expect(h.calls("DELETE")).toHaveLength(0);
    await h.prewarmer.prepare();
    expect(h.calls("POST")).toHaveLength(1);
    expect(h.deleted()).toBe(true);
  });

  it("refreshes metadata credentials during long imports and cleanup", async () => {
    const h = harness({ readyAt: 260_000 });
    const metadataFetch = vi.fn<typeof fetch>(
      async (): Promise<Response> =>
        Response.json({
          access_token: `token-${metadataFetch.mock.calls.length}`,
          expires_in: 240,
          token_type: "Bearer",
        }),
    );
    const tokenProvider = createMetadataServerTokenProvider({ fetchImpl: metadataFetch, now: h.now });
    h.tokenProvider.mockImplementation(tokenProvider);
    await h.prewarmer.prepare();
    expect(metadataFetch).toHaveBeenCalledTimes(2);
    expect(h.calls("POST")[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer token-1" });
    expect(h.calls("DELETE")[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer token-2" });
    expect(h.deleted()).toBe(true);
  });

  it("redacts credential failures and provider response bodies", async () => {
    const h = harness();
    h.tokenProvider.mockRejectedValue(new Error("private-credential"));
    await expect(h.prewarmer.prepare()).rejects.toThrow("credentials unavailable");
    const unavailable = harness();
    unavailable.fetchImpl.mockResolvedValue(new Response("private-provider-body", { status: 403 }));
    await expect(unavailable.prewarmer.prepare()).rejects.toThrow("failed with HTTP 403");
    expect(unavailable.calls("DELETE")).toHaveLength(0);
  });
});
