import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextTreeOperationFrame } from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
import { type ContextTreeExecFile, runContextTreeProcess } from "../runtime/context-tree.js";
import { ContextTreeSettings } from "../runtime/context-tree-settings.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function frame(action: "create" | "connect" | "disconnect" = "create"): ContextTreeOperationFrame {
  return {
    type: "context-tree:operation",
    requestId: randomUUID(),
    agentId: randomUUID(),
    computerId: randomUUID(),
    requireStopped: true,
    input: {
      kind: "git",
      repository: "acme/memory",
      path: ".",
      ref: "main",
      action,
      operationId: randomUUID(),
      expectedRevision: 1,
      expectedRuntimeConfigRevision: 1,
    },
  };
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ct-settings-"));
  roots.push(home);
  const run = vi.fn(async (_args: readonly string[]) => ({
    payload: {
      schemaVersion: 3,
      connection: { projectRoot: home, source: { kind: "git", repository: "acme/memory", path: ".", ref: "main" } },
      treeRoot: home,
      repository: { root: home, directory: ".", sha: "a".repeat(40), branch: "main" },
      dirty: false,
    },
  }));
  const process = vi.fn<ContextTreeExecFile>(async (_file, args) => {
    if (args.includes("--verify")) throw new Error("unborn");
    return { stdout: args.includes("rev-parse") ? "a".repeat(40) : "" };
  });
  const options = {
    home,
    environment: {},
    managedCredentials: true,
    managedEnvironment: () => ({ GH_TOKEN: "handle", OPENTAG_PROVIDER_PROXY_URL: "http://localhost/proxy" }),
    hasAgentSessions: () => false,
    exclusive: async <T>(operation: () => Promise<T>) => operation(),
    run,
    process,
  };
  return { options, run, process, settings: new ContextTreeSettings(options) };
}
it("checks an uncertain push against the staged commit instead of recreating the repository", async () => {
  const f = await fixture();
  const request = frame();
  let pushed = false;
  f.process.mockImplementation(async (_file, args) => {
    if (args[0] === "push") {
      pushed = true;
      throw new Error("response lost");
    }
    return {
      stdout: args.includes("rev-parse")
        ? "a".repeat(40)
        : args[0] === "ls-remote" && pushed
          ? `${"a".repeat(40)}\trefs/heads/main`
          : "",
    };
  });
  expect(await f.settings.run(request)).toEqual({ status: "failed", code: "publication_uncertain" });
  const restarted = new ContextTreeSettings(f.options);
  expect(await restarted.run(request)).toEqual({ status: "completed", repository: "acme/memory" });
  expect(f.process.mock.calls.filter(([file]) => file === "gh")).toHaveLength(1);
});
it("keeps uncertainty when the remote does not contain our commit", async () => {
  const f = await fixture();
  const request = frame();
  f.process.mockImplementation(async (_file, args) => {
    if (args[0] === "push") throw new Error("network");
    return { stdout: args.includes("rev-parse") ? "a".repeat(40) : "" };
  });
  await f.settings.run(request);
  expect(await new ContextTreeSettings(f.options).run(request)).toEqual({
    status: "failed",
    code: "publication_uncertain",
  });
  expect(f.process.mock.calls.filter(([file]) => file === "gh")).toHaveLength(1);
});
it("resolves remote HEAD before passing the branch to the Context Tree CLI", async () => {
  const f = await fixture();
  const request = frame("connect");
  request.input.ref = "HEAD";
  f.process.mockResolvedValue({ stdout: "ref: refs/heads/main\tHEAD\n" + "a".repeat(40) + "\tHEAD" });
  expect(await f.settings.run(request)).toEqual({ status: "completed", repository: "acme/memory", ref: "main" });
  expect(f.run).toHaveBeenCalledWith(expect.arrayContaining(["--ref", "main"]), expect.any(AbortSignal));
});

