import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SkillSource } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agentSkills,
  agents,
  computers,
  imBindings,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import {
  SessionCliProofService,
  type SessionCliSourceContext,
} from "../../services/sessions/session-cli-proof-service.js";
import { SkillService, type SkillUploadInput } from "../../services/skills/index.js";
import type { FakeSkillObjectStore } from "./fake-skill-object-store.js";
import { skillManifest, tarGz } from "./skill-archive-fixtures.js";
import type { UnitDatabase } from "./unit-database.js";

/**
 * Shared harness for the `SkillService` suites. All state lives in the caller's unit database, so
 * each suite still creates and resets its own instance; this module only removes the boilerplate of
 * seeding Accounts, Agents, Computer bindings, and deterministic archives.
 */

export interface SkillHarness {
  proofs: SessionCliProofService;
  runtimeSource(agentId: string): Promise<SessionCliSourceContext>;
  runtimeProof(agentId: string): Promise<{ source: SessionCliSourceContext; token: string }>;
  database: DatabaseClient;
  sha256(bytes: Uint8Array): string;
  createUser(): Promise<string>;
  createComputer(ownerAccountId: string): Promise<string>;
  createAgent(createdByUserId: string, computerId?: string): Promise<string>;
  archive(name: string, files?: Record<string, string>): Promise<Uint8Array>;
  upload(
    service: SkillService,
    accountId: string,
    agentId: string,
    name: string,
    options?: { replace?: boolean; source?: SkillSource; files?: Record<string, string>; declared?: string },
  ): Promise<Awaited<ReturnType<SkillService["upload"]>>>;
  serviceWith(store?: FakeSkillObjectStore): SkillService;
  objectKeyOf(skillId: string): Promise<string | undefined>;
  bumpRevision(skillId: string): Promise<void>;
  databasePausingFirstReturning(beforeReturn: () => Promise<void>): DatabaseClient;
  failingInsertDatabase(): DatabaseClient;
  committingThenThrowingInsertDatabase(): DatabaseClient;
  failingUpdateDatabase(): DatabaseClient;
  capturingLogger(): { logger: ServiceLogger; warns: Array<Record<string, unknown>> };
}

