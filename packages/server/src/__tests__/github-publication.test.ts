import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_ZERO_SHA,
  GitPublicationError,
  type GitRefUpdate,
  gitPacket,
  parseGitReceiveCommands,
} from "../services/github-proxy/git-packets.js";
import { type GitProcessOptions, runTrustedProcess } from "../services/github-proxy/git-process.js";
import { GitPublicationGuard, type GitPublicationInput } from "../services/github-proxy/git-publication.js";
import {
  GitPushRejectedError,
  type PublicationRemote,
  parseRejectedPushRefs,
} from "../services/github-proxy/git-remote.js";
import { FileSessionControlStore } from "../services/session-control-store/index.js";

const execute = promisify(execFile);
let root: string;
let remote: string;
let source: string;
let initialSha: string;
let newSha: string;
let environment: NodeJS.ProcessEnv;
let journal: FileSessionControlStore;
const ref = "refs/heads/opentag/test/topic";
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute("git", args, { cwd, env: environment, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
async function* chunks(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; offset += 128) yield bytes.subarray(offset, offset + 128);
}

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "opentag-git-publication-"));
  environment = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  source = join(root, "source");
  remote = join(root, "remote.git");
  await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.name", "Fixture"]);
  await git(source, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(source, "file.txt"), "initial\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  initialSha = await git(source, ["rev-parse", "HEAD"]);
  await git(root, ["clone", "--bare", source, remote]);
  await writeFile(join(source, "file.txt"), "updated\n");
  await git(source, ["commit", "-am", "updated"]);
  newSha = await git(source, ["rev-parse", "HEAD"]);
  journal = new FileSessionControlStore({ root: join(root, "control") });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

class LocalRemote implements PublicationRemote {
  publishCalls = 0;
  async seed(repository: string, options: GitProcessOptions) {
    await git(repository, ["fetch", remote, "+refs/heads/*:refs/heads/*"]);
    options.signal.throwIfAborted();
  }
  async publish(repository: string, updates: GitRefUpdate[]) {
    this.publishCalls++;
    try {
      await git(repository, [
        "push",
        "--atomic",
        "--porcelain",
        ...updates.map(
          (update) => `--force-with-lease=${update.ref}:${update.oldSha === GIT_ZERO_SHA ? "" : update.oldSha}`,
        ),
        remote,
        ...updates.map((update) => `${update.newSha}:${update.ref}`),
      ]);
    } catch (error) {
      // The fixture shares the production evidence path: only git's own complete all-refs
      // rejection report becomes a typed rejection; every other failure stays ambiguous.
      const failure = error as { stdout?: unknown };
      const rejected = parseRejectedPushRefs(typeof failure.stdout === "string" ? failure.stdout : "", updates);
      if (rejected) throw new GitPushRejectedError(rejected);
      throw new GitPublicationError("remote_conflict");
    }
  }
  async refs(_repository: string, refs: string[]) {
    const lines = await git(root, ["ls-remote", "--heads", remote, ...refs]);
    return new Map(
      lines
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha = "", name = ""] = line.split("\t");
          return [name, sha];
        }),
    );
  }
}

async function request(oldSha = GIT_ZERO_SHA, target = ref, next = newSha): Promise<Buffer> {
  const pack = await runTrustedProcess("git", ["pack-objects", "--stdout", "--revs"], {
    cwd: source,
    environment,
    signal: new AbortController().signal,
    input: chunks(Buffer.from(`${next}\n^${initialSha}\n`)),
  });
  if (pack.code !== 0) throw new Error("Fixture pack failed");
  return Buffer.concat([
    gitPacket(`${oldSha} ${next} ${target}\0report-status side-band-64k ofs-delta\n`),
    Buffer.from("0000"),
    pack.stdout,
  ]);
}

