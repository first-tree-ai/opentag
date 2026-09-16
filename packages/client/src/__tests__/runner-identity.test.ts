import { describe, expect, it } from "vitest";
import {
  assertRunnerReleaseVersion,
  assertRunnerVersionIsNotClientPlaceholder,
  createRunnerIdentity,
  parseRunnerIdentity,
} from "../runner/identity.js";

const identity = {
  schemaVersion: 1 as const,
  channel: "prod" as const,
  version: "0.0.5",
  sourceSha: "440dfed53c3bb22a8527cd731f82e9b9006bd9b5",
  sourceDirty: false,
  cliPackageName: "open-tag",
  nodeVersion: "v24.19.0",
  pnpmVersion: "10.12.1",
  piPackage: "@earendil-works/pi-coding-agent",
  piVersion: "0.84.2",
  contextTreeVersion: "0.1.14",
  toolLock: {
    node: "v24.19.0",
    pnpm: "10.12.1",
    piPackage: "@earendil-works/pi-coding-agent",
    piVersion: "0.84.2",
    git: "1:2.39.5-0+deb12u3",
    gh: "2.100.0",
  },
};

describe("runner identity", () => {
  it("round-trips a complete identity record", () => {
    expect(createRunnerIdentity(identity)).toMatchObject({ version: "0.0.5", sourceDirty: false });
  });

  it("rejects the private Client 0.0.0 coordinate", () => {
    expect(() => assertRunnerVersionIsNotClientPlaceholder("0.0.0")).toThrow(/CLI release coordinate/);
    expect(() => parseRunnerIdentity({ ...identity, version: "0.0.0" })).toThrow(/CLI release coordinate/);
  });

  it("accepts an externally resolved staging version and rejects independent increments", () => {
    expect(assertRunnerReleaseVersion("staging", "0.0.5", "0.0.6-staging.3.1")).toBe("0.0.6-staging.3.1");
    expect(() => assertRunnerReleaseVersion("staging", "0.0.5", "0.0.7-staging.1.1")).toThrow(/0\.0\.6-staging/);
    expect(() => assertRunnerReleaseVersion("prod", "0.0.5", "0.0.6")).toThrow(/must match source version/);
  });

  it("rejects a truncated SHA and mismatched Pi lock", () => {
    expect(() => parseRunnerIdentity({ ...identity, sourceSha: "abc" })).toThrow(/40-character/);
    expect(() =>
      parseRunnerIdentity({
        ...identity,
        toolLock: { ...identity.toolLock, piVersion: "0.0.1" },
      }),
    ).toThrow(/toolLock Pi coordinates/);
  });

  it("rejects an unknown channel, a schema mismatch, and non-matching versions", () => {
    expect(() => parseRunnerIdentity({ ...identity, channel: "canary" })).toThrow(
      /channel must be dev, staging, or prod/,
    );
    expect(() => parseRunnerIdentity({ ...identity, schemaVersion: 2 })).toThrow(/schemaVersion must be/);
    expect(() => parseRunnerIdentity(null)).toThrow(/must be an object/);
    expect(() => assertRunnerReleaseVersion("dev", "0.0.5", "0.0.6")).toThrow(/dev version 0.0.6 must match/);
    expect(() => assertRunnerReleaseVersion("prod", "0.0.5", "0.0.6")).toThrow(/must match source version/);
    expect(() => assertRunnerReleaseVersion("staging", "0.0.5-beta", "0.0.6-staging.1.1")).toThrow(/stable/);
  });
});
