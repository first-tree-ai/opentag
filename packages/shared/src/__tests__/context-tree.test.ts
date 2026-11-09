import { expect, it } from "vitest";
import {
  ContextTreeBranchSchema,
  ContextTreeConnectionSchema,
  ContextTreePathSchema,
  ContextTreesSchema,
  contextTreeSelector,
  normalizeContextTrees,
} from "../context-tree.js";

const source = { kind: "git", repository: "acme/project", path: "docs", ref: "main" } as const;
it("identifies trees by repository, directory, and branch", () => {
  expect(
    ContextTreesSchema.parse([source, { ...source, path: "notes" }, { ...source, ref: "feature/docs" }]),
  ).toHaveLength(3);
  expect(ContextTreesSchema.safeParse([source, { ...source, repository: "ACME/PROJECT" }]).success).toBe(false);
  expect(contextTreeSelector({ ...source, ref: "feature/docs" })).toBe(
    "https://github.com/acme/project/tree/feature%2Fdocs/docs",
  );
});
it("requires the current source shape", () => {
  expect(ContextTreeConnectionSchema.safeParse({ alias: "memory", repository: "acme/project" }).success).toBe(false);
});
it.each(["..", "/docs", "docs/../other", ".git", "docs//notes", "docs\\notes", "docs\n"])(
  "rejects unsafe directory %j",
  (path) => {
    expect(ContextTreePathSchema.safeParse(path).success).toBe(false);
  },
);
it.each(["", "-main", "HEAD~1", "refs/../main", "a.lock", "a\n"])("rejects unsafe branch %j", (ref) => {
  expect(ContextTreeBranchSchema.safeParse(ref).success).toBe(false);
});
it("normalizes ordering without mutation and bounds source count", () => {
  const sources = Array.from({ length: 33 }, (_, index) => ({ ...source, path: `docs${index}` }));
  expect(ContextTreesSchema.safeParse(sources.slice(0, 32)).success).toBe(true);
  expect(ContextTreesSchema.safeParse(sources).success).toBe(false);
  expect(normalizeContextTrees(sources)).toEqual(normalizeContextTrees([...sources].reverse()));
});

it("keeps Context Tree availability responses minimal and rejects credential-shaped data", async () => {
  const { ContextTreeAvailabilityResponseSchema } = await import("../context-tree-operation.js");
  expect(ContextTreeAvailabilityResponseSchema.parse({ status: "ready", readOnly: true })).toEqual({
    status: "ready",
    readOnly: true,
  });
  expect(
    ContextTreeAvailabilityResponseSchema.safeParse({
      status: "ready",
      readOnly: false,
      accessToken: "must-not-be-returned",
    }).success,
  ).toBe(false);
  expect(
    ContextTreeAvailabilityResponseSchema.safeParse({ status: "completed", repository: "acme/memory" }).success,
  ).toBe(false);
});
