import { describe, expect, it } from "vitest";
import { RunnerAuthFrameSchema } from "../cloud-runner.js";
import { RuntimeContextTreeExecutionServiceSchema } from "../execution-services.js";
import { RuntimeContextTreeExecutionSchema } from "../runtime-credentials.js";

describe("Context execution protocol", () => {
  const target = {
    kind: "git",
    repository: "acme/docs",
    path: ".",
    ref: "main",
    parentExecutionId: "11111111-1111-4111-8111-111111111111",
  };

  it("preserves the legacy target and strictly accepts the two explicit modes", () => {
    expect(RuntimeContextTreeExecutionSchema.parse(target)).toEqual(target);
    for (const mode of ["local", "remote"])
      expect(RuntimeContextTreeExecutionSchema.safeParse({ ...target, mode }).success).toBe(true);
    expect(RuntimeContextTreeExecutionSchema.safeParse({ ...target, mode: "arbitrary" }).success).toBe(false);
    expect(RuntimeContextTreeExecutionSchema.safeParse({ ...target, command: "git push" }).success).toBe(false);
  });

  it("accepts exactly one Context scope and only supported Runner versions", () => {
    for (const scope of ["context-tree:git", "context-tree:local"]) {
      expect(
        RuntimeContextTreeExecutionServiceSchema.safeParse({ service: "context-tree", scopes: [scope] }).success,
      ).toBe(true);
    }
    expect(
      RuntimeContextTreeExecutionServiceSchema.safeParse({
        service: "context-tree",
        scopes: ["context-tree:local", "context-tree:git"],
      }).success,
    ).toBe(false);
    for (const contextTreeExecutionVersion of [1, 2]) {
      expect(
        RunnerAuthFrameSchema.safeParse({ type: "auth", token: "bootstrap", contextTreeExecutionVersion }).success,
      ).toBe(true);
    }
    expect(
      RunnerAuthFrameSchema.safeParse({ type: "auth", token: "bootstrap", contextTreeExecutionVersion: 3 }).success,
    ).toBe(false);
  });
});
