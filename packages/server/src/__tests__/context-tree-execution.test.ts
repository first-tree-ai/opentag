import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contextTreeExecutionIsCurrent } from "../runtime-credentials/context-tree-execution.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import type { RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import type { RuntimeExecutionRecord } from "../runtime-credentials/types.js";

const target = { kind: "git", repository: "acme/memory", path: "docs", ref: "main" } as const;
function fixture() {
  const executions = new RuntimeExecutionRegistry();
  const parent = executions.open({
    accountId: randomUUID(),
    agentId: randomUUID(),
    agentRevision: 3,
    computerId: randomUUID(),
    computerKind: "local",
    connectionId: "connection",
    instanceId: "instance",
    placementGeneration: 2,
    providers: new Map(),
    purpose: "execution",
    services: [{ service: "context-tree", scopes: ["context-tree:git"] }],
    runId: randomUUID(),
    sessionId: randomUUID(),
    source: { kind: "delivery", deliveryId: "delivery", turnId: "turn" },
  });
  const child = executions.open({
    ...parent,
    purpose: "context-tree",
    contextTree: { ...target, parentExecutionId: parent.executionId },
  });
  const snapshot = { contextTrees: [target] } as unknown as RuntimeScopeSnapshot;
  return { parent, child, executions, snapshot };
}
describe("Context Tree execution scope", () => {
  it("requires a live ordinary parent and a currently configured exact tree", () => {
    const { parent, child, snapshot } = fixture();
    expect(contextTreeExecutionIsCurrent(child, parent, snapshot)).toBe(true);
    expect(contextTreeExecutionIsCurrent(child, undefined, snapshot)).toBe(false);
    expect(contextTreeExecutionIsCurrent(child, child, snapshot)).toBe(false);
    expect(contextTreeExecutionIsCurrent(child, parent, { ...snapshot, contextTrees: [] })).toBe(false);
    for (const change of [{ repository: "other/memory" }, { path: "." }, { ref: "other" }])
      expect(
        contextTreeExecutionIsCurrent(child, parent, { ...snapshot, contextTrees: [{ ...target, ...change }] }),
      ).toBe(false);
  });
  it.each([
    "accountId",
    "agentId",
    "agentRevision",
    "sessionId",
    "computerId",
    "instanceId",
    "connectionId",
    "placementGeneration",
    "computerKind",
  ] as const)("rejects a changed parent %s", (field) => {
    const { parent, child, snapshot } = fixture();
    const foreign = { ...parent, [field]: "changed" } as RuntimeExecutionRecord;
    expect(contextTreeExecutionIsCurrent(child, foreign, snapshot)).toBe(false);
  });
  it("binds task provenance and exact Sandbox allocation", () => {
    const { parent, child, snapshot } = fixture();
    expect(
      contextTreeExecutionIsCurrent(
        child,
        { ...parent, source: { kind: "session-message", messageId: randomUUID() } },
        snapshot,
      ),
    ).toBe(false);
    expect(
      contextTreeExecutionIsCurrent(
        child,
        { ...parent, source: { kind: "delivery", deliveryId: "other", turnId: "turn" } },
        snapshot,
      ),
    ).toBe(false);
    const sandbox = { sandboxId: randomUUID(), resourceUid: "uid", environmentGeneration: 1 };
    expect(
      contextTreeExecutionIsCurrent(
        { ...child, sandbox },
        { ...parent, sandbox: { environmentGeneration: 1, resourceUid: "uid", sandboxId: sandbox.sandboxId } },
        snapshot,
      ),
    ).toBe(true);
    expect(
      contextTreeExecutionIsCurrent(
        { ...child, sandbox },
        { ...parent, sandbox: { ...sandbox, environmentGeneration: 2 } },
        snapshot,
      ),
    ).toBe(false);
  });
  it("closing the parent closes dependent executions without touching an unrelated execution", () => {
    const { parent, child, executions } = fixture();
    const other = executions.open({ ...parent, runId: randomUUID() });
    executions.close(parent.executionId, "execution_closed");
    expect(executions.get(child.executionId)).toBeUndefined();
    expect(executions.get(other.executionId)).toBeDefined();
  });
});
