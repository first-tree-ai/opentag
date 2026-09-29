import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { assertPrivateWorkspaceRoot, SkillSourceWorkspace } from "../services/skills/source/source-workspace.js";

/**
 * The request-private staging directory: it exists while the request runs and is gone afterwards,
 * and a directory this process cannot call private is refused rather than used.
 */

describe("SkillSourceWorkspace", () => {
  it("creates a private directory and removes it on dispose", async () => {
    const workspace = await SkillSourceWorkspace.create();
    const created = await lstat(workspace.root);
    expect(created.isDirectory()).toBe(true);
    expect(created.mode & 0o077).toBe(0);
    expect(workspace.root.startsWith(tmpdir())).toBe(true);

    await workspace.dispose();
    await expect(lstat(workspace.root)).rejects.toThrow();
  });

  it("tolerates a repeated dispose", async () => {
    const workspace = await SkillSourceWorkspace.create();
    await workspace.dispose();
    await expect(workspace.dispose()).resolves.toBeUndefined();
  });

  it("fails closed on a directory it cannot call private", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-workspace-check-"));
    try {
      await chmod(directory, 0o755);
      await expect(assertPrivateWorkspaceRoot(directory)).rejects.toThrow("readable by other users");
      await chmod(directory, 0o700);
      await expect(assertPrivateWorkspaceRoot(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a staging failure as an unavailable source rather than a filesystem error", async () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(tmpdir(), "opentag-missing-staging-root");
    try {
      let code: string | undefined;
      try {
        await SkillSourceWorkspace.create();
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });
});
