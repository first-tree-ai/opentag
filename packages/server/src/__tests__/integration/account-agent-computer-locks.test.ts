import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { agents, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService, MachineAuthService } from "../../services/computers/index.js";
import { OnboardingResetService } from "../../services/onboarding-reset/onboarding-reset-service.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function fixture() {
  const observer = createDatabaseClient(testDatabase.databaseUrl);
  const first = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const second = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
  const bootstrap = await bootstrapInitialAdmin(observer.database, {
    displayName: "Owner",
    email: "locks@example.com",
  });
  const [firstConnection] = await first.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [secondConnection] = await second.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  assert(firstConnection && secondConnection);
  const machineAuth = new MachineAuthService(observer.database);
  const code = await machineAuth.issueForAccount(bootstrap.userId, {});
  const computer = await machineAuth.exchangeConnectCode(exchangeInput(code.code));
  return {
    observer,
    first,
    second,
    firstPid: firstConnection.pid,
    secondPid: secondConnection.pid,
    computer,
    machineAuth,
    accountId: bootstrap.userId,
    agents: new AgentService(observer.database),
    close: () => Promise.all([observer.sql.end(), first.sql.end(), second.sql.end()]),
  };
}
function exchangeInput(code: string) {
  return {
    code,
    installationId: crypto.randomUUID(),
    displayName: "Local",
    platform: "linux" as const,
    arch: "x64",
    clientVersion: "0.1.2",
  };
}
function agentInput(computerId?: string, name = "locked-agent") {
  return { computerId, name, displayName: name, runtimeProvider: "codex" as const };
}
async function waitForLock(value: Awaited<ReturnType<typeof fixture>>, pid: number) {
  await expect
    .poll(
      async () => {
        const [row] = await value.observer.sql<{ waiting: boolean }[]>`
      select exists(select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock') as waiting`;
        return row?.waiting ?? false;
      },
      { timeout: 5_000, interval: 10 },
    )
    .toBe(true);
}
function outcome(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return "committed";
  let error = result.reason;
  while (error?.cause) error = error.cause;
  return error?.code ?? String(error);
}

