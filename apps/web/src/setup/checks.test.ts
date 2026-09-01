import { describe, expect, it } from "vitest";
import { deriveChecks, formatRemaining, messagingCliCheck } from "./checks.js";

describe("deriveChecks", () => {
  it("reports every row as pending before the first probe resolves", () => {
    expect(deriveChecks(undefined).map((check) => check.state)).toEqual(["pending", "pending"]);
    expect(deriveChecks("checking").map((check) => check.state)).toEqual(["pending", "pending"]);
  });

  it("passes both runtime rows when the runtime is ready", () => {
    expect(deriveChecks("ready").map((check) => check.state)).toEqual(["passed", "passed"]);
  });

  it("leaves the messaging CLI out: it is asked about separately, once there is a provider", () => {
    expect(deriveChecks("ready").map((check) => check.id)).toEqual(["runtime-cli", "runtime-auth"]);
  });

  it("treats a sign-in failure as proof the CLI runs", () => {
    const checks = deriveChecks("sign-in");
    expect(checks[0]).toEqual({ id: "runtime-cli", state: "passed" });
    expect(checks[1]).toEqual({ id: "runtime-auth", state: "failed" });
  });

  it("blocks the sign-in row when the CLI is missing, rather than guessing", () => {
    const checks = deriveChecks("install");
    expect(checks[0]).toEqual({ id: "runtime-cli", state: "failed" });
    expect(checks[1]).toEqual({ id: "runtime-auth", state: "blocked" });
  });
});

describe("messagingCliCheck", () => {
  it("reports the CLI it is given, whichever provider it belongs to", () => {
    expect(messagingCliCheck("install")).toBe("pending");
    expect(messagingCliCheck("unavailable")).toBe("failed");
    expect(messagingCliCheck("ready")).toBe("passed");
  });

  it("treats a CLI the Server has not reported on as still being checked, not failing", () => {
    expect(messagingCliCheck(undefined)).toBe("pending");
    expect(messagingCliCheck("checking")).toBe("pending");
  });
});

describe("formatRemaining", () => {
  it("renders minutes and zero-padded seconds", () => {
    expect(formatRemaining(15 * 60 * 1_000)).toBe("15:00");
    expect(formatRemaining(65_000)).toBe("1:05");
  });

  it("never renders a negative duration", () => {
    expect(formatRemaining(-1_000)).toBe("0:00");
  });
});
