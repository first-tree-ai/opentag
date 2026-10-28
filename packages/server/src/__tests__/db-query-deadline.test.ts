import postgres, { type Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { applyQueryDeadline, assertQueryDeadlineSupport, DatabaseQueryTimeoutError } from "../db/query-deadline.js";

describe("query deadline configuration", () => {
  it("fails fast without the pinned transport cleanup extension", () => {
    expect(() => assertQueryDeadlineSupport({} as Sql)).toThrow(/pinned query deadline/);
  });

  it("preserves the application error and logs only the fired bound", () => {
    const setQueryDeadline = vi.fn();
    const onTimeout = vi.fn();
    const sql = { setQueryDeadline } as unknown as Sql;
    expect(applyQueryDeadline(sql, { timeoutMs: 35_000, onTimeout })).toBe(sql);
    const errorFactory = setQueryDeadline.mock.calls[0]?.[1] as (timeoutMs: number) => Error;
    const error = errorFactory(1_000);
    expect(error).toBeInstanceOf(DatabaseQueryTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 1_000 });
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith({ timeoutMs: 1_000 });
  });

  it("keeps timeout cleanup authoritative if its observer throws", () => {
    const setQueryDeadline = vi.fn();
    const failure = new Error("logging failed");
    applyQueryDeadline({ setQueryDeadline } as unknown as Sql, {
      timeoutMs: 1000,
      onTimeout: () => {
        throw failure;
      },
    });
    const factory = setQueryDeadline.mock.calls[0]?.[1] as (timeoutMs: number) => Error;
    expect(factory(1000)).toMatchObject({ name: "DatabaseQueryTimeoutError", cause: failure });
  });

  it("configures the installed driver without executing lazy queries", async () => {
    const sql = postgres("postgresql://unused/unused");
    try {
      applyQueryDeadline(sql, { timeoutMs: 1 });
      const query = sql.unsafe("select 1").values();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((query as unknown as { executed: boolean }).executed).toBe(false);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
