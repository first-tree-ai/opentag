import { beforeEach, describe, expect, it, vi } from "vitest";
import { startPostgresTestContainer } from "./integration/postgres-test-container.js";

const mocks = vi.hoisted(() => {
  const end = vi.fn();
  return {
    container: {
      getConnectionUri: () => "postgres://test:test@localhost:54321/test",
      getHost: () => "localhost",
      getPort: () => 54321,
      stop: vi.fn(),
    },
    end,
    getRuntime: vi.fn(),
    portBindings: { "5432/tcp": [{ HostPort: "0", HostIp: undefined as string | undefined }] },
    postgres: vi.fn(),
    sql: Object.assign(vi.fn(), { end }),
    start: vi.fn(),
  };
});

vi.mock("@testcontainers/postgresql", () => ({
  PostgreSqlContainer: class {
    protected hostConfig = { PortBindings: mocks.portBindings };
    protected async beforeContainerCreated() {}
    withLabels() {
      return this;
    }
    async start() {
      await this.beforeContainerCreated();
      mocks.portBindings = this.hostConfig.PortBindings;
      await mocks.start();
      return mocks.container;
    }
  },
}));

vi.mock("testcontainers", () => ({ getContainerRuntimeClient: mocks.getRuntime }));
vi.mock("postgres", () => ({ default: mocks.postgres }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.portBindings = { "5432/tcp": [{ HostPort: "0", HostIp: undefined }] };
  mocks.getRuntime.mockResolvedValue({ info: { containerRuntime: { host: "localhost" } } });
  mocks.postgres.mockReturnValue(mocks.sql);
  mocks.sql.mockResolvedValue([{ "?column?": 1 }]);
});

describe("integration PostgreSQL startup", () => {
  it.each(["localhost", "127.0.0.1"])("publishes only to loopback for Docker at %s", async (host) => {
    mocks.getRuntime.mockResolvedValue({ info: { containerRuntime: { host } } });

    await expect(startPostgresTestContainer()).resolves.toBe(mocks.container);

    expect(mocks.portBindings["5432/tcp"]).toEqual([{ HostPort: "0", HostIp: "127.0.0.1" }]);
    expect(mocks.postgres).toHaveBeenCalledWith(mocks.container.getConnectionUri(), {
      connect_timeout: 5,
      max: 1,
      onnotice: expect.any(Function),
    });
    expect(mocks.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(mocks.container.stop).not.toHaveBeenCalled();
  });

  it.each(["docker.example.test", "192.0.2.10", "172.17.0.1", "::1"])(
    "preserves the published-port defaults for Docker at %s",
    async (host) => {
      mocks.getRuntime.mockResolvedValue({ info: { containerRuntime: { host } } });

      await startPostgresTestContainer();

      expect(mocks.portBindings["5432/tcp"]).toEqual([{ HostPort: "0", HostIp: undefined }]);
    },
  );

  it("waits for a host query before returning the container", async () => {
    let finishQuery: (() => void) | undefined;
    mocks.sql.mockReturnValueOnce(new Promise<void>((resolve) => (finishQuery = resolve)));
    let returned = false;
    const starting = startPostgresTestContainer().then((container) => {
      returned = true;
      return container;
    });
    await vi.waitFor(() => expect(mocks.sql).toHaveBeenCalled());
    expect(returned).toBe(false);
    expect(mocks.end).not.toHaveBeenCalled();

    finishQuery?.();

    await expect(starting).resolves.toBe(mocks.container);
    expect(mocks.sql.mock.calls[0]?.[0]).toEqual(["select 1"]);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("closes the connection and removes a container that cannot answer a host query", async () => {
    const cause = new Error("CONNECT_TIMEOUT");
    mocks.sql.mockRejectedValueOnce(cause);

    await expect(startPostgresTestContainer()).rejects.toMatchObject({
      message: "Integration PostgreSQL is not reachable at localhost:54321; check Docker port forwarding",
      cause,
    });

    expect(mocks.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(mocks.container.stop).toHaveBeenCalledOnce();
    expect(mocks.end.mock.invocationCallOrder[0]).toBeLessThan(mocks.container.stop.mock.invocationCallOrder[0] ?? 0);
  });

  it("removes the container if closing the readiness connection fails", async () => {
    const cause = new Error("connection cleanup failed");
    mocks.end.mockRejectedValueOnce(cause);

    await expect(startPostgresTestContainer()).rejects.toMatchObject({ cause });

    expect(mocks.container.stop).toHaveBeenCalledOnce();
  });

  it("reports both the connection failure and failed container cleanup", async () => {
    const connectionError = new Error("CONNECT_TIMEOUT");
    const cleanupError = new Error("Docker unavailable");
    mocks.sql.mockRejectedValueOnce(connectionError);
    mocks.container.stop.mockRejectedValueOnce(cleanupError);

    await expect(startPostgresTestContainer()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [connectionError, cleanupError],
      message: expect.stringContaining("container cleanup also failed"),
    });
  });

  it("preserves container startup failures without opening a connection", async () => {
    const cause = new Error("image pull failed");
    mocks.start.mockRejectedValueOnce(cause);

    await expect(startPostgresTestContainer()).rejects.toBe(cause);

    expect(mocks.postgres).not.toHaveBeenCalled();
  });
});
