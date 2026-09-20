import { randomUUID } from "node:crypto";
import type { RuntimeExecutionSource } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { imMessageDeliveries, runtimeDurableWork, sessionMessages } from "../db/schema/index.js";
import type { AcceptedDeliveryRecord, RuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { CloudSessionWorkEnvelopeSchema } from "../runtime/runtime-durable-work-store.js";
import {
  PostgresRuntimeExecutionAuthority,
  type RuntimeExecutionAuthorityContext,
  validationProviderBinding,
} from "../runtime-credentials/execution-authority.js";
import { RuntimeValidationRunRegistry } from "../runtime-credentials/validation-runs.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const INSTANCE = "00000000-0000-4000-8000-0000000000d1";
const DELIVERY = "00000000-0000-4000-8000-0000000000e1";
const MESSAGE = "00000000-0000-4000-8000-0000000000f1";
const TURN = "turn-1";
const PLACEMENT = 3;

function deliverySource(overrides: Partial<Extract<RuntimeExecutionSource, { kind: "delivery" }>> = {}) {
  return { kind: "delivery" as const, deliveryId: DELIVERY, turnId: TURN, ...overrides };
}

const sessionMessageSource: RuntimeExecutionSource = { kind: "session-message", messageId: MESSAGE };

function context(overrides: Partial<RuntimeExecutionAuthorityContext> = {}): RuntimeExecutionAuthorityContext {
  return {
    agentId: AGENT,
    computerId: COMPUTER,
    instanceId: INSTANCE,
    placementGeneration: PLACEMENT,
    sessionId: SESSION,
    ...overrides,
  };
}

function acceptedDelivery(overrides: Partial<AcceptedDeliveryRecord> = {}): AcceptedDeliveryRecord {
  return {
    agentId: AGENT,
    computerId: COMPUTER,
    deliveryId: DELIVERY,
    inputHash: "a".repeat(64),
    instanceId: INSTANCE,
    placementGeneration: PLACEMENT,
    sessionId: SESSION,
    turnId: TURN,
    ...overrides,
  };
}

class StubCustody {
  accepted: AcceptedDeliveryRecord | undefined;
  readonly queries: string[] = [];

  async getDelivery(deliveryId: string): Promise<AcceptedDeliveryRecord | undefined> {
    this.queries.push(deliveryId);
    return this.accepted;
  }
}

interface StubDatabaseRows {
  readonly deliveries?: readonly Record<string, unknown>[];
  readonly sessionMessages?: readonly Record<string, unknown>[];
  readonly durableWork?: readonly Record<string, unknown>[];
}

interface StubDatabase {
  readonly database: DatabaseClient;
  readonly selects: () => number;
}

/**
 * Query stub for the authority's two `select` shapes. Rows are returned exactly as the SQL query
 * would return them; the WHERE predicates themselves (live-session, delivery-state, target-session
 * filters) are exercised by the PostgreSQL integration suite, not here.
 */
function stubDatabase(rows: StubDatabaseRows = {}): StubDatabase {
  let selects = 0;
  const resultFor = (table: unknown): readonly Record<string, unknown>[] => {
    if (table === imMessageDeliveries) return rows.deliveries ?? [];
    if (table === sessionMessages) return rows.sessionMessages ?? [];
    if (table === runtimeDurableWork) return rows.durableWork ?? [];
    throw new Error("Unexpected table in the runtime execution authority query");
  };
  const database = {
    select() {
      selects += 1;
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        innerJoin: () => query,
        leftJoin: () => query,
        limit: () => Promise.resolve(resultFor(table)),
        where: () => query,
      };
      return query;
    },
  };
  return { database: database as unknown as DatabaseClient, selects: () => selects };
}

function makeAuthority(
  options: {
    custody?: AcceptedDeliveryRecord;
    deliveries?: readonly Record<string, unknown>[];
    sessionMessages?: readonly Record<string, unknown>[];
    durableWork?: readonly Record<string, unknown>[];
    validationRuns?: RuntimeValidationRunRegistry;
  } = {},
) {
  const custody = new StubCustody();
  custody.accepted = options.custody;
  const stub = stubDatabase({
    deliveries: options.deliveries,
    sessionMessages: options.sessionMessages,
    durableWork: options.durableWork,
  });
  const validationRuns = options.validationRuns ?? new RuntimeValidationRunRegistry();
  return {
    authority: new PostgresRuntimeExecutionAuthority({
      custody: custody as unknown as RuntimeCustodyStore,
      database: stub.database,
      validationRuns,
    }),
    custody,
    selects: stub.selects,
    validationRuns,
  };
}

