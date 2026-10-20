import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { authorizationAction, connectorFeedback, probeFeedback } from "./mcp-feedback.js";
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
    ).toEqual({ label: "Request timed out", action: "retry" });
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
    ["MCP_UPSTREAM_UNAVAILABLE: timed out", "Request timed out"],
    ["MCP_UPSTREAM_UNAVAILABLE: connection refused", "Cannot reach service"],
    ["MCP_PROBE_FAILED: private response", "Couldn't load tools"],
  ])("classifies %s without exposing upstream details", (error, label) => {
    expect(probeFeedback(error, "oauth")).toEqual({ label, action: "retry" });
  });
  it("uses a generic authorization reason when the service response cannot distinguish the cause", () => {
    expect(probeFeedback(`${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`, "bearer")).toEqual({
      label: "Authorization failed",
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
