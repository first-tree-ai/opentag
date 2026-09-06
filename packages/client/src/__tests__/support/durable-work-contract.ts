import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  computeTurnResultHash,
  RuntimeDurableWorkStatusSchema,
  type SessionMessageDeliveryRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { z } from "zod";
import {
  type DurableWorkKind,
  type DurableWorkRecord,
  MemoryRuntimeDurabilityStore,
  type RuntimeDurabilityStore,
} from "../../runtime/runtime-durability.js";

const contract = z
  .array(z.object({ from: RuntimeDurableWorkStatusSchema, to: RuntimeDurableWorkStatusSchema }))
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../../../scripts/fixtures/runtime-durable-work-transitions.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const allowed = new Set(contract.map(({ from, to }) => `${from} -> ${to}`));

// The Server contract suite executes these same edges against PGlite. A swallowed Client write
// rejection is retained here so scenario cleanup can assert it, too.
export class ObservedDurabilityStore implements RuntimeDurabilityStore {
  readonly storage = new MemoryRuntimeDurabilityStore();
  readonly edges: string[] = [];
  readonly rejected: string[] = [];

  list<T>(kind: DurableWorkKind): Promise<DurableWorkRecord<T>[]> {
    return this.storage.list<T>(kind);
  }

  async write<T>(record: DurableWorkRecord<T>): Promise<void> {
    const previous = (await this.storage.list(record.kind)).find((item) => item.key === record.key);
    if (previous) {
      const edge = `${previous.status} -> ${record.status}`;
      if (!allowed.has(edge)) {
        this.rejected.push(edge);
        throw new Error(`Client wrote an edge outside the durable-work contract: ${edge}`);
      }
      this.edges.push(edge);
    }
    await this.storage.write(record);
  }

  async status(kind: DurableWorkKind, key: string): Promise<DurableWorkRecord["status"] | undefined> {
    return (await this.storage.list(kind)).find((record) => record.key === key)?.status;
  }
}

export function reportFixture(): TurnReportRequest {
  const input = {
    deliveryId: "delivery",
    turnId: "turn",
    sessionId: "session",
    agentId: "agent",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...input, resultHash: computeTurnResultHash(input) };
}

export function reportReceipt(
  report: TurnReportRequest,
  status: DurableWorkRecord["status"],
): DurableWorkRecord<TurnReportRequest> {
  return {
    key: report.turnId,
    kind: "turn-report",
    payload: report,
    acceptedAt: 10_000,
    updatedAt: 10_000,
    attempts: 0,
    status,
  };
}

export function messageFixture(): SessionMessageDeliveryRequest {
  const agentId = randomUUID();
  return {
    type: "session:message:deliver",
    requestId: randomUUID(),
    messageId: randomUUID(),
    sourceSessionId: randomUUID(),
    targetSessionId: randomUUID(),
    agentId,
    placementGeneration: 1,
    content: { kind: "text", text: "hello" },
    runtime: {
      revision: { agent: { sequence: 1, id: "agent" }, session: { sequence: 1, id: "session" } },
      agentId,
      provider: "codex",
      instructions: { platform: "platform", agent: "agent" },
      execution: { approvalPolicy: "never", networkAccess: false },
      workspace: { workspaceId: "workspace", mode: "empty_on_create", sharing: "agent" },
    },
  };
}
