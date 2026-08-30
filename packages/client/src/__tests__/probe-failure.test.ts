import { describe, expect, it } from "vitest";
import {
  classifiedProviderProbeIssue,
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

  it("treats only known artifact errno, clean non-zero exits, and crash signals as binary-shaped", () => {
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("exit"), { code: 1 }))).toBe(true);
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(true);
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(true);
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("format"), { code: "ENOEXEC" }))).toBe(true);
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("loop"), { code: "ELOOP" }))).toBe(true);
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("io"), { code: "EIO" }))).toBe(false);
    expect(isBinaryShapedProviderProbeFailure(Object.assign(new Error("ok"), { exitCode: 0 }))).toBe(false);
    expect(isBinaryShapedProviderProbeFailure(new Error("plain"))).toBe(false);
    expect(classifiedProviderProbeIssue(Object.assign(new Error("busy"), { code: "EAGAIN" }), "x")).toEqual({
      code: "temporarily_unavailable",
      message: "x",
    });
    expect(classifiedProviderProbeIssue(new Error("plain"), "x")).toBeUndefined();
    expect(classifiedProviderProbeIssue("bare", "x")).toBeUndefined();
  });
});
