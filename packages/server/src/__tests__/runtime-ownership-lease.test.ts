import { describe, expect, it, vi } from "vitest";
import {
  acquireRuntimeOwnershipLease,
  RUNTIME_OWNERSHIP_ADVISORY_LOCK_ID,
  RuntimeOwnershipLeaseError,
} from "../runtime/runtime-ownership-lease.js";

function sqlFixture(acquired: boolean) {
  const queries: Array<{ values: readonly unknown[] }> = [];
  const connection = Object.assign(
    vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ values });
      return [{ acquired }];
    }),
    { release: vi.fn() },
  );
  const sql = { reserve: vi.fn(async () => connection) };
  return { connection, queries, sql };
}

describe("runtime ownership advisory lease", () => {
  it("claims one reserved PostgreSQL session and releases it idempotently", async () => {
    const fixture = sqlFixture(true);
    const lease = await acquireRuntimeOwnershipLease(fixture.sql as never, "11111111-1111-4111-8111-111111111111");

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
  });

  it("fails closed and releases the reserved session when another instance owns the lease", async () => {
    const fixture = sqlFixture(false);

    await expect(
      acquireRuntimeOwnershipLease(fixture.sql as never, "22222222-2222-4222-8222-222222222222"),
    ).rejects.toMatchObject({
      code: "RUNTIME_OWNER_LEASE_HELD",
      message: expect.stringContaining("one Server replica"),
    });
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });

  it("exposes the actionable lease error type", () => {
    expect(new RuntimeOwnershipLeaseError("instance")).toBeInstanceOf(Error);
  });
});
