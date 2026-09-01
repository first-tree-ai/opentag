import { randomUUID } from "node:crypto";
import type { SessionReconcileRequest } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";

describe("SessionCliProofService", () => {
  it("keeps a visible IM ready reconcile proof-free when the Client did not negotiate collaboration", async () => {
    const request = {
      type: "session:reconcile",
      requestId: randomUUID(),
      installationId: randomUUID(),
      sessionId: randomUUID(),
      agentId: randomUUID(),
      placementGeneration: 1,
      desired: "ready",
      runtime: {},
    } as SessionReconcileRequest;
    const database = { transaction: vi.fn(), delete: vi.fn() };
    const service = new SessionCliProofService(
      database as never,
      { currentInstanceId: vi.fn(), supportsCapability: vi.fn().mockReturnValue(false) },
      new Uint8Array(32).fill(7),
    );

    await expect(service.prepareReconcile(randomUUID(), randomUUID(), request)).resolves.toBe(request);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.delete).not.toHaveBeenCalled();
  });
});
