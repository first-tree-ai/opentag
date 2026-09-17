import { chmod, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertEphemeralWorkspaceRoot, GitWorkspace } from "../services/github-proxy/git-workspace.js";

const created: string[] = [];
afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("ephemeral Git workspace", () => {
  it("performs no filesystem writes until the first staging directory is requested", async () => {
    const workspace = new GitWorkspace();
    expect(workspace.root).toBeUndefined();
    const staging = await workspace.stagingDirectory("read-");
    const root = workspace.root;
    expect(root).toBeDefined();
    created.push(root as string);
    expect(staging.startsWith(join(root as string, "read-"))).toBe(true);
    expect((await lstat(root as string)).mode & 0o777).toBe(0o700);
    // The shared root is created exactly once; further staging directories reuse it.
    const again = await workspace.stagingDirectory("git-");
    expect(workspace.root).toBe(root);
    expect(again.startsWith(join(root as string, "git-"))).toBe(true);
    await workspace.close();
  });

  it("removes the exclusive temporary root on close and rejects later staging", async () => {
    const workspace = new GitWorkspace();
    await workspace.stagingDirectory("tree-head-");
    const root = workspace.root as string;
    expect((await readdir(root)).some((name) => name.startsWith("tree-head-"))).toBe(true);
    await workspace.close();
    expect(workspace.root).toBeUndefined();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(workspace.stagingDirectory("read-")).rejects.toMatchObject({ code: "unavailable" });
    // Closing twice is safe.
    await workspace.close();
  });

  it("shares one in-flight creation across concurrent staging requests", async () => {
    const workspace = new GitWorkspace();
    const [first, second] = await Promise.all([
      workspace.stagingDirectory("read-"),
      workspace.stagingDirectory("git-"),
    ]);
    const root = workspace.root as string;
    created.push(root);
    expect(first).not.toBe(second);
    expect(first.startsWith(join(root, "read-"))).toBe(true);
    expect(second.startsWith(join(root, "git-"))).toBe(true);
    await workspace.close();
  });

  it("rejects a staging result when close starts during directory creation", async () => {
    const workspace = new GitWorkspace();
    await workspace.stagingDirectory("read-");
    const root = workspace.root as string;
    created.push(root);
    const staging = workspace.stagingDirectory("git-").then(
      () => "resolved",
      (error: unknown) => (error as { code?: string }).code,
    );
    // Let the already-initialized root resolve and enqueue mkdtemp. Filesystem completion
    // cannot run until this microtask turn ends, so close starts before creation completes.
    await Promise.resolve();
    const closing = workspace.close();
    await expect(staging).resolves.toBe("unavailable");
    await closing;
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on an unsafe temporary root instead of trusting it", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "opentag-workspace-unsafe-"));
    created.push(root);
    await chmod(root, 0o755);
    await expect(assertEphemeralWorkspaceRoot(root)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("removes the created root when root validation fails during initialization", async () => {
    let attempted: string | undefined;
    const workspace = new GitWorkspace({
      validateRoot: async (root) => {
        attempted = root;
        throw new Error("simulated validation failure");
      },
    });
    await expect(workspace.stagingDirectory("read-")).rejects.toThrow("simulated validation failure");
    expect(attempted).toBeDefined();
    // The partially constructed root was removed by the handled failure path.
    await expect(lstat(attempted as string)).rejects.toMatchObject({ code: "ENOENT" });
    expect(workspace.root).toBeUndefined();
    // A later close is a no-op, and staging keeps failing instead of resurrecting state.
    await workspace.close();
    await expect(workspace.stagingDirectory("read-")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("lets a close win the race against an in-flight staging creation", async () => {
    // Deterministic handshake: the root validator blocks until the test releases it, so close()
    // is guaranteed to start while the first staging request is still being created.
    let releaseValidation: (() => void) | undefined;
    let attempted: string | undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const workspace = new GitWorkspace({
      validateRoot: async (root) => {
        attempted = root;
        await validationGate;
      },
    });
    const staging = workspace.stagingDirectory("read-");
    const stagingSettled = staging.then(
      () => "resolved",
      (error: unknown) => (error as { code?: string }).code ?? "error",
    );
    const closing = workspace.close();
    expect(releaseValidation).toBeDefined();
    (releaseValidation as () => void)();

    // The staging request never returns a valid directory once close has begun draining.
    await expect(stagingSettled).resolves.toBe("unavailable");
    await closing;
    expect(workspace.root).toBeUndefined();
    await expect(lstat(attempted as string)).rejects.toMatchObject({ code: "ENOENT" });
    // No new staging directory can appear after close returned.
    await expect(workspace.stagingDirectory("git-")).rejects.toMatchObject({ code: "unavailable" });
  });
});
