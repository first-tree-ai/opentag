import { randomUUID } from "node:crypto";
import { HTTP_PATHS, SESSION_CLI_PROOF_HEADER } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { SessionCliProofError } from "../services/sessions/index.js";

const source = {
  agentId: randomUUID(),
  computerId: randomUUID(),
  connectionInstanceId: randomUUID(),
  placementGeneration: 2,
  sessionId: randomUUID(),
  sessionKind: "channel" as const,
  workspaceComputerId: randomUUID(),
};

describe("Runtime Session CLI routes", () => {
  it("derives source identity only from proof and validates bounded list input", async () => {
    const create = vi.fn(async () => ({
      messageId: randomUUID(),
      sessionId: randomUUID(),
      status: "accepted" as const,
    }));
    const send = vi.fn(async (input) => ({ messageId: input.messageId, status: "accepted" as const }));
    const listInternalSessions = vi.fn(async () => ({ items: [] }));
    const authenticate = vi.fn(async () => source);
    const app = createApp({
      runtimeSessions: {
        collaboration: { create, send },
        proofs: { authenticate },
        sessions: { listInternalSessions },
      },
    });
    const messageId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.runtimeSessionMessages,
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof" },
      payload: { messageId, targetSessionId: randomUUID(), message: "done" },
    });
    expect(response.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith("proof");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ messageId }), source);

    const listed = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.runtimeSessions}?recursive=true&limit=100`,
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listInternalSessions).toHaveBeenCalledWith(source.sessionId, { recursive: true, limit: 100 });

    const invalid = await app.inject({
      method: "POST",
      url: HTTP_PATHS.runtimeInternalSessions,
      headers: { [SESSION_CLI_PROOF_HEADER]: "proof" },
      payload: { messageId: randomUUID(), message: "task", sourceSessionId: randomUUID() },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("fails closed when managed proof context is missing", async () => {
    const app = createApp({
      runtimeSessions: {
        collaboration: { create: vi.fn(), send: vi.fn() },
        proofs: {
          authenticate: async () => {
            throw new SessionCliProofError("invalid_proof", "invalid");
          },
        },
        sessions: { listInternalSessions: vi.fn() },
      },
    });
    const response = await app.inject({ method: "GET", url: HTTP_PATHS.runtimeSessions });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "SESSION_PROOF_INVALID" } });
    await app.close();
  });
});
