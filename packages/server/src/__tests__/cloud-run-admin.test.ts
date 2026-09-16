import { describe, expect, it, vi } from "vitest";
import { CloudRunAdmin } from "../services/cloud-run/cloud-run-admin.js";
import { CloudRunAdminError } from "../services/cloud-run/errors.js";
import {
  runnerInstanceId,
  runnerInstanceLabels,
  runnerInstanceResourceName,
} from "../services/cloud-run/instance-identity.js";
import { createMetadataServerTokenProvider, createStaticTokenProvider } from "../services/cloud-run/token-provider.js";

const CONFIG = {
  project: "opentag-test",
  region: "us-west1",
  serviceAccount: "runner-sa@opentag-test.iam.gserviceaccount.com",
  image: "us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner@sha256:" + "a".repeat(64),
  vpc: { network: "opentag-net", subnetwork: "opentag-subnet", executionTag: "opentag-runner" },
  apiTimeoutMs: 5_000,
};

const IDENTITY = {
  environment: "staging" as const,
  sandboxId: "2b63a21e-f6c7-4474-91ea-4dabf0566a24",
  sessionId: "5f9a1c3e-2d4b-4e6f-8a1b-9c0d1e2f3a4b",
  environmentGeneration: 3,
};

const SPEC = {
  ...IDENTITY,
  backendUrl: "wss://api.example.com/api/v1/sandbox-runners/ws",
  bootstrapToken: "unit-bootstrap-token-secret",
};

type RecordedCall = { url: string; method: string; body?: unknown; authorization?: string };

