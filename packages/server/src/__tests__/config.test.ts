import { generateKeyPairSync } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { parseRequest } from "../api/request-validation.js";
import {
  isHostedEnvironment,
  parseCloudStorageBase,
  parseDatabaseConfig,
  parseServerConfig,
  serverEnvironmentSummary,
} from "../config.js";
import { createDatabaseClient } from "../db/client.js";
import {
  MIGRATION_ADVISORY_LOCK_ID,
  MigrationVerificationError,
  migrateDatabase,
  verifyDatabaseMigrations,
  withMigrationLock,
} from "../db/migrate.js";
import { createComputerAuthPreHandler } from "../plugins/computer-auth.js";
import { resolveAuthenticatedUserId } from "../plugins/user-auth.js";

vi.mock("postgres", () => ({ default: vi.fn() }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn(() => ({ kind: "database" })) }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({ migrate: vi.fn() }));
vi.mock("drizzle-orm/migrator", () => ({ readMigrationFiles: vi.fn() }));

const required = {
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-at-least-32-characters",
  OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
  OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
  OPENTAG_PUBLIC_URL: "http://localhost:8000",
};

const githubAppPrivateKeyPem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

describe("parseServerConfig", () => {
  it("accepts an image source revision and rejects a malformed deployment proof", () => {
    expect(parseServerConfig({ ...required, OPENTAG_BUILD_REVISION: "a".repeat(40) }).buildRevision).toBe(
      "a".repeat(40),
    );
    expect(parseServerConfig({ ...required, OPENTAG_BUILD_REVISION: "" }).buildRevision).toBeUndefined();
    expect(() => parseServerConfig({ ...required, OPENTAG_BUILD_REVISION: "main" })).toThrow();
  });

  it("offers Internal Tools on staging and keeps other environments closed by default", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
      }).internalTools,
    ).toBe(true);

    expect(parseServerConfig(required).internalTools).toBe(false);
    expect(
      parseServerConfig({ ...required, OPENTAG_ENV: "prod", OPENTAG_PUBLIC_URL: "https://example.com" }).internalTools,
    ).toBe(false);

    // The reset took one setting before it became reflexive. A deployment that still carries it
    // must keep starting, so the retired name is ignored rather than rejected as unknown.
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
        OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      }).internalTools,
    ).toBe(true);
  });

  it("applies safe local defaults", () => {
    expect(parseServerConfig(required)).toMatchObject({
      autoMigrate: true,
      environment: "dev",
      host: "127.0.0.1",
      publicUrl: "http://localhost:8000",
      port: 8000,
      observability: {
        tracing: { endpoint: "", environment: "dev", headers: "", sampleRate: 1 },
      },
      sessionTtlSeconds: 2_592_000,
      logLevel: "info",
    });
    expect(parseServerConfig(required).devAuth).toBeUndefined();
    expect(parseServerConfig(required).cloudIdentities).toEqual({ enabled: false });
    expect(parseServerConfig(required).cloudRunner).toEqual({ enabled: false });
    expect(parseServerConfig(required).cloudModel).toEqual({ enabled: false });
  });

  it("derives Cloud Runner enablement from the single overall Cloud switch and requires every coordinate", () => {
    const identities = {
      OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
      OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e2",
      OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
    };
    const runnerEnv = {
      ...identities,
      OPENTAG_CLOUD_RUNNER_IMAGE: `us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner@sha256:${"a".repeat(64)}`,
      OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-test",
      OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
      OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-test.iam.gserviceaccount.com",
      OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://api.example.com",
      OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "opentag-net",
      OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "opentag-subnet",
      OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "opentag-runner",
    };
    // The overall switch alone enables the Runner; every coordinate is mandatory.
    for (const key of Object.keys(runnerEnv).filter(
      (key) => key.startsWith("OPENTAG_CLOUD_RUNNER_") && key !== "OPENTAG_CLOUD_RUNNER_VERSION",
    )) {
      const incomplete = { ...runnerEnv } as Record<string, string>;
      delete incomplete[key];
      expect(() => parseServerConfig({ ...required, ...incomplete }), key).toThrow(/Cloud Runner/);
    }
    // The retired per-Runner flag is a transition validation input, never a switch: a leftover
    // valid value cannot enable the Runner on its own. The dedicated retired-flag test below
    // covers the tolerated and rejected postures.
    expect(parseServerConfig({ ...required, OPENTAG_CLOUD_RUNNER_ENABLED: "true" }).cloudRunner).toEqual({
      enabled: false,
    });
    const parsed = parseServerConfig({ ...required, ...runnerEnv });
    expect(parsed.cloudRunner).toMatchObject({
      enabled: true,
      project: "opentag-test",
      region: "us-west1",
      backendOrigin: "https://api.example.com",
      vpc: { network: "opentag-net", subnetwork: "opentag-subnet", executionTag: "opentag-runner" },
    });
    expect((parsed.cloudRunner as { staticAccessToken?: string }).staticAccessToken).toBeUndefined();
    // A tag-only image is never accepted; the pin must be an exact digest.
    expect(() =>
      parseServerConfig({
        ...required,
        ...runnerEnv,
        OPENTAG_CLOUD_RUNNER_IMAGE: "us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner:0.0.5",
      }),
    ).toThrow();
    // Backend origin rejects credentials, paths, and plain http.
    const credentialOrigin = new URL("https://api.example.com");
    credentialOrigin.username = "synthetic-user";
    credentialOrigin.password = "synthetic-password";
    for (const origin of [credentialOrigin.toString(), "https://api.example.com/path", "http://api.example.com"]) {
      expect(() =>
        parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: origin }),
      ).toThrow();
    }
    // The acceptance-harness static token is honored only when explicitly set.
    expect(
      parseServerConfig({
        ...required,
        ...runnerEnv,
        OPENTAG_ENV: "dev",
        OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN: "unit-token",
      }).cloudRunner,
    ).toMatchObject({ staticAccessToken: "unit-token" });
    expect(() =>
      parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN: "unit-token" }),
    ).toThrow(/explicit OPENTAG_ENV=dev/);
  });

  it("treats the retired Runner flag as a transition validation input, never a switch", () => {
    const runnerEnv = {
      OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
      OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e3",
      OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
      OPENTAG_CLOUD_RUNNER_IMAGE: `us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner@sha256:${"a".repeat(64)}`,
      OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-test",
      OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
      OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-test.iam.gserviceaccount.com",
      OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://api.example.com",
      OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "opentag-net",
      OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "opentag-subnet",
      OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "opentag-runner",
    };
    // An agreeing leftover "true" stays tolerated so the deployment can roll back to an older
    // Server that still reads the retired name.
    expect(
      parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_ENABLED: "true" }).cloudRunner,
    ).toMatchObject({ enabled: true });
    // The old "paused" posture (identities on, retired flag false) must fail startup with a clear
    // migration error rather than silently enabling previously paused execution.
    expect(() => parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_ENABLED: "false" })).toThrow(
      /OPENTAG_CLOUD_RUNNER_ENABLED=false no longer pauses the Cloud Runner/,
    );
    // Overall Cloud off stays off regardless of a leftover valid value, in either direction.
    expect(parseServerConfig({ ...required, OPENTAG_CLOUD_RUNNER_ENABLED: "false" }).cloudRunner).toEqual({
      enabled: false,
    });
    expect(parseServerConfig({ ...required, OPENTAG_CLOUD_RUNNER_ENABLED: "true" }).cloudRunner).toEqual({
      enabled: false,
    });
    // A malformed nonempty value is a migration error, whether or not Cloud is enabled.
    for (const value of ["yes", "1", "TRUE"]) {
      expect(() => parseServerConfig({ ...required, OPENTAG_CLOUD_RUNNER_ENABLED: value })).toThrow(
        /OPENTAG_CLOUD_RUNNER_ENABLED is retired/,
      );
      expect(() => parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_ENABLED: value })).toThrow(
        /OPENTAG_CLOUD_RUNNER_ENABLED is retired/,
      );
    }
    // An empty leftover is treated as absent.
    expect(
      parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_ENABLED: "" }).cloudRunner,
    ).toMatchObject({ enabled: true });
    // The missing-coordinates error names the identities switch as the enabling cause.
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
        OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e3",
        OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
      }),
    ).toThrow(/OPENTAG_CLOUD_IDENTITIES_ENABLED=true enables the Cloud Runner/);
  });

  it("lets the overall Cloud switch dominate the sole secondary model switch", () => {
    const runnerEnv = {
      OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
      OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e4",
      OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
      OPENTAG_CLOUD_RUNNER_IMAGE: `us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner@sha256:${"a".repeat(64)}`,
      OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-test",
      OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
      OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-test.iam.gserviceaccount.com",
      OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://api.example.com",
      OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "opentag-net",
      OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "opentag-subnet",
      OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "opentag-runner",
    };
    const modelEnv = {
      OPENTAG_CLOUD_MODEL_ENABLED: "true",
      OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "https://models.example.com/v1",
      OPENTAG_CLOUD_MODEL_MASTER_KEY: "fixture-master-key-sentinel-9f1c0d",
    };
    // Overall switch off yields identities, Runner, and model all disabled even when every Runner
    // coordinate is present and the secondary model switch was left on.
    const overallOff = parseServerConfig({
      ...required,
      ...runnerEnv,
      ...modelEnv,
      OPENTAG_CLOUD_IDENTITIES_ENABLED: "false",
    });
    expect(overallOff.cloudIdentities).toEqual({ enabled: false });
    expect(overallOff.cloudRunner).toEqual({ enabled: false });
    expect(overallOff.cloudModel).toEqual({ enabled: false });
    // An opted-in model configuration is validated even while the overall switch is off: a staged
    // error fails this startup instead of the later deploy that enables Cloud.
    expect(() =>
      parseServerConfig({
        ...required,
        ...runnerEnv,
        OPENTAG_CLOUD_IDENTITIES_ENABLED: "false",
        OPENTAG_CLOUD_MODEL_ENABLED: "true",
      }),
    ).toThrow(/Cloud model proxy is enabled without OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL/);
    // The secondary model switch off stops model requests while Runner persistence, release, and
    // control stay available.
    const modelOff = parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_MODEL_ENABLED: "false" });
    expect(modelOff.cloudRunner).toMatchObject({ enabled: true });
    expect(modelOff.cloudModel).toEqual({ enabled: false });
    // Both switches on with complete configuration enables the model proxy.
    const modelOn = parseServerConfig({ ...required, ...runnerEnv, ...modelEnv });
    // The Router model catalog is the only model authority; no allowlist survives config load.
    expect(modelOn.cloudModel).toMatchObject({ enabled: true, upstreamBaseUrl: "https://models.example.com/v1" });
    expect(modelOn.cloudModel).not.toHaveProperty("allowedModels");
  });

  it("parses the E9 Cloud Runner capacity ceilings with conservative defaults", () => {
    const runnerEnv = {
      OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
      OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e9",
      OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
      OPENTAG_CLOUD_RUNNER_IMAGE: `us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner@sha256:${"a".repeat(64)}`,
      OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-test",
      OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
      OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-test.iam.gserviceaccount.com",
      OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://api.example.com",
      OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "opentag-net",
      OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "opentag-subnet",
      OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "opentag-runner",
    };
    // Defaults: 3 occupied Instances per Account, 20 platform-wide.
    const defaults = parseServerConfig({ ...required, ...runnerEnv });
    expect(defaults.cloudRunner).toMatchObject({ enabled: true, maxInstancesPerAccount: 3, maxInstances: 20 });
    // Explicit positive integers are honored.
    const tuned = parseServerConfig({
      ...required,
      ...runnerEnv,
      OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT: "2",
      OPENTAG_CLOUD_RUNNER_MAX_INSTANCES: "7",
    });
    expect(tuned.cloudRunner).toMatchObject({ maxInstancesPerAccount: 2, maxInstances: 7 });
    // Zero, negative, fractional and non-numeric ceilings are rejected at startup, never coerced.
    for (const value of ["0", "-1", "1.5", "many"]) {
      expect(() =>
        parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT: value }),
      ).toThrow();
      expect(() =>
        parseServerConfig({ ...required, ...runnerEnv, OPENTAG_CLOUD_RUNNER_MAX_INSTANCES: value }),
      ).toThrow();
    }
  });

  it("enables Cloud identities only with a valid storage prefix and Runner SemVer", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_CLOUD_IDENTITIES_ENABLED: "true" })).toThrow();
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
        OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e2",
      }),
    ).toThrow();
    // The overall switch also enables the Runner, so storage prefix and Runner SemVer alone are
    // not enough: without the complete Runner coordinates the enable is incomplete and fails.
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
        OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e2",
        OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
      }),
    ).toThrow(/Cloud Runner/);
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
        OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e2",
        OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
        OPENTAG_CLOUD_RUNNER_IMAGE: `us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner@sha256:${"a".repeat(64)}`,
        OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-test",
        OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
        OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-test.iam.gserviceaccount.com",
        OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://api.example.com",
        OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "opentag-net",
        OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "opentag-subnet",
        OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "opentag-runner",
      }).cloudIdentities,
    ).toEqual({
      enabled: true,
      storageBase: "gs://opentag-sandbox/e2",
      runnerVersion: "0.0.5",
    });
    for (const storageBase of [
      "https://bucket/prefix",
      "gs://user:pass@bucket/prefix",
      "gs://bucket/prefix?x=1",
      "gs://bucket/foo/../bar",
      "gs://bucket/./secret",
      "gs://bucket/prefix/",
      "gs://bucket/",
      "s3://bucket/prefix",
    ]) {
      expect(() => parseServerConfig({ ...required, OPENTAG_CLOUD_STORAGE_BASE: storageBase })).toThrow();
    }
    expect(() => parseServerConfig({ ...required, OPENTAG_CLOUD_RUNNER_VERSION: "not-semver" })).toThrow();
    expect(parseCloudStorageBase("gs://opentag-sandbox")).toBe("gs://opentag-sandbox");
    expect(parseCloudStorageBase("gs://bucket/foo/../bar")).toBeUndefined();
  });

  it("offers Internal Tools only after an explicit loopback development opt-in", () => {
    const localPreview = { ...required, OPENTAG_ENV: "dev", OPENTAG_DEV_INTERNAL_TOOLS_ENABLED: "true" };
    expect(parseServerConfig(localPreview).internalTools).toBe(true);
    expect(parseServerConfig({ ...localPreview, OPENTAG_DEV_INTERNAL_TOOLS_ENABLED: "false" }).internalTools).toBe(
      false,
    );
    for (const override of [
      { OPENTAG_ENV: undefined },
      { OPENTAG_ENV: "prod", OPENTAG_PUBLIC_URL: "https://example.com" },
      { OPENTAG_ENV: "staging", OPENTAG_PUBLIC_URL: "https://staging.example.com" },
      { OPENTAG_HOST: "0.0.0.0" },
      { OPENTAG_PUBLIC_URL: "http://example.com" },
    ]) {
      expect(() => parseServerConfig({ ...localPreview, ...override })).toThrow();
    }
  });

  it("accepts the configured server log level and rejects unknown levels", () => {
    expect(parseServerConfig({ ...required, OPENTAG_LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(() => parseServerConfig({ ...required, OPENTAG_LOG_LEVEL: "verbose" })).toThrow();
  });

  it("keeps the legacy encryption defaults and fully validates the v2 key ring opt-in", () => {
    const ringKey = Buffer.alloc(32, 23).toString("base64");
    const retiredKey = Buffer.alloc(32, 11).toString("base64");
    // Defaults: no ring, v1 writes, and the single legacy key keeps working untouched.
    const defaults = parseServerConfig(required);
    expect(defaults.encryptionKeyRing).toBeUndefined();
    expect(defaults.imCredentialEncryptionWriteVersion).toBe(1);
    expect([...defaults.encryptionKey]).toEqual([...Buffer.alloc(32, 7)]);

    const configured = parseServerConfig({
      ...required,
      OPENTAG_ENCRYPTION_KEY_RING: JSON.stringify({ "im-2026-08": retiredKey, "im-2026-09": ringKey }),
      OPENTAG_ENCRYPTION_ACTIVE_KEY_ID: "im-2026-09",
      OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION: "2",
    });
    expect(configured.encryptionKeyRing?.activeKeyId).toBe("im-2026-09");
    expect(configured.encryptionKeyRing?.keys.get("im-2026-09")).toEqual(new Uint8Array(Buffer.alloc(32, 23)));
    expect(configured.imCredentialEncryptionWriteVersion).toBe(2);

    // Ring and active key are coupled; the active key must be in the ring; v2 writes need a ring.
    expect(() => parseServerConfig({ ...required, OPENTAG_ENCRYPTION_ACTIVE_KEY_ID: "im-2026-09" })).toThrow();
    expect(() =>
      parseServerConfig({ ...required, OPENTAG_ENCRYPTION_KEY_RING: JSON.stringify({ main: ringKey }) }),
    ).toThrow();
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_ENCRYPTION_KEY_RING: JSON.stringify({ main: ringKey }),
        OPENTAG_ENCRYPTION_ACTIVE_KEY_ID: "other",
      }),
    ).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION: "2" })).toThrow();
    expect(() =>
      parseServerConfig({
        ...required,
        OPENTAG_ENCRYPTION_KEY_RING: JSON.stringify({ main: ringKey }),
        OPENTAG_ENCRYPTION_ACTIVE_KEY_ID: "main",
        OPENTAG_IM_CREDENTIAL_ENCRYPTION_WRITE_VERSION: "3",
      }),
    ).toThrow();

    // Malformed rings fail closed without echoing key material.
    for (const ring of [
      "not-json",
      "[]",
      "{}",
      JSON.stringify({ "BAD ID": ringKey }),
      JSON.stringify({ main: "not-base64" }),
      JSON.stringify({ main: Buffer.alloc(16).toString("base64") }),
      JSON.stringify({ main: `${ringKey}==` }),
      JSON.stringify({ main: 42 }),
    ]) {
      expect(() =>
        parseServerConfig({
          ...required,
          OPENTAG_ENCRYPTION_KEY_RING: ring,
          OPENTAG_ENCRYPTION_ACTIVE_KEY_ID: "main",
        }),
      ).toThrow();
    }
  });

  it("defaults the channel target coordinates to the public release endpoint", () => {
    expect(parseServerConfig(required).channelTarget).toEqual({
      downloadBaseUrl: "https://dl.opentag.build/releases",
      pollIntervalMs: 300_000,
    });
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: "https://mirror.example.com/releases/",
        OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS: "60000",
      }).channelTarget,
    ).toEqual({ downloadBaseUrl: "https://mirror.example.com/releases", pollIntervalMs: 60_000 });
  });

  it("rejects channel target coordinates that are not plain HTTP(S) URLs", () => {
    for (const downloadBaseUrl of [
      "ftp://download.example.com/releases",
      ["https://user", ":secret@download.example.com/releases"].join(""),
      "https://download.example.com/releases?x=1",
      "not-a-url",
    ]) {
      expect(() => parseServerConfig({ ...required, OPENTAG_PORTABLE_DOWNLOAD_BASE_URL: downloadBaseUrl })).toThrow();
    }
    expect(() => parseServerConfig({ ...required, OPENTAG_CHANNEL_TARGET_POLL_INTERVAL_MS: "10" })).toThrow();
  });

  it("enables development sign-in only with an explicit existing-user email and loopback server", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: " ADMIN@Example.com ",
        OPENTAG_ENV: "dev",
      }),
    ).toMatchObject({ devAuth: { email: "admin@example.com" }, environment: "dev" });

    for (const invalid of [
      { OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true", OPENTAG_DEV_AUTH_EMAIL: "admin@example.com" },
      { OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true" },
      { OPENTAG_DEV_AUTH_EMAIL: "admin@example.com" },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://dev.example.com",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://localhost:8000",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "dev",
        OPENTAG_HOST: "0.0.0.0",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "dev",
        OPENTAG_PUBLIC_URL: "http://192.0.2.10:8000",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
  });

  it("requires complete first-party Slack OAuth configuration and a callback on this origin", () => {
    const slack = {
      OPENTAG_SLACK_CLIENT_ID: "slack-client-id",
      OPENTAG_SLACK_CLIENT_SECRET: "slack-client-secret",
      OPENTAG_SLACK_SIGNING_SECRET: "slack-signing-secret",
      OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000/api/v1/im-bindings/slack/oauth/callback",
    };
    expect(parseServerConfig({ ...required, ...slack }).slackOAuth).toEqual({
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
      signingSecret: "slack-signing-secret",
      redirectUrl: "http://localhost:8000/api/v1/im-bindings/slack/oauth/callback",
    });
    expect(
      parseServerConfig({
        ...required,
        ...slack,
        OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000",
      }).slackOAuth?.redirectUrl,
    ).toBe("http://localhost:8000/api/v1/im-bindings/slack/oauth/callback");
    expect(parseServerConfig(required).slackOAuth).toBeUndefined();
    expect(
      parseServerConfig({ ...required, OPENTAG_SLACK_CLIENT_ID: "", OPENTAG_SLACK_CLIENT_SECRET: "" }).slackOAuth,
    ).toBe(undefined);

    for (const invalid of [
      { OPENTAG_SLACK_CLIENT_ID: "slack-client-id" },
      { ...slack, OPENTAG_SLACK_REDIRECT_URL: "https://evil.example/api/v1/im-bindings/slack/oauth/callback" },
      { ...slack, OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000/api/v1/auth/google/callback" },
      {
        ...slack,
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://opentag.example.com",
        OPENTAG_SLACK_REDIRECT_URL: "http://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
  });

  it("requires complete GitHub App configuration and a callback on this origin", () => {
    const github = {
      OPENTAG_GITHUB_APP_ID: "871235",
      OPENTAG_GITHUB_APP_CLIENT_ID: "Iv1.githubclient",
      OPENTAG_GITHUB_APP_CLIENT_SECRET: "github-client-secret",
      OPENTAG_GITHUB_APP_PRIVATE_KEY: githubAppPrivateKeyPem,
      OPENTAG_GITHUB_APP_WEBHOOK_SECRET: "github-webhook-secret",
    };
    const configured = parseServerConfig({ ...required, ...github });
    expect(configured.githubApp).toMatchObject({
      appId: "871235",
      clientId: "Iv1.githubclient",
      clientSecret: "github-client-secret",
      webhookSecret: "github-webhook-secret",
      oauthCallbackUrl: "http://localhost:8000/api/v1/integrations/github/oauth/callback",
    });
    expect(configured.githubApp?.privateKey).toContain("-----BEGIN");
    expect(
      parseServerConfig({
        ...required,
        ...github,
        OPENTAG_GITHUB_OAUTH_REDIRECT_URL: "http://localhost:8000",
      }).githubApp?.oauthCallbackUrl,
    ).toBe("http://localhost:8000/api/v1/integrations/github/oauth/callback");
    expect(
      parseServerConfig({
        ...required,
        ...github,
        OPENTAG_GITHUB_OAUTH_REDIRECT_URL: "http://localhost:8000/api/v1/integrations/github/oauth/callback",
      }).githubApp?.oauthCallbackUrl,
    ).toBe("http://localhost:8000/api/v1/integrations/github/oauth/callback");
    // A base64-encoded PEM configures identically to the literal form.
    expect(
      parseServerConfig({
        ...required,
        ...github,
        OPENTAG_GITHUB_APP_PRIVATE_KEY: Buffer.from(githubAppPrivateKeyPem, "utf8").toString("base64"),
      }).githubApp?.privateKey,
    ).toBe(configured.githubApp?.privateKey);
    expect(parseServerConfig(required).githubApp).toBeUndefined();

    for (const invalid of [
      { OPENTAG_GITHUB_APP_ID: "871235" },
      { ...github, OPENTAG_GITHUB_APP_WEBHOOK_SECRET: undefined },
      { ...github, OPENTAG_GITHUB_APP_ID: "not-decimal" },
      { ...github, OPENTAG_GITHUB_APP_PRIVATE_KEY: "not-a-pem" },
      {
        ...github,
        OPENTAG_GITHUB_OAUTH_REDIRECT_URL: "https://evil.example/api/v1/integrations/github/oauth/callback",
      },
      { ...github, OPENTAG_GITHUB_OAUTH_REDIRECT_URL: "http://localhost:8000/api/v1/auth/google/callback" },
      {
        ...github,
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://opentag.example.com",
        OPENTAG_GITHUB_OAUTH_REDIRECT_URL: "http://opentag.example.com/api/v1/integrations/github/oauth/callback",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
    // The all-or-none error never echoes configured material.
    try {
      parseServerConfig({ ...required, OPENTAG_GITHUB_APP_CLIENT_SECRET: "github-client-secret" });
      expect.unreachable("partial GitHub App configuration must fail");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("github-client-secret");
    }
  });

  it("requires complete Google configuration and HTTPS in hosted environments", () => {
    expect(isHostedEnvironment("dev")).toBe(false);
    expect(isHostedEnvironment("staging")).toBe(true);
    expect(isHostedEnvironment("prod")).toBe(true);
    expect(() => parseServerConfig({ ...required, OPENTAG_GOOGLE_CLIENT_ID: "client" })).toThrow();
    for (const environment of ["staging", "prod"] as const) {
      expect(() => parseServerConfig({ ...required, OPENTAG_ENV: environment })).toThrow();
      expect(
        parseServerConfig({
          ...required,
          OPENTAG_ENV: environment,
          OPENTAG_PUBLIC_URL: environment === "staging" ? "https://dev.example.com" : "https://opentag.example.com",
          OPENTAG_GOOGLE_CLIENT_ID: "client",
          OPENTAG_GOOGLE_CLIENT_SECRET: "secret",
        }),
      ).toMatchObject({
        environment,
        google: { clientId: "client", clientSecret: "secret" },
      });
    }
  });

  it("uses OPENTAG_ENV as the channel source without interpreting the hostname", () => {
    const config = parseServerConfig({
      ...required,
      OPENTAG_ENV: "staging",
      OPENTAG_PUBLIC_URL: "https://dev.example.com",
    });
    expect(serverEnvironmentSummary(config)).toEqual({
      binName: "opentag-staging",
      channel: "staging",
      cloud: { identities: false, runner: false, model: false },
      environment: "staging",
      packageName: "open-tag-staging",
      publicUrl: "https://dev.example.com",
    });
  });

  it("reports the effective Cloud toggles in the startup summary without coordinates or key material", () => {
    const summary = serverEnvironmentSummary(
      parseServerConfig({
        ...required,
        OPENTAG_CLOUD_IDENTITIES_ENABLED: "true",
        OPENTAG_CLOUD_STORAGE_BASE: "gs://opentag-sandbox/e9",
        OPENTAG_CLOUD_RUNNER_VERSION: "0.0.5",
        OPENTAG_CLOUD_RUNNER_IMAGE: `us-west1-docker.pkg.dev/opentag-test/runners/opentag-runner@sha256:${"a".repeat(64)}`,
        OPENTAG_CLOUD_RUNNER_PROJECT: "opentag-test",
        OPENTAG_CLOUD_RUNNER_REGION: "us-west1",
        OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT: "runner@opentag-test.iam.gserviceaccount.com",
        OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN: "https://api.example.com",
        OPENTAG_CLOUD_RUNNER_VPC_NETWORK: "opentag-net",
        OPENTAG_CLOUD_RUNNER_VPC_SUBNET: "opentag-subnet",
        OPENTAG_CLOUD_RUNNER_EXECUTION_TAG: "opentag-runner",
        OPENTAG_CLOUD_MODEL_ENABLED: "true",
        OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL: "https://models.example.com/v1",
        OPENTAG_CLOUD_MODEL_MASTER_KEY: "fixture-master-key-sentinel-9f1c0d",
      }),
    );
    expect(summary.cloud).toEqual({ identities: true, runner: true, model: true });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("opentag-test");
    expect(serialized).not.toContain("fixture-master-key-sentinel");
  });

  it("rejects legacy or parallel environment values", () => {
    for (const environment of ["development", "production", "test"]) {
      expect(() => parseServerConfig({ ...required, OPENTAG_ENV: environment })).toThrow();
    }
  });

  it("rejects invalid ports, secrets, and database protocols", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_PORT: "0" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_JWT_SECRET: "short" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_DATABASE_URL: "https://example.com" })).toThrow();
  });

  it("requires a Better Auth secret that is independent of the legacy JWT secret", () => {
    expect(parseServerConfig(required).betterAuthSecret).toBe(required.BETTER_AUTH_SECRET);
    expect(parseServerConfig(required).betterAuthSecret).not.toBe(parseServerConfig(required).jwtSecret);

    const { BETTER_AUTH_SECRET: _omitted, ...withoutSecret } = required;
    expect(() => parseServerConfig(withoutSecret)).toThrow();
    expect(() => parseServerConfig({ ...required, BETTER_AUTH_SECRET: "short" })).toThrow();
    expect(() => parseServerConfig({ ...required, BETTER_AUTH_SECRET: required.OPENTAG_JWT_SECRET })).toThrow();
  });

  it("parses optional OTLP tracing configuration and validates its bounds", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_OTEL_ENDPOINT: "https://logfire-us.pydantic.dev/v1/traces",
        OPENTAG_OTEL_HEADERS: "Authorization=Bearer pylf_test",
        OPENTAG_OTEL_ENVIRONMENT: "production",
        OPENTAG_OTEL_SAMPLE_RATE: "0.25",
      }).observability.tracing,
    ).toEqual({
      endpoint: "https://logfire-us.pydantic.dev/v1/traces",
      headers: "Authorization=Bearer pylf_test",
      environment: "production",
      sampleRate: 0.25,
    });
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_SAMPLE_RATE: "1.1" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_ENDPOINT: "file:///tmp/traces" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_ENDPOINT: "https://user:pass@example.com" })).toThrow();
  });

  it("reads the optional Google Cloud project for error reporting and treats blank as unset", () => {
    expect(parseServerConfig(required).observability.errorReporting).toEqual({});
    expect(parseServerConfig({ ...required, GOOGLE_CLOUD_PROJECT: "  " }).observability.errorReporting).toEqual({});
    expect(
      parseServerConfig({ ...required, GOOGLE_CLOUD_PROJECT: " opentag-staging " }).observability.errorReporting,
    ).toEqual({ projectId: "opentag-staging" });
  });

  it("reads a service account key from the environment without echoing it on failure", () => {
    const keyType = ["service", "account"].join("_");
    const key = JSON.stringify({
      type: keyType,
      project_id: "key-project",
      client_email: "relay@key-project.example",
      private_key: "placeholder-private-key",
    });
    const credentials = {
      client_email: "relay@key-project.example",
      private_key: "placeholder-private-key",
      project_id: "key-project",
    };
    expect(
      parseServerConfig({ ...required, OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON: key }).observability.errorReporting,
    ).toEqual({ projectId: "key-project", credentials });
    expect(
      parseServerConfig({
        ...required,
        GOOGLE_CLOUD_PROJECT: "explicit-project",
        OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON: key,
      }).observability.errorReporting,
    ).toEqual({ projectId: "explicit-project", credentials });
    expect(
      parseServerConfig({ ...required, OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON: " " }).observability.errorReporting,
    ).toEqual({});

    const invalid = '{"private_key":"placeholder-private-key-value"';
    expect(() => parseServerConfig({ ...required, OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON: invalid })).toThrow(
      /OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON must be a Google service account key/,
    );
    try {
      parseServerConfig({ ...required, OPENTAG_ERROR_REPORTING_CREDENTIALS_JSON: invalid });
    } catch (error) {
      expect(String(error)).not.toContain("placeholder-private-key-value");
    }
  });

  it("reads which reverse proxies are trusted, defaulting to none", () => {
    expect(parseServerConfig(required).trustProxy).toBe(false);
    expect(parseServerConfig({ ...required, OPENTAG_TRUST_PROXY: "uniquelocal" }).trustProxy).toEqual(["uniquelocal"]);
    expect(parseServerConfig({ ...required, OPENTAG_TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(() => parseServerConfig({ ...required, OPENTAG_TRUST_PROXY: "1" })).toThrow(/OPENTAG_TRUST_PROXY/);
  });

  it("allows migration commands to parse only their database dependency", () => {
    expect(parseDatabaseConfig({ OPENTAG_DATABASE_URL: required.OPENTAG_DATABASE_URL })).toMatchObject({
      databaseUrl: required.OPENTAG_DATABASE_URL,
    });
  });
});

function mockSql(handler: (query: string, values: readonly unknown[]) => unknown | Promise<unknown>) {
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => handler(strings.join(""), values)),
    { end: vi.fn(async () => undefined) },
  );
  vi.mocked(postgres).mockReturnValue(sql as never);
  return sql;
}

