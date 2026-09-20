/**
 * The Cloud availability projection: a pure reading of the startup-validated configuration. The
 * three legs stay distinct so a reader can tell "not offered" from "cannot execute" from "no model
 * path", and no answer ever claims an environment is already running.
 */

import { describe, expect, it } from "vitest";
import { cloudAvailability } from "../cloud-product-config.js";
import type { ServerConfig } from "../config.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");

type ConfigSlice = Pick<ServerConfig, "cloudIdentities" | "cloudRunner" | "cloudModel">;

function config(overrides: Partial<ConfigSlice> = {}): ConfigSlice {
  return {
    cloudIdentities: { enabled: false },
    cloudRunner: { enabled: false },
    cloudModel: { enabled: false },
    ...overrides,
  };
}

const RUNNER = {
  enabled: true,
  image: "example/runner@sha256:0000000000000000000000000000000000000000000000000000000000000000",
  project: "example-project",
  region: "us-central1",
  serviceAccount: "runner@example-project.iam.gserviceaccount.com",
  backendOrigin: "https://opentag.example.com",
  vpc: { network: "net", subnetwork: "subnet", executionTag: "tag" },
  apiTimeoutMs: 30_000,
  createConvergeTimeoutMs: 120_000,
  bootstrapTokenTtlSeconds: 1_800,
  acceptanceTimeoutMs: 900_000,
  idleTimeoutMs: 120_000,
  maxInstancesPerAccount: 3,
  maxInstances: 20,
} as const;

const MODEL = {
  enabled: true,
  upstreamBaseUrl: "https://models.example.com",
  masterKey: "test-master-key",
  allowedModels: ["model-a"],
  tokenTtlSeconds: 1_800,
  requestTimeoutMs: 600_000,
  maxRequestBytes: 2 * 1024 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
  maxStreamsPerToken: 4,
} as const;

describe("cloudAvailability", () => {
  it("answers disabled when Cloud identities are not offered", () => {
    expect(cloudAvailability(config(), NOW)).toEqual({
      enabled: false,
      available: false,
      reason: "disabled",
      observedAt: NOW.toISOString(),
    });
  });

  it("answers execution_unavailable when identities exist without Runner allocation", () => {
    expect(
      cloudAvailability(
        config({ cloudIdentities: { enabled: true, storageBase: "gs://bucket", runnerVersion: "1.2.3" } }),
        NOW,
      ),
    ).toEqual({
      enabled: true,
      available: false,
      reason: "execution_unavailable",
      observedAt: NOW.toISOString(),
    });
  });

  it("answers model_unavailable when the Runner exists without the brokered model path", () => {
    expect(
      cloudAvailability(
        config({
          cloudIdentities: { enabled: true, storageBase: "gs://bucket", runnerVersion: "1.2.3" },
          cloudRunner: RUNNER,
        }),
        NOW,
      ),
    ).toEqual({
      enabled: true,
      available: false,
      reason: "model_unavailable",
      observedAt: NOW.toISOString(),
    });
  });

  it("answers available only when identities, execution, and the model path are all configured", () => {
    expect(
      cloudAvailability(
        config({
          cloudIdentities: { enabled: true, storageBase: "gs://bucket", runnerVersion: "1.2.3" },
          cloudRunner: RUNNER,
          cloudModel: MODEL,
        }),
        NOW,
      ),
    ).toEqual({
      enabled: true,
      available: true,
      reason: null,
      observedAt: NOW.toISOString(),
    });
  });
});
