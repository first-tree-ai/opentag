import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRefUpdate } from "../services/github-proxy/git-packets.js";
import { GitPublicationError } from "../services/github-proxy/git-packets.js";
import type { GitProcessOptions } from "../services/github-proxy/git-process.js";
import {
  GitHubPublicationRemote,
  GitPushRejectedError,
  parseRejectedPushRefs,
  seedRefspecsForAllowedRefs,
} from "../services/github-proxy/git-remote.js";

// `GitHubPublicationRemote` is the only part of this module that shells out, and its whole job is to
// hand the right argv and the right environment to the trusted Git process. Both seams — `spawn` and
// the askpass file write — are replaced here so the suite asserts the exact argv/environment without
// contacting github.com. `github-read-transport.test.ts` covers the real end-to-end pack exchange.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ writeFile: vi.fn(async () => undefined) }));

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);
const update = (ref: string, oldSha = ZERO, newSha = SHA_A): GitRefUpdate => ({ oldSha, newSha, ref });

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  argv: string[];
}

interface SpawnPlan {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/** One recorded trusted-Git invocation, with the child it spawned already answered. */
interface GitCall {
  binary: string;
  argv: string[];
  child: FakeChild;
}

/**
 * Answers every `spawn` with a real stream-backed child so `runTrustedProcess` keeps its ordinary
 * stream and close-event semantics. `plan` may be a single answer or one per invocation, in order.
 */
function mockGitProcess(plan: SpawnPlan | SpawnPlan[]): GitCall[] {
  const plans = Array.isArray(plan) ? [...plan] : [plan];
  const calls: GitCall[] = [];
  vi.mocked(spawn).mockImplementation(((binary: string, argv: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = vi.fn();
    child.argv = argv;
    calls.push({ argv, binary, child });
    const answer = plans.shift() ?? {};
    setImmediate(() => {
      child.stdout.end(answer.stdout ?? "");
      child.stderr.end(answer.stderr ?? "");
      child.exitCode = answer.code ?? 0;
      child.emit("close", answer.code ?? 0);
    });
    return child as never;
  }) as never);
  return calls;
}

const TRUSTED_GIT_PREFIX = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never"];

/** The argv `runTrustedGit` appends after its fixed safety prefix. */
function gitArgs(call: GitCall | undefined): string[] {
  const argv = call?.argv ?? [];
  expect(argv.slice(0, TRUSTED_GIT_PREFIX.length)).toEqual(TRUSTED_GIT_PREFIX);
  return argv.slice(TRUSTED_GIT_PREFIX.length);
}

const OPTIONS: GitProcessOptions = {
  cwd: "/tmp/git-workspace",
  environment: { PATH: "/usr/bin:/bin", HOME: "/tmp/git-workspace/home" },
  signal: new AbortController().signal,
};

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  vi.mocked(writeFile).mockReset();
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

function remote(fullName = "owner/repository", token = "ghs_installation-token") {
  return new GitHubPublicationRemote({ fullName, token });
}

async function askpassEnvironment(_call: GitCall) {
  const helper = join(OPTIONS.cwd, "askpass.sh");
  expect(vi.mocked(writeFile)).toHaveBeenCalledWith(helper, expect.stringContaining("$OPENTAG_GIT_TOKEN"), {
    mode: 0o700,
  });
  return helper;
}

describe("seed refspec filtering for ref-restricted snapshots", () => {
  // Captured from git 2.50.1: `git ls-remote --heads <remote> refs/heads/main` against a remote
  // carrying a planted `refs/heads/x/refs/heads/main` returns BOTH lines (documented tail-glob
  // semantics), so the remote's pattern matching can never be the snapshot authority.
  const DECOY_EXACT = `${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/heads/x/refs/heads/main\n`;
  const DECOY_GLOB = `${SHA_B}\trefs/heads/y/refs/heads/opentag/SID/context_tree/pwn\n`;

  it("keeps only the exact authorized ref and drops tail-matching decoys", () => {
    expect(seedRefspecsForAllowedRefs(DECOY_EXACT, ["refs/heads/main"])).toEqual(["+refs/heads/main:refs/heads/main"]);
  });

  it("matches Session task prefixes literally and drops embedded-prefix decoys", () => {
    const allowed = ["refs/heads/tree", "refs/heads/opentag/SID/context_tree/*"];
    const output =
      `${SHA_A}\trefs/heads/tree\n` +
      `${SHA_A}\trefs/heads/opentag/SID/context_tree/topic\n` +
      DECOY_GLOB +
      `${SHA_B}\trefs/heads/opentag/SID/context_tree_evil\n`;
    expect(seedRefspecsForAllowedRefs(output, allowed)).toEqual([
      "+refs/heads/tree:refs/heads/tree",
      "+refs/heads/opentag/SID/context_tree/topic:refs/heads/opentag/SID/context_tree/topic",
    ]);
  });

  it("returns an empty snapshot selection when only decoys answer", () => {
    expect(seedRefspecsForAllowedRefs(DECOY_GLOB, ["refs/heads/main"])).toEqual([]);
  });

  it("fails closed on malformed lines instead of skipping them", () => {
    expect(() => seedRefspecsForAllowedRefs(`not-a-sha\trefs/heads/main\n`, ["refs/heads/main"])).toThrow(
      /unavailable/,
    );
    expect(() => seedRefspecsForAllowedRefs(`${SHA_A}\trefs/tags/v1\n`, ["refs/heads/main"])).toThrow(/unavailable/);
  });

  it("skips interior blank lines in ls-remote output", () => {
    // `trim()` only strips the edges, so an interior blank line must not be read as a ref line.
    const output = `${SHA_A}\trefs/heads/main\n\n${SHA_B}\trefs/heads/other\n`;
    expect(seedRefspecsForAllowedRefs(output, ["refs/heads/main"])).toEqual(["+refs/heads/main:refs/heads/main"]);
  });
});

describe("push porcelain rejection evidence", () => {
  // Captured from git 2.50.1: `git push --atomic --porcelain --force-with-lease=<ref>:<stale>`
  const REAL_STALE_LEASE_REPORT = [
    "To ../remote.git",
    `!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)`,
    "Done",
    "",
  ].join("\n");

  it("accepts a complete all-refs rejection report as definitive", () => {
    expect(parseRejectedPushRefs(REAL_STALE_LEASE_REPORT, [update("refs/heads/opentag/topic")])).toEqual([
      "refs/heads/opentag/topic",
    ]);
  });

  it("requires every pushed ref to carry the rejection flag", () => {
    const updates = [update("refs/heads/opentag/one"), update("refs/heads/opentag/two")];
    const partial = [
      "To ../remote.git",
      `!\t${SHA_A}:refs/heads/opentag/one\t[remote rejected] (cannot lock ref)`,
      "Done",
    ].join("\n");
    expect(parseRejectedPushRefs(partial, updates)).toBeUndefined();
    const both = [
      "To ../remote.git",
      `!\t${SHA_A}:refs/heads/opentag/one\t[remote rejected] (cannot lock ref)`,
      `!\t${SHA_A}:refs/heads/opentag/two\t[remote rejected] (cannot lock ref)`,
      "Done",
    ].join("\n");
    expect(parseRejectedPushRefs(both, updates)).toEqual(["refs/heads/opentag/one", "refs/heads/opentag/two"]);
  });

  it("rejects reports with any applied, forced, new, or up-to-date flag on a pushed ref", () => {
    for (const flag of [" ", "+", "*", "-", "="]) {
      const mixed = [
        "To ../remote.git",
        `!\t${SHA_A}:refs/heads/opentag/one\t[remote rejected] (cannot lock ref)`,
        `${flag}\t${SHA_A}:refs/heads/opentag/two\t[ok]`,
        "Done",
      ].join("\n");
      expect(
        parseRejectedPushRefs(mixed, [update("refs/heads/opentag/one"), update("refs/heads/opentag/two")]),
      ).toBeUndefined();
    }
  });

  it("rejects truncated, malformed, or transport-failure output", () => {
    const updates = [update("refs/heads/opentag/topic")];
    // No "Done" trailer: a truncated report can hide further ref lines.
    expect(
      parseRejectedPushRefs(
        `To ../remote.git\n!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)\n`,
        updates,
      ),
    ).toBeUndefined();
    // Transport failures print no porcelain ref lines at all.
    expect(parseRejectedPushRefs("", updates)).toBeUndefined();
    expect(parseRejectedPushRefs("fatal: unable to connect to ../remote.git\n", updates)).toBeUndefined();
    // A non-porcelain line anywhere disqualifies the whole report.
    expect(parseRejectedPushRefs(`${REAL_STALE_LEASE_REPORT}garbage\n`, updates)).toBeUndefined();
    expect(
      parseRejectedPushRefs(
        `To ../remote.git\n!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)\nnot a porcelain line\nDone\n`,
        updates,
      ),
    ).toBeUndefined();
  });

  it("ignores porcelain lines naming refs outside the pushed set", () => {
    // git also reports the local side of a multi-ref push; only pushed refs carry weight, so an
    // unrelated `=` line cannot by itself disprove all-refs rejection.
    const stdout = [
      "To ../remote.git",
      `=\trefs/heads/other\t[up to date]`,
      `!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)`,
      "Done",
    ].join("\n");
    expect(parseRejectedPushRefs(stdout, [update("refs/heads/opentag/topic")])).toEqual(["refs/heads/opentag/topic"]);
  });

  it("rejects a report whose only ref line is not a rejection", () => {
    const stdout = ["To ../remote.git", `=\trefs/heads/other\t[up to date]`, "Done"].join("\n");
    expect(parseRejectedPushRefs(stdout, [update("refs/heads/opentag/topic")])).toBeUndefined();
  });

  it("rejects a report carrying a porcelain line and the Done trailer only", () => {
    // Every pushed ref must appear; a report that rejects nothing recognizable is unproven.
    expect(parseRejectedPushRefs("Done\n", [update("refs/heads/opentag/topic")])).toBeUndefined();
  });

  it("carries the rejected refs on the typed error", () => {
    const error = new GitPushRejectedError(["refs/heads/opentag/one", "refs/heads/opentag/two"]);
    expect(error).toBeInstanceOf(GitPublicationError);
    expect(error.name).toBe("GitPushRejectedError");
    expect(error.code).toBe("remote_conflict");
    expect(error.rejectedRefs).toEqual(["refs/heads/opentag/one", "refs/heads/opentag/two"]);
  });
});

describe("GitHubPublicationRemote credential handling", () => {
  it.each([
    ["a scoped full name", "owner/repository", "ghs_token"],
    ["a dot and underscore full name", "owner.name/repo_name", "ghs.token_1"],
    ["a token at the maximum length", "owner/repository", "t".repeat(4096)],
  ])("accepts %s", (_label, fullName, token) => {
    expect(() => remote(fullName, token)).not.toThrow();
  });

  it.each([
    ["a full name with no owner", "repository", "ghs_token"],
    ["a full name with three segments", "owner/group/repository", "ghs_token"],
    ["a full name carrying a space", "owner/repo itory", "ghs_token"],
    ["an empty token", "owner/repository", ""],
    ["a token over the maximum length", "owner/repository", "t".repeat(4097)],
    ["a token carrying a shell metacharacter", "owner/repository", "ghs_token;rm -rf /"],
  ])("rejects %s as an invalid request", (_label, fullName, token) => {
    expect(() => remote(fullName, token)).toThrow(GitPublicationError);
    expect(() => remote(fullName, token)).toThrow(/invalid_request/);
  });

  it("never places the token in argv, only in the trusted child environment", async () => {
    const calls = mockGitProcess([{ code: 0 }, { code: 0 }]);
    await remote("owner/repository", "ghs_secret-token").seed("/tmp/repository.git", OPTIONS);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    const helper = await askpassEnvironment(calls[0] as GitCall);
    // argv carries the fixed https remote, never credentials; the token rides the env of the fetch.
    expect(gitArgs(calls[0])).toEqual([
      "-C",
      "/tmp/repository.git",
      "remote",
      "add",
      "origin",
      "https://github.com/owner/repository.git",
    ]);
    expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain("ghs_secret-token");
    expect(gitArgs(calls[1])).toEqual([
      "-c",
      "http.followRedirects=false",
      "-C",
      "/tmp/repository.git",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      "+refs/heads/*:refs/heads/*",
    ]);
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      helper,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$OPENTAG_GIT_TOKEN" ;; esac\n',
      { mode: 0o700 },
    );
  });

  it("writes the askpass helper into the workspace on the read paths too", async () => {
    mockGitProcess({ code: 0, stdout: `${SHA_A}\trefs/heads/main\n` });
    await remote().refs("/tmp/repository.git", ["refs/heads/main"], OPTIONS);
    await askpassEnvironment({ argv: [], binary: "git", child: {} as FakeChild });
  });
});

