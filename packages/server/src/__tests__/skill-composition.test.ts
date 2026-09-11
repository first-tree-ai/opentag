import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { composeSkillServices, skillStorageSecretValues } from "../services/skills/index.js";

const serviceLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const registry = { currentInstanceId: vi.fn(), supportsCapability: vi.fn(), send: vi.fn() };

describe("composeSkillServices", () => {
  it("composes nothing without a bucket so the routes answer 503, and start/stop are no-ops", () => {
    const composition = composeSkillServices({
      config: {},
      database: {} as DatabaseClient,
      registry,
      serviceLogger,
    });
    expect(composition.appOptions).toEqual({});
    const log = { info: vi.fn(), error: vi.fn() };
    composition.start(log as never);
    composition.stop();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("wires the services, notifier, and sweeper when a bucket is configured", () => {
    const composition = composeSkillServices({
      config: {
        skillStorage: {
          bucket: "opentag-skills",
          endpoint: "http://127.0.0.1:1",
          region: "auto",
          accessKeyId: "id",
          secretAccessKey: "secret",
          prefix: "skills/",
          forcePathStyle: true,
        },
      },
      database: {} as DatabaseClient,
      registry,
      serviceLogger,
    });
    expect(composition.appOptions.skills?.skills).toBeDefined();
    expect(composition.appOptions.skills?.assignments).toBeDefined();
    expect(composition.appOptions.skills?.notifier).toBeDefined();
    composition.stop();
  });

  it("reports only the configured storage secrets for startup redaction", () => {
    expect(skillStorageSecretValues({})).toEqual([]);
    expect(
      skillStorageSecretValues({
        OPENTAG_SKILL_STORAGE_S3_ACCESS_KEY_ID: "id",
        OPENTAG_SKILL_STORAGE_S3_SECRET_ACCESS_KEY: "",
      }),
    ).toEqual(["id"]);
  });
});