describe("PostgresRuntimeExecutionAuthority delivery admission", () => {
  it("authorizes accepted custody matching identity and placement before trusting any database probe", async () => {
    const { authority, custody, selects } = makeAuthority({
      custody: acceptedDelivery(),
      deliveries: [{ state: "pending", turnId: TURN }],
    });

    await expect(authority.authorize(deliverySource(), context())).resolves.toEqual({ status: "authorized" });
    expect(custody.queries).toEqual([DELIVERY]);
    // Accepted custody is authoritative; a stray pending probe row cannot downgrade it.
    expect(selects()).toBe(0);
  });

  it.each<[string, AcceptedDeliveryRecord | undefined]>([
    ["no accepted custody", undefined],
    ["a stale turn", acceptedDelivery({ turnId: "turn-stale" })],
    ["a foreign session", acceptedDelivery({ sessionId: "session-foreign" })],
    ["a foreign agent", acceptedDelivery({ agentId: "agent-foreign" })],
    ["a foreign computer", acceptedDelivery({ computerId: "00000000-0000-4000-8000-0000000000c2" })],
    ["a foreign instance", acceptedDelivery({ instanceId: "00000000-0000-4000-8000-0000000000d2" })],
    ["a stale placement", acceptedDelivery({ placementGeneration: PLACEMENT - 1 })],
  ])("refuses custody with %s", async (_case, custodyRow) => {
    const { authority, selects } = makeAuthority({ custody: custodyRow });

    await expect(authority.authorize(deliverySource(), context())).resolves.toEqual({ status: "invalid" });
    // Every mismatch falls through to the live dispatch/accept probe exactly once.
    expect(selects()).toBe(1);
  });

  it.each(["pending", "expired"] as const)(
    "keeps a live not-yet-accepted dispatch retryable while its row is %s",
    async (state) => {
      const { authority } = makeAuthority({ deliveries: [{ state, turnId: TURN }] });

      await expect(authority.authorize(deliverySource(), context())).resolves.toEqual({ status: "not_ready" });
    },
  );

  it("refuses when the release probe finds no live dispatch for the delivery", async () => {
    const { authority } = makeAuthority();

    await expect(authority.authorize(deliverySource(), context())).resolves.toEqual({ status: "invalid" });
  });
});

describe("PostgresRuntimeExecutionAuthority Session message admission", () => {
  it.each<[string, "authorized" | "not_ready" | "invalid"]>([
    ["accepted", "authorized"],
    ["unknown", "not_ready"],
    ["unreachable", "invalid"],
    ["rejected", "invalid"],
  ])("maps Session message outcome %s to %s", async (lastOutcome, status) => {
    const { authority, selects } = makeAuthority({
      sessionMessages: [{ lastOutcome, agentId: AGENT, computerKind: "local" }],
    });

    await expect(authority.authorize(sessionMessageSource, context())).resolves.toEqual({ status });
    expect(selects()).toBe(1);
  });

  it("refuses a Session message the target Session has no recorded outcome for", async () => {
    const { authority } = makeAuthority();

    await expect(authority.authorize(sessionMessageSource, context())).resolves.toEqual({ status: "invalid" });
  });

  it("never authorizes accepted Cloud work whose durable record is settled or on another allocation", async () => {
    const sandboxId = "00000000-0000-4000-8000-0000000000aa";
    const cloudFacts = [
      {
        lastOutcome: "accepted",
        agentId: AGENT,
        computerKind: "cloud",
        placementComputerId: COMPUTER,
        placementGeneration: PLACEMENT,
        sandboxId,
        sandboxResourceName: "instances/one",
        sandboxEnvironmentGeneration: 2,
      },
    ];
    const envelope = CloudSessionWorkEnvelopeSchema.parse({
      type: "cloud-session-message-work",
      request: {
        type: "session:message:deliver",
        requestId: MESSAGE,
        messageId: MESSAGE,
        sourceSessionId: "00000000-0000-4000-8000-000000000002",
        targetSessionId: SESSION,
        agentId: AGENT,
        placementGeneration: PLACEMENT,
        content: { kind: "text", text: "do it" },
        runtime: {
          contextTreeRepository: null,
          revision: {
            agent: { sequence: 1, id: "revision-agent" },
            session: { sequence: 1, id: "revision-session" },
          },
          agentId: AGENT,
          provider: "pi",
          instructions: { platform: "platform", agent: "agent" },
          execution: { approvalPolicy: "never", networkAccess: false },
          workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
        },
      },
      allocation: { sandboxId, environmentGeneration: 2, resourceName: "instances/one" },
      turnId: "turn-1",
    });

    const accepted = makeAuthority({
      sessionMessages: cloudFacts,
      durableWork: [{ status: "accepted", payload: envelope }],
    });
    await expect(accepted.authority.authorize(sessionMessageSource, context())).resolves.toEqual({
      status: "authorized",
    });
    // Settled work keeps `lastOutcome=accepted` but can never authorize a fresh execution.
    const settled = makeAuthority({
      sessionMessages: cloudFacts,
      durableWork: [{ status: "failed", payload: envelope }],
    });
    await expect(settled.authority.authorize(sessionMessageSource, context())).resolves.toEqual({ status: "invalid" });
    // An accepted record for a replaced allocation is not the current allocation's authority.
    const replaced = makeAuthority({
      sessionMessages: [{ ...cloudFacts[0], sandboxResourceName: "instances/two" }],
      durableWork: [{ status: "accepted", payload: envelope }],
    });
    await expect(replaced.authority.authorize(sessionMessageSource, context())).resolves.toEqual({
      status: "invalid",
    });
    // A missing durable record fails closed for Cloud even though the outcome says accepted.
    const missing = makeAuthority({ sessionMessages: cloudFacts });
    await expect(missing.authority.authorize(sessionMessageSource, context())).resolves.toEqual({ status: "invalid" });
  });
});

