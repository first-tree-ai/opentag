import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agents, computers } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ContextTreeOperationService } from "../../services/agents/context-tree-operation-service.js";
import { GitHubContextTreeOperations } from "../../services/agents/github-context-tree-operations.js";
import { AgentGitHubCredentialService } from "../../services/github/agent-github-credential-service.js";
import { githubMcpFixture } from "../support/github-mcp.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => {
  await pg.reset();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.sql.end()));
});
afterAll(async () => {
  await pg?.stop();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  { action: "connect", cause: "deadline" },
  { action: "connect", cause: "close" },
  { action: "create", cause: "deadline" },
  { action: "create", cause: "close" },
] as const)(
  "does not save $action selection when $cause wins during final authority SQL",
  async ({ action, cause }) => {
    const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
    clients.push(client);
    const f = await githubMcpFixture(client.database),
      agentId = f.ids[0];
    assert(agentId);
    const [computer] = await client.database
      .insert(computers)
      .values({
        ownerAccountId: f.accountId,
        currentInstallationId: randomUUID(),
        displayName: "Context",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.1.2",
      })
      .returning();
    assert(computer);
    await client.database.update(agents).set({ computerId: computer.id }).where(eq(agents.id, agentId));
    let creates = 0,
      initializes = 0,
      overviewReads = 0;
    const api = {
      getRepository: async () => ({
        repositoryId: "42",
        fullName: "acme/memory",
        defaultBranch: "main",
        private: true,
        permissions: { pull: true, push: true, admin: false },
      }),
      getAuthenticatedUser: async () => ({ id: "42", login: "acme" }),
      createPrivateRepository: async () => {
        creates++;
        return api.getRepository();
      },
      initializeContextTree: async () => {
        initializes++;
      },
    };
    const github = new AgentGitHubCredentialService({ ...f.github.options, api: api as never });
    const service = new AgentService(client.database, { mcpCredentialCipher: f.cipher });
    const config = await service.getConfigById(f.accountId, agentId);
    const entered = deferred(),
      release = deferred();
    const management = {
      getOverview: async (...args: Parameters<typeof github.getOverview>) => {
        const result = await github.getOverview(...args);
        if (++overviewReads === (action === "create" ? 6 : 2)) {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
      resolveRepository: github.resolveRepository.bind(github),
      getExecutionUserCredential: github.getExecutionUserCredential.bind(github),
    };
    const budgetMs = cause === "close" ? 10_000 : action === "create" ? 1500 : 250;
    const operations = new GitHubContextTreeOperations({
      management,
      api,
      computerKind: async () => "local",
      treeHeads: {
        verify: async (input) => {
          await input.recheck?.();
          return "a".repeat(40);
        },
      },
      budgetMs,
    });
    const settings = new ContextTreeOperationService(
      service,
      { currentInstanceId: () => "peer", supportsCapability: () => true },
      operations,
    );
    const running = settings.run(f.accountId, agentId, {
      action,
      kind: "git",
      repository: "acme/memory",
      path: ".",
      ref: action === "create" ? "HEAD" : "main",
      expectedRevision: config.revision,
      expectedRuntimeConfigRevision: config.runtimeConfig.revision,
    });
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (cause === "deadline") await new Promise((done) => setTimeout(done, budgetMs + 50));
      else closing = operations.close();
      await expect(client.sql`select 1 as healthy`).resolves.toHaveLength(1);
    } finally {
      release.resolve();
    }
    try {
      expect(await running).toMatchObject({
        status: "failed",
        ...(action === "create" ? { code: "publication_uncertain" } : {}),
      });
      expect((await service.getConfigById(f.accountId, agentId)).runtimeConfig.contextTrees).toHaveLength(0);
      expect(creates).toBe(action === "create" ? 1 : 0);
      expect(initializes).toBe(action === "create" ? 1 : 0);
    } finally {
      await (closing ?? operations.close());
    }
  },
);
