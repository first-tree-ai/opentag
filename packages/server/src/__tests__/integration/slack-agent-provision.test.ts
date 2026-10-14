import { randomUUID } from "node:crypto";
import {
  ProvisionSlackAgentRequestSchema,
  RUNTIME_AGENT_SLACK_PROVISION_PATH,
  SESSION_CLI_PROOF_HEADER,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { accountCliLoginCodes, agents, computers, imBindings, slackInstallations } from "../../db/schema/index.js";
import { AgentSlackProvisionService } from "../../services/agents/agent-slack-provision-service.js";
import { AgentService } from "../../services/agents/index.js";
import {
  AuthService,
  type AuthTokenProvider,
  ConnectCodeService,
  consumeAccountConnectCode,
  hashSecret,
} from "../../services/auth/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { SlackConfigurationService } from "../../services/im-bindings/slack/index.js";
import { SessionCliProofError } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let database: MigratedTestDatabase;
beforeAll(async () => {
  database = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => database.stop());
beforeEach(async () => database.reset());

async function fixture() {
  const client = createDatabaseClient(database.databaseUrl);
  const owner = await bootstrapInitialAdmin(client.database, { displayName: "Owner", email: "owner@example.com" });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: owner.userId,
      currentInstallationId: randomUUID(),
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.1.1",
    })
    .returning();
  if (!computer) throw new Error("Missing Computer");
  const agentService = new AgentService(client.database);
  const source = await agentService.createForAccount(owner.userId, {
    name: "original",
    displayName: "Original",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const proofs = {
    authenticate: vi.fn(async (proof: string) => {
      if (proof !== "proof") throw new SessionCliProofError("invalid_proof", "Invalid proof");
      return {
        agentId: source.id,
        computerId: computer.id,
        connectionInstanceId: randomUUID(),
        placementGeneration: 1,
        sessionId: randomUUID(),
        sessionKind: "channel" as const,
        installationId: randomUUID(),
      };
    }),
  };
  const issuer = new ConnectCodeService(client.database);
  const tokens = {
    issuePairForUser: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", expiresIn: 900 })),
  };
  const auth = new AuthService(client.database, tokens as unknown as AuthTokenProvider);
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const bindings = new ImBindingService(client.database, cipher);
  const api = {
    inspectInstallation: vi.fn(async () => ({
      appId: "A_NEW",
      teamId: "T_TEAM",
      enterpriseId: null,
      botUserId: "U_BOT",
      botId: "B_BOT",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    })),
    botInfo: vi.fn(async () => ({ id: "B_BOT", userId: "U_BOT", appId: "A_NEW", deleted: false })),
    botProfile: vi.fn(async () => ({ displayName: "Actual Slack Name", avatarUrl: null })),
  };
  const slack = new SlackConfigurationService({
    database: client.database,
    cipher,
    imBindings: bindings,
    api: api as never,
  });
  const service = new AgentSlackProvisionService({
    database: client.database,
    proofs,
    agents: agentService,
    slack,
    publicOrigin: "https://opentag.example.com",
  });
  const app = createApp({ authService: auth, runtimeAgentSlackProvision: { service } });
  const input = ProvisionSlackAgentRequestSchema.parse({
    code: (await issuer.issueForUser(owner.userId, "slack-agent-provision")).code,
    agent: {
      creationIntentId: randomUUID(),
      name: "new-helper",
      displayName: "Requested Name",
      runtimeProvider: "codex",
    },
    slack: {
      appId: "A_NEW",
      teamId: "T_TEAM",
      botUserId: "U_BOT",
      botAccessToken: "xoxb-private-test-token",
      signingSecret: "private-test-signing-secret",
    },
  });
  return {
    ...client,
    app,
    source,
    owner,
    input,
    issuer,
    tokens,
    api,
    proofs,
    submit: (payload = input, proof = "proof") =>
      app.inject({
        method: "POST",
        url: RUNTIME_AGENT_SLACK_PROVISION_PATH,
        headers: { [SESSION_CLI_PROOF_HEADER]: proof },
        payload,
      }),
    close: async () => {
      await app.close();
      await client.sql.end();
    },
  };
}

describe("Slack Agent provisioning", () => {
  it("rejects authority and Computer overrides before consuming the code, then uses safe defaults", async () => {
    const f = await fixture();
    try {
      const [otherComputer] = await f.database
        .insert(computers)
        .values({
          ownerAccountId: f.owner.userId,
          currentInstallationId: randomUUID(),
          displayName: "Another owned Computer",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.1.1",
        })
        .returning();
      if (!otherComputer) throw new Error("Missing other Computer");
      for (const override of [
        { computerId: otherComputer.id },
        { computerId: f.source.computerId },
        { runtimeConfig: { permissions: { approvalPolicy: "never", allowCommands: ["sh", "curl"] } } },
        { runtimeConfig: { permissions: { allowCommands: ["sh"] } } },
        { runtimeConfig: { maxDurationMs: 86_400_000 } },
        { runtimeConfig: { maxDurationMs: null } },
      ]) {
        const denied = await f.submit({ ...f.input, agent: { ...f.input.agent, ...override } } as never);
        expect(denied.statusCode).toBe(400);
      }
      for (const runtimeProvider of ["pi", "claude-code"] as const) {
        const denied = await f.submit({ ...f.input, agent: { ...f.input.agent, runtimeProvider } });
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe("AGENT_FORBIDDEN");
      }
      const [code] = await f.database
        .select()
        .from(accountCliLoginCodes)
        .where(eq(accountCliLoginCodes.tokenHash, `slack-provision.${hashSecret(f.input.code)}`));
      expect(code?.consumedAt).toBeNull();
      expect(await f.database.select().from(agents)).toHaveLength(1);
      expect(f.api.inspectInstallation).not.toHaveBeenCalled();

      const input = {
        ...f.input,
        agent: {
          ...f.input.agent,
          runtimeConfig: { model: "gpt-6.1-sol", reasoningEffort: "high", instructions: "Help with the task." },
        },
      };
      const created = await f.submit(input);
      expect(created.statusCode).toBe(200);
      expect(created.json().agent).toMatchObject({
        computerId: f.source.computerId,
        runtimeConfig: {
          ...input.agent.runtimeConfig,
          maxDurationMs: null,
          permissions: { approvalPolicy: "on-request", allowCommands: [] },
        },
      });
      const replay = await f.submit({
        ...input,
        code: (await f.issuer.issueForUser(f.owner.userId, "slack-agent-provision")).code,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().agent.id).toBe(created.json().agent.id);
    } finally {
      await f.close();
    }
  });

  it("blocks Account token exchange without consuming the operation code, then creates and encrypts the new binding", async () => {
    const f = await fixture();
    try {
      const [storedCode] = await f.database
        .select()
        .from(accountCliLoginCodes)
        .where(eq(accountCliLoginCodes.tokenHash, `slack-provision.${hashSecret(f.input.code)}`));
      expect(storedCode?.consumedAt).toBeNull();
      // This is the exact lookup made by the old exchange endpoint, including after a code-only rollback.
      expect(
        await f.database
          .select()
          .from(accountCliLoginCodes)
          .where(eq(accountCliLoginCodes.tokenHash, hashSecret(f.input.code))),
      ).toHaveLength(0);
      const login = await f.app.inject({
        method: "POST",
        url: "/api/v1/auth/connect/exchange",
        payload: { code: f.input.code },
      });
      expect(login.statusCode).toBe(401);
      expect(login.json().error.code).toBe("AUTH_CODE_PURPOSE_MISMATCH");
      const result = await f.submit();
      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toMatchObject({
        agent: { name: "new-helper" },
        slack: {
          binding: {
            bot: { displayName: "Actual Slack Name" },
            identity: { appId: "A_NEW", teamId: "T_TEAM", botUserId: "U_BOT" },
          },
        },
        interactionsUrl: "https://opentag.example.com/api/v1/im-bindings/slack/interactions",
      });
      expect(result.body).not.toContain(f.input.slack.botAccessToken);
      expect(result.body).not.toContain(f.input.slack.signingSecret);
      expect(f.tokens.issuePairForUser).not.toHaveBeenCalled();
      expect(await f.database.select().from(agents)).toHaveLength(2);
      const stored = await f.database.select().from(slackInstallations);
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(f.input.slack.botAccessToken);
      expect(JSON.stringify(stored)).not.toContain(f.input.slack.signingSecret);
      const [original] = await f.database.select().from(agents).where(eq(agents.id, f.source.id));
      expect(original?.selfConfigurationEnabled).toBe(false);
      expect(await f.database.select().from(imBindings).where(eq(imBindings.agentId, f.source.id))).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("does not downgrade stripped codes or accept a normal login code for provisioning", async () => {
    const f = await fixture();
    try {
      for (const code of [
        f.input.code.replace("slack-provision.", ""),
        f.input.code.replace("slack-provision.", "other."),
      ]) {
        await expect(consumeAccountConnectCode(f.database, code, "login")).rejects.toMatchObject({
          code: "AUTH_INVALID_CODE",
        });
      }
      await expect(
        consumeAccountConnectCode(
          f.database,
          `slack-provision.${f.owner.connectCode}`,
          "slack-agent-provision",
          f.owner.userId,
        ),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CODE" });
      const result = await f.submit({ ...f.input, code: f.owner.connectCode });
      expect(result.statusCode).toBe(400);
      const [row] = await f.database
        .select()
        .from(accountCliLoginCodes)
        .where(eq(accountCliLoginCodes.tokenHash, hashSecret(f.owner.connectCode)));
      expect(row?.consumedAt).toBeNull();
      expect(await f.submit()).toMatchObject({ statusCode: 200 });
    } finally {
      await f.close();
    }
  });

  it("authenticates the source before parsing and rejects caller-chosen Account or target IDs", async () => {
    const f = await fixture();
    try {
      expect((await f.submit(f.input, "invalid")).statusCode).toBe(401);
      const response = await f.submit({ ...f.input, agentId: f.source.id, accountId: f.owner.userId } as never);
      expect(response.statusCode).toBe(400);
      const [row] = await f.database
        .select()
        .from(accountCliLoginCodes)
        .where(eq(accountCliLoginCodes.tokenHash, `slack-provision.${hashSecret(f.input.code)}`));
      expect(row?.consumedAt).toBeNull();
      expect(await f.database.select().from(agents)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("requires a matching active Account and keeps mismatched and expired operation codes unconsumed", async () => {
    const f = await fixture();
    try {
      await expect(
        consumeAccountConnectCode(f.database, f.input.code, "slack-agent-provision", randomUUID()),
      ).rejects.toMatchObject({ code: "AUTH_USER_MISMATCH" });
      const expired = await new ConnectCodeService(f.database, { now: () => new Date("2020-01-01") }).issueForUser(
        f.owner.userId,
        "slack-agent-provision",
      );
      expect((await f.submit({ ...f.input, code: expired.code })).json().error.code).toBe("AUTH_CODE_EXPIRED");
      expect(await f.submit()).toMatchObject({ statusCode: 200 });
    } finally {
      await f.close();
    }
  });

  it("consumes a concurrent code once and replays the same creation intent without changing credentials", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all([f.submit(), f.submit()]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
      const first = results.find((r) => r.statusCode === 200)?.json();
      const next = await f.issuer.issueForUser(f.owner.userId, "slack-agent-provision");
      const replay = await f.submit({ ...f.input, code: next.code });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().agent.id).toBe(first.agent.id);
      expect(replay.json().slack.binding.credentialGeneration).toBe(first.slack.binding.credentialGeneration);
      expect(f.api.inspectInstallation).toHaveBeenCalledTimes(1);
      expect(await f.database.select().from(agents)).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("keeps an unbound creation on identity failure and recovers only that Agent with a fresh operation code", async () => {
    const f = await fixture();
    try {
      const failure = await f.submit({ ...f.input, slack: { ...f.input.slack, teamId: "T_OTHER" } });
      expect(failure.statusCode).toBe(409);
      expect(failure.json().error.code).toBe("SLACK_BINDING_IDENTITY_MISMATCH");
      const [created] = await f.database
        .select()
        .from(agents)
        .where(eq(agents.creationIntentId, f.input.agent.creationIntentId));
      expect(created).toBeDefined();
      expect(await f.database.select().from(imBindings)).toHaveLength(0);
      const code = (await f.issuer.issueForUser(f.owner.userId, "slack-agent-provision")).code;
      const recovered = await f.submit({ ...f.input, code });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().agent.id).toBe(created?.id);
      expect(await f.database.select().from(agents)).toHaveLength(2);
      const different = await f.submit({
        ...f.input,
        code: (await f.issuer.issueForUser(f.owner.userId, "slack-agent-provision")).code,
        slack: { ...f.input.slack, appId: "A_OTHER" },
      });
      expect(different.statusCode).toBe(409);
      expect(await f.database.select().from(imBindings)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});