function fakeFetch(
  handler: (call: RecordedCall) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>,
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(
    async (input: unknown, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(init.body) } : {}),
        ...(init?.headers?.authorization ? { authorization: init.headers.authorization } : {}),
      };
      calls.push(call);
      const result = await handler(call);
      return new Response(result.body === undefined ? "" : JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function instanceBody(overrides: Record<string, unknown> = {}) {
  const name = runnerInstanceResourceName(CONFIG.project, CONFIG.region, runnerInstanceId(IDENTITY));
  return {
    name,
    etag: '"revision-1"',
    ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
    defaultUriDisabled: true,
    invokerIamDisabled: false,
    restartPolicy: "NEVER",
    serviceAccount: CONFIG.serviceAccount,
    containers: [
      {
        name: "runner",
        image: CONFIG.image,
        sandboxLauncher: true,
        args: ["opentag-runner", "serve"],
        resources: { limits: { cpu: "1", memory: "1Gi" } },
        ports: [{ containerPort: 8080 }],
      },
    ],
    uid: "uid-1234-5678",
    labels: runnerInstanceLabels(IDENTITY),
    reconciling: true,
    vpcAccess: {
      egress: "ALL_TRAFFIC",
      networkInterfaces: [{ network: "opentag-net", subnetwork: "opentag-subnet", tags: ["opentag-runner"] }],
    },
    terminalCondition: { state: "CONDITION_RECONCILING" },
    ...overrides,
  };
}

function admin(fetchImpl: typeof fetch, options: { sleep?: (ms: number) => Promise<void> } = {}) {
  return new CloudRunAdmin(CONFIG, {
    fetchImpl,
    tokenProvider: createStaticTokenProvider("unit-access-token"),
    sleep: options.sleep ?? (() => Promise.resolve()),
  });
}

describe("runner instance identity", () => {
  it("derives deterministic DNS-safe names scoped by sandbox and environment generation", () => {
    const id = runnerInstanceId(IDENTITY);
    expect(id).toMatch(/^ot-s-[0-9a-f]{32}-3$/);
    expect(runnerInstanceId({ ...IDENTITY, environmentGeneration: 4 })).not.toBe(id);
    expect(runnerInstanceId({ ...IDENTITY, environment: "prod" })).toMatch(/^ot-p-/);
    expect(runnerInstanceId({ ...IDENTITY, environment: "dev" })).toMatch(/^ot-d-/);
    expect(runnerInstanceId(IDENTITY)).toBe(id); // stable across calls
    expect(id.length).toBeLessThan(50);
  });

  it("rejects non-positive generations and malformed identities", () => {
    expect(() => runnerInstanceId({ ...IDENTITY, environmentGeneration: 0 })).toThrow(CloudRunAdminError);
    expect(() => runnerInstanceId({ ...IDENTITY, sandboxId: "not-a-uuid" })).toThrow(CloudRunAdminError);
  });
});

describe("CloudRunAdmin create", () => {
  it("creates the pinned 1CPU/1GiB sandbox-launcher instance with Direct VPC and hardened surface", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.method === "POST")
        return { status: 200, body: { name: "projects/opentag-test/locations/us-west1/operations/op-1" } };
      return { status: 200, body: instanceBody() };
    });
    const result = await admin(fetchImpl).createInstance(SPEC);
    expect(result.outcome).toBe("created");
    expect(result.operationName).toBe("projects/opentag-test/locations/us-west1/operations/op-1");
    expect(result.instance.uid).toBe("uid-1234-5678");

    const create = calls[0] as RecordedCall;
    const expectedId = runnerInstanceId(IDENTITY);
    expect(create.url).toBe(
      `https://run.googleapis.com/v2/projects/opentag-test/locations/us-west1/instances?instanceId=${expectedId}`,
    );
    expect(create.authorization).toBe("Bearer unit-access-token");
    const body = create.body as Record<string, unknown>;
    expect(body).toMatchObject({
      ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
      defaultUriDisabled: true,
      invokerIamDisabled: false,
      restartPolicy: "NEVER",
      serviceAccount: CONFIG.serviceAccount,
      vpcAccess: {
        egress: "ALL_TRAFFIC",
        networkInterfaces: [{ network: "opentag-net", subnetwork: "opentag-subnet", tags: ["opentag-runner"] }],
      },
    });
    const [container] = (body as { containers: Record<string, unknown>[] }).containers as Record<string, unknown>[];
    expect(container).toMatchObject({
      image: CONFIG.image,
      sandboxLauncher: true,
      args: ["opentag-runner", "serve"],
      resources: { limits: { cpu: "1", memory: "1Gi" }, cpuIdle: false },
      ports: [{ containerPort: 8080 }],
    });
    const env = Object.fromEntries(
      (container as { env: { name: string; value: string }[] }).env.map((entry) => [entry.name, entry.value]),
    );
    expect(env.OPENTAG_RUNNER_BACKEND_URL).toBe(SPEC.backendUrl);
    expect(env.OPENTAG_RUNNER_BOOTSTRAP_TOKEN).toBe(SPEC.bootstrapToken);
    expect(env.OPENTAG_RUNNER_SANDBOX_NAME).toBe(expectedId);
    const labels = (body as { labels: Record<string, string> }).labels;
    expect(labels["opentag-sandbox"]).toBe(IDENTITY.sandboxId.replaceAll("-", ""));
    expect(labels["opentag-gen"]).toBe("3");
    expect(labels["managed-by"]).toBe("opentag");
  });

  it("adopts the existing owned resource on 409 instead of duplicating", async () => {
    const { calls, fetchImpl } = fakeFetch((call) =>
      call.method === "POST"
        ? { status: 409, body: { error: { message: "already exists" } } }
        : { status: 200, body: instanceBody() },
    );
    const result = await admin(fetchImpl).createInstance(SPEC);
    expect(result.outcome).toBe("adopted");
    expect(result.instance.uid).toBe("uid-1234-5678");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("refuses to adopt a resource without this sandbox's ownership labels", async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.method === "POST"
        ? { status: 409, body: { error: { message: "already exists" } } }
        : { status: 200, body: instanceBody({ labels: { "managed-by": "someone-else" } }) },
    );
    await expect(admin(fetchImpl).createInstance(SPEC)).rejects.toMatchObject({ kind: "ownership_mismatch" });
  });

  it("uses the narrow documented v1 compatibility create only for the networkInterfaces rejection", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.method === "POST" && call.url.includes("/v2/")) {
        return {
          status: 400,
          body: {
            error: {
              message:
                "metadata.annotations[run.googleapis.com/vpc-access-egress]: The run.googleapis.com/vpc-access-egress annotation cannot be set without also setting the run.googleapis.com/vpc-access-connector annotation or the run.googleapis.com/network-interfaces annotation.",
            },
          },
        };
      }
      if (call.method === "POST" && call.url.includes("/apis/run.googleapis.com/v1/")) {
        return { status: 200, body: { metadata: { uid: "uid-1234-5678" } } };
      }
      return { status: 200, body: instanceBody() };
    });
    const result = await admin(fetchImpl).createInstance(SPEC);
    expect(result.outcome).toBe("created");
    const v1 = calls.find((call) => call.url.includes("/apis/run.googleapis.com/v1/"));
    expect(v1?.url).toBe(
      "https://us-west1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/opentag-test/instances",
    );
    const body = v1?.body as {
      metadata: { annotations: Record<string, string>; name: string };
      spec: { serviceAccountName: string; containers: Record<string, unknown>[] };
    };
    expect(body.metadata.name).toBe(runnerInstanceId(IDENTITY));
    expect(JSON.parse(body.metadata.annotations["run.googleapis.com/network-interfaces"] as string)).toEqual([
      { network: "opentag-net", subnetwork: "opentag-subnet", tags: ["opentag-runner"] },
    ]);
    expect(body.metadata.annotations["run.googleapis.com/vpc-access-egress"]).toBe("all-traffic");
    expect(body.spec.containers[0]).toMatchObject({
      sandboxLauncher: true,
      image: CONFIG.image,
      ports: [{ containerPort: 8080 }],
    });
  });

  it("never falls back to default egress for other 400 rejections", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      status: 400,
      body: { error: { message: "invalid image reference" } },
    }));
    await expect(admin(fetchImpl).createInstance(SPEC)).rejects.toMatchObject({ kind: "invalid" });
    expect(calls.filter((call) => call.url.includes("/apis/run.googleapis.com/v1/"))).toHaveLength(0);
  });

  it("fails verification unless exactly the declared startup-probe port is present", async () => {
    const [container] = instanceBody().containers as Record<string, unknown>[];
    for (const ports of [
      undefined,
      [],
      [{ containerPort: 9090 }],
      [{ containerPort: 8080 }, { containerPort: 9090 }],
    ]) {
      const candidate = { ...container };
      if (ports === undefined) delete candidate.ports;
      else candidate.ports = ports;
      const { fetchImpl } = fakeFetch((call) =>
        call.method === "POST"
          ? { status: 200, body: { name: "projects/opentag-test/locations/us-west1/operations/op-1" } }
          : { status: 200, body: instanceBody({ containers: [candidate] }) },
      );
      await expect(admin(fetchImpl).createInstance(SPEC)).rejects.toMatchObject({ kind: "invalid" });
    }
  });

  it("fails verification when the created instance lacks the Direct VPC attachment", async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.method === "POST"
        ? { status: 200, body: { name: "projects/opentag-test/locations/us-west1/operations/op-1" } }
        : { status: 200, body: instanceBody({ vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [] } }) },
    );
    const cloud = admin(fetchImpl);
    await expect(cloud.createInstance(SPEC)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("reports unknown on transport failure with a bounded sanitized message", async () => {
    const failing = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(admin(failing as unknown as typeof fetch).createInstance(SPEC)).rejects.toMatchObject({
      kind: "unknown",
    });
  });

  it("sanitizes error bodies instead of echoing payloads", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 500,
      body: { error: { message: `backend exploded with ${SPEC.bootstrapToken} and ${"x".repeat(10_000)}` } },
    }));
    const error = await admin(fetchImpl)
      .createInstance(SPEC)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudRunAdminError);
    const message = (error as Error).message;
    expect(message).not.toContain(SPEC.bootstrapToken);
    expect(message.length).toBeLessThanOrEqual(600);
    expect(message).not.toContain("x".repeat(600));
  });
});

