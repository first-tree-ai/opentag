import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderProxyResponse } from "../../runtime-credentials/provider-proxy-adapter.js";
import { GitPublicationError, gitPacket } from "./git-packets.js";
import { type GitProcessOptions, runTrustedGit } from "./git-process.js";
import { assertDirectoryBudget } from "./git-publication.js";
import type { PublicationRemote } from "./git-remote.js";
import type { GitWorkspace } from "./git-workspace.js";

export interface GitReadRequest {
  repositoryId: string;
  service: "git-upload-pack" | "git-receive-pack";
  advertise: boolean;
  protocol?: string;
  defaultRef: string;
  allowedRefs?: readonly string[];
  body: AsyncIterable<Uint8Array>;
  remote: PublicationRemote;
  signal: AbortSignal;
  revalidate(): Promise<void>;
}

/** Git reads are served from a trusted snapshot exposing only this execution's permitted refs. */
export class GitReadTransport {
  readonly #workspace: GitWorkspace;
  readonly #maximum: number;
  #active = 0;
  constructor(options: { workspace: GitWorkspace; maxConcurrent?: number }) {
    this.#workspace = options.workspace;
    this.#maximum = options.maxConcurrent ?? 4;
  }

  async handle(input: GitReadRequest): Promise<ProviderProxyResponse> {
    if (this.#active >= this.#maximum) throw new GitPublicationError("resource_limit");
    if ((!input.advertise && input.service !== "git-upload-pack") || (input.protocol && input.protocol !== "version=2"))
      throw new GitPublicationError("invalid_request");
    this.#active++;
    let workspace: string | undefined;
    const abort = new AbortController();
    const signal = AbortSignal.any([input.signal, abort.signal, AbortSignal.timeout(120_000)]);
    let checking = false;
    const monitor = setInterval(() => {
      if (checking || !workspace) return;
      checking = true;
      void assertDirectoryBudget(workspace, 512 * 1024 * 1024)
        .catch(() => abort.abort())
        .finally(() => {
          checking = false;
        });
    }, 500);
    monitor.unref();
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      clearInterval(monitor);
      this.#active--;
      abort.abort();
      if (workspace) await rm(workspace, { recursive: true, force: true });
    };
    try {
      await input.revalidate();
      workspace = await this.#workspace.stagingDirectory("read-");
      const home = join(workspace, "home");
      await mkdir(home, { mode: 0o700 });
      const options: GitProcessOptions = {
        cwd: workspace,
        signal,
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          XDG_CONFIG_HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          ...(input.protocol ? { GIT_PROTOCOL: input.protocol } : {}),
        },
      };
      const repository = join(workspace, "repository.git");
      await runTrustedGit(["-c", "init.templateDir=", "init", "--bare", repository], options);
      await input.remote.seed(repository, options, input.allowedRefs);
      await runTrustedGit(["-C", repository, "symbolic-ref", "HEAD", input.defaultRef], options);
      await assertDirectoryBudget(workspace, 512 * 1024 * 1024);
      await input.revalidate();
      const header = input.advertise
        ? Buffer.concat([gitPacket(`# service=${input.service}\n`), Buffer.from("0000")])
        : undefined;
      signal.throwIfAborted();
      const onAbort = () => {
        void dispose();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const stream = spawnGitStream(input, repository, options);
      return {
        status: 200,
        headers: {
          "content-type": `application/x-${input.service}-${input.advertise ? "advertisement" : "result"}`,
          "cache-control": "no-store",
        },
        body: cleanupBody(
          stream,
          async () => {
            signal.removeEventListener("abort", onAbort);
            await dispose();
          },
          header,
        ),
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}

async function* cleanupBody(body: AsyncIterable<Uint8Array>, dispose: () => Promise<void>, header?: Uint8Array) {
  try {
    if (header) yield header;
    yield* body;
  } finally {
    await dispose();
  }
}

async function* spawnGitStream(
  input: GitReadRequest,
  repository: string,
  options: GitProcessOptions,
): AsyncIterable<Uint8Array> {
  const child = spawn(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "uploadpack.allowReachableSHA1InWant=true",
      input.service.slice(4),
      "--stateless-rpc",
      ...(input.advertise ? ["--advertise-refs"] : []),
      repository,
    ],
    { cwd: options.cwd, env: options.environment, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  options.signal.addEventListener("abort", kill, { once: true });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) kill();
  });
  child.stdin.on("error", () => undefined);
  const completion = once(child, "close")
    .then(([code]) => code as number)
    .catch(() => 1);
  const feeding = feedGitRequest(input.advertise ? undefined : input.body, child.stdin).catch(() => {
    kill();
  });
  try {
    let bytes = 0;
    for await (const chunk of child.stdout) {
      options.signal.throwIfAborted();
      bytes += (chunk as Buffer).length;
      if (bytes > 512 * 1024 * 1024) throw new GitPublicationError("resource_limit");
      yield chunk as Buffer;
    }
    await feeding;
    if ((await completion) !== 0) throw new GitPublicationError("unavailable");
  } finally {
    options.signal.removeEventListener("abort", kill);
    kill();
    await completion;
  }
}

async function feedGitRequest(
  body: AsyncIterable<Uint8Array> | undefined,
  target: NodeJS.WritableStream,
): Promise<void> {
  let bytes = 0;
  if (body)
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new GitPublicationError("resource_limit");
      if (!target.write(chunk)) await once(target, "drain");
    }
  target.end();
}
