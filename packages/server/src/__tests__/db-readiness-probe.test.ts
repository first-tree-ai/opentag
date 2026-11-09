import type { Sql } from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApplicationDatabaseReadinessProbe,
  createDedicatedDatabaseReadinessProbe,
  DatabaseProbeTimeoutError,
} from "../db/readiness-probe.js";

type FakeClient = Sql & { end: ReturnType<typeof vi.fn>; queries: number };

function fakeClient(answer: () => Promise<unknown>): FakeClient {
  const client = Object.assign(
    () => {
      client.queries += 1;
      return answer();
    },
    { end: vi.fn(() => Promise.resolve()), queries: 0 },
  );
  return client as unknown as FakeClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createDedicatedDatabaseReadinessProbe", () => {
  it("reuses one connection while probes succeed", async () => {
    const client = fakeClient(() => Promise.resolve([]));
    const connect = vi.fn(() => client);
    const probe = createDedicatedDatabaseReadinessProbe("postgres://probe", { deadlineMs: 1_000, connect });

    await probe.run();
    await probe.run();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("postgres://probe", 1_000);
    expect(client.queries).toBe(2);
  });

  it("destroys a wedged connection at the deadline and reconnects on the next run", async () => {
    vi.useFakeTimers();
    const wedged = fakeClient(() => new Promise<never>(() => undefined));
    const healthy = fakeClient(() => Promise.resolve([]));
    const connect = vi.fn().mockReturnValueOnce(wedged).mockReturnValueOnce(healthy);
    const debug = vi.fn();
    const probe = createDedicatedDatabaseReadinessProbe("postgres://probe", {
      deadlineMs: 1_000,
      connect,
      log: { debug },
    });

    const first = probe.run().then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await first).toBeInstanceOf(DatabaseProbeTimeoutError);
    expect(wedged.end).toHaveBeenCalledWith({ timeout: 0 });

    await probe.run();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(healthy.queries).toBe(1);
    expect(debug).toHaveBeenCalledWith(
      { check: "database", reason: "deadline" },
      "Destroying readiness probe connection",
    );
  });

  it("keeps the connection when the database rejects quickly", async () => {
    const client = fakeClient(() => Promise.reject(new Error("connection refused")));
    const connect = vi.fn(() => client);
    const probe = createDedicatedDatabaseReadinessProbe("postgres://probe", { deadlineMs: 1_000, connect });

    await expect(probe.run()).rejects.toThrow("connection refused");
    await expect(probe.run()).rejects.toThrow("connection refused");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
  });

  it("ends the connection on close and refuses later runs", async () => {
    const client = fakeClient(() => Promise.resolve([]));
    const probe = createDedicatedDatabaseReadinessProbe("postgres://probe", {
      deadlineMs: 1_000,
      connect: () => client,
    });
    await probe.run();

    await probe.close();

    expect(client.end).toHaveBeenCalledWith({ timeout: 1 });
    await expect(probe.run()).rejects.toThrow("closed");
  });

  it("closes without connecting when no probe ever ran", async () => {
    const connect = vi.fn();
    const probe = createDedicatedDatabaseReadinessProbe("postgres://probe", { deadlineMs: 1_000, connect });

    await probe.close();

    expect(connect).not.toHaveBeenCalled();
  });
});

describe("application pool readiness", () => {
  it("shares a failed check until both sides settle, then permits a fresh attempt", async () => {
    let release!: () => void;
    const connectivity = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error("application pool unavailable");
    const unsafe = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce([]);
    const run = createApplicationDatabaseReadinessProbe({ unsafe } as unknown as Sql, {
      run: vi.fn(() => connectivity),
      close: async () => {},
    });
    const first = run();
    const outcome = first.catch((error) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(run()).toBe(first);
    expect(unsafe).toHaveBeenCalledTimes(1);
    release();
    expect(await outcome).toMatchObject({ message: "Application database pool readiness failed", cause: failure });
    await expect(run()).resolves.toBeUndefined();
    expect(unsafe).toHaveBeenCalledTimes(2);
  });
});
