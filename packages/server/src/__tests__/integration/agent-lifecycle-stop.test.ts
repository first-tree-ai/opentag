import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type SessionReconcileRequest, type SessionReconcileResult } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents as agentRows,
  computers,
  imBindings,
  sessionCliProofs,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { stopAgentSessions } from "../../runtime/agent-session-stopper.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ProviderCliReconcileOwner } from "../../runtime/provider-cli-reconcile-owner.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner, RuntimeDomainRequestError } from "../../runtime/runtime-domain-owner.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { SessionCliProofService } from "../../services/sessions/session-cli-proof-service.js";
import { deferred } from "../support/deferred.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
const domains: RuntimeDomainOwner[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => {
  await pg.reset();
});
afterEach(async () => {
  await Promise.all(domains.splice(0).map((domain) => domain.close()));
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.sql.end()));
});
afterAll(async () => {
  await pg?.stop();
});
async function fixture(
  onSend?: (frame: { type: string }, done: () => void) => void,
  options: { poolMax?: number; requestTimeoutMs?: number; afterPrepare?: () => Promise<void> } = {},
) {
  const client = createDatabaseClient(pg.databaseUrl, { max: options.poolMax ?? 1 });
  clients.push(client);
  const [account] = await client.database
    .insert(users)
    .values({ email: "lifecycle@example.test", displayName: "Lifecycle" })
    .returning();
  assert(account);
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: account.id,
      currentInstanceId: randomUUID(),
      currentInstallationId: randomUUID(),
      displayName: "Lifecycle",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.1.2",
    })
    .returning();
  assert(computer?.currentInstallationId && computer.currentInstanceId);
  const agents = new AgentService(client.database);
  const agent = await agents.createForAccount(account.id, {
    name: "lifecycle",
    displayName: "Lifecycle",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const [binding] = await client.database
    .insert(imBindings)
    .values({
      agentId: agent.id,
      provider: "feishu",
      status: "active",
      externalAppId: randomUUID(),
      externalBotId: "fixture",
      credentialSchemaVersion: 1,
      credentialGeneration: 1,
      encryptedCredential: "fixture",
      activatedAt: new Date(),
    })
    .returning();
  assert(binding);
  const [session] = await client.database
    .insert(sessions)
    .values({ imBindingId: binding.id, channelId: "C", conversationKind: "channel", kind: "channel" })
    .returning();
  assert(session);
  await client.database
    .insert(sessionPlacements)
    .values({ sessionId: session.id, computerId: computer.id, generation: 1 });
  const registry = new ConnectionRegistry(),
    frames: SessionReconcileRequest[] = [],
    sent = deferred();
  const socket = {
    readyState: WebSocket.OPEN,
    send: (text: string, callback?: () => void) => {
      const frame = JSON.parse(text) as { type: string };
      if (frame.type === "session:reconcile") {
        frames.push(frame as SessionReconcileRequest);
        sent.resolve();
      }
      if (onSend) onSend(frame, () => callback?.());
      else callback?.();
    },
  } as unknown as WebSocket;
  await registry.register(
    {
      computerId: computer.id,
      installationId: computer.currentInstallationId,
      instanceId: computer.currentInstanceId,
      lastHeartbeatAt: Date.now(),
      socket,
      active: true,
      negotiatedCapabilities: {
        [RUNTIME_CAPABILITY.sessionCollaboration]: 1,
        [RUNTIME_CAPABILITY.providerCliReconcile]: 1,
      },
    },
    async () => undefined,
  );
  const proofs = new SessionCliProofService(client.database, registry, randomBytes(32));
  const mint = () =>
    proofs.mint({
      sessionId: session.id,
      computerId: computer.id,
      placementGeneration: 1,
      connectionInstanceId: computer.currentInstanceId as string,
    });
  await mint();
  const preparation = { started: 0, active: 0, peak: 0 };
  const domain = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(client.database), {
    requestTimeoutMs: options.requestTimeoutMs ?? 2000,
    prepareReconcile: async (...args) => {
      preparation.started++;
      preparation.active++;
      preparation.peak = Math.max(preparation.peak, preparation.active);
      try {
        const prepared = await proofs.prepareReconcile(...args);
        await options.afterPrepare?.();
        return prepared;
      } finally {
        preparation.active--;
      }
    },
  });
  domains.push(domain);
  const dependencies = {
    currentInstanceId: (id: string) => registry.currentInstanceId(id),
    requestReconcile: domain.requestReconcile.bind(domain),
  };
  const respond = async (frame = frames.at(-1)) => {
    assert(frame);
    const result: SessionReconcileResult = {
      type: "session:reconcile:result",
      requestId: frame.requestId,
      sessionId: frame.sessionId,
      placementGeneration: frame.placementGeneration,
      status: "stopped",
    };
    await domain.businessOptions().handle(result, {
      computerId: computer.id,
      instanceId: computer.currentInstanceId as string,
      installationId: computer.currentInstallationId as string,
      signal: new AbortController().signal,
    });
  };
  return {
    client,
    account,
    computer,
    agent,
    agents,
    binding,
    session,
    registry,
    proofs,
    mint,
    domain,
    preparation,
    dependencies,
    respond,
    sent,
    frames,
  };
}