describe("GitHubPublicationRemote seed", () => {
  it("fetches every head when no ref restriction was requested", async () => {
    const calls = mockGitProcess([{ code: 0 }, { code: 0 }]);
    await remote().seed("/tmp/repository.git", OPTIONS);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    // The unrestricted path never runs ls-remote; the unrestricted refspec is the whole head space.
    expect(gitArgs(calls[1]).at(-1)).toBe("+refs/heads/*:refs/heads/*");
    expect(gitArgs(calls[0])).not.toContain("ls-remote");
  });

  it("restricts the fetch refspecs to the authorized refs the remote actually offers", async () => {
    const calls = mockGitProcess([
      { code: 0 },
      { code: 0, stdout: `${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/heads/x/refs/heads/main\n` },
      { code: 0 },
    ]);
    await remote().seed("/tmp/repository.git", OPTIONS, ["refs/heads/main"]);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
    // ls-remote runs with the ref restriction and the given allowed refs as patterns.
    expect(gitArgs(calls[1])).toEqual([
      "-c",
      "http.followRedirects=false",
      "-C",
      "/tmp/repository.git",
      "ls-remote",
      "--heads",
      "origin",
      "refs/heads/main",
    ]);
    // The planted tail-matching decoy never reaches the fetch refspec list.
    expect(gitArgs(calls[2]).at(-1)).toBe("+refs/heads/main:refs/heads/main");
    expect(gitArgs(calls[2])).not.toContain("+refs/heads/x/refs/heads/main:refs/heads/x/refs/heads/main");
  });

  it("skips the fetch entirely when the remote offers nothing authorized", async () => {
    mockGitProcess([
      { code: 0 },
      { code: 0, stdout: `${SHA_B}\trefs/heads/y/refs/heads/opentag/SID/context_tree/pwn\n` },
    ]);
    await remote().seed("/tmp/repository.git", OPTIONS, ["refs/heads/main"]);
    // Two spawns only: remote add and ls-remote. No fetch means nothing was pulled into the snapshot.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed ls-remote output instead of seeding a partial snapshot", async () => {
    mockGitProcess([{ code: 0 }, { code: 0, stdout: "not-a-sha\trefs/heads/main\n" }]);
    await expect(remote().seed("/tmp/repository.git", OPTIONS, ["refs/heads/main"])).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("reports an unavailable remote add as an invalid-objects failure", async () => {
    mockGitProcess({ code: 128, stderr: "fatal: not a git repository" });
    await expect(remote().seed("/tmp/repository.git", OPTIONS)).rejects.toMatchObject({ code: "invalid_objects" });
  });
});

describe("GitHubPublicationRemote publish", () => {
  it("pushes atomically with one lease per update and the token out of argv", async () => {
    const calls = mockGitProcess({ code: 0 });
    const updates = [update("refs/heads/opentag/topic", SHA_B, SHA_A), update("refs/heads/opentag/new", ZERO, SHA_B)];
    await remote().publish("/tmp/repository.git", updates, OPTIONS);
    // A push bypasses `runTrustedGit`, so it states its own safety options; check them explicitly.
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("--atomic");
    expect(argv).toContain("--porcelain");
    // A fresh ref leases against the empty string; an existing one leases against its known old SHA.
    expect(argv).toContain(`--force-with-lease=refs/heads/opentag/topic:${SHA_B}`);
    expect(argv).toContain("--force-with-lease=refs/heads/opentag/new:");
    expect(argv).toContain(`${SHA_A}:refs/heads/opentag/topic`);
    expect(argv).toContain(`${SHA_B}:refs/heads/opentag/new`);
    // The hooks path is neutralized and host redirects cannot be followed for a push.
    expect(argv).toContain("core.hooksPath=/dev/null");
    expect(argv).toContain("http.followRedirects=false");
    expect(JSON.stringify(argv)).not.toContain("ghs_");
  });

  it("raises the typed rejection only on complete all-refs rejection evidence", async () => {
    mockGitProcess({
      code: 1,
      stdout: [
        "To https://github.com/owner/repository.git",
        `!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)`,
        "Done",
        "",
      ].join("\n"),
    });
    const error = await remote()
      .publish("/tmp/repository.git", [update("refs/heads/opentag/topic")], OPTIONS)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GitPushRejectedError);
    expect((error as GitPushRejectedError).rejectedRefs).toEqual(["refs/heads/opentag/topic"]);
  });

  it("keeps an ambiguous transport failure as remote_conflict, never a definite rejection", async () => {
    mockGitProcess({ code: 128, stderr: "fatal: unable to access 'https://github.com/owner/repository.git/'" });
    const error = await remote()
      .publish("/tmp/repository.git", [update("refs/heads/opentag/topic")], OPTIONS)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GitPublicationError);
    expect(error).not.toBeInstanceOf(GitPushRejectedError);
    expect((error as GitPublicationError).code).toBe("remote_conflict");
  });

  it("treats a truncated rejection report as an ambiguous remote_conflict", async () => {
    mockGitProcess({
      code: 1,
      stdout: `To https://github.com/owner/repository.git\n!\t${SHA_A}:refs/heads/opentag/topic\t[rejected] (stale info)\n`,
    });
    await expect(
      remote().publish("/tmp/repository.git", [update("refs/heads/opentag/topic")], OPTIONS),
    ).rejects.toMatchObject({ code: "remote_conflict" });
  });

  it("succeeds without inspecting the report when the exit status is zero", async () => {
    mockGitProcess({ code: 0, stdout: "To ../remote.git\nDone\n" });
    await expect(
      remote().publish("/tmp/repository.git", [update("refs/heads/opentag/topic")], OPTIONS),
    ).resolves.toBeUndefined();
  });
});

