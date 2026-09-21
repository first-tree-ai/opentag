import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RuntimeCapabilityStore,
  RuntimeCapabilityStoreCapacityError,
} from "../runtime-credentials/capability-store.js";
import {
  RuntimeExecutionRegistry,
  RuntimeExecutionRegistryCapacityError,
} from "../runtime-credentials/execution-registry.js";
import { RuntimeProxyTicketStore } from "../runtime-credentials/ticket-store.js";
import { RuntimeUrlHandleStore } from "../runtime-credentials/url-handle-store.js";
import { RuntimeValidationRunRegistry } from "../runtime-credentials/validation-runs.js";

function executionInput(overrides: Partial<Parameters<RuntimeExecutionRegistry["open"]>[0]> = {}) {
  return {
    runId: randomUUID(),
    accountId: randomUUID(),
    agentId: randomUUID(),
    agentRevision: 1,
    sessionId: randomUUID(),
    computerId: randomUUID(),
    instanceId: randomUUID(),
    connectionId: randomUUID(),
    placementGeneration: 1,
    source: { kind: "delivery" as const, deliveryId: "d1", turnId: "t1" },
    purpose: "execution" as const,
    computerKind: "local" as const,
    providers: new Map(),
    ...overrides,
  };
}

describe("RuntimeCapabilityStore", () => {
  const issueInput = {
    executionId: randomUUID(),
    provider: "slack" as const,
    bindingId: "b1",
    purpose: "execution" as const,
    scopeHash: "a".repeat(64),
    authorizationRevision: "slack:1:1",
    credentialGeneration: "1:1",
  };

  it("issues 256-bit opaque tokens and keeps only current plus previous per slot", () => {
    const now = 1_000;
    const store = new RuntimeCapabilityStore({ now: () => now });
    const first = store.issue(issueInput);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.lookup(first.token)?.grantId).toBe(first.record.grantId);
    const second = store.issue(issueInput);
    expect(store.lookup(second.token)?.grantId).toBe(second.record.grantId);
    expect(store.lookup(first.token)?.superseded).toBe(true);
    const third = store.issue(issueInput);
    expect(store.lookup(third.token)).toBeDefined();
    expect(store.lookup(second.token)).toBeDefined();
    expect(store.lookup(first.token)).toBeUndefined();
  });

  it("expires capabilities at the 60s TTL with a 30s refresh boundary", () => {
    let now = 1_000;
    const store = new RuntimeCapabilityStore({ now: () => now });
    const { token, record } = store.issue(issueInput);
    expect(record.expiresAt - now).toBe(60_000);
    expect(record.refreshAfter - now).toBe(30_000);
    now += 59_999;
    expect(store.lookup(token)).toBeDefined();
    now += 2;
    expect(store.lookup(token)).toBeUndefined();
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(0);
  });

  it("revokes all grants of an execution and isolates slots across executions", () => {
    const store = new RuntimeCapabilityStore();
    const mine = store.issue(issueInput);
    const other = store.issue({ ...issueInput, executionId: randomUUID() });
    expect(store.revokeExecution(issueInput.executionId)).toBe(1);
    expect(store.lookup(mine.token)).toBeUndefined();
    expect(store.lookup(other.token)).toBeDefined();
  });

  it("bounds total records", () => {
    const store = new RuntimeCapabilityStore({ maxRecords: 1 });
    store.issue(issueInput);
    expect(() => store.issue({ ...issueInput, executionId: randomUUID() })).toThrow(
      RuntimeCapabilityStoreCapacityError,
    );
  });
});

describe("RuntimeProxyTicketStore", () => {
  it("issues single-use 15s tickets and refuses replay", () => {
    const now = 1_000;
    const store = new RuntimeProxyTicketStore({ now: () => now });
    const input = {
      executionId: randomUUID(),
      computerId: randomUUID(),
      instanceId: randomUUID(),
      connectionId: randomUUID(),
    };
    const { ticket, expiresAt } = store.issue(input);
    expect(expiresAt - now).toBe(15_000);
    expect(store.consume(ticket)?.executionId).toBe(input.executionId);
    expect(store.consume(ticket)).toBeUndefined();
  });

  it("rejects expired tickets and revokes by execution", () => {
    let now = 1_000;
    const store = new RuntimeProxyTicketStore({ now: () => now });
    const input = {
      executionId: randomUUID(),
      computerId: randomUUID(),
      instanceId: randomUUID(),
      connectionId: randomUUID(),
    };
    const first = store.issue(input);
    now += 15_001;
    expect(store.consume(first.ticket)).toBeUndefined();
    const second = store.issue(input);
    expect(store.revokeExecution(input.executionId)).toBe(1);
    expect(store.consume(second.ticket)).toBeUndefined();
  });
});