describe("database migration helpers", () => {
  it("creates a PostgreSQL Drizzle client with the configured pool size", async () => {
    const sql = mockSql(() => []);
    const client = createDatabaseClient("postgresql://localhost/opentag", { max: 3 });

    expect(postgres).toHaveBeenLastCalledWith("postgresql://localhost/opentag", {
      max: 3,
      onnotice: expect.any(Function),
    });
    expect(client.database).toBeDefined();
    expect(client.sql).toBe(sql);
    await client.sql.end();
  });

  it("preserves non-Zod parser failures and returns no unauthenticated identity", async () => {
    const failure = new Error("parser failed");
    expect(() =>
      parseRequest(
        {
          parse: () => {
            throw failure;
          },
        },
        {},
      ),
    ).toThrow(failure);
    await expect(resolveAuthenticatedUserId({ headers: {} } as never, {} as never)).resolves.toBeUndefined();
  });

  it("rejects missing machine credentials and verifies a non-empty bearer token", async () => {
    const verifyMachineToken = vi.fn().mockResolvedValue({ computerId: "computer" });
    const handler = createComputerAuthPreHandler({ verifyMachineToken });
    await expect(handler({ headers: {} } as never, {} as never)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      statusCode: 401,
    });
    await expect(handler({ headers: { authorization: "Bearer " } } as never, {} as never)).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      statusCode: 401,
    });
    const request = { headers: { authorization: "Bearer machine-token" } } as {
      headers: { authorization: string };
      computerAuthContext?: unknown;
    };
    await handler(request as never, {} as never);
    expect(verifyMachineToken).toHaveBeenCalledWith("machine-token");
    expect(request.computerAuthContext).toEqual({ computerId: "computer" });
  });

  it("releases the advisory lock after a successful operation", async () => {
    const sql = mockSql(() => []);
    const result = await withMigrationLock(sql as never, async () => "migrated");

    expect(result).toBe("migrated");
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.mock.calls[0]?.[1]).toBe(MIGRATION_ADVISORY_LOCK_ID);
    expect(sql.mock.calls[1]?.[1]).toBe(MIGRATION_ADVISORY_LOCK_ID);
  });

  it("releases the advisory lock and closes the connection after migration failure", async () => {
    const sql = mockSql(() => []);
    vi.mocked(migrate).mockRejectedValueOnce(new Error("migration failed"));

    await expect(migrateDatabase("postgresql://localhost/opentag", "/tmp/drizzle")).rejects.toThrow("migration failed");
    expect(drizzle).toHaveBeenCalledWith(sql);
    expect(migrate).toHaveBeenCalledWith({ kind: "database" }, { migrationsFolder: "/tmp/drizzle" });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.end).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty", [{ migration_table: null }], [], "The database has not been migrated"],
    [
      "behind",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [{ hash: "h1", created_at: "1" }],
      "The database is behind the checked-in migrations",
    ],
    [
      "diverged",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [
        { hash: "h1", created_at: "1" },
        { hash: "h2", created_at: "2" },
        { hash: "h3", created_at: "3" },
      ],
      "The database has migrations unknown to this server build",
    ],
    [
      "hash mismatch",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [
        { hash: "wrong", created_at: "1" },
        { hash: "h2", created_at: "2" },
      ],
      "The database migration history does not match this build",
    ],
    [
      "timestamp mismatch",
      [{ migration_table: "drizzle.__drizzle_migrations" }],
      [
        { hash: "h1", created_at: "9" },
        { hash: "h2", created_at: "2" },
      ],
      "The database migration history does not match this build",
    ],
  ])("classifies %s migration state", async (reason, relation, applied, message) => {
    vi.mocked(readMigrationFiles).mockReturnValue([
      { hash: "h1", folderMillis: 1, sql: "" },
      { hash: "h2", folderMillis: 2, sql: "" },
    ] as never);
    const sql = mockSql((query) => {
      if (query.includes("to_regclass")) return relation;
      if (query.includes("from drizzle.__drizzle_migrations")) return applied;
      return [];
    });

    const result = verifyDatabaseMigrations("postgresql://localhost/opentag", "/tmp/drizzle");
    await expect(result).rejects.toBeInstanceOf(MigrationVerificationError);
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.toMatchObject({
      reason:
        reason === "empty" ? "empty" : reason === "behind" ? "behind" : reason === "diverged" ? "diverged" : "diverged",
    });
    expect(sql.end).toHaveBeenCalledOnce();
  });

  it("accepts an exact migration ledger and wraps database failures as unreachable", async () => {
    vi.mocked(readMigrationFiles).mockReturnValue([
      { hash: "h1", folderMillis: 1, sql: "" },
      { hash: "h2", folderMillis: 2, sql: "" },
    ] as never);
    const sql = mockSql((query) => {
      if (query.includes("to_regclass")) return [{ migration_table: "drizzle.__drizzle_migrations" }];
      if (query.includes("from drizzle.__drizzle_migrations")) {
        return [
          { hash: "h1", created_at: "1" },
          { hash: "h2", created_at: "2" },
        ];
      }
      return [];
    });
    await expect(verifyDatabaseMigrations("postgresql://localhost/opentag", "/tmp/drizzle")).resolves.toBeUndefined();
    expect(sql.end).toHaveBeenCalledOnce();

    const failureSql = mockSql(() => {
      throw new Error("connection refused");
    });
    const unreachable = verifyDatabaseMigrations("postgresql://localhost/opentag", "/tmp/drizzle");
    await expect(unreachable).rejects.toMatchObject({
      name: "MigrationVerificationError",
      reason: "unreachable",
      cause: expect.objectContaining({ message: "connection refused" }),
    });
    expect(failureSql.end).toHaveBeenCalledOnce();
  });

  it("runs the migration CLI with only the database config", async () => {
    vi.resetModules();
    const migrateDatabaseMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../db/migrate.js", () => ({ migrateDatabase: migrateDatabaseMock }));
    const previousUrl = process.env.OPENTAG_DATABASE_URL;
    process.env.OPENTAG_DATABASE_URL = "postgresql://localhost/opentag";
    try {
      await import("../db/migrate-cli.js");
    } finally {
      if (previousUrl === undefined) delete process.env.OPENTAG_DATABASE_URL;
      else process.env.OPENTAG_DATABASE_URL = previousUrl;
      vi.doUnmock("../db/migrate.js");
    }
    expect(migrateDatabaseMock).toHaveBeenCalledWith(
      "postgresql://localhost/opentag",
      expect.stringContaining("/drizzle"),
    );
  });
});

