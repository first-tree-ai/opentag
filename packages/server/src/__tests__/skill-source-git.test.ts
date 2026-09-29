import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverSkillDirectories, type RemoteSkillSource, SKILL_ERROR_CODES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  assertGitRemoteAllowed,
  fetchGitSnapshot,
  GIT_SOURCE_CONFIG,
  type GitProcessInvocation,
  type GitProcessRunner,
  gitCloneArguments,
  gitSourceEnvironment,
  parseGitTree,
} from "../services/skills/source/git-source.js";
import { SkillSourceWorkspace } from "../services/skills/source/source-workspace.js";
import { startGitRepositoryFixture } from "./support/git-http-fixture.js";

/**
 * The git transport: the hardening that must reach every invocation, and the real fetch paths.
 *
 * The argument and environment assertions run through an injected runner, so what the process would
 * have received is asserted without spawning anything. The fetch paths run against a real repository
 * on localhost, because the value of this test is that `ls-tree`, the promisor blob read, and the
 * `--filter` fallback genuinely behave as assumed.
 */

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);

function treeRecord(mode: string, type: string, sha: string, path: string): string {
  return `${mode} ${type} ${sha}\t${path}\0`;
}

function githubSource(overrides: Partial<RemoteSkillSource> = {}): RemoteSkillSource {
  return { kind: "github", url: "https://github.com/owner/repo.git", ...overrides };
}

/** Records every invocation and answers the tree listing; the clone fails so nothing runs twice. */
function recordingRunner(): { calls: { args: string[]; options: GitProcessInvocation }[]; run: GitProcessRunner } {
  const calls: { args: string[]; options: GitProcessInvocation }[] = [];
  return {
    calls,
    run: async (_binary, args, options) => {
      calls.push({ args, options });
      if (args.includes("clone")) return { code: 1, stdout: Buffer.alloc(0) };
      return { code: 0, stdout: Buffer.from(treeRecord("100644", "blob", BLOB_A, "README.md")) };
    },
  };
}

