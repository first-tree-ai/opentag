import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxRunnerRuntime } from "../cloud-runtime-composition.js";
import type { ServerConfig } from "../config.js";
import type { DatabaseClient } from "../db/client.js";
import { createPerformanceLogger } from "../observability/performance-logger.js";
import type { CloudRunAdmin } from "../services/cloud-run/index.js";
import { runnerInstanceId } from "../services/cloud-run/instance-identity.js";
import { FakeWorkspaceObjectStore } from "./support/fake-workspace-store.js";

const recordAdmin = vi.hoisted(() => vi.fn());
const recordAdminInstance = vi.hoisted(() => vi.fn());
vi.mock("../services/cloud-run/index.js", async (original) => {
  const actual = await original<typeof import("../services/cloud-run/index.js")>();
  return {
    ...actual,
    CloudRunAdmin: class extends actual.CloudRunAdmin {
      constructor(...args: ConstructorParameters<typeof actual.CloudRunAdmin>) {
        super(...args);
        recordAdmin(...args);
        recordAdminInstance(this);
      }
    },
  };
});

const sessionId = "5f9a1c3e-2d4b-4e6f-8a1b-9c0d1e2f3a4b";
const otherSession = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function config(environment: ServerConfig["environment"]) {
  return {
    environment,
    jwtSecret: "unit-test-jwt-secret-at-least-32-characters",
    cloudIdentities: { enabled: true as const, runnerVersion: "0.0.5", storageBase: "gs://unit-cloud/x" },
    cloudRunner: {
      enabled: true,
      image: `registry.example.test/runner@sha256:${"a".repeat(64)}`,
      project: "unit-project",
      region: "us-west1",
      serviceAccount: "runner@unit-project.iam.gserviceaccount.com",
      backendOrigin: "https://server.example.test",
      vpc: { network: "unit-network", subnetwork: "unit-subnet", executionTag: "unit-runner" },
      staticAccessToken: "fixture-google-access-token",
      apiTimeoutMs: 30_000,
      createConvergeTimeoutMs: 120_000,
      bootstrapTokenTtlSeconds: 600,
      acceptanceTimeoutMs: 60_000,
      idleTimeoutMs: 120_000,
      maxInstancesPerAccount: 4,
      maxInstances: 17,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("production Runner diagnostic selection wiring", () => {
  it("retains selected diagnostics while instrumenting Cloud Run requests", async () => {
    vi.stubEnv("OPENTAG_ENV", "staging");
    vi.stubEnv("OPENTAG_CLOUD_LATENCY_DIAGNOSTICS", "true");
    vi.stubEnv("OPENTAG_CLOUD_LATENCY_SESSION_IDS", sessionId);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    const log = vi.fn();
    const performanceLogger = createPerformanceLogger(
      () => ({ isLevelEnabled: () => true, debug: log, info: log, warn: log }) as never,
    );
    createSandboxRunnerRuntime({} as DatabaseClient, config("staging"), {
      workspaceStoreFactory: () => new FakeWorkspaceObjectStore(),
      performanceLogger,
    });
    const admin = recordAdminInstance.mock.calls.at(-1)?.[0] as CloudRunAdmin;
    const id = runnerInstanceId({
      environment: "staging",
      sandboxId: otherSession,
      sessionId,
      environmentGeneration: 1,
    });
    expect(await admin.getInstance(admin.resourceNameFor(id))).toBeUndefined();
    expect(recordAdmin.mock.calls.at(-1)?.[1]).toMatchObject({ diagnosticSessionIds: [sessionId] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(log.mock.calls.map(([payload]) => payload)).toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "cloud-run", status: 404 })]),
    );
  });

  it.each([
    {
      environment: "staging" as const,
      processEnvironment: "staging",
      flag: "true",
      ids: ` ${sessionId}, ${otherSession} `,
      expected: [sessionId, otherSession],
    },
    { environment: "prod" as const, processEnvironment: "staging", flag: "true", ids: sessionId, expected: [] },
    { environment: "dev" as const, processEnvironment: "staging", flag: "true", ids: sessionId, expected: [] },
    { environment: "staging" as const, processEnvironment: "prod", flag: "true", ids: sessionId, expected: [] },
    { environment: "staging" as const, processEnvironment: "staging", flag: "false", ids: sessionId, expected: [] },
    { environment: "staging" as const, processEnvironment: "staging", flag: undefined, ids: sessionId, expected: [] },
    { environment: "staging" as const, processEnvironment: "staging", flag: "true", ids: undefined, expected: [] },
    { environment: "staging" as const, processEnvironment: "staging", flag: "true", ids: "invalid", expected: [] },
    {
      environment: "staging" as const,
      processEnvironment: "staging",
      flag: "true",
      ids: Array(17).fill(sessionId).join(","),
      expected: [],
    },
  ])(
    "passes only explicitly enabled Staging selection to the real admin constructor: %j",
    ({ environment, processEnvironment, flag, ids, expected }) => {
      vi.stubEnv("OPENTAG_ENV", processEnvironment);
      vi.stubEnv("OPENTAG_CLOUD_LATENCY_DIAGNOSTICS", flag);
      vi.stubEnv("OPENTAG_CLOUD_LATENCY_SESSION_IDS", ids);
      const runtime = createSandboxRunnerRuntime({} as DatabaseClient, config(environment), {
        workspaceStoreFactory: () => new FakeWorkspaceObjectStore(),
      });
      expect(runtime).toBeDefined();
      expect(recordAdmin.mock.calls.at(-1)?.[1]).toMatchObject({ diagnosticSessionIds: expected });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
