import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitHubProviderAdapter } from "../services/github-proxy/github-provider-adapter.js";
import { GitHubHttpTransport } from "../services/github-proxy/http-transport.js";
import { verifyPublishedContextTree } from "../services/github-proxy/tree-verifier.js";
import { nativeProxyChannel } from "./support/native-proxy-channel.js";

const run = promisify(execFile);
function assertGitFixtureExit(code: number | null, inputError: NodeJS.ErrnoException | undefined) {
  // Git may finish its response before consuming all input; other failures must still fail the fixture.
  if (code !== 0 || (inputError && inputError.code !== "EPIPE"))
    throw new Error("Git fixture failed", { cause: inputError });
}

for (const cloud of [false, true])
  describe.skipIf(cloud && process.platform !== "linux")(
    `${cloud ? "Cloud" : "Local"} real Git through the full provider channel`,
    () => {
      it("preserves commits, arbitrary refs and Git semantics without a Session or Tree publication policy", async () => {
        const root = await mkdtemp(join(tmpdir(), "ot-git-full-"));
        const environment = {
          HOME: root,
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: join(root, "checkout"),
          GIT_AUTHOR_NAME: "Original Author",
          GIT_AUTHOR_EMAIL: "author@example.invalid",
          GIT_COMMITTER_NAME: "Original Committer",
          GIT_COMMITTER_EMAIL: "committer@example.invalid",
          GIT_TERMINAL_PROMPT: "0",
        };
        const local = async (cwd: string, args: string[]) =>
          (await run("git", args, { cwd, env: environment })).stdout.trim();
        const seed = join(root, "seed"),
          bare = join(root, "code.git"),
          checkout = join(root, "checkout");
        await mkdir(seed);
        await local(seed, ["init", "--initial-branch=main"]);
        await writeFile(join(seed, "file.txt"), "seed\n");
        await local(seed, ["add", "."]);
        await local(seed, ["commit", "-m", "seed"]);
        await local(seed, ["commit", "--allow-empty", "-m", "history"]);
        await local(root, ["clone", "--bare", seed, bare]);
        await local(bare, ["config", "http.receivepack", "true"]);
        await local(bare, ["update-ref", "refs/heads/protected", "HEAD"]);
        const hook = join(bare, "hooks", "pre-receive");
        await writeFile(
          hook,
          '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/protected ]; then echo "fixture protected branch" >&2; exit 1; fi\ndone\n',
        );
        await chmod(hook, 0o755);
        const requests: string[] = [];
        const upstream = http.createServer((request, response) => {
          void serveGit(request, response).catch(() => response.destroy());
        });
        async function serveGit(request: http.IncomingMessage, response: http.ServerResponse) {
          // GitHub Git HTTP challenges with Basic; accepting API Bearer here hides real failures.
          const expected = `Basic ${Buffer.from("x-access-token:ghu_fixture_owner").toString("base64")}`;
          if (request.headers.authorization !== expected) {
            response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
            response.end("Authentication required");
            return;
          }
          const url = new URL(request.url ?? "/", "https://github.com");
          requests.push(url.pathname);
          const chunks: Uint8Array[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const child = spawn("git", ["http-backend"], {
            env: {
              ...environment,
              GIT_PROJECT_ROOT: root,
              GIT_HTTP_EXPORT_ALL: "1",
              PATH_INFO: url.pathname.replace("/team/", "/"),
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: request.method,
              CONTENT_TYPE: request.headers["content-type"] ?? "",
              CONTENT_LENGTH: String(body.length),
              GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
              REMOTE_USER: "fixture-owner",
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
          const output: Uint8Array[] = [];
          child.stdout.on("data", (chunk) => output.push(chunk));
          child.stderr.resume();
          let inputError: NodeJS.ErrnoException | undefined;
          child.stdin.on("error", (error: NodeJS.ErrnoException) => {
            inputError = error;
          });
          child.stdin.end(body);
          const [code] = await once(child, "close");
          assertGitFixtureExit(code, inputError);
          const result = Buffer.concat(output),
            end = result.indexOf("\r\n\r\n");
          if (end < 0) throw Error("Invalid CGI response");
          const { status, headers } = cgiHeaders(result.subarray(0, end).toString());
          response.writeHead(status, headers);
          response.end(result.subarray(end + 4));
        }
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const address = upstream.address();
        if (!address || typeof address === "string") throw Error("Missing port");
        const adapter = new GitHubProviderAdapter({
          management: {
            getExecutionUserCredential: async () => ({
              accessToken: "ghu_fixture_owner",
              githubUserId: "owner",
              credentialGeneration: 1n,
              accessExpiresAt: new Date(Date.now() + 600000),
            }),
          },
          transport: new GitHubHttpTransport({
            resolveAddresses: async () => ["140.82.112.3"],
            connect: (url, options, listener) =>
              http.request(
                { ...options, hostname: "127.0.0.1", port: address.port, path: url.pathname + url.search },
                listener,
              ),
          }),
        });
        let channel = await nativeProxyChannel(root, adapter, cloud);
        const git = async (cwd: string, args: string[]) => {
          // Each entry process models a new command container with a fresh temporary CA file.
          if (cloud) await rm(join(root, "sandbox-home", "ca.pem"), { force: true });
          return (
            await (cloud
              ? run(
                  process.execPath,
                  [channel.cloudEntry as string, join(channel.cloudBin as string, "git"), ...args],
                  {
                    cwd,
                    env: environment,
                    ...(process.getuid?.() === 0 ? { uid: 10000, gid: 10000 } : {}),
                    timeout: 30000,
                  },
                )
              : run("git", args, { cwd, env: { ...environment, ...channel.environment }, timeout: 30000 }))
          ).stdout.trim();
        };
        try {
          const url = "https://github.com/team/code.git";
          expect(await git(root, ["ls-remote", url])).toContain("refs/heads/main");
          const shallow = join(root, "shallow");
          await git(root, ["clone", "--depth=1", url, shallow]);
          expect(await git(shallow, ["rev-list", "--count", "HEAD"])).toBe("1");
          await git(shallow, ["fetch", "--unshallow"]);
          expect(await git(shallow, ["rev-list", "--count", "HEAD"])).toBe("2");
          await git(root, ["clone", url, checkout]);
          expect(await local(checkout, ["config", "--get", "remote.origin.url"])).toBe(url);
          await git(checkout, ["checkout", "-b", "feature/ordinary"]);
          await git(checkout, ["config", "user.name", "Original Committer"]);
          await git(checkout, ["config", "user.email", "committer@example.invalid"]);
          await writeFile(join(checkout, "file.txt"), "native\n");
          const key = join(root, "signing-key");
          await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { env: environment });
          if (cloud && process.getuid?.() === 0) await chown(key, 10000, 10000);
          await git(checkout, [
            "-c",
            "gpg.format=ssh",
            "-c",
            `user.signingkey=${key}`,
            "commit",
            "-S",
            "--author=Original Author <author@example.invalid>",
            "-am",
            "original metadata",
          ]);
          const sha = await local(checkout, ["rev-parse", "HEAD"]),
            raw = await local(checkout, ["cat-file", "commit", "HEAD"]);
          await git(checkout, ["tag", "v-fixture"]);
          await git(checkout, [
            "-c",
            "gpg.format=ssh",
            "-c",
            `user.signingkey=${key}`,
            "tag",
            "-s",
            "v-signed",
            "-m",
            "signed tag",
          ]);
          await git(checkout, ["tag", "v-blob", "HEAD:file.txt"]);
          const tagOid = await local(checkout, ["rev-parse", "v-signed"]);
          const tagBytes = await local(checkout, ["cat-file", "tag", tagOid]);
          await git(checkout, [
            "push",
            "--atomic",
            "origin",
            "HEAD",
            "refs/tags/v-fixture",
            "refs/tags/v-signed",
            "refs/tags/v-blob",
            "HEAD:refs/heads/context/default",
          ]);
          for (const ref of ["feature/ordinary", "v-fixture", "context/default"])
            expect(await local(bare, ["rev-parse", ref])).toBe(sha);
          expect(await local(bare, ["cat-file", "commit", sha])).toBe(raw);
          expect(await local(bare, ["cat-file", "tag", tagOid])).toBe(tagBytes);
          expect(await local(bare, ["cat-file", "-t", "v-blob"])).toBe("blob");
          const signers = join(root, "allowed-signers");
          await writeFile(signers, `committer@example.invalid ${await readFile(`${key}.pub`, "utf8")}`);
          await local(bare, [
            "-c",
            "gpg.format=ssh",
            "-c",
            `gpg.ssh.allowedSignersFile=${signers}`,
            "verify-commit",
            sha,
          ]);
          await local(bare, [
            "-c",
            "gpg.format=ssh",
            "-c",
            `gpg.ssh.allowedSignersFile=${signers}`,
            "verify-tag",
            tagOid,
          ]);
          await expect(git(checkout, ["push", "origin", "HEAD:refs/heads/protected"])).rejects.toMatchObject({
            stderr: expect.stringContaining("fixture protected branch"),
          });
          await expect(
            verifyPublishedContextTree(bare, sha, { cwd: root, environment, signal: new AbortController().signal }),
          ).rejects.toThrow(/tree_invalid/);
          expect(await local(bare, ["rev-parse", "context/default"])).toBe(sha);
          expect(raw).toContain("gpgsig -----BEGIN SSH SIGNATURE-----");
          expect(raw).toContain("author Original Author <author@example.invalid>");
          expect(raw).toContain("committer Original Committer <committer@example.invalid>");
          await channel.close();
          channel = await nativeProxyChannel(root, adapter, cloud);
          // A fresh execution can continue the same ordinary branch.
          await git(checkout, ["commit", "--amend", "-m", "continued work", "--allow-empty"]);
          expect(await local(checkout, ["rev-parse", "HEAD"])).not.toBe(sha);
          await expect(git(checkout, ["push", "origin", "HEAD"])).rejects.toBeDefined();
          await expect(
            git(checkout, [
              "push",
              `--force-with-lease=refs/heads/feature/ordinary:${"0".repeat(40)}`,
              "origin",
              "HEAD",
            ]),
          ).rejects.toMatchObject({ stderr: expect.stringContaining("stale info") });
          await git(checkout, ["push", "--force-with-lease", "origin", "HEAD"]);
          await git(checkout, ["fetch", "origin"]);
          await git(checkout, ["push", "origin", ":refs/tags/v-fixture", ":refs/heads/context/default"]);
          expect(await local(bare, ["for-each-ref", "--format=%(refname)"])).not.toContain("context/default");
          expect(await readFile(join(checkout, "file.txt"), "utf8")).toBe("native\n");
          expect(requests.some((path) => path.endsWith("git-receive-pack"))).toBe(true);
          expect(channel.connections).toHaveLength(1);
          expect(channel.connections[0]?.snapshot().active).toBe(0);
        } finally {
          await channel.close();
          upstream.closeAllConnections();
          await new Promise<void>((resolve) => upstream.close(() => resolve()));
          await rm(root, { recursive: true, force: true });
        }
      }, 60000);
    },
  );

function cgiHeaders(raw: string): { status: number; headers: Record<string, string> } {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of raw.split("\r\n")) {
    const colon = line.indexOf(":"),
      name = line.slice(0, colon).toLowerCase(),
      value = line.slice(colon + 1).trim();
    if (name === "status") status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { status, headers };
}
