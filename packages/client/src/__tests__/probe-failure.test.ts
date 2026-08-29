import { describe, expect, it } from "vitest";
import {
  artifactOrTransientProbeIssue,
  isBinaryShapedProviderProbeFailure,
  isTransientProviderProbeFailure,
  readProbeFailureEvidence,
} from "../agent-runtime/probe-failure.js";

describe("provider probe failure taxonomy", () => {
  it("reads no evidence from non-object values", () => {
    expect(readProbeFailureEvidence(null)).toEqual({});
    expect(readProbeFailureEvidence("timeout")).toEqual({});
    expect(isTransientProviderProbeFailure(null)).toBe(false);
    expect(isBinaryShapedProviderProbeFailure("x")).toBe(false);
  });

  it("treats crash signals as binary even when killed is set", () => {
    const error = Object.assign(new Error("crash"), { killed: true, signal: "SIGSEGV" });
    expect(isTransientProviderProbeFailure(error)).toBe(false);
    expect(isBinaryShapedProviderProbeFailure(error)).toBe(true);
  });

  it("treats unknown non-crash signals and timeout kills as transient", () => {
    expect(isTransientProviderProbeFailure(Object.assign(new Error("usr"), { signal: "SIGUSR1" }))).toBe(true);
    expect(isTransientProviderProbeFailure(Object.assign(new Error("kill"), { killed: true, signal: "SIGKILL" }))).toBe(
      true,
    );
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("usr"), { signal: "SIGUSR1" }))).toBe(false);
  });

  it("treats clean non-zero exits and ENOENT as binary-shaped", () => {
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("exit"), { code: 1 }))).toBe(true);
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isBinaryShapedProviderProbeFailure(new Error("plain"))).toBe(false);
    expect(artifactOrTransientProbeIssue(Object.assign(new Error("busy"), { code: "EAGAIN" }), "x")).toEqual({
      code: "temporarily_unavailable",
      message: "x",
    });
  });
});
