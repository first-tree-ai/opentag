import { expect, it } from "vitest";
import {
  ContextTreeAliasSchema,
  ContextTreeRepositorySchema,
  ContextTreesSchema,
  normalizeContextTrees,
} from "../context-tree.js";

it("preserves repository spelling and trims surrounding whitespace", () => {
  expect(ContextTreeRepositorySchema.parse("  Acme/Team-Memory  ")).toBe("Acme/Team-Memory");
});
it.each(["memory", "/tmp/memory", "acme/tree.git", "acme/tree.GIT", "https://github.com/acme/tree"])(
  "rejects non-repository target %s",
  (target) => {
    expect(ContextTreeRepositorySchema.safeParse(target).success).toBe(false);
  },
);

it("rejects duplicate aliases and case-insensitive duplicate repositories", () => {
  expect(
    ContextTreesSchema.safeParse([
      { alias: "team", repository: "acme/one" },
      { alias: "team", repository: "acme/two" },
    ]).success,
  ).toBe(false);
  expect(
    ContextTreesSchema.safeParse([
      { alias: "team", repository: "Acme/One" },
      { alias: "other", repository: "acme/one" },
    ]).success,
  ).toBe(false);
  expect(ContextTreesSchema.parse([])).toEqual([]);
});
it.each(["", "../tree", "a/b", " tree", ".tree", "tree.git", "tree.GIT", "a".repeat(101)])(
  "rejects unsafe alias %s",
  (alias) => {
    expect(ContextTreeAliasSchema.safeParse(alias).success).toBe(false);
  },
);
it("normalizes identity without precedence or mutation", () => {
  const trees = [
    { alias: "z", repository: "Acme/Z" },
    { alias: "a", repository: "Acme/A" },
  ];
  expect(normalizeContextTrees(trees)).toEqual(normalizeContextTrees([...trees].reverse()));
  expect(trees[0]?.repository).toBe("Acme/Z");
});

it("accepts 32 trees and rejects a 33rd tree", () => {
  const connections = Array.from({ length: 33 }, (_, index) => ({
    alias: `tree-${index}`,
    repository: `acme/tree-${index}`,
  }));
  expect(ContextTreesSchema.safeParse(connections.slice(0, 32)).success).toBe(true);
  expect(ContextTreesSchema.safeParse(connections).success).toBe(false);
});