it.each(["reactivate", "second suspension", "delete"])(
  "skips an old suspend callback after %s without a stop frame",
  async (change) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    const service = new AgentService(f.client.database, {
      onProviderCliPlacementChanged: async () => {
        entered.resolve();
        await release.promise;
      },
      stopSessions: (targets) => stopAgentSessions(f.client.database, targets, f.dependencies),
    });
    const stopping = service.suspendById(f.account.id, f.agent.id);
    try {
      await entered.promise;
      await f.agents.reactivateById(f.account.id, f.agent.id);
      const proof = await f.mint();
      if (change !== "reactivate") await f.agents.suspendById(f.account.id, f.agent.id);
      if (change === "delete") await f.agents.deleteById(f.account.id, f.agent.id);
      release.resolve();
      await stopping;
      expect(f.frames).toHaveLength(0);
      if (change === "reactivate")
        await expect(f.proofs.authenticate(proof.token)).resolves.toMatchObject({ agentId: f.agent.id });
    } finally {
      release.resolve();
      await stopping;
    }
  },
);

it("releases final admission before a stopped result and preserves a later reused proof", async () => {
  const f = await fixture();
  const service = new AgentService(f.client.database, {
    stopSessions: (targets) => stopAgentSessions(f.client.database, targets, f.dependencies),
  });
  const stopping = service.suspendById(f.account.id, f.agent.id);
  await f.sent.promise;
  await f.agents.reactivateById(f.account.id, f.agent.id);
  const proof = await f.mint();
  await expect(f.client.sql`select 1 as healthy`).resolves.toHaveLength(1);
  await f.respond();
  await stopping;
  expect(f.frames).toHaveLength(1);
  await expect(f.proofs.authenticate(proof.token)).resolves.toMatchObject({ agentId: f.agent.id });
});

