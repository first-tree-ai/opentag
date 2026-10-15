import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { nativeGhFixture } from "./support/native-gh-fixture.js";

const binary = process.env.OPENTAG_TEST_GH_BINARY;
const run = promisify(execFile);

describe.skipIf(!binary)("real gh native API compatibility (offline fixture)", () => {
  it("reads private commit statuses with an exact read grant on every registered spelling", async () => {
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
        expect(fixture.permissions.at(-1)).toEqual({ contents: "read", pull_requests: "read", statuses: "read" });
      }
      expect(fixture.counts.revoked).toBe(fixture.counts.minted);
      for (const args of [
        ["api", `repos/${fixture.fullName}/statuses/main`, "--method", "POST", "-f", "state=success"],
        ["api", "repos/foreign/private/commits/main/status"],
      ])
        await expect(
          run(binary as string, args, { cwd: fixture.root, env: fixture.environment, timeout: 15000 }),
        ).rejects.toMatchObject({ code: 1 });
      expect(fixture.counts.minted).toBe(3);
    } finally {
      await fixture.close();
    }
  });
  it("reads, diffs, checks, creates, comments, edits, closes and reopens within the task scope", async () => {
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
      expect(fixture.permissions).toContainEqual({
        contents: "read",
        pull_requests: "read",
        checks: "read",
        actions: "read",
      });
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
            "main",
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
      expect(fixture.counts.minted).toBeGreaterThan(0);
      expect(fixture.counts.revoked).toBe(fixture.counts.minted);
      const writes = () =>
        fixture.upstreamRequests.filter(
          (request) =>
            request.method !== "GET" &&
            (request.path !== "/graphql" || (JSON.stringify(request.body) ?? "").includes("mutation")),
        ).length;
      const baseline = writes();
      for (const args of [
        ["api", "repos/foreign/secret"],
        [
          "api",
          `repos/${fixture.fullName}/pulls`,
          "--method",
          "POST",
          "-f",
          "head=main",
          "-f",
          "base=main",
          "-f",
          "title=Denied",
        ],
        ["api", `repos/${fixture.fullName}/pulls/2`, "--method", "PATCH", "-f", "state=closed"],
        [
          "api",
          "graphql",
          "-f",
          'query={repository(owner:"team",name:"code"){owner{...on Organization{repositories(first:1){nodes{id}}}}}}',
        ],
      ])
        await expect(gh(args)).rejects.toMatchObject({ code: 1 });
      expect(writes()).toBe(baseline);
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
        expect(fixture.counts.revoked).toBe(fixture.counts.minted);
      } finally {
        await fixture.close();
      }
    },
    30000,
  );
  it("does not need Projects permission for a plain title edit", async () => {
    const fixture = await nativeGhFixture({ denyProjectMetadata: true });
    try {
      await run(
        binary as string,
        ["pr", "edit", "1", "-R", fixture.fullName, "--title", "Without project permission"],
        { cwd: fixture.root, env: fixture.environment, timeout: 15000 },
      );
      expect(fixture.pr.title).toBe("Without project permission");
      expect(fixture.permissions).not.toContainEqual(expect.objectContaining({ organization_projects: "read" }));
    } finally {
      await fixture.close();
    }
  });
  it("supports check fields in a native GraphQL mutation response with scoped read permissions", async () => {
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
      expect(fixture.permissions.at(-1)).toEqual({
        contents: "read",
        pull_requests: "write",
        checks: "read",
        actions: "read",
      });
      expect(fixture.counts.revoked).toBe(fixture.counts.minted);
    } finally {
      await fixture.close();
    }
  });
  it("never closes another Session's PR even after a successful native preread", async () => {
    const fixture = await nativeGhFixture();
    try {
      await expect(
        run(binary as string, ["pr", "close", "2", "-R", fixture.fullName], {
          cwd: fixture.root,
          env: fixture.environment,
          timeout: 15000,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(
        fixture.upstreamRequests.some((request) => (JSON.stringify(request.body) ?? "").includes("mutation")),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});
