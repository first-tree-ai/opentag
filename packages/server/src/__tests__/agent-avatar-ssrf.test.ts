import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import type { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import { ImResourceService } from "../services/im/im-resource-service.js";

describe("Agent avatar SSRF regression", () => {
  it("passes a connection-filtering transport to avatar policy", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("blocked destination"));
    const query = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ providerUrl: "https://avatar.example.test/image.png" }]),
    };
    const database = { select: vi.fn().mockReturnValue(query) } as unknown as DatabaseClient;
    const service = new ImResourceService(database, vi.fn(), { fetch } as unknown as ExternalCallPolicy);

    await expect(service.openAvatar("owner", "agent")).rejects.toMatchObject({
      code: "IM_BINDING_TEMPORARILY_UNAVAILABLE",
      statusCode: 503,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://avatar.example.test/image.png",
      { headers: { accept: "image/*" } },
      expect.objectContaining({ allowAnyHttpsHost: true, maxAttempts: 1, transport: expect.any(Function) }),
    );
    const [url, init, options] = fetch.mock.calls[0] as [string, RequestInit, { transport?: unknown }];
    expect(url).toBe("https://avatar.example.test/image.png");
    expect(init.headers).toEqual({ accept: "image/*" });
    expect(init).not.toHaveProperty("credentials");
    expect(init).not.toHaveProperty("authorization");
    expect(options.transport).toEqual(expect.any(Function));
  });
});
