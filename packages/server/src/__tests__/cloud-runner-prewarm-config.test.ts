import { describe, expect, it } from "vitest";
import { resolveCloudRunnerConfig } from "../cloud-runner-config.js";

const environment = {
  OPENTAG_CLOUD_RUNNER_IMAGE: `us-west1-docker.pkg.dev/opentag-test/runners/runner@sha256:${"a".repeat(64)}`,
  OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-test",
  OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
  OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-test.iam.gserviceaccount.com",
  OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://api.example.com",
  OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "sandbox-net",
  OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "sandbox-subnet",
  OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "sandbox-runner",
};

describe("Background Runner image preparation configuration", () => {
  it.each(["staging", "prod"])("enables startup preparation by default on %s", (channel) => {
    expect(resolveCloudRunnerConfig({ ...environment, OPENTAG_ENV: channel }, true)).toMatchObject({
      prewarm: { enabled: true, intervalMs: 60_000 },
    });
  });
  it("defaults off locally, supports explicit disablement and a bounded cadence", () => {
    expect(resolveCloudRunnerConfig({ ...environment, OPENTAG_ENV: "dev" }, true)).toMatchObject({
      prewarm: { enabled: false },
    });
    expect(
      resolveCloudRunnerConfig(
        { ...environment, OPENTAG_ENV: "staging", OPENTAG_CLOUD_RUNNER_PREWARM_ENABLED: "false" },
        true,
      ),
    ).toMatchObject({ prewarm: { enabled: false } });
    expect(
      resolveCloudRunnerConfig(
        {
          ...environment,
          OPENTAG_ENV: "dev",
          OPENTAG_CLOUD_RUNNER_PREWARM_ENABLED: "true",
          OPENTAG_CLOUD_RUNNER_PREWARM_INTERVAL_MS: "2000",
        },
        true,
      ),
    ).toMatchObject({ prewarm: { enabled: true, intervalMs: 2_000 } });
    expect(resolveCloudRunnerConfig({ ...environment, OPENTAG_ENV: "staging" }, false)).toEqual({ enabled: false });
  });
  it.each(["0", "999", "3600001", "NaN", "1000.5"])("rejects invalid intervals: %s", (value) => {
    expect(() =>
      resolveCloudRunnerConfig({ ...environment, OPENTAG_CLOUD_RUNNER_PREWARM_INTERVAL_MS: value }, true),
    ).toThrow();
  });
  it("rejects malformed switches", () => {
    expect(() =>
      resolveCloudRunnerConfig({ ...environment, OPENTAG_CLOUD_RUNNER_PREWARM_ENABLED: "yes" }, true),
    ).toThrow();
  });
});
