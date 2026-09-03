import { describe, expect, it } from "vitest";
import { DEFAULT_SIGN_IN_DESTINATION, resolveSignInDestination } from "../sign-in-destination.js";

describe("sign-in destination", () => {
  it("defaults when a caller asked for nowhere in particular", () => {
    expect(resolveSignInDestination()).toBe(DEFAULT_SIGN_IN_DESTINATION);
    expect(resolveSignInDestination(undefined)).toBe(DEFAULT_SIGN_IN_DESTINATION);
  });

  it("allows the areas a sign-in is meant to arrive at", () => {
    for (const destination of [
      "/agents",
      "/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24",
      "/agents?tab=all",
      "/settings",
      "/settings/profile",
      "/agents/setup",
      "/login",
    ]) {
      expect(resolveSignInDestination(destination)).toBe(destination);
    }
  });

  it("refuses every way of naming somewhere else", () => {
    for (const destination of [
      // Absolute and scheme-relative targets leave the origin entirely.
      "https://evil.example",
      "http://evil.example/agents",
      "//evil.example",
      "//evil.example/agents",
      // A backslash is a path separator to some parsers and not others, so the two disagree about where this goes.
      "/\\evil.example",
      "\\\\evil.example",
      "/agents\\..\\settings",
      // A fragment changes which document the browser ends up showing.
      "/agents#/../evil",
      // Control characters truncate whatever reads the value next, so the two readers disagree about the target.
      "/agents\n/evil",
      "/agents\r\nLocation: https://evil.example",
      "/agents\u0000",
      "/agents\u007f",
      // A trailing space is not part of any allowed path, and trimming it would accept a value nobody wrote.
      "/agents ",
      // Local, but not somewhere a sign-in lands.
      "/",
      "/internal",
      "/api/v1/me",
      "agents",
      "",
    ]) {
      expect(resolveSignInDestination(destination)).toBeUndefined();
    }
  });

  it("refuses a destination longer than the bound", () => {
    expect(resolveSignInDestination(`/agents?q=${"a".repeat(1024)}`)).toBeUndefined();
  });
});
