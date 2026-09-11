import { createHash } from "node:crypto";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { skillArchivePath } from "@opentag/shared";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import type { SkillStorageConfig } from "../../config.js";
import { createDatabaseClient } from "../../db/client.js";
import type { UserAuthService } from "../../services/auth/index.js";
import {
  createS3SkillBlobClient,
  S3SkillBlobStore,
  SkillAssignmentService,
  SkillService,
} from "../../services/skills/index.js";
import { validSkillZip } from "../support/skill-fixtures.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The object storage round trip against a real S3-compatible endpoint: PGlite unit tests cover the service logic
 * with an in-memory store, so this suite only asserts what MinIO can prove — objects appear, are replaced, and vanish.
 */

let testDatabase: MigratedTestDatabase;
let minio: StartedMinioContainer;
let storageConfig: SkillStorageConfig;
let store: S3SkillBlobStore;
const clients: Array<{ end(): Promise<void> }> = [];

beforeAll(async () => {
  [testDatabase, minio] = await Promise.all([
    startMigratedTestDatabase(),
    new MinioContainer("minio/minio:latest").start(),
  ]);
  storageConfig = {
    bucket: "opentag-skills-test",
    endpoint: minio.getConnectionUrl(),
    region: "us-east-1",
    accessKeyId: minio.getUsername(),
    secretAccessKey: minio.getPassword(),
    prefix: "skills/",
    forcePathStyle: true,
  };
  const client = createS3SkillBlobClient(storageConfig);
  await client.send(new CreateBucketCommand({ Bucket: storageConfig.bucket }));
  store = S3SkillBlobStore.fromConfig(storageConfig, client);
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.end()));
  await Promise.all([testDatabase?.stop(), minio?.stop()]);
});

beforeEach(async () => testDatabase.reset());

async function fixture() {
  const { database, sql } = createDatabaseClient(testDatabase.databaseUrl);
  clients.push(sql);
  const { userId } = await bootstrapInitialAdmin(database, { displayName: "Admin", email: "admin@example.com" });
  return { database, userId, service: new SkillService(database, store) };
}

function authService(userId: string): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: { user: { id: userId, email: "admin@example.com", displayName: "Admin" }, setupCompletedAt: null },
    }),
  };
}

describe("skill storage against MinIO", () => {
  it("writes, replaces, and deletes archive objects alongside the database rows", async () => {
    const { userId, service } = await fixture();
    await store.healthCheck();

    const created = await service.upsertFromArchive(userId, validSkillZip("round-trip"), {
      onConflict: "fail",
      updatedBy: { kind: "user", id: userId },
    });
    const listed = await store.list(`${userId}/`);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.key.endsWith(`/${created.skill.digest}.zip`)).toBe(true);
    expect(await store.head(listed[0]?.key ?? "")).toMatchObject({ size: created.skill.archiveBytes });

    const replaced = await service.upsertFromArchive(userId, validSkillZip("round-trip", { "extra.md": "# more" }), {
      onConflict: "replace",
      updatedBy: { kind: "user", id: userId },
    });
    const afterReplace = await store.list(`${userId}/`);
    expect(afterReplace).toHaveLength(1);
    expect(afterReplace[0]?.key.endsWith(`/${replaced.skill.digest}.zip`)).toBe(true);
    expect(await store.head(listed[0]?.key ?? "")).toBeUndefined();

    await service.delete(userId, "round-trip");
    expect(await store.list(`${userId}/`)).toEqual([]);
  });

  it("streams a near-limit archive through the HTTP route byte for byte", async () => {
    const { database, userId, service } = await fixture();
    const payload = new Uint8Array(4 * 1024 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 2654435761) >>> 24;
    const upload = validSkillZip("large", { "data/blob.bin": payload });
    expect(upload.byteLength).toBeGreaterThan(3 * 1024 * 1024);
    const { skill } = await service.upsertFromArchive(userId, upload, {
      onConflict: "fail",
      updatedBy: { kind: "user", id: userId },
    });

    const app = createApp({
      authService: authService(userId),
      skills: { skills: service, assignments: new SkillAssignmentService(database) },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: skillArchivePath("large"),
        headers: { authorization: "Bearer access" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-length"]).toBe(String(skill.archiveBytes));
      expect(response.rawPayload.byteLength).toBe(skill.archiveBytes);
      expect(createHash("sha256").update(response.rawPayload).digest("hex")).toBe(skill.archiveSha256);
    } finally {
      await app.close();
    }
  });
});
