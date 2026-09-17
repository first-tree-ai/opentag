import { describe, expect, it } from "vitest";
import type { GitRefUpdate } from "../services/github-proxy/git-packets.js";
import { parseRejectedPushRefs, seedRefspecsForAllowedRefs } from "../services/github-proxy/git-remote.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);
const update = (ref: string, oldSha = ZERO, newSha = SHA_A): GitRefUpdate => ({ oldSha, newSha, ref });

describe("seed refspec filtering for ref-restricted snapshots", () => {
  // Captured from git 2.50.1: `git ls-remote --heads <remote> refs/heads/main` against a remote
  // carrying a planted `refs/heads/x/refs/heads/main` returns BOTH lines (documented tail-glob
  // semantics), so the remote's pattern matching can never be the snapshot authority.
  const DECOY_EXACT = `${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/heads/x/refs/heads/main\n`;
  const DECOY_GLOB = `${SHA_B}\trefs/heads/y/refs/heads/opentag/SID/context_tree/pwn\n`;

  it("keeps only the exact authorized ref and drops tail-matching decoys", () => {
    expect(seedRefspecsForAllowedRefs(DECOY_EXACT, ["refs/heads/main"])).toEqual(["+refs/heads/main:refs/heads/main"]);
  });

  it("matches Session task prefixes literally and drops embedded-prefix decoys", () => {
    const allowed = ["refs/heads/tree", "refs/heads/opentag/SID/context_tree/*"];
    const output =
      `${SHA_A}\trefs/heads/tree\n` +
      `${SHA_A}\trefs/heads/opentag/SID/context_tree/topic\n` +
      DECOY_GLOB +
      `${SHA_B}\trefs/heads/opentag/SID/context_tree_evil\n`;
    expect(seedRefspecsForAllowedRefs(output, allowed)).toEqual([
      "+refs/heads/tree:refs/heads/tree",
      "+refs/heads/opentag/SID/context_tree/topic:refs/heads/opentag/SID/context_tree/topic",
    ]);
  });

  it("returns an empty snapshot selection when only decoys answer", () => {
    expect(seedRefspecsForAllowedRefs(DECOY_GLOB, ["refs/heads/main"])).toEqual([]);
  });

  it("fails closed on malformed lines instead of skipping them", () => {
    expect(() => seedRefspecsForAllowedRefs(`not-a-sha\trefs/heads/main\n`, ["refs/heads/main"])).toThrow(
      /unavailable/,
    );
    expect(() => seedRefspecsForAllowedRefs(`${SHA_A}\trefs/tags/v1\n`, ["refs/heads/main"])).toThrow(/unavailable/);
  });
});

describe("push porcelain rejection evidence", () => {
  // Captured from git 2.50.1: `git push --atomic --porcelain --force-with-lease=<ref>:<stale>`
  const REAL_STALE_LEASE_REPORT = [
    "To ../remote.git",
    `!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)`,
    "Done",
    "",
  ].join("\n");

  it("accepts a complete all-refs rejection report as definitive", () => {
    expect(parseRejectedPushRefs(REAL_STALE_LEASE_REPORT, [update("refs/heads/opentag/topic")])).toEqual([
      "refs/heads/opentag/topic",
    ]);
  });

  it("requires every pushed ref to carry the rejection flag", () => {
    const updates = [update("refs/heads/opentag/one"), update("refs/heads/opentag/two")];
    const partial = [
      "To ../remote.git",
      `!\t${SHA_A}:refs/heads/opentag/one\t[remote rejected] (cannot lock ref)`,
      "Done",
    ].join("\n");
    expect(parseRejectedPushRefs(partial, updates)).toBeUndefined();
    const both = [
      "To ../remote.git",
      `!\t${SHA_A}:refs/heads/opentag/one\t[remote rejected] (cannot lock ref)`,
      `!\t${SHA_A}:refs/heads/opentag/two\t[remote rejected] (cannot lock ref)`,
      "Done",
    ].join("\n");
    expect(parseRejectedPushRefs(both, updates)).toEqual(["refs/heads/opentag/one", "refs/heads/opentag/two"]);
  });

  it("rejects reports with any applied, forced, new, or up-to-date flag on a pushed ref", () => {
    for (const flag of [" ", "+", "*", "-", "="]) {
      const mixed = [
        "To ../remote.git",
        `!\t${SHA_A}:refs/heads/opentag/one\t[remote rejected] (cannot lock ref)`,
        `${flag}\t${SHA_A}:refs/heads/opentag/two\t[ok]`,
        "Done",
      ].join("\n");
      expect(
        parseRejectedPushRefs(mixed, [update("refs/heads/opentag/one"), update("refs/heads/opentag/two")]),
      ).toBeUndefined();
    }
  });

  it("rejects truncated, malformed, or transport-failure output", () => {
    const updates = [update("refs/heads/opentag/topic")];
    // No "Done" trailer: a truncated report can hide further ref lines.
    expect(
      parseRejectedPushRefs(
        `To ../remote.git\n!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)\n`,
        updates,
      ),
    ).toBeUndefined();
    // Transport failures print no porcelain ref lines at all.
    expect(parseRejectedPushRefs("", updates)).toBeUndefined();
    expect(parseRejectedPushRefs("fatal: unable to connect to ../remote.git\n", updates)).toBeUndefined();
    // A non-porcelain line anywhere disqualifies the whole report.
    expect(parseRejectedPushRefs(`${REAL_STALE_LEASE_REPORT}garbage\n`, updates)).toBeUndefined();
  });
});
