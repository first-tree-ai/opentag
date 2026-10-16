import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { nativeGhFixture } from "./support/native-gh-fixture.js";

const binary = process.env.OPENTAG_TEST_GH_BINARY;
const run = promisify(execFile);

describe.skipIf(!binary)("real gh native API compatibility (offline fixture)", () => {
  it("paginates 300 pages on one product connection and comments on an ordinary issue", async () => {
    const fixture = await nativeGhFixture();
    const gh = (args: string[]) =>
      run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 30000 });
    try {
      const result = await gh(["api", `repos/${fixture.fullName}/issues`, "--paginate", "--jq", ".[0].number"]);
      expect(result.stdout.trim().split("\n").map(Number)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
      expect(fixture.channel.connections).toHaveLength(1);
      expect(fixture.channel.connections[0]?.snapshot()).toEqual({ active: 0, retired: 256, bufferedBytes: 0 });
      expect(
        JSON.parse(
          (
            await gh([
              "api",
              `repos/${fixture.fullName}/issues/99/comments`,
              "--method",
              "POST",
              "-f",
              "body=Issue comment",
            ])
          ).stdout,
        ),
      ).toMatchObject({ body: "Issue comment", user: { login: "fixture-owner" } });
    } finally {
      await fixture.close();
    }
  }, 60000);
  it("discovers workflows and filters private runs with native gh while leaving permissions to GitHub", async () => {
    const fixture = await nativeGhFixture({ privateRepository: true });
    const gh = (args: string[]) =>
      run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 15000 });
    try {
      for (const selectors of [
        [],
        ["--branch", "main"],
        ["--commit", "1".repeat(40)],
        ["--workflow", "ci.yml"],
        ["--workflow", "42"],
        ["--user", "fixture-user", "--event", "push", "--status", "success", "--created", ">2026-10-01"],
      ]) {
        const result = await gh([
          "run",
          "list",
          "-R",
          fixture.fullName,
          "--limit",
          "1",
          "--json",
          "databaseId,headSha,workflowName",
          ...selectors,
        ]);
        expect(JSON.parse(result.stdout)).toEqual([
          { databaseId: 7, headSha: "1".repeat(40), workflowName: "Fixture CI" },
        ]);
      }
      expect(fixture.upstreamRequests).toContainEqual(
        expect.objectContaining({ path: `/repos/${fixture.fullName}/actions/workflows` }),
      );
      expect(
        fixture.upstreamRequests.some(
          (request) => new URLSearchParams(request.search).get("head_sha") === "1".repeat(40),
        ),
      ).toBe(true);
      expect(
        JSON.parse((await gh(["workflow", "list", "-R", fixture.fullName, "--json", "id,name,state"])).stdout),
      ).toEqual([{ id: 42, name: "Fixture CI", state: "active" }]);
      expect(
        JSON.parse(
          (await gh(["run", "view", "7", "-R", fixture.fullName, "--json", "databaseId,conclusion,jobs"])).stdout,
        ),
      ).toMatchObject({ databaseId: 7, conclusion: "success", jobs: [expect.objectContaining({ name: "build" })] });
      for (const args of [
        ["workflow", "run", "42", "-R", fixture.fullName],
        ["workflow", "disable", "42", "-R", fixture.fullName],
        ["run", "cancel", "7", "-R", fixture.fullName],
        ["api", "repos/foreign/private/actions/workflows"],
      ])
        await expect(gh(args)).rejects.toMatchObject({ code: 1 });
      expect(fixture.upstreamRequests.some((request) => request.method !== "GET")).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 60000);
  it("reads private commit statuses using the connected user on every native spelling", async () => {
    const fixture = await nativeGhFixture({ privateRepository: true });
    try {
      for (const suffix of ["commits/main/status", "commits/feature/topic/statuses", "statuses/feature/topic"]) {
        const result = await run(binary as string, ["api", `repos/${fixture.fullName}/${suffix}`], {
          cwd: fixture.root,
          env: fixture.environment,
          timeout: 15000,
        });
        const payload = JSON.parse(result.stdout);
        expect(Array.isArray(payload) ? payload : payload.statuses).toEqual([
          { context: "private-ci", state: "success" },
        ]);
      }
      for (const args of [
        ["api", `repos/${fixture.fullName}/statuses/main`, "--method", "POST", "-f", "state=success"],
        ["api", "repos/foreign/private/commits/main/status"],
      ])
        await expect(
          run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 15000 }),
        ).rejects.toMatchObject({ code: 1 });
    } finally {
      await fixture.close();
    }
  });
  it("reads, diffs, checks, creates, comments, edits, closes and reopens without a Session workflow restriction", async () => {
    const fixture = await nativeGhFixture();
    const gh = (args: string[]) =>
      run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 15000 });
    try {
      expect(JSON.parse((await gh(["repo", "view", fixture.fullName, "--json", "name,owner"])).stdout).name).toBe(
        "code",
      );
      expect(
        JSON.parse((await gh(["pr", "view", "1", "-R", fixture.fullName, "--json", "number,title"])).stdout).number,
      ).toBe(1);
      expect((await gh(["pr", "diff", "1", "-R", fixture.fullName])).stdout).toContain("diff --git");
      expect((await gh(["pr", "diff", "1", "-R", fixture.fullName, "--patch"])).stdout).toContain("diff --git");
      expect(
        JSON.parse((await gh(["pr", "checks", "1", "-R", fixture.fullName, "--json", "name,state"])).stdout),
      ).toEqual([{ name: "fixture-check", state: "SUCCESS" }]);
      expect((await gh(["pr", "view", "1", "-R", fixture.fullName])).stdout).toContain("Fixture");
      await gh(["pr", "view", "1", "-R", fixture.fullName, "--comments"]);
      expect(
        JSON.parse(
          (await gh(["pr", "list", "-R", fixture.fullName, "--state", "all", "--json", "number,title,author"])).stdout,
        ),
      ).toEqual([]);
      expect(
        (
          await gh([
            "pr",
            "create",
            "-R",
            fixture.fullName,
            "--head",
            fixture.branch,
            "--base",
            "release/next",
            "--draft",
            "--title",
            "Fixture",
            "--body",
            "Fixture only",
          ])
        ).stdout,
      ).toContain("/pull/1");
      expect((await gh(["pr", "comment", "1", "-R", fixture.fullName, "--body", "Fixture only"])).stdout).toContain(
        "issuecomment-1",
      );
      await gh(["pr", "edit", "1", "-R", fixture.fullName, "--title", "Edited fixture"]);
      expect(fixture.pr.title).toBe("Edited fixture");
      await gh(["pr", "close", "1", "-R", fixture.fullName]);
      expect(fixture.pr.state).toBe("CLOSED");
      await gh(["pr", "reopen", "1", "-R", fixture.fullName]);
      expect(fixture.pr.state).toBe("OPEN");
    } finally {
      await fixture.close();
    }
  }, 60000);
  it.each(["checks", "edit", "comment", "close", "reopen"])(
    "supports a cold standalone pr %s without an earlier PR read",
    async (command) => {
      const fixture = await nativeGhFixture();
      try {
        if (command === "reopen") fixture.pr.state = "CLOSED";
        const flags: Record<string, string[]> = {
          checks: ["--json", "name,state"],
          edit: ["--title", "Cold edit"],
          comment: ["--body", "Cold comment"],
          close: [],
          reopen: [],
        };
        const result = await run(
          binary as string,
          ["pr", command, "1", "-R", fixture.fullName, ...(flags[command] ?? [])],
          { cwd: fixture.root, env: fixture.environment, timeout: 15000 },
        );
        if (command === "checks")
          expect(JSON.parse(result.stdout)).toEqual([{ name: "fixture-check", state: "SUCCESS" }]);
      } finally {
        await fixture.close();
      }
    },
    30000,
  );
  it("preserves GitHub's Projects error rather than manufacturing a different response", async () => {
    const fixture = await nativeGhFixture({ denyProjectMetadata: true });
    try {
      const query =
        'query PullRequestProjectItems { repository(owner:"team",name:"code") { pullRequest(number:1) { projectItems(first:1) { totalCount } } } }';
      await expect(
        run(binary as string, ["api", "graphql", "-f", `query=${query}`], {
          cwd: fixture.root,
          env: fixture.environment,
          timeout: 15000,
        }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Resource not accessible by integration") });
      // gh itself ignores optional Projects metadata errors when editing unrelated fields.
      await run(binary as string, ["pr", "edit", "1", "-R", fixture.fullName, "--title", "Native edit"], {
        cwd: fixture.root,
        env: fixture.environment,
        timeout: 15000,
      });
      expect(fixture.pr.title).toBe("Native edit");
    } finally {
      await fixture.close();
    }
  });
  it("forwards review and merge writes for existing PRs under native GitHub permissions", async () => {
    const fixture = await nativeGhFixture();
    const gh = (args: string[]) =>
      run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 15000 });
    try {
      fixture.pr.isDraft = false;
      await gh(["pr", "review", "1", "-R", fixture.fullName, "--approve"]);
      await gh(["pr", "merge", "1", "-R", fixture.fullName, "--merge"]);
      expect(fixture.pr.state).toBe("MERGED");
      expect(
        JSON.parse(
          (await gh(["api", `repos/${fixture.fullName}/pulls/2/reviews`, "--method", "POST", "-f", "event=APPROVE"]))
            .stdout,
        ).state,
      ).toBe("APPROVED");
      expect(
        JSON.parse(
          (await gh(["api", `repos/${fixture.fullName}/pulls/2/merge`, "--method", "PUT", "-f", "merge_method=squash"]))
            .stdout,
        ).merged,
      ).toBe(true);
      expect(fixture.upstreamRequests.filter((request) => request.path.endsWith("/merge"))).toHaveLength(1);
      expect(JSON.stringify(fixture.environment)).not.toContain("ghu_fixture_owner");
    } finally {
      await fixture.close();
    }
  });
  it("supports check fields in a native GraphQL mutation response without response-field permission planning", async () => {
    const fixture = await nativeGhFixture();
    const gh = (args: string[]) =>
      run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 15000 });
    try {
      await gh(["pr", "view", "1", "-R", fixture.fullName, "--json", "id,number"]);
      const query = `mutation($id:ID!) { closePullRequest(input:{pullRequestId:$id}) { pullRequest {
        state commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:1) { nodes {
          ... on CheckRun { isRequired(pullRequestId:$id) checkSuite { workflowRun { event } } }
        } } } } } }
      } } }`;
      const response = JSON.parse((await gh(["api", "graphql", "-f", `query=${query}`, "-f", "id=PR_fixture"])).stdout);
      expect(response.data.closePullRequest.pullRequest.state).toBe("CLOSED");
    } finally {
      await fixture.close();
    }
  });
  it("can continue a different Session's PR using a fresh execution", async () => {
    const fixture = await nativeGhFixture();
    try {
      await run(binary as string, ["pr", "close", "2", "-R", fixture.fullName], {
        cwd: fixture.root,
        env: fixture.environment,
        timeout: 15000,
      });
      expect(fixture.foreignPr.state).toBe("CLOSED");
    } finally {
      await fixture.close();
    }
  });
});