describe("CloudRunAdmin delete", () => {
  const name = runnerInstanceResourceName(CONFIG.project, CONFIG.region, runnerInstanceId(IDENTITY));

  it("treats 404 as verified removal", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { error: { message: "not found" } } }));
    const result = await admin(fetchImpl).deleteInstance(name, "uid-1234-5678");
    expect(result.alreadyGone).toBe(true);
  });

  it("refuses to delete when the tracked UID no longer matches", async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.method === "GET" ? { status: 200, body: instanceBody({ uid: "different-uid" }) } : { status: 200, body: {} },
    );
    await expect(admin(fetchImpl).deleteInstance(name, "uid-1234-5678")).rejects.toMatchObject({
      kind: "ownership_mismatch",
    });
  });

  it("deletes the UID-verified resource and returns the operation name", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.method === "GET") return { status: 200, body: instanceBody() };
      return { status: 200, body: { name: "projects/opentag-test/locations/us-west1/operations/del-1" } };
    });
    const result = await admin(fetchImpl).deleteInstance(name, "uid-1234-5678");
    expect(result).toEqual({
      alreadyGone: false,
      operationName: "projects/opentag-test/locations/us-west1/operations/del-1",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(new URL(calls[1]?.url ?? "").searchParams.get("etag")).toBe('"revision-1"');
  });

  it("rejects resource names outside the configured project/region", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: instanceBody() }));
    await expect(
      admin(fetchImpl).deleteInstance("projects/other/locations/us-east1/instances/x", "uid-1234-5678"),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("metadata server token provider", () => {
  it("acquires, caches, and refreshes tokens with the metadata flavor header", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      expect(String(input)).toContain("computeMetadata/v1/instance/service-accounts/default/token");
      expect(init?.headers?.["Metadata-Flavor"]).toBe("Google");
      return new Response(JSON.stringify({ access_token: `token-${now}`, expires_in: 3600, token_type: "Bearer" }), {
        status: 200,
      });
    });
    const provider = createMetadataServerTokenProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    expect(await provider()).toBe("token-1000000");
    expect(await provider()).toBe("token-1000000"); // cached
    now += 3_600_000; // past expiry margin
    expect(await provider()).toBe("token-4600000");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails as a credential error when the metadata server is unreachable", async () => {
    const provider = createMetadataServerTokenProvider({
      fetchImpl: vi.fn(async () => {
        throw new Error("connect EHOSTUNREACH");
      }) as unknown as typeof fetch,
    });
    await expect(provider()).rejects.toMatchObject({ kind: "credential" });
  });
});

