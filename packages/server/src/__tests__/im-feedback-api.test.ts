import { randomUUID } from "node:crypto";
import {
  agentImFeedbackPath,
  type ImFeedbackView,
  imFeedbackActionsPath,
  imFeedbackDestinationPath,
  imFeedbackPath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ImFeedbackServiceError } from "../services/im/im-feedback-actions.js";
import { SESSION_COOKIE_NAME, signedInBrowser } from "./signed-in-browser.js";

const accountId = randomUUID(),
  agentId = randomUUID(),
  id = randomUUID();
const view: ImFeedbackView = {
  id,
  agentId,
  taskId: "55555555-5555-4555-8555-555555555555",
  sessionId: randomUUID(),
  revision: 2,
  state: "failed",
  errorCode: "provider_failed",
  effects: "not_started",
  sandboxId: null,
  environmentGeneration: null,
  deliveryState: "sent",
  retryBlockedReason: null,
  actions: [{ kind: "retry_task", confirmation: "signed-token" }],
  action: null,
};
const input = { kind: "retry_task", revision: 2, confirmation: "signed-token" };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
function setup() {
  const me = { user: { id: accountId, email: "owner@example.test", displayName: "Owner" }, setupCompletedAt: null };
  const service = {
    getForAccount: vi.fn(async () => view),
    listForAccount: vi.fn(async () => ({ items: [], nextCursor: null })),
    submitForAccount: vi.fn(async () => view),
    destinationForAccount: vi.fn(async () => ({ owner: false, ownerDisplayName: "Owner", agentName: "Helper" })),
  };
  const auth = {
    getAuthenticatedUser: vi.fn(async () => ({ me, tokenExpiresAt: new Date("2030-01-01T00:00:00Z") })),
    getActiveUserById: vi.fn(async () => me),
  } as unknown as UserAuthService;
  const app = createApp({
    authService: auth,
    betterAuth: signedInBrowser(accountId),
    browserAuth: { publicOrigin: "https://opentag.example.com", secureCookies: false, sessionTtlSeconds: 604800 },
    imFeedback: service as never,
  });
  apps.push(app);
  return { app, service };
}
describe("owner feedback HTTP API", () => {
  it("authenticates details and bounded Agent list reads without mutating", async () => {
    const { app, service } = setup();
    const unauth = await app.inject({ method: "GET", url: imFeedbackPath(id) });
    expect(unauth.statusCode).toBe(401);
    expect(service.getForAccount).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "GET",
      url: imFeedbackPath(id),
      headers: { authorization: "Bearer owner" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.getForAccount).toHaveBeenCalledWith(accountId, id);
    const cursor = randomUUID();
    expect(
      (
        await app.inject({
          method: "GET",
          url: agentImFeedbackPath(agentId, cursor),
          headers: { authorization: "Bearer owner" },
        })
      ).statusCode,
    ).toBe(200);
    expect(service.listForAccount).toHaveBeenCalledWith(accountId, agentId, cursor);
    expect(service.submitForAccount).not.toHaveBeenCalled();
  });
  it("answers where a card link leads for any signed-in reader", async () => {
    const { app, service } = setup();
    expect((await app.inject({ method: "GET", url: imFeedbackDestinationPath(id) })).statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: imFeedbackDestinationPath(id),
      headers: { authorization: "Bearer owner" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ owner: false, ownerDisplayName: "Owner", agentName: "Helper" });
    expect(service.destinationForAccount).toHaveBeenCalledWith(accountId, id);
  });
  it("requires browser origin and double-submit CSRF before admission", async () => {
    const { app, service } = setup();
    const cookie = `${SESSION_COOKIE_NAME}=session; opentag_csrf=csrf-token`;
    const request = {
      method: "POST" as const,
      url: imFeedbackActionsPath(id),
      payload: input,
      headers: { cookie, origin: "https://opentag.example.com" },
    };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...request.headers, origin: "https://foreign.test", "x-opentag-csrf": "csrf-token" },
        })
      ).statusCode,
    ).toBe(403);
    expect(service.submitForAccount).not.toHaveBeenCalled();
    const result = await app.inject({ ...request, headers: { ...request.headers, "x-opentag-csrf": "csrf-token" } });
    expect(result.statusCode).toBe(202);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(service.submitForAccount).toHaveBeenCalledExactlyOnceWith(accountId, id, input);
  });
  it("rejects caller-supplied targets and reports an owner conflict without exposing internals", async () => {
    const { app, service } = setup();
    const request = {
      method: "POST" as const,
      url: imFeedbackActionsPath(id),
      headers: { authorization: "Bearer owner" },
      payload: { ...input, sandboxId: randomUUID() },
    };
    expect((await app.inject(request)).statusCode).toBe(400);
    expect(service.submitForAccount).not.toHaveBeenCalled();
    service.submitForAccount.mockRejectedValueOnce(
      new ImFeedbackServiceError("IM_FEEDBACK_CONFLICT", "Refresh the current operation.", 409),
    );
    expect((await app.inject({ ...request, payload: input })).statusCode).toBe(409);
    service.getForAccount.mockRejectedValueOnce(
      new ImFeedbackServiceError("IM_FEEDBACK_NOT_FOUND", "Unavailable", 404),
    );
    expect((await app.inject({ method: "GET", url: imFeedbackPath(id), headers: request.headers })).statusCode).toBe(
      404,
    );
  });
});

it.each([undefined, false])("rejects unacknowledged discard through the HTTP boundary (%s)", async (ack) => {
  const { app, service } = setup();
  const response = await app.inject({
    method: "POST",
    url: imFeedbackActionsPath(id),
    headers: { authorization: "Bearer owner" },
    payload: { ...input, kind: "discard", ...(ack !== undefined ? { permanentLossAcknowledged: ack } : {}) },
  });
  expect(response.statusCode).toBe(400);
  expect(service.submitForAccount).not.toHaveBeenCalled();
});