for (const cloud of [false, true])
  describe.skipIf(!binary || (cloud && process.platform !== "linux"))(
    `${cloud ? "Cloud" : "Local"} native downloads through the full provider channel`,
    () => {
      it("downloads private Actions logs/artifacts, release assets and archives without forwarding credentials", async () => {
        const fixture = await nativeGhFixture({ cloud, privateRepository: true });
        const gh = async (args: string[]) => {
          // A fresh entry process represents a fresh command container's temporary filesystem.
          if (cloud) await rm(join(fixture.root, "sandbox-home", "ca.pem"), { force: true });
          return cloud
            ? run(
                process.execPath,
                [fixture.channel.cloudEntry as string, join(fixture.channel.cloudBin as string, "gh"), ...args],
                {
                  cwd: fixture.root,
                  env: { PATH: `${dirname(binary as string)}:${process.env.PATH}` },
                  ...(process.getuid?.() === 0 ? { uid: 10000, gid: 10000 } : {}),
                  timeout: 20000,
                },
              )
            : run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 20000 });
        };
        try {
          expect((await gh(["run", "view", "7", "-R", fixture.fullName, "--log"])).stdout).toContain(
            "fixture-log-line",
          );
          const destination = join(fixture.root, "download");
          await gh(["run", "download", "7", "-R", fixture.fullName, "-n", "fixture-artifact", "-D", destination]);
          expect(await readFile(join(destination, "result.txt"), "utf8")).toBe("fixture-artifact-bytes\n");
          expect((await gh(["api", `repos/${fixture.fullName}/actions/jobs/99/logs`])).stdout).toContain(
            "fixture-log-line",
          );
          await gh(["release", "download", "v1.0.0", "-R", fixture.fullName, "-p", "fixture.txt", "-D", destination]);
          expect(await readFile(join(destination, "fixture.txt"), "utf8")).toBe("fixture-release-bytes\n");
          await gh(["release", "download", "v1.0.0", "-R", fixture.fullName, "--archive", "zip", "-D", destination]);
          const archive = unzipSync(await readFile(join(destination, "code-v1.0.0.zip")));
          expect(strFromU8(archive["team-code/file.txt"] as Uint8Array)).toBe("fixture-archive-bytes\n");
          expect((await gh(["api", "--method", "HEAD", `repos/${fixture.fullName}`, "--include"])).stdout).toContain(
            "200",
          );
          expect(fixture.upstreamRequests.some((request) => request.path === "/storage/artifact.zip")).toBe(true);
          expect(new Set(fixture.upstreamRequests.map((request) => request.host))).toEqual(
            new Set([
              "api.github.com",
              "productionresultssa9.blob.core.windows.net",
              "results-receiver.actions.githubusercontent.com",
              "release-assets.githubusercontent.com",
              "codeload.github.com",
            ]),
          );
          expect(fixture.channel.connections).toHaveLength(1);
        } finally {
          await fixture.close();
        }
      }, 60000);
    },
  );
