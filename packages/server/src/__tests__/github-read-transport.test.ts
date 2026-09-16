import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitRefUpdate } from "../services/github-proxy/git-packets.js";
import type { GitProcessOptions } from "../services/github-proxy/git-process.js";
import { GitPublicationGuard } from "../services/github-proxy/git-publication.js";
import { GitReadTransport } from "../services/github-proxy/git-read-transport.js";
import type { PublicationRemote } from "../services/github-proxy/git-remote.js";
import { FileSessionControlStore } from "../services/session-control-store/index.js";

const exec = promisify(execFile);
let root: string, upstream: string, baseUrl: string, server: Server;
let environment: NodeJS.ProcessEnv;
let allowedRefs: string[] | undefined;
let sessionId: string;
async function git(cwd: string, args: string[]) {
  return (await exec("git", args, { cwd, env: environment, maxBuffer: 1024 * 1024, timeout: 20_000 })).stdout.trim();
}
class FixtureRemote implements PublicationRemote {
  async seed(repository: string, _options: GitProcessOptions, refs?: readonly string[]) {
    const lines = await git(root, ["ls-remote", "--heads", upstream, ...(refs ?? [])]);
    const names = lines
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")[1] as string);
    if (names.length) await git(repository, ["fetch", upstream, ...names.map((ref) => `+${ref}:${ref}`)]);
  }
  async publish(repository: string, updates: GitRefUpdate[]) {
    await git(repository, ["push", "--atomic", upstream, ...updates.map((update) => `${update.newSha}:${update.ref}`)]);
  }
  async refs(_repository: string, refs: string[]) {
    return new Map(
      (await git(root, ["ls-remote", upstream, ...refs]))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha = "", ref = ""] = line.split("\t");
          return [ref, sha];
        }),
    );
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "opentag-git-http-"));
  environment = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const source = join(root, "seed");
  await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.name", "Fixture"]);
  await git(source, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(source, "file.txt"), "initial\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  await git(source, ["checkout", "-b", "private-branch"]);
  await writeFile(join(source, "private.txt"), "not granted\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "private"]);
  await git(source, ["checkout", "main"]);
  upstream = join(root, "upstream.git");
  await git(root, ["clone", "--bare", source, upstream]);
  sessionId = randomUUID();
  allowedRefs = undefined;
  const controlStore = new FileSessionControlStore({ root: join(root, "control") });
  const reads = new GitReadTransport({ root: join(root, "reads"), controlStore });
  const writes = new GitPublicationGuard({ root: join(root, "writes"), controlStore });
  const remote = new FixtureRemote();
  server = createServer((request, response) => {
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const advertise = url.pathname.endsWith("/info/refs");
      const service = advertise ? url.searchParams.get("service") : url.pathname.split("/").at(-1);
      if (service !== "git-upload-pack" && service !== "git-receive-pack") throw new Error("fixture route");
      if (service === "git-receive-pack" && !advertise) {
        const body = await writes.receive({
          sessionId,
          executionId: randomUUID(),
          operationId: randomUUID(),
          repositoryId: "1",
          policyRevision: "1",
          scopes: [{ role: "code", refPrefix: "refs/heads/opentag/" }],
          protectedTreeRefs: ["refs/heads/main"],
          body: request,
          signal: abort.signal,
          remote,
          revalidate: async () => undefined,
        });
        response.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
        response.end(body);
        return;
      }
      const result = await reads.handle({
        sessionId,
        repositoryId: "1",
        policyRevision: "1",
        service,
        advertise,
        protocol: request.headers["git-protocol"] as string | undefined,
        defaultRef: "refs/heads/main",
        allowedRefs,
        body: request,
        signal: abort.signal,
        remote,
        revalidate: async () => undefined,
      });
      response.writeHead(result.status, result.headers);
      await pipeline(Readable.from(result.body), response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(403);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  baseUrl = `http://127.0.0.1:${address.port}/owner/repo.git`;
});
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("native Git over trusted smart HTTP", () => {
  it.each([0, 2])("clones, fetches, and pushes real pack data with protocol v%s", async (version) => {
    const checkout = join(root, "checkout");
    await git(root, ["-c", `protocol.version=${version}`, "clone", baseUrl, checkout]);
    expect(await readFile(join(checkout, "file.txt"), "utf8")).toBe("initial\n");
    await git(checkout, ["config", "user.name", "Fixture"]);
    await git(checkout, ["config", "user.email", "fixture@example.invalid"]);
    await git(checkout, ["checkout", "-b", "opentag/topic"]);
    await writeFile(join(checkout, "file.txt"), "updated\n");
    await git(checkout, ["commit", "-am", "update"]);
    await git(checkout, ["push", "origin", "HEAD"]);
    expect(await git(upstream, ["rev-parse", "opentag/topic"])).toBe(await git(checkout, ["rev-parse", "HEAD"]));
    await git(checkout, ["fetch", "origin"]);
    await expect(git(checkout, ["push", "origin", "HEAD:main"])).rejects.toThrow();
  });
  it("hides ungranted refs and denies fetching their SHA even when the caller knows it", async () => {
    allowedRefs = ["refs/heads/main"];
    const hidden = await git(upstream, ["rev-parse", "private-branch"]);
    const listed = await git(root, ["ls-remote", baseUrl]);
    expect(listed).not.toContain("private-branch");
    const checkout = join(root, "checkout");
    await git(root, ["clone", baseUrl, checkout]);
    await expect(git(checkout, ["fetch", "origin", hidden])).rejects.toThrow();
    await expect(readFile(join(checkout, "private.txt"))).rejects.toThrow();
  });
});