function input(body: Buffer, upstream = new LocalRemote()): GitPublicationInput {
  return {
    sessionId: randomUUID(),
    executionId: randomUUID(),
    operationId: randomUUID(),
    repositoryId: "123",
    policyRevision: "github:1",
    scopes: [{ role: "code", refPrefix: "refs/heads/opentag/test/" }],
    protectedTreeRefs: ["refs/heads/master"],
    body: chunks(body),
    signal: new AbortController().signal,
    remote: upstream,
    revalidate: async () => undefined,
  };
}
function guard(
  verifyTree?: (typeof GitPublicationGuard extends new (options: infer T) => unknown ? T : never)["verifyTree"],
) {
  return new GitPublicationGuard({
    root: join(root, "staging"),
    controlStore: journal,
    ...(verifyTree ? { verifyTree } : {}),
  });
}

describe("trusted Git publication", () => {
  it("validates a real pack, journals intent, atomically publishes, and confirms the remote SHA", async () => {
    const upstream = new LocalRemote();
    const operation = input(await request(), upstream);
    const result = await guard().receive(operation);
    expect(result.toString()).toContain(`ok ${ref}`);
    expect(upstream.publishCalls).toBe(1);
    expect(await git(remote, ["rev-parse", ref])).toBe(newSha);
    expect(await journal.readWrite(operation.sessionId, operation.operationId)).toMatchObject({
      outcome: { state: "succeeded", resultCode: "remote_sha_confirmed" },
    });
    expect(await journal.listSources(operation.sessionId)).toHaveLength(1);
  });

  it("rejects a protected Tree ref under a code grant before any remote update", async () => {
    const upstream = new LocalRemote();
    const operation = input(await request(GIT_ZERO_SHA, "refs/heads/master"), upstream);
    operation.scopes = [{ role: "code", refPrefix: "refs/heads/" }];
    expect((await guard().receive(operation)).toString()).toContain("publication rejected");
    expect(upstream.publishCalls).toBe(0);
    expect(await journal.listUnresolvedWrites(operation.sessionId)).toEqual([]);
  });

  it("runs Tree verification on the actual received commit before publishing", async () => {
    const upstream = new LocalRemote();
    const verifyTree = vi.fn(async () => {
      throw new GitPublicationError("tree_invalid");
    });
    const operation = input(await request(GIT_ZERO_SHA, "refs/heads/master"), upstream);
    operation.scopes = [{ role: "context_tree", exactRef: "refs/heads/master" }];
    expect((await guard(verifyTree).receive(operation)).toString()).toContain("publication rejected");
    expect(verifyTree).toHaveBeenCalledWith(expect.any(String), newSha, expect.any(Object));
    expect(upstream.publishCalls).toBe(0);
  });

  it("rejects a stale expected old SHA without touching upstream", async () => {
    const upstream = new LocalRemote();
    const operation = input(await request(GIT_ZERO_SHA, "refs/heads/main"), upstream);
    operation.scopes = [{ role: "code", exactRef: "refs/heads/main" }];
    expect((await guard().receive(operation)).toString()).toContain("publication rejected");
    expect(upstream.publishCalls).toBe(0);
    expect(await git(remote, ["rev-parse", "main"])).toBe(initialSha);
  });

  it("records unknown and blocks reuse when remote acceptance cannot be confirmed", async () => {
    const upstream = new LocalRemote();
    upstream.refs = async () => {
      throw new Error("transport lost");
    };
    const operation = input(await request(), upstream);
    expect((await guard().receive(operation)).toString()).toContain("publication rejected");
    expect(await git(remote, ["rev-parse", ref])).toBe(newSha);
    expect(await journal.readWrite(operation.sessionId, operation.operationId)).toMatchObject({
      outcome: { state: "unknown" },
    });
  });

  it("classifies git's definitive all-refs rejection as rejected even when the remote moved", async () => {
    const upstream = new LocalRemote();
    const baseSeed = upstream.seed.bind(upstream);
    let moved = false;
    upstream.seed = async (repository, options) => {
      await baseSeed(repository, options);
      // A concurrent writer creates the target branch after the snapshot but before the push,
      // so the create lease fails and the confirmation read observes a third value.
      if (!moved) {
        moved = true;
        await git(remote, ["update-ref", ref, "main"]);
      }
    };
    const operation = input(await request(), upstream);
    expect((await guard().receive(operation)).toString()).toContain(`ng ${ref}`);
    expect(upstream.publishCalls).toBe(1);
    expect(await journal.readWrite(operation.sessionId, operation.operationId)).toMatchObject({
      outcome: { state: "rejected", resultCode: "remote_push_rejected" },
    });
    // The rejection is terminal: the no-replay fence does not block the Session's fresh push,
    // which retries against the moved ref and completes.
    expect(await journal.listUnresolvedWrites(operation.sessionId)).toEqual([]);
    const retry = { ...input(await request(initialSha), upstream), sessionId: operation.sessionId };
    expect((await guard().receive(retry)).toString()).toContain(`ok ${ref}`);
    expect(await journal.readWrite(operation.sessionId, retry.operationId)).toMatchObject({
      outcome: { state: "succeeded" },
    });
  });

  it("keeps transport-failure outcomes unknown when the observed refs moved elsewhere", async () => {
    const upstream = new LocalRemote();
    upstream.publish = async () => {
      throw new Error("socket hangup before report-status");
    };
    upstream.refs = async (_repository, refs) => new Map(refs.map((name) => [name, initialSha]));
    const operation = input(await request(), upstream);
    expect((await guard().receive(operation)).toString()).toContain(`ng ${ref}`);
    expect(await journal.readWrite(operation.sessionId, operation.operationId)).toMatchObject({
      outcome: { state: "unknown" },
    });
    expect((await journal.listUnresolvedWrites(operation.sessionId)).length).toBe(1);
  });

  it("keeps unknown when the push landed but another writer advanced the ref before confirmation", async () => {
    const upstream = new LocalRemote();
    const baseRefs = upstream.refs.bind(upstream);
    upstream.refs = async (repository: string, refs: string[]) => {
      const current = await baseRefs(repository, refs);
      for (const name of current.keys()) current.set(name, initialSha);
      return current;
    };
    const operation = input(await request(), upstream);
    expect((await guard().receive(operation)).toString()).toContain(`ng ${ref}`);
    expect(await journal.readWrite(operation.sessionId, operation.operationId)).toMatchObject({
      outcome: { state: "unknown" },
    });
  });

  it("rejects a pack that exceeds the staged object budget, which includes seeded history", async () => {
    // The staged snapshot holds the full seeded history plus the received pack; the object
    // budget applies to that total inventory, not to the incoming pack alone.
    const upstream = new LocalRemote();
    const operation = input(await request(), upstream);
    const limited = new GitPublicationGuard({
      root: join(root, "staging-budget"),
      controlStore: journal,
      maxObjects: 2,
    });
    expect((await limited.receive(operation)).toString()).toContain("publication rejected");
    expect(upstream.publishCalls).toBe(0);
  });

  it("enforces the pack spool limit at the exact byte boundary", async () => {
    const body = await request();
    const over = new GitPublicationGuard({
      root: join(root, "staging-over"),
      controlStore: journal,
      maxPackBytes: body.length - 1,
    });
    await expect(over.receive(input(body))).rejects.toThrow(/resource_limit/);
    const exact = new GitPublicationGuard({
      root: join(root, "staging-exact"),
      controlStore: journal,
      maxPackBytes: body.length,
    });
    expect((await exact.receive(input(body))).toString()).toContain(`ok ${ref}`);
  });

  it("rejects duplicate ref commands and malformed framing", async () => {
    const command = `${GIT_ZERO_SHA} ${newSha} ${ref}`;
    expect(() =>
      parseGitReceiveCommands(Buffer.concat([gitPacket(command), gitPacket(command), Buffer.from("0000")])),
    ).toThrow(/invalid_request/);
    expect(() => parseGitReceiveCommands(Buffer.from("0001"))).toThrow(/invalid_request/);
  });
});