describe("CloudRunAdmin policy and uncertain allocation", () => {
  it.each([
    { defaultUriDisabled: false },
    { invokerIamDisabled: true },
    { ingress: "INGRESS_TRAFFIC_ALL" },
    { restartPolicy: "ALWAYS" },
    { serviceAccount: "wrong@example.com" },
    { containers: [] },
    {
      vpcAccess: {
        egress: "ALL_TRAFFIC",
        networkInterfaces: [{ network: CONFIG.vpc.network, subnetwork: CONFIG.vpc.subnetwork, tags: [] }],
      },
    },
    {
      vpcAccess: {
        networkInterfaces: [
          { network: CONFIG.vpc.network, subnetwork: CONFIG.vpc.subnetwork, tags: [CONFIG.vpc.executionTag] },
        ],
      },
    },
  ])("rejects adopted resources with drifted policy %j", async (override) => {
    const { fetchImpl } = fakeFetch((c) =>
      c.method === "POST" ? { status: 409 } : { status: 200, body: instanceBody(override) },
    );
    await expect(admin(fetchImpl).createInstance(SPEC)).rejects.toMatchObject({ kind: "invalid" });
  });
  it("records the accepted operation before waiting for resource visibility", async () => {
    let observed = false;
    const operationName = "projects/opentag-test/locations/us-west1/operations/slow";
    const { calls, fetchImpl } = fakeFetch((c) => {
      if (c.method === "POST") return { status: 200, body: { name: operationName } };
      expect(observed).toBe(true);
      return { status: 404 };
    });
    await expect(
      admin(fetchImpl).createInstance(SPEC, {
        onOperation: async (name) => {
          expect(name).toBe(operationName);
          observed = true;
        },
      }),
    ).rejects.toMatchObject({ kind: "unknown" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("refuses URL path/query operands before any cloud call", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 404 }));
    const cloud = admin(fetchImpl);
    const name = cloud.resourceNameFor(cloud.instanceIdFor(IDENTITY));
    for (const suffix of ["/../other", "?etag=wrong", "#fragment", "/extra"])
      await expect(cloud.getInstance(name + suffix)).rejects.toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });
  it("supports full UUIDs and the largest safe generation within the 49-character limit", () => {
    const name = runnerInstanceId({ ...IDENTITY, environmentGeneration: Number.MAX_SAFE_INTEGER });
    expect(name.length).toBe(49);
    expect(name).toContain(IDENTITY.sandboxId.replaceAll("-", ""));
    expect(() => runnerInstanceId({ ...IDENTITY, environmentGeneration: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
  it("will not delete without a compare-and-delete etag", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: instanceBody({ etag: undefined }) }));
    const cloud = admin(fetchImpl);
    await expect(
      cloud.deleteInstance(cloud.resourceNameFor(cloud.instanceIdFor(IDENTITY)), "uid-1234-5678"),
    ).rejects.toMatchObject({ kind: "unknown" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it("does not retain credential-bearing transport causes", async () => {
    const cloud = admin((async () => {
      throw new Error(SPEC.bootstrapToken);
    }) as typeof fetch);
    const error = await cloud.createInstance(SPEC).catch((e) => e);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(SPEC.bootstrapToken);
  });
});

describe("Cloud Admin bounded transport", () => {
  it("cancels an oversized streaming body before buffering the whole response", async () => {
    let cancelled = false,
      pulls = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(128 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const cloud = admin((async () => response) as typeof fetch);
    await expect(cloud.getInstance(cloud.resourceNameFor(cloud.instanceIdFor(IDENTITY)))).rejects.toMatchObject({
      kind: "unknown",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(4);
  });
  it("distinguishes rejected POST from policy failure after accepted POST", async () => {
    const rejected = admin(fakeFetch(() => ({ status: 400, body: { error: { message: "invalid image" } } })).fetchImpl);
    await expect(rejected.createInstance(SPEC)).rejects.toMatchObject({ createRejected: true });
    const accepted = admin(
      fakeFetch((c) =>
        c.method === "POST"
          ? { status: 200, body: { name: "projects/opentag-test/locations/us-west1/operations/create" } }
          : { status: 200, body: instanceBody({ defaultUriDisabled: false }) },
      ).fetchImpl,
    );
    await expect(accepted.createInstance(SPEC)).rejects.toMatchObject({ kind: "invalid", createRejected: false });
  });
});

it("credential acquisition before POST proves non-submission, but after POST preserves uncertainty", async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          name: `projects/${CONFIG.project}/locations/${CONFIG.region}/operations/create-1`,
        }),
        { status: 200 },
      ),
  );
  const unavailable = async (): Promise<string> => {
    throw new Error("private provider diagnostics");
  };
  const before = new CloudRunAdmin(CONFIG, { fetchImpl, tokenProvider: unavailable });
  await expect(before.createInstance(SPEC)).rejects.toMatchObject({ kind: "credential", createRejected: true });
  expect(fetchImpl).not.toHaveBeenCalled();
  let acquisitions = 0;
  const after = new CloudRunAdmin(CONFIG, {
    fetchImpl,
    tokenProvider: async () => {
      if (++acquisitions === 1) return "synthetic-token";
      return unavailable();
    },
  });
  await expect(after.createInstance(SPEC)).rejects.toMatchObject({ kind: "credential", createRejected: false });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
