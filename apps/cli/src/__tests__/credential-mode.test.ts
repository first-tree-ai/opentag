import { describe, expect, it } from "vitest";
import { resolveLegacyMcpGateway, resolveRuntimeCredentialMode } from "../core/daemon/credential-mode.js";

describe("daemon credential mode", () => {
  it("defaults to legacy and rejects unknown modes", () => {
    expect(resolveRuntimeCredentialMode({})).toBe("legacy");
    expect(resolveRuntimeCredentialMode({ OPENTAG_RUNTIME_CREDENTIAL_MODE: "proxy" })).toBe("proxy");
    expect(() => resolveRuntimeCredentialMode({ OPENTAG_RUNTIME_CREDENTIAL_MODE: "raw" })).toThrow();
  });

  it("keeps legacy MCP delivery on unless explicitly turned off", () => {
    expect(resolveLegacyMcpGateway({})).toBe(true);
    expect(resolveLegacyMcpGateway({ OPENTAG_LEGACY_MCP_GATEWAY: "on" })).toBe(true);
    expect(resolveLegacyMcpGateway({ OPENTAG_LEGACY_MCP_GATEWAY: "off" })).toBe(false);
    expect(() => resolveLegacyMcpGateway({ OPENTAG_LEGACY_MCP_GATEWAY: "maybe" })).toThrow(
      "OPENTAG_LEGACY_MCP_GATEWAY must be on or off",
    );
  });
});