it("requires managed credentials for creation and leaves disconnect local", async () => {
  const f = await fixture();
  const settings = new ContextTreeSettings({ ...f.options, managedEnvironment: () => undefined });
  expect(await settings.run(frame())).toEqual({ status: "failed", code: "authentication_required" });
  expect(await settings.run(frame("disconnect"))).toEqual({ status: "completed", repository: null });
  expect(f.process).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it("fences replay by source and revisions and refuses work while the agent is running", async () => {
  const f = await fixture();
  const request = frame("connect");
  await f.settings.run(request);
  expect(await f.settings.run({ ...request, input: { ...request.input, ref: "other" } })).toEqual({
    status: "failed",
    code: "stale_configuration",
  });
  expect(await new ContextTreeSettings({ ...f.options, hasAgentSessions: () => true }).run(frame())).toEqual({
    status: "failed",
    code: "busy",
  });
});
it("never starts queued work after cancellation", async () => {
  const f = await fixture();
  let onQueued!: (operation: () => Promise<unknown>) => void;
  const queued = new Promise<() => Promise<unknown>>((resolve) => {
    onQueued = resolve;
  });
  const settings = new ContextTreeSettings({
    ...f.options,
    exclusive: (operation) => {
      onQueued(operation);
      return new Promise(() => {});
    },
  });
  const pending = settings.run(frame("connect"));
  const operation = await queued;
  settings.close();
  expect(await pending).toEqual({ status: "failed", code: "failed" });
  await expect(operation()).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});

it.each(["main", "HEAD"])(
  "creates and verifies a repository with branch %s through real Git and the CLI",
  async (ref) => {
    const f = await fixture();
    const root = f.options.home;
    const remote = join(root, "remote.git");
    const bin = join(root, "bin");
    const gitConfig = join(root, "gitconfig");
    await writeFile(gitConfig, "[init]\n defaultBranch = trunk\n");
    await mkdir(bin);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n *" clone "*|*" fetch "*|*" push "*) exec /usr/bin/git -c protocol.file.allow=always -c 'url.file://${remote}.insteadOf=https://github.com/acme/memory.git' "$@";;\nesac\nexec /usr/bin/git "$@"\n`,
      { mode: 0o700 },
    );
    const processRun = vi.fn<ContextTreeExecFile>(async (file, args, options) => {
      if (file === "gh") {
        expect(args).toEqual(["repo", "create", "acme/memory", "--private"]);
        expect(options.env?.GH_TOKEN).toBe("handle");
        return runContextTreeProcess(
          "/usr/bin/git",
          ["-c", "init.defaultBranch=" + (ref === "HEAD" ? "trunk" : "main"), "init", "--bare", remote],
          options,
        );
      }
      expect(options.env).not.toHaveProperty("GIT_DIR");
      return runContextTreeProcess(file, args, options);
    });
    const settings = new ContextTreeSettings({
      ...f.options,
      run: undefined,
      process: processRun,
      environment: {
        HOME: root,
        PATH: `${bin}:${globalThis.process.env.PATH}`,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_DIR: "/invalid/inherited-checkout",
      },
    });
    const request = frame();
    request.input.ref = ref;
    const expected = { status: "completed", repository: "acme/memory", ...(ref === "HEAD" ? { ref: "trunk" } : {}) };
    expect(await settings.run(request)).toEqual(expected);
    const committed = await runContextTreeProcess(
      "/usr/bin/git",
      ["--git-dir", remote, "ls-tree", "--name-only", ref === "HEAD" ? "trunk" : "main"],
      {
        cwd: root,
        env: { HOME: root, PATH: globalThis.process.env.PATH },
        timeout: 5000,
        maxBuffer: 1024,
        windowsHide: true,
      },
    );
    expect(committed.stdout.trim()).toBe("NODE.md");
    expect(await new ContextTreeSettings({ ...f.options, run: undefined, process: processRun }).run(request)).toEqual(
      expected,
    );
    expect(processRun.mock.calls.filter(([file]) => file === "gh")).toHaveLength(1);
  },
  30_000,
);
