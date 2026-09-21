import { describe, expect, it } from "vitest";
import { verifyGitHubRepositoryAdmissionProof } from "../services/github/bindings-proof.js";

describe("GitHub admission proof freshness", () => {
  it("rejects invalid verification dates instead of treating NaN comparisons as fresh", () => {
    const identity = { connectionId: "connection", authorizationVersion: 1n, githubUserId: "123" };
    expect(() =>
      verifyGitHubRepositoryAdmissionProof(
        { ...identity, bindingsHash: "hash", verifiedAt: new Date(Number.NaN) },
        identity,
        "hash",
        new Date(),
      ),
    ).toThrow();
  });
});
