import { randomUUID } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createRunnerImagePrewarmCoordinator,
  type RunnerImagePrewarmLeadership,
} from "../../services/cloud-run/runner-image-prewarm-coordinator.js";
import { startPostgresTestContainer } from "./postgres-test-container.js";

describe("Runner image preparation coordination on PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let admin: ReturnType<typeof postgres>;
  const leaderships: RunnerImagePrewarmLeadership[] = [];

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    admin = postgres(container.getConnectionUri(), { max: 1, connect_timeout: 5, onnotice: () => undefined });
  }, 120_000);
  afterEach(async () => {
    await Promise.all(leaderships.splice(0).map((leadership) => leadership.release()));
  });
  afterAll(async () => {
    await admin?.end({ timeout: 1 });
    await container?.stop();
  });
  async function acquire(key: string) {
    const leadership = await createRunnerImagePrewarmCoordinator(container.getConnectionUri(), key)();
    if (leadership) leaderships.push(leadership);
    return leadership;
  }

  it("elects one replica without waiting and allows takeover when its dedicated session closes", async () => {
    const key = randomUUID();
    const candidates = await Promise.all([acquire(key), acquire(key)]);
    const held = candidates.filter((candidate) => candidate !== undefined);
    expect(held).toHaveLength(1);
    const leader = held[0];
    expect(await leader?.isHeld()).toBe(true);
    expect(await acquire(key)).toBeUndefined();
    await leader?.release();
    const replacement = await acquire(key);
    expect(await replacement?.isHeld()).toBe(true);
  });

  it("keeps independent environment and placement keys independent", async () => {
    const first = await acquire(`staging-${randomUUID()}`);
    const second = await acquire(`prod-${randomUUID()}`);
    expect(await first?.isHeld()).toBe(true);
    expect(await second?.isHeld()).toBe(true);
  });

  it("detects a lost backend session instead of trusting a reconnected session's old success marker", async () => {
    const key = randomUUID();
    const leader = await acquire(key);
    expect(await leader?.isHeld()).toBe(true);
    const terminated = await admin<{ terminated: boolean }[]>`
      select pg_terminate_backend(pid) as terminated from pg_locks
      where locktype = 'advisory' and granted and pid <> pg_backend_pid()
    `;
    expect(terminated.some((row) => row.terminated)).toBe(true);
    await expect.poll(async () => leader?.isHeld().catch(() => false)).toBe(false);
    const replacement = await acquire(key);
    expect(await replacement?.isHeld()).toBe(true);
    expect(await leader?.isHeld()).toBe(false);
  });
});