describe("PostgresRuntimeExecutionAuthority validation admission", () => {
  function issue(registry: RuntimeValidationRunRegistry) {
    return registry.issue({
      agentId: AGENT,
      bindingId: "binding-1",
      computerId: COMPUTER,
      instanceId: INSTANCE,
      provider: "github",
    });
  }

  it("consumes a Server-issued validation run exactly once and maps its provider binding", async () => {
    const registry = new RuntimeValidationRunRegistry();
    const run = issue(registry);
    const { authority, selects } = makeAuthority({ validationRuns: registry });
    const source: RuntimeExecutionSource = { kind: "validation", validationRunId: run.validationRunId };

    await expect(authority.authorize(source, context())).resolves.toEqual({ status: "authorized", validation: run });
    expect(validationProviderBinding(run)).toEqual({ bindingId: "binding-1", provider: "github" });
    expect(registry.size).toBe(0);
    // Single use: the consumed run can never authorize a second open.
    await expect(authority.authorize(source, context())).resolves.toEqual({ status: "invalid" });
    expect(selects()).toBe(0);
  });

  it("refuses an unknown validation run id", async () => {
    const { authority } = makeAuthority();

    await expect(
      authority.authorize({ kind: "validation", validationRunId: randomUUID() }, context()),
    ).resolves.toEqual({ status: "invalid" });
  });

  it("refuses an expired validation run", async () => {
    let now = 1_000;
    const registry = new RuntimeValidationRunRegistry({ now: () => now, ttlMs: 10 });
    const run = issue(registry);
    const { authority } = makeAuthority({ validationRuns: registry });
    now = 1_010;

    await expect(
      authority.authorize({ kind: "validation", validationRunId: run.validationRunId }, context()),
    ).resolves.toEqual({ status: "invalid" });
  });

  it.each<[string, Partial<RuntimeExecutionAuthorityContext>]>([
    ["computer", { computerId: "00000000-0000-4000-8000-0000000000c2" }],
    ["instance", { instanceId: "00000000-0000-4000-8000-0000000000d2" }],
    ["agent", { agentId: "agent-foreign" }],
  ])("refuses and burns a run issued for another %s", async (_case, override) => {
    const registry = new RuntimeValidationRunRegistry();
    const run = issue(registry);
    const { authority } = makeAuthority({ validationRuns: registry });
    const source: RuntimeExecutionSource = { kind: "validation", validationRunId: run.validationRunId };

    await expect(authority.authorize(source, context(override))).resolves.toEqual({ status: "invalid" });
    expect(registry.size).toBe(0);
    // A mismatched attempt consumed the run, so the correct context cannot revive it either.
    await expect(authority.authorize(source, context())).resolves.toEqual({ status: "invalid" });
  });
});

describe("PostgresRuntimeExecutionAuthority live revalidation", () => {
  const revalidationContext = {
    agentId: AGENT,
    computerId: COMPUTER,
    instanceId: INSTANCE,
    sessionId: SESSION,
  };

  it("keeps an accepted delivery valid while it is still the accepted turn", async () => {
    const { authority, selects } = makeAuthority({ deliveries: [{ state: "accepted", turnId: TURN }] });

    await expect(authority.revalidate(deliverySource(), revalidationContext)).resolves.toBe("valid");
    expect(selects()).toBe(1);
  });

  it.each<[string, readonly Record<string, unknown>[]]>([
    ["the delivery row is gone", []],
    ["the delivery left the accepted state", [{ state: "steered", turnId: TURN }]],
    ["the accepted turn was replaced", [{ state: "accepted", turnId: "turn-replaced" }]],
  ])("invalidates a delivery when %s", async (_case, deliveries) => {
    const { authority } = makeAuthority({ deliveries });

    await expect(authority.revalidate(deliverySource(), revalidationContext)).resolves.toBe("invalid");
  });

  it.each<[string, "valid" | "invalid" | "not_ready"]>([
    ["accepted", "valid"],
    ["unknown", "not_ready"],
    ["unreachable", "invalid"],
    ["rejected", "invalid"],
  ])("maps recorded Session message outcome %s to %s on revalidation", async (lastOutcome, expected) => {
    const { authority } = makeAuthority({
      sessionMessages: [{ lastOutcome, agentId: AGENT, computerKind: "local" }],
    });

    await expect(authority.revalidate(sessionMessageSource, revalidationContext)).resolves.toBe(expected);
  });

  it("invalidates a Session message whose recorded row is gone", async () => {
    const { authority } = makeAuthority();

    await expect(authority.revalidate(sessionMessageSource, revalidationContext)).resolves.toBe("invalid");
  });

  it("keeps a validation source valid through revalidation without a database read", async () => {
    const { authority, selects } = makeAuthority();

    await expect(
      authority.revalidate({ kind: "validation", validationRunId: randomUUID() }, revalidationContext),
    ).resolves.toBe("valid");
    expect(selects()).toBe(0);
  });
});