describe("RuntimeExecutionRegistry", () => {
  it("opens, closes, and reports close events with the exact record", () => {
    const registry = new RuntimeExecutionRegistry();
    const events: string[] = [];
    registry.onClose((event) => events.push(`${event.executionId}:${event.code}`));
    const record = registry.open(executionInput());
    expect(registry.get(record.executionId)?.runId).toBe(record.runId);
    expect(registry.close(record.executionId, "execution_closed")?.executionId).toBe(record.executionId);
    expect(registry.get(record.executionId)).toBeUndefined();
    expect(registry.close(record.executionId, "execution_closed")).toBeUndefined();
    expect(events).toEqual([`${record.executionId}:execution_closed`]);
  });

  it("drops every execution bound to a replaced control connection", () => {
    const registry = new RuntimeExecutionRegistry();
    const connection = { computerId: randomUUID(), instanceId: randomUUID(), connectionId: randomUUID() };
    const first = registry.open(executionInput(connection));
    const second = registry.open(executionInput(connection));
    const other = registry.open(executionInput());
    const closed = registry.closeConnection(
      connection.computerId,
      connection.instanceId,
      connection.connectionId,
      "connection_replaced",
    );
    expect(new Set(closed)).toEqual(new Set([first.executionId, second.executionId]));
    expect(registry.get(first.executionId)).toBeUndefined();
    expect(registry.get(second.executionId)).toBeUndefined();
    expect(registry.get(other.executionId)).toBeDefined();
  });

  it("sweeps expired executions and never extends their lifetime", () => {
    let now = 1_000;
    const registry = new RuntimeExecutionRegistry({ now: () => now, maxLifetimeMs: 100 });
    const record = registry.open(executionInput());
    now += 99;
    expect(registry.get(record.executionId)).toBeDefined();
    now += 2;
    expect(registry.get(record.executionId)).toBeUndefined();
    expect(registry.sweep()).toEqual([record.executionId]);
    expect(registry.size).toBe(0);
  });

  it("bounds executions per connection", () => {
    const registry = new RuntimeExecutionRegistry({ maxPerConnection: 1 });
    const connection = { computerId: randomUUID(), instanceId: randomUUID(), connectionId: randomUUID() };
    registry.open(executionInput(connection));
    expect(() => registry.open(executionInput(connection))).toThrow(RuntimeExecutionRegistryCapacityError);
  });
});

describe("RuntimeValidationRunRegistry", () => {
  it("issues single-use runs bound to the exact agent and connection", () => {
    const registry = new RuntimeValidationRunRegistry();
    const identity = { computerId: randomUUID(), instanceId: randomUUID(), agentId: randomUUID() };
    const run = registry.issue({ provider: "slack", bindingId: "b1", ...identity });
    expect(registry.consume(run.validationRunId, identity)?.bindingId).toBe("b1");
    expect(registry.consume(run.validationRunId, identity)).toBeUndefined();
    const second = registry.issue({ provider: "slack", bindingId: "b1", ...identity });
    expect(registry.consume(second.validationRunId, { ...identity, agentId: randomUUID() })).toBeUndefined();
  });
});

describe("RuntimeUrlHandleStore", () => {
  it("resolves handles only for the same execution, provider, and kind", () => {
    const store = new RuntimeUrlHandleStore();
    const executionId = randomUUID();
    const handleId = store.create({
      executionId,
      provider: "slack",
      kind: "upload",
      url: "https://files.slack.com/upload/v1/ABC",
    });
    expect(store.resolve(handleId, { executionId, provider: "slack", kind: "upload" })?.url).toBe(
      "https://files.slack.com/upload/v1/ABC",
    );
    expect(store.resolve(handleId, { executionId, provider: "slack", kind: "download" })).toBeUndefined();
    expect(store.resolve(handleId, { executionId, provider: "feishu", kind: "upload" })).toBeUndefined();
    expect(store.resolve(handleId, { executionId: randomUUID(), provider: "slack", kind: "upload" })).toBeUndefined();
  });

  it("revokes handles with the execution and expires them", () => {
    let now = 1_000;
    const store = new RuntimeUrlHandleStore({ now: () => now, ttlMs: 50 });
    const executionId = randomUUID();
    const first = store.create({ executionId, provider: "slack", kind: "download", url: "https://slack.com/f" });
    now += 51;
    expect(store.resolve(first, { executionId, provider: "slack", kind: "download" })).toBeUndefined();
    const second = store.create({ executionId, provider: "slack", kind: "download", url: "https://slack.com/g" });
    expect(store.revokeExecution(executionId)).toBe(1);
    expect(store.resolve(second, { executionId, provider: "slack", kind: "download" })).toBeUndefined();
  });
});

describe("RuntimeCapabilityStore live matching for long streams", () => {
  const base = {
    executionId: randomUUID(),
    provider: "slack" as const,
    bindingId: "b1",
    scopeHash: "a".repeat(64),
    authorizationRevision: "slack:1:1",
  };

  it("matches only an unexpired grant with the exact scope and revision", () => {
    let now = 1_000;
    const store = new RuntimeCapabilityStore({ now: () => now, ttlMs: 100, refreshAfterMs: 50 });
    store.issue({ ...base, purpose: "execution", credentialGeneration: "1:1" });
    expect(store.hasLiveMatching(base)).toBe(true);
    expect(store.hasLiveMatching({ ...base, scopeHash: "b".repeat(64) })).toBe(false);
    expect(store.hasLiveMatching({ ...base, authorizationRevision: "slack:2:1" })).toBe(false);
    expect(store.hasLiveMatching({ ...base, executionId: randomUUID() })).toBe(false);
    expect(store.hasLiveMatching({ ...base, provider: "feishu" })).toBe(false);
    expect(store.hasLiveMatching({ ...base, bindingId: "b2" })).toBe(false);
    now += 101;
    expect(store.hasLiveMatching(base)).toBe(false);
  });

  it("keeps a superseded grant matching its own scope during a renewal overlap", () => {
    let now = 1_000;
    const store = new RuntimeCapabilityStore({ now: () => now, ttlMs: 100, refreshAfterMs: 50 });
    store.issue({ ...base, purpose: "execution", credentialGeneration: "1:1" });
    now += 60;
    // The replacement grant carries a different scope; the superseded one is still the only
    // live grant for scope A, proving liveness is not tied to the current or original grant id.
    store.issue({ ...base, scopeHash: "b".repeat(64), purpose: "execution", credentialGeneration: "1:1" });
    now += 30;
    expect(store.hasLiveMatching(base)).toBe(true);
    now += 20;
    expect(store.hasLiveMatching(base)).toBe(false);
  });
});