describe("Account / Agent / Computer cross-connection lock order", () => {
  it.each([false, true])("serializes targeted repair with rebind (same target: %s)", async (sameTarget) => {
    const value = await fixture();
    const locked = deferred();
    const release = deferred();
    try {
      const agent = await value.agents.createForAccount(value.accountId, agentInput(value.computer.computerId));
      const issued = await value.machineAuth.issueForAccount(value.accountId, {
        mode: "repair",
        targetComputerId: value.computer.computerId,
        targetAgentId: agent.id,
      });
      const target = value.computer;
      if (!sameTarget) {
        const other = await value.machineAuth.exchangeConnectCode(
          exchangeInput((await value.machineAuth.issueForAccount(value.accountId, {})).code),
        );
        await value.agents.rebindById(value.accountId, agent.id, other.computerId);
      }
      const service = new AgentService(value.first.database, {
        afterAgentLocked: async () => {
          locked.resolve();
          await release.promise;
        },
      });
      const rebind = service.rebindById(value.accountId, agent.id, target.computerId);
      const results = Promise.allSettled([
        rebind,
        locked.promise.then(async () => {
          const repair = new MachineAuthService(value.second.database).exchangeConnectCode(exchangeInput(issued.code));
          const settled = Promise.allSettled([repair]);
          await waitForLock(value, value.secondPid);
          release.resolve();
          const [result] = await settled;
          if (result.status === "rejected") throw result.reason;
          return result.value;
        }),
      ]);
      const actual = await results;
      expect(actual.map(outcome)).toEqual(["committed", "committed"]);
    } finally {
      release.resolve();
      await value.close();
    }
  });

  it("rebinds without acquiring an Account lock", async () => {
    const value = await fixture();
    const agent = await value.agents.createForAccount(value.accountId, agentInput(value.computer.computerId));
    const targetCode = await value.machineAuth.issueForAccount(value.accountId, {});
    const target = await value.machineAuth.exchangeConnectCode(exchangeInput(targetCode.code));
    const locked = deferred();
    const release = deferred();
    const holding = value.first.sql.begin(async (transaction) => {
      await transaction`select id from users where id = ${value.accountId} for update`;
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      await value.second.sql`set statement_timeout = '500ms'`;
      await expect(
        new AgentService(value.second.database).rebindById(value.accountId, agent.id, target.computerId),
      ).resolves.toMatchObject({ computerId: target.computerId, revision: 2 });
    } finally {
      release.resolve();
      await holding;
      await value.close();
    }
  });

  it.each(["disconnect", "delete", "reset"] as const)("serializes bound creation with Computer %s", async (action) => {
    const value = await fixture();
    const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const gateLocked = deferred();
    const release = deferred();
    let gateTransaction: Promise<unknown> | undefined;
    try {
      await value.observer.sql.unsafe(`
        create function pause_agent_insert() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(910191); return new; end $$;
        create trigger pause_agent_insert before insert on agents for each row execute function pause_agent_insert();`);
      gateTransaction = gate.sql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(910191)`;
        gateLocked.resolve();
        await release.promise;
      });
      await gateLocked.promise;
      const create = new AgentService(value.first.database).createForAccount(
        value.accountId,
        agentInput(value.computer.computerId),
      );
      const created = Promise.allSettled([create]);
      await waitForLock(value, value.firstPid);
      const computers = new ComputerService(value.second.database, {
        getActiveUserById: async () => {
          throw new Error("Unexpected account lookup");
        },
      });
      const mutation =
        action === "delete"
          ? computers.deleteComputer(value.accountId, value.computer.computerId)
          : action === "disconnect"
            ? computers.disconnectComputer(value.accountId, value.computer.computerId)
            : new OnboardingResetService({
                database: value.second.database,
                agents: new AgentService(value.second.database),
                environment: "dev",
                allowLocalPreview: true,
              }).resetOnboarding(value.accountId);
      const mutated = Promise.allSettled([mutation]);
      await waitForLock(value, value.secondPid);
      release.resolve();
      await gateTransaction;
      const results = [...(await created), ...(await mutated)];
      expect(results.map(outcome)).toEqual([
        "committed",
        action === "delete" ? "COMPUTER_IN_USE" : action === "reset" ? "ONBOARDING_RESET_UNVERIFIED" : "committed",
      ]);
    } finally {
      release.resolve();
      await gateTransaction;
      await value.observer.sql.unsafe(
        "drop trigger if exists pause_agent_insert on agents; drop function if exists pause_agent_insert()",
      );
      await gate.sql.end();
      await value.close();
    }
  });
  it("serializes bound and unbound creation of the same name", async () => {
    const value = await fixture();
    const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const gateLocked = deferred();
    const release = deferred();
    let holding: Promise<unknown> | undefined;
    try {
      await value.observer.sql.unsafe(`
        create function pause_unbound_insert() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(910193); return new; end $$;
        create trigger pause_unbound_insert before insert on agents for each row execute function pause_unbound_insert();`);
      holding = gate.sql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(910193)`;
        gateLocked.resolve();
        await release.promise;
      });
      await gateLocked.promise;
      const unbound = new AgentService(value.first.database).createForAccount(value.accountId, agentInput());
      const unboundResult = Promise.allSettled([unbound]);
      await waitForLock(value, value.firstPid);
      const bound = new AgentService(value.second.database).createForAccount(
        value.accountId,
        agentInput(value.computer.computerId),
      );
      const boundResult = Promise.allSettled([bound]);
      await waitForLock(value, value.secondPid);
      release.resolve();
      await holding;
      expect([...(await unboundResult), ...(await boundResult)].map(outcome)).toEqual([
        "committed",
        "AGENT_NAME_CONFLICT",
      ]);
    } finally {
      release.resolve();
      await holding;
      await value.observer.sql.unsafe(
        "drop trigger if exists pause_unbound_insert on agents; drop function if exists pause_unbound_insert()",
      );
      await gate.sql.end();
      await value.close();
    }
  });

  it("serializes bound creation with an operator transfer into the same Account", async () => {
    const value = await fixture();
    const gate = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const gateLocked = deferred();
    const release = deferred();
    let holding: Promise<unknown> | undefined;
    try {
      const [source] = await value.observer.database
        .insert(users)
        .values({ displayName: "Source", email: "source@example.com" })
        .returning();
      assert(source);
      const agent = await value.agents.createForAccount(source.id, agentInput());
      await value.agents.suspendById(source.id, agent.id);
      await value.observer.sql.unsafe(`
        create function pause_agent_transfer() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(910192); return new; end $$;
        create trigger pause_agent_transfer before update of created_by_user_id on agents for each row execute function pause_agent_transfer();`);
      holding = gate.sql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(910192)`;
        gateLocked.resolve();
        await release.promise;
      });
      await gateLocked.promise;
      const transfer = new AgentService(value.first.database).transferToAccount({
        agentId: agent.id,
        targetAccountId: value.accountId,
        slack: "disable",
      });
      const transferred = Promise.allSettled([transfer]);
      await waitForLock(value, value.firstPid);
      const create = new AgentService(value.second.database).createForAccount(
        value.accountId,
        agentInput(value.computer.computerId),
      );
      const created = Promise.allSettled([create]);
      await waitForLock(value, value.secondPid);
      release.resolve();
      await holding;
      expect([...(await transferred), ...(await created)].map(outcome)).toEqual(["committed", "AGENT_NAME_CONFLICT"]);
    } finally {
      release.resolve();
      await holding;
      await value.observer.sql.unsafe(
        "drop trigger if exists pause_agent_transfer on agents; drop function if exists pause_agent_transfer()",
      );
      await gate.sql.end();
      await value.close();
    }
  });
});

describe("owner-scoped Agent locking", () => {
  it("returns the same 404 for foreign and missing Agents while the foreign row is locked", async () => {
    const value = await fixture();
    const locked = deferred();
    const release = deferred();
    const [foreign] = await value.observer.database
      .insert(users)
      .values({ displayName: "Foreign", email: "foreign@example.com" })
      .returning();
    assert(foreign);
    const foreignCode = await value.machineAuth.issueForAccount(foreign.id, {});
    const foreignComputer = await value.machineAuth.exchangeConnectCode(exchangeInput(foreignCode.code));
    const agent = await value.agents.createForAccount(value.accountId, agentInput());
    const held = value.first.sql.begin(async (transaction) => {
      await transaction`select id from agents where id = ${agent.id} for update`;
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      // A regression becomes a PostgreSQL timeout, rather than hanging the test or pool.
      await value.second.sql`set statement_timeout = '500ms'`;
      const service = new AgentService(value.second.database);
      for (const id of [agent.id, crypto.randomUUID()]) {
        const operations = [
          () => service.updateById(foreign.id, id, { displayName: "forbidden", expectedRevision: 1 }),
          () => service.suspendById(foreign.id, id),
          () => service.reactivateById(foreign.id, id),
          () => service.rebindById(foreign.id, id, foreignComputer.computerId),
          () => service.deleteById(foreign.id, id),
        ];
        for (const operation of operations)
          await expect(operation()).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
        await expect(service.getById(foreign.id, id)).rejects.toMatchObject({
          code: "RESOURCE_NOT_FOUND",
          statusCode: 404,
        });
        await expect(service.getConfigById(foreign.id, id)).rejects.toMatchObject({
          code: "RESOURCE_NOT_FOUND",
          statusCode: 404,
        });
      }
    } finally {
      release.resolve();
      await held;
      await value.close();
    }
  });

  it.each(["owner", "deleted", "suspended"] as const)(
    "rechecks %s after a legitimate caller waits for the row lock",
    async (change) => {
      const value = await fixture();
      const locked = deferred();
      const release = deferred();
      const [other] = await value.observer.database
        .insert(users)
        .values({ displayName: "Other", email: "race@example.com" })
        .returning();
      assert(other);
      const agent = await value.agents.createForAccount(value.accountId, agentInput());
      const held = value.first.database.transaction(async (transaction) => {
        await transaction
          .update(agents)
          .set(change === "owner" ? { createdByUserId: other.id } : { status: change })
          .where(eq(agents.id, agent.id));
        locked.resolve();
        await release.promise;
      });
      try {
        await locked.promise;
        const mutation = new AgentService(value.second.database).suspendById(value.accountId, agent.id);
        const settled = Promise.allSettled([mutation]);
        await waitForLock(value, value.secondPid);
        release.resolve();
        await held;
        const [result] = await settled;
        expect(result).toMatchObject({
          status: "rejected",
          reason:
            change === "suspended"
              ? { code: "AGENT_LIFECYCLE_CONFLICT", statusCode: 409 }
              : { code: "RESOURCE_NOT_FOUND", statusCode: 404 },
        });
        const [row] = await value.observer.database.select().from(agents).where(eq(agents.id, agent.id));
        assert(row);
        expect(row.status).toBe(change === "owner" ? "active" : change);
        expect(row.revision).toBe(1);
      } finally {
        release.resolve();
        await held;
        await value.close();
      }
    },
  );
});