async function code(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("git source hardening", () => {
  it("passes the bounded, no-creds clone to the runner", async () => {
    const workspace = await SkillSourceWorkspace.create();
    const { calls, run } = recordingRunner();
    try {
      expect(
        await code(
          fetchGitSnapshot({
            source: githubSource(),
            workspace: workspace.root,
            signal: new AbortController().signal,
            run,
          }),
        ),
      ).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
    } finally {
      await workspace.dispose();
    }
    const clone = calls[0];
    expect(clone).toBeDefined();
    const args = clone?.args ?? [];
    for (const expected of [
      "clone",
      "--quiet",
      "--no-checkout",
      "--single-branch",
      "--no-tags",
      "--filter=blob:none",
      "--depth",
      "1",
    ]) {
      expect(args, expected).toContain(expected);
    }
    // The URL is separated from the flags, so a URL that begins with a dash is a URL.
    expect(args.slice(-3)).toEqual([
      "--",
      "https://github.com/owner/repo.git",
      join(workspacePath(calls), "repository"),
    ]);
    for (const setting of GIT_SOURCE_CONFIG) expect(args, setting).toContain(setting);
    expect(args).toContain("http.followRedirects=false");
    expect(args).toContain("protocol.file.allow=never");
    expect(args).toContain("protocol.allow=never");
    expect(clone?.options.cwd).toBe(workspacePath(calls));
  });

  it("runs git with a HOME of its own and no way to answer a credential prompt", async () => {
    const workspace = await SkillSourceWorkspace.create();
    const { calls, run } = recordingRunner();
    try {
      await code(
        fetchGitSnapshot({
          source: githubSource(),
          workspace: workspace.root,
          signal: new AbortController().signal,
          run,
        }),
      );
    } finally {
      await workspace.dispose();
    }
    const environment = calls[0]?.options.environment ?? {};
    expect(environment.HOME).toBe(join(workspacePath(calls), "home"));
    expect(environment.XDG_CONFIG_HOME).toBe(join(workspacePath(calls), "home"));
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GIT_ASKPASS).toBe("");
    expect(environment.GIT_SSH_COMMAND).toBe("/bin/false");
    // The child environment is built, never inherited: a secret in the Server's environment cannot
    // reach a third-party host through a git configuration the fetch did not ask for.
    expect(environment.PATH).toBe(process.env.PATH ?? "/usr/bin:/bin");
    expect(
      Object.keys(environment).every(
        (name) => name.startsWith("GIT_") || ["PATH", "HOME", "XDG_CONFIG_HOME", "LC_ALL"].includes(name),
      ),
    ).toBe(true);
  });

  it("routes every git connection through the pinning tunnel when one is given", async () => {
    const calls: { args: string[]; options: GitProcessInvocation }[] = [];
    const run: GitProcessRunner = async (_binary, args, options) => {
      calls.push({ args, options });
      if (args.includes("clone") || args.includes("config")) return { code: 0, stdout: Buffer.alloc(0) };
      return { code: 0, stdout: Buffer.from(treeRecord("100644", "blob", BLOB_A, "README.md")) };
    };
    const workspace = await SkillSourceWorkspace.create();
    try {
      await code(
        fetchGitSnapshot({
          source: githubSource(),
          workspace: workspace.root,
          signal: new AbortController().signal,
          run,
          proxyUrl: "http://127.0.0.1:4567",
          measureWorkspace: async () => 1,
        }),
      );
    } finally {
      await workspace.dispose();
    }
    // The clone is told to proxy, and the repository records it too: a lazy blob fetch is a separate
    // process that reads the repository's own configuration rather than this command line.
    expect(calls[0]?.args).toContain("http.proxy=http://127.0.0.1:4567");
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining([
        "-C",
        expect.stringContaining("repository"),
        "config",
        "http.proxy",
        "http://127.0.0.1:4567",
      ]),
    );
    expect(calls[0]?.options.environment.NO_PROXY).toBe("");
    expect(calls[0]?.options.environment.no_proxy).toBe("");
  });

  it("carries the ref and the workspace into the clone arguments", () => {
    const args = gitCloneArguments(githubSource({ ref: "release-2026" }), "/tmp/repo");
    expect(args).toContain("--branch");
    expect(args[args.indexOf("--branch") + 1]).toBe("release-2026");
    expect(args.slice(-2)).toEqual(["https://github.com/owner/repo.git", "/tmp/repo"]);
  });

  it("keeps the environment free of a global config and a system config", () => {
    const environment = gitSourceEnvironment("/home");
    expect(environment).toMatchObject({ HOME: "/home", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  });

  it("judges the remote before any process exists", async () => {
    const publicResolver = { allowLoopback: true, resolveAddresses: async () => ["93.184.216.34"] };
    await expect(
      assertGitRemoteAllowed(githubSource(), { allowLoopback: false, resolveAddresses: async () => ["93.184.216.34"] }),
    ).resolves.toBeUndefined();
    expect(
      await code(assertGitRemoteAllowed(githubSource({ url: "https://127.0.0.1/repo.git" }), { allowLoopback: false })),
    ).toBe(SKILL_ERROR_CODES.SOURCE_BLOCKED);
    expect(
      await code(
        assertGitRemoteAllowed(githubSource({ url: "http://example.com/repo.git" }), { allowLoopback: false }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_BLOCKED);
    expect(
      await code(
        assertGitRemoteAllowed(githubSource({ url: "https://localtest.me/repo.git" }), {
          allowLoopback: false,
          resolveAddresses: async () => ["10.0.0.1"],
        }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_BLOCKED);
    expect(
      await code(
        assertGitRemoteAllowed(githubSource({ url: "https://missing.example.com/repo.git" }), {
          allowLoopback: false,
          resolveAddresses: async () => {
            throw new Error("ENOTFOUND");
          },
        }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
    await expect(
      assertGitRemoteAllowed(githubSource({ url: "http://127.0.0.1:1/repo.git" }), publicResolver),
    ).resolves.toBeUndefined();
  });
});

describe("parseGitTree", () => {
  it("keeps regular files and drops symlinks and submodule links", () => {
    const listing = Buffer.from(
      [
        treeRecord("100644", "blob", BLOB_A, "README.md"),
        treeRecord("100755", "blob", BLOB_B, "skills/demo/run.sh"),
        treeRecord("120000", "blob", BLOB_A, "skills/demo/link"),
        treeRecord("160000", "commit", BLOB_B, "vendor/submodule"),
        treeRecord("100644", "blob", BLOB_B, "skills/demo/SKILL.md"),
      ].join(""),
    );
    expect(parseGitTree(listing)).toEqual([
      { path: "README.md", executable: false, id: BLOB_A },
      { path: "skills/demo/run.sh", executable: true, id: BLOB_B },
      { path: "skills/demo/SKILL.md", executable: false, id: BLOB_B },
    ]);
  });
});

/** The workspace path the recording runner saw, taken from the clone's last argument. */
function workspacePath(calls: { args: string[] }[]): string {
  const directory = calls[0]?.args.at(-1) ?? "";
  return directory.slice(0, directory.lastIndexOf("/"));
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else total += (await lstat(child)).size;
    }
  }
  return total;
}

const LARGE = "x".repeat(512 * 1024);

async function withFixture<T>(
  options: Parameters<typeof startGitRepositoryFixture>[0],
  run: (fixture: Awaited<ReturnType<typeof startGitRepositoryFixture>>, workspace: SkillSourceWorkspace) => Promise<T>,
): Promise<T> {
  const fixture = await startGitRepositoryFixture(options);
  const workspace = await SkillSourceWorkspace.create();
  try {
    return await run(fixture, workspace);
  } finally {
    await workspace.dispose();
    await fixture.close();
  }
}

function allowLoopback() {
  return { allowLoopback: true };
}

describe("fetchGitSnapshot over a real repository", () => {
  it("lists the tree and reads a blob", async () => {
    await withFixture(
      { files: { "README.md": "# demo", "skills/demo/SKILL.md": "---\nname: demo\ndescription: A demo\n---\n" } },
      async (fixture, workspace) => {
        await assertGitRemoteAllowed(githubSource({ url: fixture.url }), allowLoopback());
        const snapshot = await fetchGitSnapshot({
          source: githubSource({ url: fixture.url }),
          workspace: workspace.root,
          signal: new AbortController().signal,
        });
        expect(snapshot.files.map((file) => file.path).sort()).toEqual(["README.md", "skills/demo/SKILL.md"]);
        expect(new TextDecoder().decode(await snapshot.read("skills/demo/SKILL.md"))).toContain("name: demo");
        await snapshot.dispose();
      },
    );
  });

  it("honours the requested ref", async () => {
    await withFixture(
      {
        files: { "skills/main/SKILL.md": "main" },
        branches: { feature: { "skills/feature/SKILL.md": "feature" } },
      },
      async (fixture, workspace) => {
        const defaultSnapshot = await fetchGitSnapshot({
          source: githubSource({ url: fixture.url }),
          workspace: workspace.root,
          signal: new AbortController().signal,
        });
        expect(defaultSnapshot.files.map((file) => file.path)).toEqual(["skills/main/SKILL.md"]);
        await defaultSnapshot.dispose();

        // A second workspace: the transport always clones into `<workspace>/repository`.
        const branchWorkspace = await SkillSourceWorkspace.create();
        try {
          const snapshot = await fetchGitSnapshot({
            source: githubSource({ url: fixture.url, ref: "feature" }),
            workspace: branchWorkspace.root,
            signal: new AbortController().signal,
          });
          expect(snapshot.files.map((file) => file.path).sort()).toEqual([
            "skills/feature/SKILL.md",
            "skills/main/SKILL.md",
          ]);
          expect(new TextDecoder().decode(await snapshot.read("skills/feature/SKILL.md"))).toBe("feature");
          await snapshot.dispose();
        } finally {
          await branchWorkspace.dispose();
        }
      },
    );
  });

  it("confines discovery to the source's subpath", async () => {
    await withFixture(
      {
        files: {
          "packages/demo/skills/inside/SKILL.md": "inside",
          "packages/other/skills/outside/SKILL.md": "outside",
        },
      },
      async (fixture, workspace) => {
        const source = githubSource({ url: fixture.url, subpath: "packages/demo" });
        const snapshot = await fetchGitSnapshot({
          source,
          workspace: workspace.root,
          signal: new AbortController().signal,
        });
        const discovered = discoverSkillDirectories({
          paths: snapshot.files.map((file) => file.path),
          subpath: source.subpath,
        });
        expect(discovered.map((entry) => entry.path)).toEqual(["packages/demo/skills/inside"]);
        await snapshot.dispose();
      },
    );
  });

  it("degrades to a plain shallow clone when the peer ignores --filter", async () => {
    await withFixture({ files: { "skills/demo/SKILL.md": LARGE }, allowFilter: false }, async (fixture, workspace) => {
      const snapshot = await fetchGitSnapshot({
        source: githubSource({ url: fixture.url }),
        workspace: workspace.root,
        signal: new AbortController().signal,
      });
      expect((await snapshot.read("skills/demo/SKILL.md")).byteLength).toBe(LARGE.length);
      await snapshot.dispose();
    });
  });

  it("reads a blob on demand when the peer honours --filter", async () => {
    await withFixture({ files: { "skills/demo/SKILL.md": LARGE }, allowFilter: true }, async (fixture, workspace) => {
      const snapshot = await fetchGitSnapshot({
        source: githubSource({ url: fixture.url }),
        workspace: workspace.root,
        signal: new AbortController().signal,
      });
      // The clone holds the commit and its trees only: the blob is fetched by the read below.
      expect(await directoryBytes(join(workspace.root, "repository"))).toBeLessThan(LARGE.length / 2);
      expect((await snapshot.read("skills/demo/SKILL.md")).byteLength).toBe(LARGE.length);
      await snapshot.dispose();
    });
  });

  it("refuses a clone that outgrows the snapshot budget", async () => {
    await withFixture({ files: { "README.md": "# demo" } }, async (fixture, workspace) => {
      expect(
        await code(
          fetchGitSnapshot({
            source: githubSource({ url: fixture.url }),
            workspace: workspace.root,
            signal: new AbortController().signal,
            maxBytes: 1,
          }),
        ),
      ).toBe(SKILL_ERROR_CODES.SOURCE_TOO_LARGE);
    });
  });

  it("refuses a ref that does not exist without leaking the git error", async () => {
    await withFixture({ files: { "README.md": "# demo" } }, async (fixture, workspace) => {
      expect(
        await code(
          fetchGitSnapshot({
            source: githubSource({ url: fixture.url, ref: "nope" }),
            workspace: workspace.root,
            signal: new AbortController().signal,
          }),
        ),
      ).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
    });
  });
});
