import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A local git repository served over smart HTTP, for tests that must exercise the real transport.
 *
 * Two alternatives were rejected. A local `file://` path is refused by the transport's own
 * `protocol.file.allow=never`, which is a property worth keeping. `git daemon` speaks `git://`, a
 * protocol the source parser never produces, so a test through it would prove nothing about what a
 * deployment actually dials. What is left is the same thing production uses: `git http-backend`
 * behind a small CGI shim, on a loopback port, with the repository on local disk. No network beyond
 * `127.0.0.1` is involved.
 *
 * `uploadpack.allowFilter` is configurable because it decides which of the two real paths is under
 * test: with it, the clone is genuinely blob-less and a blob read is a lazy fetch; without it, git
 * reports the filter as unsupported and falls back to a plain shallow clone.
 */

export interface GitRepositoryFixture {
  /** The directory the HTTP server exports; the repository lives directly inside it. */
  root: string;
  /** Absolute path of the bare repository. */
  repository: string;
  /** `http://127.0.0.1:<port>/repository.git` */
  url: string;
  close(): Promise<void>;
}

export interface GitRepositoryFixtureOptions {
  /** Files of the single commit, keyed by repository-relative path. */
  files: Record<string, string>;
  /** Extra branches: branch name to files, each committed on top of the initial commit. */
  branches?: Record<string, Record<string, string>>;
  allowFilter?: boolean;
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Opentag Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Opentag Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}

async function writeTree(directory: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function cgiHeader(line: string): { name: string; value: string } | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  return { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
}

/** Writes a CGI document as an HTTP response: header block, blank line, body. */
function applyCgiDocument(document: Buffer, response: ServerResponse): void {
  const separator = document.indexOf("\r\n\r\n");
  const head = separator < 0 ? "" : document.subarray(0, separator).toString("utf8");
  const body = separator < 0 ? Buffer.alloc(0) : document.subarray(separator + 4);
  let status = 200;
  for (const line of head.split("\r\n")) {
    const header = cgiHeader(line);
    if (header === undefined) continue;
    if (header.name.toLowerCase() === "status") status = Number.parseInt(header.value, 10) || 200;
    else response.setHeader(header.name, header.value);
  }
  response.writeHead(status);
  response.end(body);
}

/**
 * Serves `git http-backend` as CGI. The response is the CGI document: header block, blank line, body.
 */
function serveGitBackend(root: string): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const [pathname = "/", query = ""] = (request.url ?? "/").split("?");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: pathname,
          QUERY_STRING: query,
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(Buffer.concat(chunks).byteLength),
          GIT_PROTOCOL: request.headers["git-protocol"]?.toString() ?? "",
          REMOTE_ADDR: "127.0.0.1",
          REMOTE_USER: "",
          SERVER_PROTOCOL: "HTTP/1.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(Buffer.concat(chunks));
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.on("close", () => applyCgiDocument(Buffer.concat(output), response));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });
}

export async function startGitRepositoryFixture(options: GitRepositoryFixtureOptions): Promise<GitRepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "opentag-git-fixture-"));
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await git(work, ["init", "--quiet", "--initial-branch=main"]);
  await writeTree(work, options.files);
  await git(work, ["add", "--all"]);
  await git(work, ["commit", "--quiet", "--message", "initial"]);
  for (const [branch, files] of Object.entries(options.branches ?? {})) {
    await git(work, ["checkout", "--quiet", "-b", branch]);
    await writeTree(work, files);
    await git(work, ["add", "--all"]);
    await git(work, ["commit", "--quiet", "--message", branch]);
    await git(work, ["checkout", "--quiet", "main"]);
  }
  const repository = join(root, "repository.git");
  await git(work, ["clone", "--quiet", "--bare", work, repository]);
  if (options.allowFilter === true) {
    await git(repository, ["config", "uploadpack.allowFilter", "true"]);
  }
  const { server, port } = await serveGitBackend(root);
  return {
    root,
    repository,
    url: `http://127.0.0.1:${port}/repository.git`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
