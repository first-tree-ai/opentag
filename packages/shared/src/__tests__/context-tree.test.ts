import { expect, it } from "vitest";
import { ContextTreeRepositorySchema } from "../context-tree.js";

it("preserves repository spelling and trims surrounding whitespace", () => {
  expect(ContextTreeRepositorySchema.parse("  Acme/Team-Memory  ")).toBe("Acme/Team-Memory");
});
it.each(["memory", "/tmp/memory", "acme/tree.git", "acme/tree.GIT", "https://github.com/acme/tree"])(
  "rejects non-repository target %s",
  (target) => {
    expect(ContextTreeRepositorySchema.safeParse(target).success).toBe(false);
  },
);
