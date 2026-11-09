/**
 * The closure flag must equal `descendant.ended_at is null` after every lifecycle path, because the
 * internal-Session page trusts it to exclude ended children from the partial activity index.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../../../admin/bootstrap.js";
import { computers, imBindings, sessionDescendants, sessions } from "../../../db/schema/index.js";
import { AgentService } from "../../agents/index.js";
import { disableImBindingInTransaction } from "../../im-bindings/disable-im-binding.js";
import { SessionService } from "../session-service.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");

let db: UnitDatabase;

beforeAll(async () => {
  db = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
});

/** Rows whose flag disagrees with the descendant's `ended_at`. The invariant is a count of zero. */
async function closureDivergence(): Promise<number> {
  const result = await db.engine.query<{ divergent: number }>(`
    select count(*)::int as divergent
    from session_descendants link
    inner join sessions child on child.id = link.descendant_session_id
    where link.descendant_active is distinct from (child.ended_at is null)
  `);
  return result.rows[0]?.divergent ?? -1;
}

async function seed() {
  const bootstrap = await bootstrapTestAccount(db.database, { displayName: "Admin", email: "admin@example.com" }, NOW);
  const installationId = randomUUID();
  const connectionInstanceId = randomUUID();
  const [computer] = await db.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: installationId,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "1",
      currentInstanceId: connectionInstanceId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: computers.id });
  if (!computer) throw new Error("Computer fixture missing");
  const agent = await new AgentService(db.database, { now: () => NOW }).createForAccount(bootstrap.userId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const [binding] = await db.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: "app",
      externalBotId: "bot",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "test",
      activatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .returning({ id: imBindings.id });
  if (!binding) throw new Error("IM binding fixture missing");
  const service = new SessionService(db.database, { now: () => NOW });
  const root = await service.ensureChatSession(
    { imBindingId: binding.id, channelId: "C1", conversationKind: "dm" },
    "channel",
  );
  const createChild = (creatorSessionId: string) =>
    service.createInternalSessionWithMessage({
      creatorSessionId,
      creatorInstallationId: installationId,
      creatorConnectionInstanceId: connectionInstanceId,
      creatorComputerId: computer.id,
      creatorPlacementGeneration: 1,
      messageId: randomUUID(),
      initialMessage: `work-${randomUUID()}`,
    });
  const first = await createChild(root.session.id);
  const second = await createChild(root.session.id);
  const grandchild = await createChild(first.session.id);
  return { service, root, first, second, grandchild, bindingId: binding.id };
}

describe("Session descendant activity closure", () => {
  it("marks every created descendant active and pages them", async () => {
    const fixture = await seed();
    const rows = await db.database.select().from(sessionDescendants);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.descendantActive)).toBe(true);
    expect(await closureDivergence()).toBe(0);

    const page = await fixture.service.listInternalSessions(fixture.root.session.id, { recursive: true, limit: 20 });
    expect(page.items.map((item) => item.sessionId).sort()).toEqual(
      [fixture.first.session.id, fixture.second.session.id, fixture.grandchild.session.id].sort(),
    );
  });

  it("removes descendants from the page in the transaction that disables the binding", async () => {
    const fixture = await seed();
    await db.database.transaction((transaction) => disableImBindingInTransaction(transaction, fixture.bindingId, NOW));

    const ended = await db.database.select().from(sessions).where(eq(sessions.endedAt, NOW));
    expect(ended).toHaveLength(4);
    const rows = await db.database.select().from(sessionDescendants);
    expect(rows.every((row) => row.descendantActive)).toBe(false);
    expect(await closureDivergence()).toBe(0);
    expect(await fixture.service.listInternalSessions(fixture.root.session.id, { recursive: true, limit: 20 })).toEqual(
      {
        items: [],
      },
    );
  });

  it("keeps a repeated disable idempotent and never reactivates an ended descendant", async () => {
    const fixture = await seed();
    await db.database.transaction((transaction) => disableImBindingInTransaction(transaction, fixture.bindingId, NOW));
    // The second disable matches no binding row, so it must not touch the closure at all.
    await db.database.transaction((transaction) =>
      disableImBindingInTransaction(transaction, fixture.bindingId, new Date(NOW.getTime() + 1_000)),
    );
    expect((await db.database.select().from(sessionDescendants)).every((row) => !row.descendantActive)).toBe(true);
    expect(await closureDivergence()).toBe(0);
  });
});