export function createSkillHarness(unit: Pick<UnitDatabase, "database">): SkillHarness {
  const database = unit.database;
  const instances = new Map<string, string>();
  const proofs = new SessionCliProofService(
    database,
    {
      currentInstanceId: (id) => instances.get(id),
      supportsCapability: (id, instance) => instances.get(id) === instance,
    },
    randomBytes(32),
  );

  async function runtimeProof(agentId: string): Promise<{ source: SessionCliSourceContext; token: string }> {
    const [agent] = await database.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw new Error("Missing test Agent");
    const computerId = agent.computerId ?? (await createComputer(agent.createdByUserId));
    await database.update(agents).set({ computerId }).where(eq(agents.id, agentId));
    const instanceId = instances.get(computerId) ?? randomUUID();
    instances.set(computerId, instanceId);
    await database.update(computers).set({ currentInstanceId: instanceId }).where(eq(computers.id, computerId));
    let [binding] = await database.select().from(imBindings).where(eq(imBindings.agentId, agentId)).limit(1);
    if (!binding) {
      [binding] = await database
        .insert(imBindings)
        .values({
          agentId,
          provider: "feishu",
          status: "active",
          externalAppId: randomUUID(),
          externalBotId: "fixture-bot",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "fixture",
          activatedAt: new Date(),
        })
        .returning();
    }
    if (!binding) throw new Error("Missing test binding");
    const [session] = await database
      .insert(sessions)
      .values({ imBindingId: binding.id, kind: "channel", channelId: randomUUID(), conversationKind: "channel" })
      .returning();
    if (!session) throw new Error("Missing test Session");
    await database.insert(sessionPlacements).values({ sessionId: session.id, computerId, generation: 1 });
    const { token } = await proofs.mint({
      sessionId: session.id,
      computerId,
      placementGeneration: 1,
      connectionInstanceId: instanceId,
    });
    return { source: await proofs.authenticate(token), token };
  }

  async function runtimeSource(agentId: string): Promise<SessionCliSourceContext> {
    return (await runtimeProof(agentId)).source;
  }

  const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await database.insert(users).values({ id, email: `${id}@example.test`, displayName: "Skill owner" });
    return id;
  }

  async function createComputer(ownerAccountId: string): Promise<string> {
    const id = randomUUID();
    await database.insert(computers).values({
      id,
      ownerAccountId,
      currentInstallationId: randomUUID(),
      displayName: "Test Computer",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.0",
    });
    return id;
  }

  async function createAgent(createdByUserId: string, computerId?: string): Promise<string> {
    const id = randomUUID();
    await database.insert(agents).values({
      id,
      createdByUserId,
      computerId: computerId ?? null,
      name: `skill-agent-${id.slice(0, 8)}`,
      displayName: "Skill Agent",
      runtimeProvider: "pi",
    });
    return id;
  }

  async function archive(name: string, files: Record<string, string> = {}): Promise<Uint8Array> {
    return tarGz([
      { name: "SKILL.md", body: skillManifest(name) },
      ...Object.entries(files).map(([path, body]) => ({ name: path, body })),
    ]);
  }

  function serviceWith(store?: FakeSkillObjectStore): SkillService {
    return new SkillService({ database, proofs, ...(store ? { store } : {}), keyPrefix: "skills" });
  }

  async function upload(
    service: SkillService,
    accountId: string,
    agentId: string,
    name: string,
    options: { replace?: boolean; source?: SkillSource; files?: Record<string, string>; declared?: string } = {},
  ) {
    const bytes = await archive(name, options.files ?? {});
    const input: SkillUploadInput = {
      bytes,
      format: "tar.gz",
      declaredSha256: options.declared ?? sha256(bytes),
      replace: options.replace ?? false,
      source: options.source ?? "web_upload",
    };
    return service.upload(accountId, agentId, input);
  }

  async function objectKeyOf(skillId: string): Promise<string | undefined> {
    const [row] = await database
      .select({ objectKey: agentSkills.objectKey })
      .from(agentSkills)
      .where(eq(agentSkills.id, skillId))
      .limit(1);
    return row?.objectKey;
  }

  async function bumpRevision(skillId: string): Promise<void> {
    await database
      .update(agentSkills)
      .set({ revision: sql`${agentSkills.revision} + 1` })
      .where(eq(agentSkills.id, skillId));
  }

  /**
   * Pauses the first terminal `returning()` of an update, delete, or insert so a test can land
   * another writer while that write is in flight. The hook runs once, before the delayed statement
   * executes.
   */
  function databasePausingFirstReturning(beforeReturn: () => Promise<void>): DatabaseClient {
    let armed = true;
    const gate = async () => {
      if (!armed) return;
      armed = false;
      await beforeReturn();
    };
    const wrap = (builder: unknown): unknown =>
      new Proxy(builder as object, {
        get(target, property, receiver) {
          if (property === "returning") {
            return async (...args: unknown[]) => {
              await gate();
              return (target as { returning: (...input: unknown[]) => unknown }).returning(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? (...args: unknown[]) => wrap(value.apply(target, args)) : value;
        },
      });
    const executor = (database: DatabaseClient | DatabaseTransaction): DatabaseClient | DatabaseTransaction =>
      new Proxy(database, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property === "transaction")
            return (run: (transaction: DatabaseTransaction) => Promise<unknown>, options: unknown) =>
              Reflect.apply(value, target, [
                (transaction: DatabaseTransaction) => run(executor(transaction) as DatabaseTransaction),
                options,
              ]);
          if (property === "update" || property === "delete" || property === "insert")
            return (...args: unknown[]) => wrap(Reflect.apply(value, target, args));
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return executor(database) as DatabaseClient;
  }

  /** Fails the real admission transaction at its row insert so compensation sees a rollback. */
  function failingInsertDatabase(): DatabaseClient {
    return new Proxy(database, {
      get(target, property) {
        if (property === "transaction") {
          return (run: (transaction: DatabaseTransaction) => Promise<unknown>) =>
            target.transaction((transaction) =>
              run(
                new Proxy(transaction, {
                  get(executor, method) {
                    if (method === "insert")
                      return (table: Parameters<DatabaseTransaction["insert"]>[0]) => {
                        if (table === agentSkills)
                          return {
                            values: () => ({
                              returning: async () => {
                                throw new Error("forced Skill row write failure");
                              },
                            }),
                          };
                        return executor.insert(table);
                      };
                    const value = Reflect.get(executor, method);
                    return typeof value === "function" ? value.bind(executor) : value;
                  },
                }),
              ),
            );
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Loses the acknowledgement after the actual admission transaction has committed. */
  function committingThenThrowingInsertDatabase(): DatabaseClient {
    return new Proxy(database, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "transaction")
          return async (run: (transaction: DatabaseTransaction) => Promise<unknown>, options: unknown) => {
            let inserted = false;
            const result = await Reflect.apply(value, target, [
              (transaction: DatabaseTransaction) =>
                run(
                  new Proxy(transaction, {
                    get(executor, method) {
                      const operation = Reflect.get(executor, method);
                      if (method === "insert")
                        return (table: Parameters<DatabaseTransaction["insert"]>[0]) => {
                          if (table === agentSkills) inserted = true;
                          return executor.insert(table);
                        };
                      return typeof operation === "function" ? operation.bind(executor) : operation;
                    },
                  }),
                ),
              options,
            ]);
            if (inserted) throw new Error("forced insert commit-then-throw");
            return result;
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Wraps the client so a Skill row update fails, exercising the replace compensation path. */
  function failingUpdateDatabase(): DatabaseClient {
    const wrap = (executor: DatabaseClient | DatabaseTransaction): DatabaseClient | DatabaseTransaction =>
      new Proxy(executor, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property === "transaction")
            return (run: (transaction: DatabaseTransaction) => Promise<unknown>, options: unknown) =>
              Reflect.apply(value, target, [
                (transaction: DatabaseTransaction) => run(wrap(transaction) as DatabaseTransaction),
                options,
              ]);
          if (property === "update")
            return (table: Parameters<DatabaseTransaction["update"]>[0]) =>
              table === agentSkills
                ? {
                    set: () => ({
                      where: () => ({
                        returning: async () => {
                          throw new Error("forced Skill row update failure");
                        },
                      }),
                    }),
                  }
                : target.update(table);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    return wrap(database) as DatabaseClient;
  }

  function capturingLogger(): { logger: ServiceLogger; warns: Array<Record<string, unknown>> } {
    const warns: Array<Record<string, unknown>> = [];
    return {
      warns,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (bindings: Record<string, unknown>) => warns.push(bindings),
        error: () => undefined,
      },
    };
  }

  return {
    proofs,
    runtimeSource,
    runtimeProof,
    database,
    sha256,
    createUser,
    createComputer,
    createAgent,
    archive,
    upload,
    serviceWith,
    objectKeyOf,
    bumpRevision,
    databasePausingFirstReturning,
    failingInsertDatabase,
    committingThenThrowingInsertDatabase,
    failingUpdateDatabase,
    capturingLogger,
  };
}
