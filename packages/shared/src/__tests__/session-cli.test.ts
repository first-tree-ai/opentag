import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SESSION_CLI_DEFAULT_LIMIT,
  SESSION_CLI_MAX_LIMIT,
  SessionCliCommandResponseSchema,
  SessionCliCreateRequestSchema,
  SessionCliListQuerySchema,
  SessionCliListResponseSchema,
  SessionCliSendRequestSchema,
} from "../index.js";

describe("Session CLI contract", () => {
  it("keeps source identity out of create and send inputs", () => {
    const create = { messageId: randomUUID(), message: "Investigate", reasoningEffort: "high" };
    expect(SessionCliCreateRequestSchema.parse(create)).toEqual(create);
    expect(() => SessionCliCreateRequestSchema.parse({ ...create, sourceSessionId: randomUUID() })).toThrow();
    const send = { messageId: randomUUID(), targetSessionId: randomUUID(), message: "Done" };
    expect(SessionCliSendRequestSchema.parse(send)).toEqual(send);
    expect(() => SessionCliSendRequestSchema.parse({ ...send, agentId: randomUUID() })).toThrow();
  });

  it("reserves version 5 message IDs for the Server, and accepts every other UUID", () => {
    const send = { targetSessionId: randomUUID(), message: "Done" };
    const create = { message: "Investigate" };
    for (const messageId of ["5f3c2b1a-9d8e-5c7b-8a6f-1e2d3c4b5a69", "5F3C2B1A-9D8E-5C7B-8A6F-1E2D3C4B5A69"]) {
      expect(SessionCliSendRequestSchema.safeParse({ ...send, messageId }).success).toBe(false);
      expect(SessionCliCreateRequestSchema.safeParse({ ...create, messageId }).success).toBe(false);
    }
    // A retry that names its own ID keeps working, whatever generated it.
    for (const messageId of [
      randomUUID(),
      "018f4e2a-7b3c-7d1e-9f20-3a4b5c6d7e8f",
      "1b671a64-40d5-11ee-be56-0242ac120002",
    ]) {
      expect(SessionCliSendRequestSchema.safeParse({ ...send, messageId }).success).toBe(true);
      expect(SessionCliCreateRequestSchema.safeParse({ ...create, messageId }).success).toBe(true);
    }
  });

  it("bounds list pages and validates result shapes", () => {
    expect(SessionCliListQuerySchema.parse({})).toEqual({ recursive: false, limit: SESSION_CLI_DEFAULT_LIMIT });
    expect(() => SessionCliListQuerySchema.parse({ limit: SESSION_CLI_MAX_LIMIT + 1 })).toThrow();
    const command = { messageId: randomUUID(), sessionId: randomUUID(), status: "accepted" as const };
    expect(SessionCliCommandResponseSchema.parse(command)).toEqual(command);
    expect(SessionCliListResponseSchema.parse({ items: [], nextCursor: "opaque" })).toEqual({
      items: [],
      nextCursor: "opaque",
    });
  });
});
