import { describe, expect, it } from "vitest";
import { encodeCursor, parseCursor } from "../task-cursor.js";
import { TaskQueryError } from "../task-error.js";

/**
 * The cursor is the one place a Task read accepts caller-supplied time text, so it is validated for
 * the instant it claims to be and not only for the shape of its digits: a value that passes here
 * reaches a `timestamptz` cast, where PostgreSQL answers a database error instead of the 400 this
 * service promises. The microseconds are kept as text throughout, because a `Date` would truncate
 * them and pages would then repeat or skip rows.
 */

const ID = "11111111-1111-4111-8111-111111111111";

function cursorFor(at: unknown): string {
  return Buffer.from(JSON.stringify({ at, id: ID }), "utf8").toString("base64url");
}

function expectRejected(at: unknown): void {
  let caught: unknown;
  try {
    parseCursor(cursorFor(at));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TaskQueryError);
  expect(caught).toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
}

describe("Task cursor validation", () => {
  it("keeps the exact microsecond instant it was given", () => {
    const at = "2026-08-24T12:20:01.456789Z";
    const parsed = parseCursor(encodeCursor(at, ID));
    expect(parsed).toEqual({ at, id: ID });
    // Round-tripping is text, so a value whose microseconds are not a whole millisecond survives.
    expect(parseCursor(encodeCursor(parsed?.at ?? "", ID))?.at).toBe(at);
  });

  it("accepts a whole second, a millisecond and six fractional digits", () => {
    for (const at of [
      "2026-08-24T12:20:01Z",
      "2026-08-24T12:20:01.000Z",
      "2026-08-24T12:20:01.1Z",
      "2024-02-29T23:59:59.999999Z",
      "2000-02-29T00:00:00.000001Z",
      "2026-12-31T00:00:00.000000Z",
    ]) {
      expect(parseCursor(cursorFor(at))?.at).toBe(at);
    }
  });

  it("rejects a digit-shaped value that is not a calendar instant", () => {
    // The regression this test exists for: right shape, impossible fields, and it used to reach the
    // database as a 22008 error instead of a 400.
    expectRejected("2026-99-99T99:99:99.123456Z");
    expectRejected("2026-13-01T00:00:00.000000Z");
    expectRejected("2026-00-10T00:00:00.000000Z");
    expectRejected("2026-01-32T00:00:00.000000Z");
    expectRejected("2026-01-00T00:00:00.000000Z");
    expectRejected("2026-04-31T00:00:00.000000Z");
    expectRejected("2026-02-29T00:00:00.000000Z");
    expectRejected("2026-01-01T24:00:00.000000Z");
    expectRejected("2026-01-01T00:60:00.000000Z");
    expectRejected("2026-01-01T00:00:60.000000Z");
    expectRejected("0000-01-01T00:00:00.000000Z");
  });

  it("rejects a value that is not a timestamp of this shape at all", () => {
    expectRejected("not-a-date");
    expectRejected("2026-08-24 12:20:01.456789+00");
    expectRejected("2026-08-24T12:20:01.4567891Z");
    expectRejected("2026-08-24T12:20:01.456789+01:00");
    expectRejected(20260824);
  });

  it("rejects a cursor whose id or payload is malformed", () => {
    expect(() => parseCursor("not-base64-json")).toThrow(TaskQueryError);
    expect(() =>
      parseCursor(
        Buffer.from(JSON.stringify({ at: "2026-08-24T12:20:01.000000Z", id: "not-a-uuid" }), "utf8").toString(
          "base64url",
        ),
      ),
    ).toThrow(TaskQueryError);
    expect(() =>
      parseCursor(
        Buffer.from(JSON.stringify({ at: "2026-08-24T12:20:01.000000Z", id: ID, extra: true }), "utf8").toString(
          "base64url",
        ),
      ),
    ).toThrow(TaskQueryError);
  });

  it("treats an absent cursor as the first page", () => {
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor("")).toBeUndefined();
  });
});