const skillStorageEnvironment = {
  OPENTAG_SKILL_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  OPENTAG_SKILL_STORAGE_REGION: "us-east-1",
  OPENTAG_SKILL_STORAGE_BUCKET: "opentag-skills",
  OPENTAG_SKILL_STORAGE_ACCESS_KEY_ID: "opentag",
  OPENTAG_SKILL_STORAGE_SECRET_ACCESS_KEY: "opentag-minio-dev",
};

describe("Skill storage configuration", () => {
  it("is disabled by default", () => {
    expect(parseServerConfig(required).skillStorage).toEqual({ enabled: false });
  });

  it("resolves the full group with prefix and path-style defaults", () => {
    expect(parseServerConfig({ ...required, ...skillStorageEnvironment }).skillStorage).toEqual({
      enabled: true,
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "opentag-skills",
      accessKeyId: "opentag",
      secretAccessKey: "opentag-minio-dev",
      prefix: "skills",
      forcePathStyle: true,
      gcIntervalSeconds: 3600,
      gcGraceSeconds: 86400,
    });
    expect(
      parseServerConfig({
        ...required,
        ...skillStorageEnvironment,
        OPENTAG_SKILL_STORAGE_PREFIX: "bundles",
        OPENTAG_SKILL_STORAGE_FORCE_PATH_STYLE: "false",
      }).skillStorage,
    ).toMatchObject({ prefix: "bundles", forcePathStyle: false });
  });

  it("defaults the GC window, allows disabling it, and floors the grace period", () => {
    expect(parseServerConfig({ ...required, ...skillStorageEnvironment }).skillStorage).toMatchObject({
      gcIntervalSeconds: 3600,
      gcGraceSeconds: 86400,
    });
    expect(
      parseServerConfig({
        ...required,
        ...skillStorageEnvironment,
        OPENTAG_SKILL_STORAGE_GC_INTERVAL_SECONDS: "0",
      }).skillStorage,
    ).toMatchObject({ gcIntervalSeconds: 0 });
    expect(() =>
      parseServerConfig({
        ...required,
        ...skillStorageEnvironment,
        OPENTAG_SKILL_STORAGE_GC_GRACE_SECONDS: "299",
      }),
    ).toThrow();
  });

  it("normalizes the object-key prefix and rejects a traversal at parse time", () => {
    for (const [raw, expected] of [
      ["skills/", "skills"],
      ["/skills", "skills"],
      ["//skills//", "skills"],
      ["skills//nested/", "skills/nested"],
    ] as const) {
      expect(
        parseServerConfig({ ...required, ...skillStorageEnvironment, OPENTAG_SKILL_STORAGE_PREFIX: raw }).skillStorage,
      ).toMatchObject({ prefix: expected });
    }
    for (const raw of ["/", "a/../b", "a b"]) {
      expect(() =>
        parseServerConfig({ ...required, ...skillStorageEnvironment, OPENTAG_SKILL_STORAGE_PREFIX: raw }),
      ).toThrow(/OPENTAG_SKILL_STORAGE_PREFIX/);
    }
  });

  it("allows a base path but rejects a partial group and a bad endpoint", () => {
    expect(
      parseServerConfig({
        ...required,
        ...skillStorageEnvironment,
        OPENTAG_SKILL_STORAGE_ENDPOINT: "https://s3.example.test/gateway",
      }).skillStorage,
    ).toMatchObject({ enabled: true, endpoint: "https://s3.example.test/gateway" });

    const partial = {
      OPENTAG_SKILL_STORAGE_ENDPOINT: skillStorageEnvironment.OPENTAG_SKILL_STORAGE_ENDPOINT,
      OPENTAG_SKILL_STORAGE_REGION: skillStorageEnvironment.OPENTAG_SKILL_STORAGE_REGION,
      OPENTAG_SKILL_STORAGE_BUCKET: skillStorageEnvironment.OPENTAG_SKILL_STORAGE_BUCKET,
      OPENTAG_SKILL_STORAGE_ACCESS_KEY_ID: skillStorageEnvironment.OPENTAG_SKILL_STORAGE_ACCESS_KEY_ID,
    };
    expect(() => parseServerConfig({ ...required, ...partial })).toThrow();

    for (const endpoint of [
      "ftp://minio.example.test",
      "http://user:pass@minio.example.test",
      "http://minio.example.test/?token=1",
      "not-a-url",
    ]) {
      expect(() =>
        parseServerConfig({ ...required, ...skillStorageEnvironment, OPENTAG_SKILL_STORAGE_ENDPOINT: endpoint }),
      ).toThrow();
    }
  });
});