it.each(["Agent", "placement"])("rechecks %s authority after an actual final admission lock wait", async (change) => {
  const prepared = deferred(),
    admit = deferred(),
    locked = deferred(),
    release = deferred();
  const f = await fixture(undefined, {
    afterPrepare: async () => {
      prepared.resolve();
      await admit.promise;
    },
  });
  const holder = anotherClient(),
    observer = anotherClient();
  const diagnostics: string[] = [];
  const stopping = stoppingService(f, diagnostics).suspendById(f.account.id, f.agent.id);
  await prepared.promise;
  const holding = holder.sql.begin(async (sql) => {
    if (change === "Agent") await sql`update agents set status='active', revision=revision+1 where id=${f.agent.id}`;
    else await sql`update session_placements set generation=generation+1 where session_id=${f.session.id}`;
    locked.resolve();
    await release.promise;
  });
  try {
    await locked.promise;
    admit.resolve();
    await blockedOn(observer, change === "Agent" ? "agents" : "session_placements");
    expect(f.frames).toHaveLength(0);
    release.resolve();
    await holding;
    await stopping;
    expect(f.frames).toHaveLength(0);
    expect(diagnostics).toEqual([]);
    expect(await observer.database.select().from(sessionCliProofs)).toHaveLength(1);
    expect(await f.client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
  } finally {
    admit.resolve();
    release.resolve();
    await holding;
    await stopping;
  }
});

it.each([false, true])("preserves a newer proof after cleanup waits on placement, replacement=%s", async (replace) => {
  const f = await fixture();
  const holder = anotherClient(),
    observer = anotherClient(),
    locked = deferred(),
    release = deferred();
  const diagnostics: string[] = [];
  const stopping = stoppingService(f, diagnostics).suspendById(f.account.id, f.agent.id);
  await f.sent.promise;
  const holding = holder.sql.begin(async (sql) => {
    await sql`select session_id from session_placements where session_id=${f.session.id} for update`;
    await sql`update session_cli_proofs set updated_at=updated_at + interval '1 second',
      proof_id=case when ${replace} then ${randomUUID()}::uuid else proof_id end where session_id=${f.session.id}`;
    locked.resolve();
    await release.promise;
  });
  let result: Promise<void> | undefined;
  try {
    await locked.promise;
    result = f.respond();
    await blockedOn(observer, "session_placements");
    release.resolve();
    await holding;
    await result;
    await stopping;
    expect(diagnostics).toEqual([]);
    expect(await observer.database.select().from(sessionCliProofs)).toHaveLength(1);
    await healthyAfterStop(f);
  } finally {
    release.resolve();
    await holding;
    await result;
    await stopping;
  }
});

it("finishes a confirmed stop while provider cancel and socket callbacks remain pending", async () => {
  const release = deferred(),
    cancelSent = deferred();
  let respond: (() => Promise<void>) | undefined;
  const f = await fixture((frame, done) => {
    if (frame.type === "provider-cli:cancel") {
      cancelSent.resolve();
      void release.promise.then(done);
    } else if (frame.type === "session:reconcile") {
      void release.promise.then(done);
      queueMicrotask(() => {
        void respond?.();
      });
    } else done();
  });
  respond = f.respond;
  const owner = new ProviderCliReconcileOwner(f.registry, {
    listActiveProviderCliRequirements: async () => [
      {
        agentId: f.agent.id,
        integrationId: randomUUID(),
        provider: "slack",
        credentialGeneration: 1,
        expectedIdentity: { provider: "slack", teamId: "T", botUserId: "U", botId: "B" },
      },
    ],
    issueIntegrationCliValidationGrant: async () => undefined,
  });
  await owner.onActiveBindingChanged({ agentId: f.agent.id, computerId: f.computer.id });
  const service = new AgentService(f.client.database, {
    onProviderCliPlacementChanged: (input) => owner.onAgentPlacementChanged(input),
    stopSessions: (targets) => stopAgentSessions(f.client.database, targets, f.dependencies),
  });
  try {
    const stopping = service.suspendById(f.account.id, f.agent.id);
    await cancelSent.promise;
    expect((await stopping).status).toBe("suspended");
    expect(f.frames).toHaveLength(1);
    expect(
      await f.client.database.select().from(sessionCliProofs).where(eq(sessionCliProofs.sessionId, f.session.id)),
    ).toHaveLength(0);
    await expect(f.client.sql`select 1 as healthy`).resolves.toHaveLength(1);
  } finally {
    release.resolve();
    owner.close();
  }
});

it.each([
  { count: 64, poolMax: 1 },
  { count: 1024, poolMax: 1 },
  { count: 4096, poolMax: 1 },
  { count: 4096, poolMax: 20 },
])(
  "stops all $count Sessions with bounded preparation in a max-$poolMax pool",
  async ({ count, poolMax }) => {
    let respond: Awaited<ReturnType<typeof fixture>>["respond"] | undefined;
    const errors: unknown[] = [];
    const f = await fixture(
      (frame, done) => {
        done();
        if (frame.type === "session:reconcile")
          queueMicrotask(() => {
            void respond?.(frame as SessionReconcileRequest).catch((error) => errors.push(error));
          });
      },
      { poolMax, requestTimeoutMs: 30000 },
    );
    respond = f.respond;
    await populateSessions(f, count);
    const diagnostics: string[] = [];
    const service = stoppingService(f, diagnostics);
    let queries = 0;
    const debug = f.client.sql.options.debug;
    f.client.sql.options.debug = () => {
      queries++;
    };
    const start = performance.now();
    try {
      const stopping = service.suspendById(f.account.id, f.agent.id);
      await f.sent.promise;
      const controlAt = performance.now();
      const control = f.client.sql`select 1 as healthy`.then((rows) => ({ rows, ms: performance.now() - controlAt }));
      expect((await stopping).status).toBe("suspended");
      const elapsedMs = performance.now() - start;
      const stopQueries = queries;
      expect((await control).rows).toEqual([{ healthy: 1 }]);
      await f.domain.close();
      const remainingProofs = await f.client.database.select().from(sessionCliProofs);
      console.log(
        "LC_STOP_DISPATCH",
        JSON.stringify({
          count,
          poolMax,
          elapsedMs,
          sqlCount: stopQueries,
          peakPreparation: f.preparation.peak,
          stopped: f.frames.length,
          remainingProofs: remainingProofs.length,
          diagnostics,
          samePoolControlMs: (await control).ms,
        }),
      );
      expect(errors).toEqual([]);
      expect(diagnostics).toEqual([]);
      expect(f.frames).toHaveLength(count);
      expect(f.preparation).toMatchObject({ started: count, active: 0, peak: 16 });
      expect(stopQueries).toBeLessThanOrEqual(count * 5 + 32);
      expect(remainingProofs).toHaveLength(0);
      await healthyAfterStop(f);
    } finally {
      f.client.sql.options.debug = debug;
    }
  },
  60000,
);

it.each([0, 1])(
  "stops admitting on capacity with %i free domain slots and joins admitted results",
  async (vacancies) => {
    const f = await fixture(undefined, { poolMax: 20, requestTimeoutMs: 30000 });
    const count = 4096;
    await populateSessions(f, count);
    const held: Promise<unknown>[] = [];
    for (let index = 0; index < 1024 - vacancies; index++) {
      held.push(
        f.domain
          .requestReconcile(f.computer.id, f.computer.currentInstanceId as string, {
            type: "session:reconcile",
            requestId: randomUUID(),
            installationId: f.computer.currentInstallationId as string,
            sessionId: f.session.id,
            agentId: f.agent.id,
            placementGeneration: 1,
            desired: "stopped",
          })
          .catch((error) => error),
      );
    }
    await expect.poll(() => f.frames.length, { timeout: 10000 }).toBe(1024 - vacancies);
    f.preparation.started = f.preparation.peak = 0;
    let capacity = 0;
    const requestReconcile = f.dependencies.requestReconcile;
    f.dependencies.requestReconcile = (...args) =>
      requestReconcile(...args).catch((error) => {
        if (error instanceof RuntimeDomainRequestError && error.code === "capacity") capacity++;
        throw error;
      });
    const budget = dispatchBudget();
    const diagnostics: string[] = [];
    let finished = false;
    const start = performance.now();
    const stopping = stoppingService(f, diagnostics)
      .suspendById(f.account.id, f.agent.id)
      .finally(() => {
        finished = true;
      });
    try {
      if (vacancies === 1) {
        await expect.poll(() => f.frames.length, { timeout: 10000 }).toBe(1024);
        await expect.poll(() => capacity, { timeout: 10000 }).toBe(15);
        expect(finished).toBe(false);
        expect(budget.signal.aborted).toBe(false);
        await f.respond();
      }
      expect((await stopping).status).toBe("suspended");
      expect(f.frames).toHaveLength(1024);
      expect(f.preparation).toMatchObject({ started: 16, active: 0, peak: 16 });
      expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
      expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(count - vacancies);
      await f.domain.close();
      await Promise.all(held);
      await healthyAfterStop(f);
      console.log(
        "LC_R1_CAPACITY",
        JSON.stringify({
          count,
          vacancies,
          elapsedMs: performance.now() - start,
          preparations: f.preparation.started,
          stopped: vacancies,
          remainingProofs: count - vacancies,
        }),
      );
    } finally {
      await f.domain.close();
      await stopping;
      await Promise.all(held);
    }
  },
  60000,
);

it("joins the actual blocked proof read after cutoff without starting final authority SQL", async () => {
  const f = await fixture();
  const holder = anotherClient(),
    observer = anotherClient();
  const locked = deferred(),
    release = deferred();
  const holding = holder.sql.begin(async (sql) => {
    await sql`lock table session_cli_proofs in access exclusive mode`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const budget = dispatchBudget();
  const diagnostics: string[] = [];
  let finished = false,
    authorityReads = 0;
  const debug = f.client.sql.options.debug;
  f.client.sql.options.debug = (_id, query) => {
    if (query.includes('"agents"."revision" =') && query.includes('"agents"."status" <>')) authorityReads++;
  };
  const stopping = stoppingService(f, diagnostics)
    .suspendById(f.account.id, f.agent.id)
    .finally(() => {
      finished = true;
    });
  try {
    await blockedOn(observer, "session_cli_proofs");
    budget.abort();
    expect(await observer.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    expect(finished).toBe(false);
    release.resolve();
    await holding;
    expect((await stopping).status).toBe("suspended");
    expect(authorityReads).toBe(0);
    expect(f.frames).toHaveLength(0);
    expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
    expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(1);
    await healthyAfterStop(f);
  } finally {
    release.resolve();
    await holding;
    await stopping;
    f.client.sql.options.debug = debug;
  }
});

it("fences the send when an actual Agent lock wait crosses cutoff", async () => {
  const prepared = deferred(),
    admit = deferred(),
    locked = deferred(),
    release = deferred();
  const f = await fixture(undefined, {
    afterPrepare: async () => {
      prepared.resolve();
      await admit.promise;
    },
  });
  const holder = anotherClient(),
    observer = anotherClient();
  const budget = dispatchBudget();
  const diagnostics: string[] = [];
  let finished = false;
  const stopping = stoppingService(f, diagnostics)
    .suspendById(f.account.id, f.agent.id)
    .finally(() => {
      finished = true;
    });
  await prepared.promise;
  const holding = holder.sql.begin(async (sql) => {
    await sql`select id from agents where id=${f.agent.id} for no key update`;
    locked.resolve();
    await release.promise;
  });
  try {
    await locked.promise;
    admit.resolve();
    await blockedOn(observer, "agents");
    budget.abort();
    expect(await observer.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    expect(finished).toBe(false);
    release.resolve();
    await holding;
    expect((await stopping).status).toBe("suspended");
    expect(f.frames).toHaveLength(0);
    expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
    expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(1);
    await healthyAfterStop(f);
  } finally {
    admit.resolve();
    release.resolve();
    await holding;
    await stopping;
  }
});

it("joins confirmed stop proof cleanup after cutoff while its actual placement SQL is blocked", async () => {
  const f = await fixture();
  const holder = anotherClient(),
    observer = anotherClient();
  const budget = dispatchBudget(),
    locked = deferred(),
    release = deferred();
  const diagnostics: string[] = [];
  let finished = false;
  const stopping = stoppingService(f, diagnostics)
    .suspendById(f.account.id, f.agent.id)
    .finally(() => {
      finished = true;
    });
  await f.sent.promise;
  const holding = holder.sql.begin(async (sql) => {
    await sql`select session_id from session_placements where session_id=${f.session.id} for update`;
    locked.resolve();
    await release.promise;
  });
  let result: Promise<void> | undefined;
  try {
    await locked.promise;
    budget.abort();
    result = f.respond();
    await blockedOn(observer, "session_placements");
    expect(finished).toBe(false);
    expect(await observer.database.select().from(sessionCliProofs)).toHaveLength(1);
    release.resolve();
    await holding;
    await result;
    expect((await stopping).status).toBe("suspended");
    expect(diagnostics).toEqual([]);
    expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(0);
    await healthyAfterStop(f);
  } finally {
    release.resolve();
    await holding;
    await result;
    await stopping;
  }
});

it("uses one real 30-second dispatch budget for unresponsive Sessions without starting another wave", async () => {
  const f = await fixture(undefined, { requestTimeoutMs: 30000 });
  await populateSessions(f, 64);
  const diagnostics: string[] = [];
  const start = performance.now();
  const stopping = stoppingService(f, diagnostics).suspendById(f.account.id, f.agent.id);
  await expect.poll(() => f.frames.length, { timeout: 10000 }).toBe(16);
  expect(await f.client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
  expect((await stopping).status).toBe("suspended");
  const elapsedMs = performance.now() - start;
  expect(elapsedMs).toBeGreaterThanOrEqual(29000);
  expect(elapsedMs).toBeLessThan(45000);
  expect(f.frames).toHaveLength(16);
  expect(f.preparation).toMatchObject({ started: 16, active: 0, peak: 16 });
  expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
  expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(64);
  await healthyAfterStop(f);
  console.log("LC_R1_TIMEOUT", JSON.stringify({ elapsedMs, preparations: 16, stopFrames: 16, remainingProofs: 64 }));
}, 60000);

it("joins owner shutdown and rejects late results without more preparation or SQL", async () => {
  const f = await fixture();
  await populateSessions(f, 64);
  const diagnostics: string[] = [];
  const stopping = stoppingService(f, diagnostics).suspendById(f.account.id, f.agent.id);
  try {
    await expect.poll(() => f.frames.length, { timeout: 10000 }).toBe(16);
    const closing = f.domain.close();
    expect((await stopping).status).toBe("suspended");
    await closing;
    expect(f.preparation).toMatchObject({ started: 16, active: 0, peak: 16 });
    expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
    let queries = 0;
    const debug = f.client.sql.options.debug;
    f.client.sql.options.debug = () => {
      queries++;
    };
    try {
      await f.respond();
      expect(queries).toBe(0);
    } finally {
      f.client.sql.options.debug = debug;
    }
    expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(64);
    await healthyAfterStop(f);
  } finally {
    await f.domain.close();
    await stopping;
  }
});

it("retains proof SQL beyond the original request timeout until owner close drains it", async () => {
  const f = await fixture(undefined, { requestTimeoutMs: 500 });
  const holder = anotherClient(),
    observer = anotherClient();
  const budget = dispatchBudget(),
    locked = deferred(),
    release = deferred();
  const diagnostics: string[] = [];
  const stopping = stoppingService(f, diagnostics).suspendById(f.account.id, f.agent.id);
  await f.sent.promise;
  const holding = holder.sql.begin(async (sql) => {
    await sql`select session_id from session_placements where session_id=${f.session.id} for update`;
    locked.resolve();
    await release.promise;
  });
  let result: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  try {
    await locked.promise;
    budget.abort();
    result = f.respond();
    await blockedOn(observer, "session_placements");
    expect((await stopping).status).toBe("suspended");
    expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
    closing = f.domain.close().then(() => {
      closed = true;
    });
    expect(await observer.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    expect(closed).toBe(false);
    expect(await observer.database.select().from(sessionCliProofs)).toHaveLength(1);
    release.resolve();
    await holding;
    await result;
    await closing;
    expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(0);
    await healthyAfterStop(f);
  } finally {
    release.resolve();
    await holding;
    await result;
    await closing;
    await stopping;
  }
});

it("keeps a shared 20-slot pool usable while all 16 admitted proof reads are blocked", async () => {
  const f = await fixture(undefined, { poolMax: 20 });
  await populateSessions(f, 64);
  const holder = anotherClient(),
    observer = anotherClient();
  const locked = deferred(),
    release = deferred();
  const holding = holder.sql.begin(async (sql) => {
    await sql`lock table session_cli_proofs in access exclusive mode`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const budget = dispatchBudget(),
    diagnostics: string[] = [];
  let finished = false,
    controlResult: unknown,
    controlMs = 0;
  let control: Promise<void> | undefined;
  const stopping = stoppingService(f, diagnostics)
    .suspendById(f.account.id, f.agent.id)
    .finally(() => {
      finished = true;
    });
  try {
    await expect
      .poll(
        async () => {
          const [row] =
            await observer.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from "session_cli_proofs"%'`;
          return row?.n;
        },
        { timeout: 5000 },
      )
      .toBe(16);
    const controlAt = performance.now();
    control = f.client.sql`select 1 as healthy`.then(
      (rows) => {
        controlResult = rows;
        controlMs = performance.now() - controlAt;
      },
      (error) => {
        controlResult = error;
      },
    );
    await expect.poll(() => controlResult, { timeout: 5000 }).toEqual([{ healthy: 1 }]);
    budget.abort();
    expect(await observer.sql`select 2 as healthy`).toEqual([{ healthy: 2 }]);
    expect(finished).toBe(false);
    expect(f.preparation).toMatchObject({ started: 16, active: 16, peak: 16 });
    release.resolve();
    await holding;
    expect((await stopping).status).toBe("suspended");
    expect(f.frames).toHaveLength(0);
    expect(diagnostics).toEqual(["AGENT_SESSION_STOP_FAILED"]);
    expect(await f.client.database.select().from(sessionCliProofs)).toHaveLength(64);
    await healthyAfterStop(f);
    console.log(
      "LC_R1_POOL_FAULT",
      JSON.stringify({ poolMax: 20, blockedProofReads: 16, controlMs, preparations: 16, remainingProofs: 64 }),
    );
  } finally {
    release.resolve();
    await holding;
    await stopping;
    await control;
  }
}, 15000);

type StopFixture = Awaited<ReturnType<typeof fixture>>;
function anotherClient() {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(client);
  return client;
}
function dispatchBudget() {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
  return controller;
}
function stoppingService(f: StopFixture, diagnostics: string[]) {
  return new AgentService(f.client.database, {
    onDiagnostic: (code) => diagnostics.push(code),
    stopSessions: (targets) => stopAgentSessions(f.client.database, targets, f.dependencies),
  });
}
async function populateSessions(f: StopFixture, count: number) {
  const added = await f.client.database
    .insert(sessions)
    .values(
      Array.from({ length: count - 1 }, (_, index) => ({
        imBindingId: f.binding.id,
        channelId: `channel-${index}`,
        conversationKind: "channel" as const,
        kind: "channel" as const,
      })),
    )
    .returning({ id: sessions.id });
  await f.client.database
    .insert(sessionPlacements)
    .values(added.map(({ id }) => ({ sessionId: id, computerId: f.computer.id, generation: 1 })));
  await f.client.database.insert(sessionCliProofs).values(
    added.map(({ id }) => ({
      sessionId: id,
      proofId: randomUUID(),
      tokenHash: randomBytes(32).toString("hex"),
      computerId: f.computer.id,
      placementGeneration: 1,
      connectionInstanceId: f.computer.currentInstanceId as string,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
}
async function blockedOn(observer: ReturnType<typeof createDatabaseClient>, table: string) {
  await expect
    .poll(
      async () => {
        const [row] =
          await observer.sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like ${`%${table}%`}) as blocked`;
        return row?.blocked;
      },
      { timeout: 5000 },
    )
    .toBe(true);
}
async function healthyAfterStop(f: StopFixture) {
  const [agent] = await f.client.database
    .select({ status: agentRows.status })
    .from(agentRows)
    .where(eq(agentRows.id, f.agent.id));
  expect(agent?.status).toBe("suspended");
  const storedSessions = await f.client.database
    .select({ endedAt: sessions.endedAt })
    .from(sessions)
    .where(eq(sessions.imBindingId, f.binding.id));
  expect(storedSessions.every((session) => session.endedAt === null)).toBe(true);
  expect(await f.client.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
  const [row] = await f.client
    .sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'`;
  expect(row?.n).toBe(0);
}
