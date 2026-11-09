import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_UNKNOWN_KEY_PASSES as BROWSER_MAX_UNKNOWN_KEY_PASSES,
  parseResponseIgnoringUnknownKeys as browserParseResponseIgnoringUnknownKeys,
} from "../browser.js";
import { MAX_UNKNOWN_KEY_PASSES, parseResponseIgnoringUnknownKeys } from "../index.js";

const activity = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }).strict(),
  z.object({ state: z.literal("working"), startedAt: z.string() }).strict(),
]);
const owner = z.union([
  z.object({ kind: z.literal("user"), id: z.string() }).strict(),
  z.object({ team: z.string() }).strict(),
]);
const schema = z
  .object({
    items: z.array(
      z
        .object({
          activity,
          owner,
          status: z.enum(["active", "paused"]),
          labels: z.record(z.string(), z.object({ color: z.string() }).strict()),
        })
        .strict(),
    ),
  })
  .strict();

const known = {
  items: [
    {
      activity: { state: "working", startedAt: "t" },
      owner: { team: "core" },
      status: "active",
      labels: { a: { color: "red" } },
    },
  ],
};

describe("parseResponseIgnoringUnknownKeys", () => {
  it("exports the same parser from both the root and browser barrels", () => {
    expect(BROWSER_MAX_UNKNOWN_KEY_PASSES).toBe(MAX_UNKNOWN_KEY_PASSES);
    expect(browserParseResponseIgnoringUnknownKeys).toBe(parseResponseIgnoringUnknownKeys);
  });

  it("passes a known response through unchanged", () => {
    expect(parseResponseIgnoringUnknownKeys(schema, known)).toEqual({ success: true, data: known, ignoredKeys: [] });
  });

  it("drops unknown keys at every depth, in union variants and records, and keeps known fields", () => {
    const future = {
      added: 1,
      items: [
        {
          activity: { state: "working", startedAt: "t", runningTaskCount: 2 },
          owner: { team: "core", since: "2030" },
          status: "active",
          labels: { a: { color: "red", shade: "dark" } },
          extra: { nested: true },
        },
      ],
    };
    const parsed = parseResponseIgnoringUnknownKeys(schema, future);
    expect(parsed).toMatchObject({ success: true, data: known });
    expect([...parsed.ignoredKeys].sort()).toEqual(
      [
        "added",
        "items.0.activity.runningTaskCount",
        "items.0.owner.since",
        "items.0.labels.a.shade",
        "items.0.extra",
      ].sort(),
    );
    // The caller's body is never mutated.
    expect(future.items[0]?.activity).toHaveProperty("runningTaskCount", 2);
  });

  it("still rejects a wrong type, a missing field, or an unknown enum value next to unknown keys", () => {
    const item = known.items[0];
    for (const broken of [
      { items: [{ ...item, status: 3, extra: 1 }] },
      { items: [{ ...item, activity: { state: "working" }, extra: 1 }] },
      { items: [{ ...item, status: "archived" }] },
      { items: [{ ...item, activity: { state: "sleeping" } }] },
      { items: [{ ...item, owner: { kind: "bot" } }] },
    ]) {
      expect(parseResponseIgnoringUnknownKeys(schema, broken)).toMatchObject({
        success: false,
        reason: "invalid",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.any(Array), code: expect.any(String) }),
        ]),
      });
    }
  });

  it("follows unknown keys that surface one nesting level per pass", () => {
    let level: z.ZodTypeAny = z.object({ leaf: z.string() }).strict();
    for (let depth = 0; depth < 5; depth += 1) {
      level = z.union([z.object({ next: level }).strict(), z.object({ other: z.number() }).strict()]);
    }
    let body: Record<string, unknown> = { leaf: "x", extra: 1 };
    for (let depth = 0; depth < 5; depth += 1) body = { next: body, [`extra${depth}`]: depth };
    expect(parseResponseIgnoringUnknownKeys(level, body)).toMatchObject({ success: true });
  });

  it("stops when a pass removes no new keys or when target path is not a record", () => {
    const nonConverging = {
      safeParse: () => ({
        success: false as const,
        error: { issues: [{ code: "unrecognized_keys", path: ["missing", "nested"], keys: ["k"] }] },
      }),
    };
    expect(parseResponseIgnoringUnknownKeys(nonConverging, null)).toEqual({
      success: false,
      reason: "invalid",
      ignoredKeys: ["missing.nested.k"],
      issues: [{ code: "unrecognized_keys", path: ["missing", "nested"], keys: ["k"] }],
    });

    const withoutErrorIssues = {
      safeParse: () => ({ success: false as const }),
    };
    expect(parseResponseIgnoringUnknownKeys(withoutErrorIssues, {})).toEqual({
      success: false,
      reason: "invalid",
      ignoredKeys: [],
      issues: [],
    });
  });

  it("stops with a clear reason when unknown keys never stop surfacing", () => {
    // A schema whose every pass reports a new unknown key, as a non-converging response would.
    let calls = 0;
    const endless = {
      safeParse: () => {
        calls += 1;
        return {
          success: false as const,
          error: { issues: [{ code: "unrecognized_keys", path: [], keys: [`k${calls}`] }] },
        };
      },
    };
    expect(parseResponseIgnoringUnknownKeys(endless, {})).toMatchObject({
      success: false,
      reason: "unknown_key_pass_limit",
    });
    expect(calls).toBe(MAX_UNKNOWN_KEY_PASSES + 1);
  });
});
