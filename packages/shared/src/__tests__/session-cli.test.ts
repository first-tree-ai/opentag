import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formatSessionRunInput,
  parseSessionRunInputs,
  SESSION_CLI_DEFAULT_LIMIT,
  SESSION_CLI_MAX_LIMIT,
  SESSION_CLI_RUN_INPUTS_MAX,
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

  it("reads Run inputs from a header, and none from anything malformed", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const inputs = [
      { kind: "delivery" as const, deliveryId: id },
      { kind: "session-message" as const, messageId: id },
    ];
    expect(parseSessionRunInputs(inputs.map(formatSessionRunInput).join(","))).toEqual(inputs);
    expect(parseSessionRunInputs(undefined)).toEqual([]);
    expect(parseSessionRunInputs(`m:${id},x:${id}`)).toEqual([]);
    expect(
      parseSessionRunInputs(
        Array(SESSION_CLI_RUN_INPUTS_MAX + 1)
          .fill(`m:${id}`)
          .join(","),
      ),
    ).toEqual([]);
  });
});