describe("GitHubPublicationRemote refs", () => {
  it("maps only the requested heads to their SHAs", async () => {
    mockGitProcess({ code: 0, stdout: `${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/heads/opentag/topic\n` });
    const result = await remote().refs("/tmp/repository.git", ["refs/heads/main", "refs/heads/opentag/topic"], OPTIONS);
    expect(result).toEqual(
      new Map([
        ["refs/heads/main", SHA_A],
        ["refs/heads/opentag/topic", SHA_B],
      ]),
    );
  });

  it("ignores blank lines and empty output", async () => {
    mockGitProcess({ code: 0, stdout: "\n\n" });
    expect(await remote().refs("/tmp/repository.git", ["refs/heads/main"], OPTIONS)).toEqual(new Map());
  });

  it("fails closed when the remote answers a ref that was not requested", async () => {
    // The remote is untrusted: an unrequested ref appearing in the answer cannot be trusted into the
    // snapshot, exactly as an unrequested head must never enter a read snapshot.
    mockGitProcess({ code: 0, stdout: `${SHA_A}\trefs/heads/other\n` });
    await expect(remote().refs("/tmp/repository.git", ["refs/heads/main"], OPTIONS)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("fails closed on a malformed SHA", async () => {
    mockGitProcess({ code: 0, stdout: `not-a-sha\trefs/heads/main\n` });
    await expect(remote().refs("/tmp/repository.git", ["refs/heads/main"], OPTIONS)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("surfaces a non-zero ls-remote exit as invalid_objects", async () => {
    mockGitProcess({ code: 128, stderr: "fatal: could not read from remote" });
    await expect(remote().refs("/tmp/repository.git", ["refs/heads/main"], OPTIONS)).rejects.toMatchObject({
      code: "invalid_objects",
    });
  });
});
