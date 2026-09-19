import { createHash, randomUUID } from "node:crypto";
import type { SkillSource } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agentSkills, agents, computers, users } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
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

export function createSkillHarness(unit: UnitDatabase): SkillHarness {
  const database = unit.database;

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
    return new SkillService({ database, ...(store ? { store } : {}), keyPrefix: "skills" });
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
    return new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if ((property === "update" || property === "delete" || property === "insert") && typeof value === "function") {
          return (...args: unknown[]) => wrap(value.apply(target, args));
        }
        return value;
      },
    }) as DatabaseClient;
  }

  /** Wraps the client so a Skill row insert fails, exercising the object-cleanup compensation path. */
  function failingInsertDatabase(): DatabaseClient {
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            if (table === agentSkills) {
              return {
                values: () => ({
                  returning: async () => {
                    throw new Error("forced Skill row write failure");
                  },
                }),
              };
            }
            const insert = Reflect.get(target, "insert", receiver) as (value: unknown) => unknown;
            return insert.call(target, table);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /**
   * Wraps the client so a Skill row insert commits and then throws, modelling a dropped connection
   * that returns no result even though the row landed.
   */
  function committingThenThrowingInsertDatabase(): DatabaseClient {
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            if (table === agentSkills) {
              const insert = Reflect.get(target, "insert", receiver) as (value: unknown) => {
                values: (input: unknown) => { returning: () => Promise<unknown> };
              };
              const builder = insert.call(target, table);
              return {
                values: (input: unknown) => ({
                  returning: async () => {
                    await builder.values(input).returning();
                    throw new Error("forced insert commit-then-throw");
                  },
                }),
              };
            }
            const insert = Reflect.get(target, "insert", receiver) as (value: unknown) => unknown;
            return insert.call(target, table);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /** Wraps the client so a Skill row update fails, exercising the replace compensation path. */
  function failingUpdateDatabase(): DatabaseClient {
    return new Proxy(database, {
      get(target, property, receiver) {
        if (property === "update") {
          return (table: unknown) => {
            if (table === agentSkills) {
              return {
                set: () => ({
                  where: () => ({
                    returning: async () => {
                      throw new Error("forced Skill row update failure");
                    },
                  }),
                }),
              };
            }
            const update = Reflect.get(target, "update", receiver) as (value: unknown) => unknown;
            return update.call(target, table);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
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
