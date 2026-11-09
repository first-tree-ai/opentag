import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { authorizationAction, connectorFeedback, failureCodeFeedback, probeFeedback } from "./mcp-feedback.js";
import { authorization, entry } from "./mcp-test-fixtures.js";

describe("Connector feedback evidence", () => {
  it("does not claim ongoing availability from a successful tool snapshot", () => {
    expect(connectorFeedback(entry())).toEqual({});
  });
  it("keeps a previous tool result quiet during background refresh", () => {
    expect(connectorFeedback(entry({ authorization: { ...authorization(), probeState: "pending" } }))).toEqual({});
  });
  it.each(["missing timestamp", "missing snapshot"])("shows initial loading with %s", (missing) => {
    const row = entry({
      authorization: {
        ...authorization(),
        probeState: "pending",
        probedAt: missing === "missing timestamp" ? null : authorization().probedAt,
      },
      ...(missing === "missing snapshot" ? { snapshot: null } : {}),
    });
    expect(connectorFeedback(row)).toEqual({ label: "Loading tools…", neutral: true });
  });
  it("retains an empty result during background refresh", () => {
    const snapshot = entry().snapshot;
    expect(
      connectorFeedback(
        entry({
          authorization: { ...authorization(), probeState: "pending", toolsCount: 0 },
          snapshot: snapshot && { ...snapshot, tools: [] },
        }),
      ),
    ).toEqual({ label: "No tools available", neutral: true });
  });
  it("keeps a confirmed tool failure visible even with a saved snapshot", () => {
    expect(
      connectorFeedback(
        entry({
          authorization: {
            ...authorization(),
            probeState: "failed",
            probeError: "MCP_UPSTREAM_UNAVAILABLE: timed out",
          },
        }),
      ),
    ).toEqual({ label: "The service timed out. Try again.", action: "retry" });
  });
  it("does not treat an old probe error as the result of a pending refresh", () => {
    expect(
      connectorFeedback(
        entry({
          authorization: {
            ...authorization(),
            probeState: "pending",
            probeError: "MCP_UPSTREAM_UNAVAILABLE: timed out",
          },
        }),
      ),
    ).toEqual({});
  });
  it("does not infer provider revocation from a local reset", () => {
    expect(
      connectorFeedback(
        entry({ authorization: { ...authorization(), status: "revoked", hasCredential: false, failureCode: null } }),
      ),
    ).toEqual({ action: "authorize" });
  });
  it("uses a known expiration reason and offers reauthorization", () => {
    const row = entry({ authorization: { ...authorization(), status: "expired", hasCredential: false } });
    expect(connectorFeedback(row)).toEqual({ label: "Authorization expired", action: "authorize" });
    expect(authorizationAction(row)).toBe("Reauthorize");
  });
  it.each([
    ["MCP_UPSTREAM_UNAVAILABLE: timed out", "The service timed out. Try again."],
    ["MCP_UPSTREAM_UNAVAILABLE: connection refused", "Can't reach the service. Try again later."],
    ["MCP_PROBE_FAILED: private response", "Couldn't load tools. Try again."],
  ])("classifies %s without exposing upstream details", (error, label) => {
    expect(probeFeedback(error, "oauth")).toEqual({ label, action: "retry" });
  });
  it("asks for a new key when the service rejects a saved key, and to authorize again otherwise", () => {
    expect(probeFeedback(`${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`, "bearer")).toEqual({
      label: "The key was rejected. Update it.",
      action: "authorize",
    });
    expect(probeFeedback(`${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`, "oauth")).toEqual({
      label: "Authorization didn't finish. Try again.",
      action: "authorize",
    });
  });
  it("keeps complete empty results neutral and partial results quiet", () => {
    expect(connectorFeedback(entry({ authorization: { ...authorization(), toolsCount: 0 } }))).toEqual({
      label: "No tools available",
      neutral: true,
    });
    expect(
      connectorFeedback(entry({ authorization: { ...authorization(), toolsCount: 0, toolsTruncated: true } })),
    ).toEqual({});
  });
});

describe("Connector failure reasons with a next step", () => {
  it("names an unreachable address, unsupported sign-in, and an unreachable service", () => {
    expect(failureCodeFeedback(MCP_ERROR_CODES.URL_BLOCKED)).toBe(
      "Can't reach this address. Check the connector address.",
    );
    expect(failureCodeFeedback(MCP_ERROR_CODES.SERVER_URL_INVALID)).toBe(
      "Can't reach this address. Check the connector address.",
    );
    expect(failureCodeFeedback(MCP_ERROR_CODES.REGISTRATION_UNSUPPORTED)).toBe(
      "This service doesn't support account sign-in. Use an API key.",
    );
    expect(failureCodeFeedback(MCP_ERROR_CODES.REGISTRATION_FAILED)).toBe("Authorization didn't finish. Try again.");
    expect(failureCodeFeedback(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE)).toBe("Can't reach the service. Try again later.");
    expect(failureCodeFeedback("SOMETHING_ELSE")).toBeUndefined();
    expect(failureCodeFeedback(null)).toBeUndefined();
  });

  it("explains a blocked custom address from a probe failure", () => {
    expect(probeFeedback(`${MCP_ERROR_CODES.URL_BLOCKED}: resolves to a non-public address`, "none", false)).toEqual({
      label: "Can't reach this address. Check the connector address.",
      action: "retry",
      recovery: "edit-address",
    });
  });
});
