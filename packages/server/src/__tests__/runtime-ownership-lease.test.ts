import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ postgres: vi.fn() }));

vi.mock("postgres", () => ({ default: state.postgres }));

import {
  acquireRuntimeOwnershipLease,
  DEFAULT_RUNTIME_OWNERSHIP_ACQUIRE_TIMEOUT_MS,
  RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID,
  RuntimeOwnershipLeaseError,
} from "../runtime/runtime-ownership-lease.js";

function clientFixture(results: boolean[]) {
  const queries: Array<{ values: readonly unknown[] }> = [];
  let queryIndex = 0;
  const connection = Object.assign(
    vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ values });
      return [{ acquired: results[Math.min(queryIndex++, results.length - 1)] ?? false }];
    }),
    { release: vi.fn() },
  );
  const client = {
    reserve: vi.fn(async () => connection),
    end: vi.fn(async () => undefined),
  };
  state.postgres.mockReturnValue(client);
  return { client, connection, queries };
}

describe("runtime ownership advisory lease", () => {
  it("uses a dedicated single-connection client and releases it idempotently", async () => {
    const fixture = clientFixture([true]);
    const lease = await acquireRuntimeOwnershipLease(
      "postgresql://opentag@localhost/opentag",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(state.postgres).toHaveBeenCalledWith(
      "postgresql://opentag@localhost/opentag",
      expect.objectContaining({
        max: 1,
        onclose: expect.any(Function),
        onnotice: expect.any(Function),
        connection: { application_name: "opentag-runtime-ownership" },
      }),
    );
    expect(lease.state).toEqual({
      mode: "single",
      status: "owned",
      instanceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(fixture.queries[0]?.values).toEqual([RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID]);

    await lease.release();
    await lease.release();

    expect(fixture.queries[1]?.values).toEqual([RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID]);
    expect(fixture.connection.release).toHaveBeenCalledOnce();
    expect(fixture.client.end).toHaveBeenCalledOnce();
    expect(lease.state).toEqual({ mode: "single", status: "not_owned" });
  });

  it("stops reporting ownership when the dedicated connection closes", async () => {
    const fixture = clientFixture([true]);
    const onLost = vi.fn();
    const lease = await acquireRuntimeOwnershipLease(
      "postgresql://opentag@localhost/opentag",
      "11111111-1111-4111-8111-111111111111",
      { onLost },
    );
    const onclose = state.postgres.mock.calls.at(-1)?.[1]?.onclose as (() => void) | undefined;

    onclose?.();

    expect(lease.state).toEqual({ mode: "single", status: "not_owned" });
    expect(onLost).toHaveBeenCalledOnce();
    await lease.release();
    expect(fixture.client.end).toHaveBeenCalledOnce();
  });

  it("retries a held lease with backoff before succeeding", async () => {
    const fixture = clientFixture([false, true]);
    const sleep = vi.fn(async () => undefined);
    const lease = await acquireRuntimeOwnershipLease(
      "postgresql://opentag@localhost/opentag",
      "22222222-2222-4222-8222-222222222222",
      { timeoutMs: 1_000, retryDelayMs: 10, sleep },
    );

    expect(fixture.connection).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
    await lease.release();
  });

  it("fails closed after the bounded acquisition window and closes the lease client", async () => {
    const fixture = clientFixture([false]);

    await expect(
      acquireRuntimeOwnershipLease("postgresql://opentag@localhost/opentag", "22222222-2222-4222-8222-222222222222", {
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_OWNER_LEASE_HELD",
      message: expect.stringContaining("one Server replica"),
    });
    expect(fixture.connection.release).toHaveBeenCalledOnce();
    expect(fixture.client.end).toHaveBeenCalledOnce();
  });

  it("uses the documented default acquisition timeout", () => {
    expect(DEFAULT_RUNTIME_OWNERSHIP_ACQUIRE_TIMEOUT_MS).toBe(30_000);
    expect(new RuntimeOwnershipLeaseError("instance")).toBeInstanceOf(Error);
  });
});
