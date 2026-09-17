import { MCP_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import type { McpServiceError } from "../services/mcp/errors.js";
import {
  buildMcpAuthHeaders,
  MCP_OAUTH_AUTHORIZATION_HEADER,
  parseExtraHeaders,
  validateAuthHeaderName,
} from "../services/mcp/mcp-auth-headers.js";

/**
 * The one place an outbound authorization header is built. Probing and any future runtime call take
 * this same path, so a rule cannot be enforced in one and forgotten in the other.
 *
 * The interesting cases are the ones a reader would have to reason about rather than look up: an
 * empty scheme is a legitimate "send it verbatim", `extra_headers` apply to all three kinds, and a
 * collision between the resolved authorization header and an extra header is refused rather than
 * silently resolved one way.
 */

function failure(run: () => unknown): McpServiceError {
  try {
    run();
  } catch (error) {
    return error as McpServiceError;
  }
  throw new Error("Expected the call to fail");
}

describe("buildMcpAuthHeaders", () => {
  it("always uses the Authorization header for OAuth, as the specification requires", () => {
    const headers = buildMcpAuthHeaders({
      kind: "oauth",
      authHeader: "x-custom",
      authScheme: "Token",
      extraHeaders: {},
      accessToken: "at_123",
    });
    expect(headers).toEqual({ [MCP_OAUTH_AUTHORIZATION_HEADER]: "Bearer at_123" });
  });

  it("sends a bearer value verbatim when the scheme is empty", () => {
    const headers = buildMcpAuthHeaders({
      kind: "bearer",
      authHeader: "x-api-key",
      authScheme: "",
      extraHeaders: {},
      bearerKey: "key_123",
    });
    // An empty scheme is a value, not an absence: prefixing it would send a scheme the Server
    // never asked for.
    expect(headers).toEqual({ "x-api-key": "key_123" });
  });

  it("prefixes a non-empty scheme with one space", () => {
    const headers = buildMcpAuthHeaders({
      kind: "bearer",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      bearerKey: "key_123",
    });
    expect(headers).toEqual({ authorization: "Bearer key_123" });
  });

  it("sends no authorization header at all for an anonymous authorization", () => {
    const headers = buildMcpAuthHeaders({
      kind: "none",
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: { "x-workspace-id": "ws_123" },
    });
    // Extra headers are configuration rather than credentials, so `none` still sends them.
    expect(headers).toEqual({ "x-workspace-id": "ws_123" });
    expect(headers.authorization).toBeUndefined();
  });

  it("attaches extra headers for every kind", () => {
    for (const kind of ["none", "bearer", "oauth"] as const) {
      const headers = buildMcpAuthHeaders({
        kind,
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: { "x-workspace-id": "ws_123", "x-tenant": "t1" },
        ...(kind === "bearer" ? { bearerKey: "k" } : {}),
        ...(kind === "oauth" ? { accessToken: "at" } : {}),
      });
      expect(headers["x-workspace-id"], kind).toBe("ws_123");
      expect(headers["x-tenant"], kind).toBe("t1");
    }
  });

  it("refuses an extra header that repeats the resolved authorization header, case-insensitively", () => {
    const error = failure(() =>
      buildMcpAuthHeaders({
        kind: "bearer",
        authHeader: "x-api-key",
        authScheme: "",
        extraHeaders: { "X-Api-Key": "conflict" },
        bearerKey: "k",
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.AUTH_HEADER_INVALID);
  });

  it("refuses a collision with an inherited authorization header name", () => {
    // The Agent inherits `auth_header` from the shared definition while overriding the extra
    // headers; the collision check runs against the resolved pair, not each field alone.
    const error = failure(() =>
      buildMcpAuthHeaders({
        kind: "bearer",
        authHeader: "authorization",
        authScheme: "Bearer",
        extraHeaders: { authorization: "dup" },
        bearerKey: "k",
      }),
    );
    expect(error.code).toBe(MCP_ERROR_CODES.AUTH_HEADER_INVALID);
  });

  it("requires the credential the kind calls for", () => {
    expect(
      failure(() =>
        buildMcpAuthHeaders({ kind: "bearer", authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} }),
      ).code,
    ).toBe(MCP_ERROR_CODES.AUTH_HEADER_INVALID);
    expect(
      failure(() =>
        buildMcpAuthHeaders({ kind: "oauth", authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} }),
      ).code,
    ).toBe(MCP_ERROR_CODES.AUTH_HEADER_INVALID);
    // `none` needs nothing, which is the point of it being a real authorization kind.
    expect(() =>
      buildMcpAuthHeaders({ kind: "none", authHeader: "authorization", authScheme: "Bearer", extraHeaders: {} }),
    ).not.toThrow();
  });
});

describe("MCP custom header validation", () => {
  it("accepts a token-shaped header name and lowercases it", () => {
    expect(validateAuthHeaderName("X-Api-Key")).toBe("x-api-key");
  });

  it("refuses a name outside the RFC 9110 token set", () => {
    for (const name of ["", "x api key", "x:key", "x\tkey", "x\nkey", "x\r\nInjected: 1"]) {
      expect(() => validateAuthHeaderName(name), JSON.stringify(name)).toThrow();
    }
  });

  it("refuses the reserved headers that would conflict with the transport", () => {
    for (const name of ["host", "content-length", "connection", "transfer-encoding", "content-type", "accept"]) {
      expect(() => validateAuthHeaderName(name), name).toThrow();
    }
    for (const name of ["mcp-method", "mcp-name", "mcp-protocol-version", "mcp-param-x"]) {
      expect(() => validateAuthHeaderName(name), name).toThrow();
    }
  });
});

describe("MCP extra header validation", () => {
  it("lowercases keys and keeps values as written", () => {
    expect(parseExtraHeaders({ "X-Workspace-Id": "ws_123" })).toEqual({ "x-workspace-id": "ws_123" });
  });

  it("refuses a key outside the token set, including CR/LF", () => {
    for (const key of ["x workspace", "x:key", "x\nInjected"]) {
      expect(() => parseExtraHeaders({ [key]: "v" }), JSON.stringify(key)).toThrow();
    }
  });

  it("refuses a value containing CR or LF", () => {
    for (const value of ["a\nb", "a\rb", "a\r\nb"]) {
      expect(() => parseExtraHeaders({ "x-key": value }), JSON.stringify(value)).toThrow();
    }
  });

  it("refuses a value containing any other control character", () => {
    /*
     * CR and LF were the injection risk; a NUL and its neighbours were a worse user experience —
     * undici rejects the value, which reached the user as "the MCP endpoint could not be reached", an
     * error about the Server for a header this deployment refused to send.
     */
    for (const value of ["a\u0000b", "a\u0007b", "a\u001fb", "a\u007fb"]) {
      expect(() => parseExtraHeaders({ "x-key": value }), JSON.stringify(value)).toThrow();
    }
  });

  it("refuses the reserved names", () => {
    for (const key of ["host", "content-type", "accept", "mcp-name"]) {
      expect(() => parseExtraHeaders({ [key]: "v" }), key).toThrow();
    }
  });

  it("refuses the connection-scoped names undici will not send", () => {
    /*
     * `te` and `proxy-authorization` are the ones that mattered most: they describe the hop rather than
     * the request, so forwarding them was wrong independently of undici refusing the others.
     */
    for (const key of ["keep-alive", "upgrade", "expect", "te", "trailer", "proxy-authorization"]) {
      expect(() => parseExtraHeaders({ [key]: "v" }), key).toThrow();
    }
  });

  it("bounds the count, a single value, and the serialized total", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-h${index}`, "v"]));
    expect(() => parseExtraHeaders(tooMany)).toThrow();

    expect(() => parseExtraHeaders({ "x-key": "v".repeat(4097) })).toThrow();

    // Sixteen values just under the per-value bound exceed the total bound together.
    const overTotal = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`x-h${index}`, "v".repeat(600)]));
    expect(() => parseExtraHeaders(overTotal)).toThrow();
  });

  it("accepts sixteen headers within every bound", () => {
    const atLimit = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`x-h${index}`, "v"]));
    expect(Object.keys(parseExtraHeaders(atLimit))).toHaveLength(16);
  });
});
