import { describe, expect, it, vi } from "vitest";
import {
  checkServerHealth,
  ServerHealthConfigurationError,
  ServerHealthNetworkError,
  ServerHealthResponseError,
} from "../health.js";

describe("checkServerHealth", () => {
  it("classifies an invalid server URL as configuration failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(checkServerHealth("not-a-url", fetchImpl)).rejects.toBeInstanceOf(ServerHealthConfigurationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a validated health response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", service: "opentag-server" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(checkServerHealth("http://127.0.0.1:8000", fetchImpl)).resolves.toEqual({
      status: "ok",
      service: "opentag-server",
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("http://127.0.0.1:8000/healthz"));
  });

  it("classifies network failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"));

    await expect(checkServerHealth("http://127.0.0.1:8000", fetchImpl)).rejects.toBeInstanceOf(
      ServerHealthNetworkError,
    );
  });

  it("classifies non-success HTTP responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(checkServerHealth("http://127.0.0.1:8000", fetchImpl)).rejects.toMatchObject({
      name: "ServerHealthHttpError",
      status: 503,
    });
  });

  it.each([
    new Response(JSON.stringify({ status: "degraded", service: "opentag-server" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response("not-json", { status: 200 }),
  ])("classifies invalid response bodies", async (response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(checkServerHealth("http://127.0.0.1:8000", fetchImpl)).rejects.toBeInstanceOf(
      ServerHealthResponseError,
    );
  });
});
