import { Readable } from "node:stream";
import { runtimeImResourcePath } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { AuthServiceError } from "../services/auth/index.js";

const workspaceId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const workspaceComputerId = "59ea83c3-0452-4fdb-a81b-e8037e91cd1b";
const sessionId = "07a9192e-cb82-477a-a931-2c694e937012";
const computerId = "e9f6f9f3-84e2-4448-bbe4-f933cbd5b68f";
const instanceId = "fef187cf-0e5b-4c12-826a-c012e3a2b4cd";
const imMessageId = "f7ca351d-337f-4c64-8aca-1ad5ab6fa7f2";
const authorization = { authorization: "Bearer access" };
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: workspaceId, email: "admin@example.com", displayName: "Admin" },
        setupCompletedAt: null,
      },
    }),
  };
}

function resourceUrl(overrides: Partial<Parameters<typeof runtimeImResourcePath>[2]> = {}, ordinal = 2) {
  return runtimeImResourcePath(imMessageId, ordinal, {
    sessionId,
    instanceId,
    placementGeneration: 7,
    ...overrides,
  });
}

function createResourceApp(resource: Record<string, unknown>, verifyMachineToken?: ReturnType<typeof vi.fn>) {
  const resources = { open: vi.fn().mockResolvedValue(resource) };
  const machineAuth = {
    verifyMachineToken:
      verifyMachineToken ??
      vi.fn().mockResolvedValue({
        credentialId: "6a7f5ffb-65c2-40e2-8b20-89f430aa74e5",
        workspaceComputerId,
        workspaceId,
        computerId,
      }),
  };
  const app = createApp({
    authService: authService(),
    machineAuthService: machineAuth as never,
    imResourceService: resources as never,
  });
  apps.push(app);
  return { app, resources };
}

describe("IM resource HTTP API", () => {
  it("rejects Account bearer tokens through the real Runtime resource route", async () => {
    const verifyMachineToken = vi
      .fn()
      .mockRejectedValue(new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "machine token required", 401));
    const { app, resources } = createResourceApp({ stream: Readable.from([]) }, verifyMachineToken);

    const response = await app.inject({
      method: "GET",
      url: resourceUrl(),
      headers: { authorization: "Bearer account-access-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(verifyMachineToken).toHaveBeenCalledWith("account-access-token");
    expect(resources.open).not.toHaveBeenCalled();
  });

  it("passes the authenticated placement scope and returns safe resource metadata", async () => {
    const { app, resources } = createResourceApp({
      stream: Readable.from([Buffer.from("image")]),
      kind: "image",
      mediaType: "image/png",
      sizeBytes: 5,
      filename: "报告 图.png",
    });

    const response = await app.inject({ method: "GET", url: resourceUrl(), headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("image");
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-length"]).toBe("5");
    expect(response.headers["content-disposition"]).toBe(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%E5%9B%BE.png",
    );
    expect(resources.open).toHaveBeenCalledWith(
      { credentialId: expect.any(String), workspaceComputerId, workspaceId, computerId },
      { sessionId, instanceId, placementGeneration: 7 },
      imMessageId,
      2,
    );
  });

  it("falls back to a safe media type and omits absent optional metadata", async () => {
    const { app } = createResourceApp({
      stream: Readable.from([Buffer.from("data")]),
      kind: "file",
      mediaType: "text/plain\r\nx-secret: leaked",
    });

    const response = await app.inject({ method: "GET", url: resourceUrl(), headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
  });

  it.each([
    ["invalid message id", resourceUrl().replace(imMessageId, "not-a-uuid")],
    ["out-of-range ordinal", resourceUrl({}, 16)],
    ["invalid placement generation", resourceUrl({ placementGeneration: 0 })],
  ])("rejects %s before calling the resource service", async (_label, url) => {
    const { app, resources } = createResourceApp({
      stream: Readable.from([]),
      kind: "file",
    });

    const response = await app.inject({ method: "GET", url, headers: authorization });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", category: "validation" } });
    expect(resources.open).not.toHaveBeenCalled();
  });
});
