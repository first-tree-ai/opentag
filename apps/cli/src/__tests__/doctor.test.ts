import { ServerHealthConfigurationError, ServerHealthNetworkError } from "@opentag/client";
import { describe, expect, it, vi } from "vitest";
import { resolveServerUrl, runDoctor } from "../core/doctor.js";

describe("resolveServerUrl", () => {
  it("prefers the command option over the environment", () => {
    expect(resolveServerUrl("http://cli.example", { OPENTAG_SERVER_URL: "http://env.example" })).toBe(
      "http://cli.example",
    );
  });

  it("uses the environment before the default", () => {
    expect(resolveServerUrl(undefined, { OPENTAG_SERVER_URL: "http://env.example" })).toBe("http://env.example");
    expect(resolveServerUrl(undefined, {})).toBe("http://127.0.0.1:8000");
  });
});

describe("runDoctor", () => {
  it("reports a healthy server", async () => {
    const healthChecker = vi.fn().mockResolvedValue({ status: "ok", service: "opentag-server" } as const);

    await expect(runDoctor({ serverUrl: "http://server.example", healthChecker })).resolves.toEqual({
      exitCode: 0,
      message: "OpenTag server is healthy (opentag-server) at http://server.example",
    });
    expect(healthChecker).toHaveBeenCalledWith("http://server.example");
  });

  it("reports a categorized failure and a non-zero exit code", async () => {
    const healthChecker = vi.fn().mockRejectedValue(new ServerHealthNetworkError("offline"));

    await expect(runDoctor({ serverUrl: "http://server.example", healthChecker })).resolves.toEqual({
      exitCode: 1,
      message: "Network error: could not reach the OpenTag server at http://server.example",
    });
  });

  it("reports an invalid server URL as a configuration error", async () => {
    const healthChecker = vi.fn().mockRejectedValue(new ServerHealthConfigurationError("invalid URL"));

    await expect(runDoctor({ serverUrl: "not-a-url", healthChecker })).resolves.toEqual({
      exitCode: 1,
      message: "Configuration error: invalid OpenTag server URL not-a-url",
    });
  });
});
