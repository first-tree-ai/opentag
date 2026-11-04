import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  migrate: vi.fn(),
  runtime: vi.fn(),
  start: vi.fn(),
  sharedStop: vi.fn(),
  disposableStop: vi.fn(),
}));
vi.mock("../db/migrate.js", () => ({ migrateDatabase: mocks.migrate }));
vi.mock("testcontainers", () => ({ getContainerRuntimeClient: mocks.runtime }));
vi.mock("./integration/local-test-database.js", () => ({ acquireLocalTestDatabase: mocks.acquire }));
vi.mock("./integration/postgres-test-container.js", () => ({ startPostgresTestContainer: mocks.start }));

import { startMigratedTestDatabase } from "./integration/migrated-test-database.js";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CI", "");
  mocks.runtime.mockResolvedValue({ info: { containerRuntime: { host: "localhost" } } });
  mocks.acquire.mockResolvedValue({ databaseUrl: "postgres://shared/opentag", stop: mocks.sharedStop });
  mocks.start.mockResolvedValue({ getConnectionUri: () => "postgres://disposable/test", stop: mocks.disposableStop });
});
afterEach(() => vi.unstubAllEnvs());

describe("integration database selection", () => {
  it("reuses the local logical database and migration ledger without resetting data", async () => {
    const fixture = await startMigratedTestDatabase();
    expect(fixture.databaseUrl).toBe("postgres://shared/opentag");
    expect(mocks.migrate).toHaveBeenCalledWith(fixture.databaseUrl, expect.any(String));
    expect(mocks.start).not.toHaveBeenCalled();
    await fixture.stop();
    expect(mocks.sharedStop).toHaveBeenCalledOnce();
    expect(mocks.disposableStop).not.toHaveBeenCalled();
  });

  it.each(["postgres:16-alpine", { disposable: true } as const])(
    "uses a disposable database for %j",
    async (options) => {
      const fixture = await startMigratedTestDatabase(options);
      expect(fixture.databaseUrl).toBe("postgres://disposable/test");
      expect(mocks.acquire).not.toHaveBeenCalled();
      expect(mocks.runtime).not.toHaveBeenCalled();
      await fixture.stop();
      expect(mocks.disposableStop).toHaveBeenCalledOnce();
    },
  );

  it("preserves disposable CI fixtures", async () => {
    vi.stubEnv("CI", "true");
    const fixture = await startMigratedTestDatabase();
    expect(fixture.databaseUrl).toBe("postgres://disposable/test");
    expect(mocks.acquire).not.toHaveBeenCalled();
    await fixture.stop();
  });

  it("does not apply local sharing to a remote Docker endpoint", async () => {
    mocks.runtime.mockResolvedValue({ info: { containerRuntime: { host: "docker.example.test" } } });
    const fixture = await startMigratedTestDatabase();
    expect(fixture.databaseUrl).toBe("postgres://disposable/test");
    expect(mocks.acquire).not.toHaveBeenCalled();
    await fixture.stop();
  });

  it("releases the local lease after a migration failure", async () => {
    const error = new Error("migration unavailable");
    mocks.migrate.mockRejectedValueOnce(error);
    await expect(startMigratedTestDatabase()).rejects.toBe(error);
    expect(mocks.sharedStop).toHaveBeenCalledOnce();
    expect(mocks.disposableStop).not.toHaveBeenCalled();
  });
});
