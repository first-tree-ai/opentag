import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeProxyAdapterStreamRequest } from "../../runtime/runtime-proxy-loopback-adapter.js";

const exec = promisify(execFile);

/** Real Git smart HTTP without internet, host credentials, or a second TCP listener. */
export async function nativeGitFixture(root: string) {
  const env = {
    PATH: process.env.OPENTAG_TEST_GIT_BINARY
      ? `${dirname(process.env.OPENTAG_TEST_GIT_BINARY)}:${process.env.PATH}`
      : process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Original Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Original Committer",
    GIT_COMMITTER_EMAIL: "committer@example.invalid",
  };
  const git = async (cwd: string, args: string[]) =>
    (await exec("git", args, { cwd, env, timeout: 15000 })).stdout.trim();
  const seed = join(root, "seed"),
    repository = join(root, "fixture.git");
  await mkdir(seed);
  await git(seed, ["init", "--initial-branch=main"]);
  await writeFile(join(seed, "file.txt"), "initial\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "initial"]);
  await git(root, ["clone", "--bare", seed, repository]);
  await git(repository, ["config", "http.receivepack", "true"]);
  const requests: string[] = [];
  const openStream = async (request: RuntimeProxyAdapterStreamRequest) => {
    if (request.provider !== "github" || request.headers["x-opentag-provider-origin"] !== "github.com")
      throw Error("Wrong authority");
    const url = new URL(request.path, "https://github.com");
    if (!url.pathname.startsWith("/team/fixture.git/")) throw Error("Wrong repository");
    requests.push(request.path);
    const input: Buffer[] = [];
    for await (const chunk of request.body) input.push(Buffer.from(chunk));
    const body = Buffer.concat(input);
    const result = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", ["http-backend"], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname.replace("/team/", "/"),
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
          REMOTE_USER: "fixture-user",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      child.stderr.resume();
      child.on("error", reject);
      child.stdin.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error(`Git CGI exit ${code}`)),
      );
      child.stdin.end(body);
    });
    const end = result.indexOf("\r\n\r\n");
    if (end < 0) throw Error("Invalid Git CGI response");
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of result.subarray(0, end).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon).toLowerCase(),
        value = line.slice(colon + 1).trim();
      if (key === "status") status = Number.parseInt(value, 10);
      else headers[key] = value;
    }
    return {
      status,
      headers,
      body: (async function* () {
        yield result.subarray(end + 4);
      })(),
    };
  };
  return { env, repository, git, requests, openStream, initial: await readFile(join(seed, "file.txt"), "utf8") };
}
