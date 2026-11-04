import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), connect: vi.fn(), sql: vi.fn(), end: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => mocks.run }));
vi.mock("postgres", () => ({ default: mocks.connect }));

import { acquireLocalTestDatabase } from "./integration/local-test-database.js";

const owned = { Config: { Labels: { "opentag.test.postgres": "shared-local" } }, State: { Running: true } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.run.mockImplementation(async (_command: string, args: string[]) => ({
    stdout: args[0] === "inspect" ? JSON.stringify([owned]) : "",
  }));
  mocks.sql.mockResolvedValue([]);
  mocks.connect.mockReturnValue(Object.assign(mocks.sql, { end: mocks.end }));
});

describe("persistent local test database", () => {
  it("reuses the existing database and releases only the serialization connection", async () => {
    const fixture = await acquireLocalTestDatabase();
    await fixture.stop();

    expect(mocks.run.mock.calls.map(([, args]) => args[0])).toEqual(["inspect", "exec"]);
    expect(mocks.sql.mock.calls[0]?.[0]).toEqual(["select pg_advisory_lock(1869898087, 1)"]);
    expect(fixture.databaseUrl).toBe("postgresql://opentag:opentag@127.0.0.1:5432/opentag");
    expect(mocks.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(mocks.sql).toHaveBeenCalledOnce();
  });

  it("does not return until another test releases the database lock", async () => {
    let release!: () => void;
    mocks.sql.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let acquired = false;
    const acquiring = acquireLocalTestDatabase().then((fixture) => {
      acquired = true;
      return fixture;
    });
    await vi.waitFor(() => expect(mocks.sql).toHaveBeenCalledOnce());
    expect(acquired).toBe(false);
    release();
    const fixture = await acquiring;
    expect(acquired).toBe(true);
    await fixture.stop();
  });

  it.each(["Error: No such object", "error: no such object"])(
    "creates one persistent container after %s",
    async (message) => {
      mocks.run.mockRejectedValueOnce({ stderr: `${message}: opentag-local-postgres` });
      const fixture = await acquireLocalTestDatabase();
      await fixture.stop();

      const create = mocks.run.mock.calls.find(([, args]) => args[0] === "run")?.[1];
      expect(create).toContain("opentag-local-postgres");
      expect(create).toContain("opentag-local-postgres-data:/var/lib/postgresql/data");
      expect(create).toContain("127.0.0.1:5432:5432");
      expect(mocks.run.mock.calls.some(([, args]) => ["rm", "stop"].includes(args[0]))).toBe(false);
    },
  );

  it("accepts a simultaneous named-container creation without creating a second instance", async () => {
    mocks.run.mockRejectedValueOnce({ stderr: "Error: No such object: opentag-local-postgres" });
    mocks.run.mockRejectedValueOnce({ stderr: "Error: No such object: opentag-postgres-1" });
    mocks.run.mockRejectedValueOnce({ stderr: "Conflict. The container name is already in use" });
    const fixture = await acquireLocalTestDatabase();
    expect(mocks.run.mock.calls.filter(([, args]) => args[0] === "run")).toHaveLength(1);
    await fixture.stop();
  });

  it("reuses the development Compose database instead of starting another instance", async () => {
    mocks.run.mockRejectedValueOnce({ stderr: "error: no such object: opentag-local-postgres" });
    mocks.run.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          Config: {
            Labels: { "com.docker.compose.service": "postgres" },
            Env: ["POSTGRES_DB=opentag", "POSTGRES_USER=opentag"],
          },
          HostConfig: { PortBindings: { "5432/tcp": [{ HostPort: "5432" }] } },
          State: { Running: true },
        },
      ]),
    });
    const fixture = await acquireLocalTestDatabase();
    expect(mocks.run.mock.calls.some(([, args]) => args[0] === "run")).toBe(false);
    expect(mocks.run.mock.calls.at(-1)?.[1]).toContain("opentag-postgres-1");
    await fixture.stop();
  });

  it("does not adopt or restart an unrelated container with the same name", async () => {
    mocks.run.mockResolvedValueOnce({ stdout: JSON.stringify([{ Config: {}, State: { Running: false } }]) });
    await expect(acquireLocalTestDatabase()).rejects.toThrow("not an OpenTag shared test database");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("closes a failed lock connection without stopping the persistent database", async () => {
    const failure = new Error("database connection closed");
    mocks.sql.mockRejectedValueOnce(failure);
    await expect(acquireLocalTestDatabase()).rejects.toBe(failure);
    expect(mocks.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(mocks.run.mock.calls.some(([, args]) => args[0] === "rm")).toBe(false);
  });
});
