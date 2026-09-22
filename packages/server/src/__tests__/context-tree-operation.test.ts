import { randomUUID } from "node:crypto";
import {
  type AgentAdminConfig,
  CONTEXT_TREES_MAX,
  type ContextTreeOperationFrame,
  type ContextTreeOperationRequest,
} from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ContextTreeOperationOwner } from "../runtime/context-tree-operation-owner.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { ContextTreeOperationService } from "../services/agents/context-tree-operation-service.js";

function fixture() {
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const registry = {
    currentInstanceId: vi.fn(() => instanceId),
    supportsCapability: vi.fn(() => true),
    send: vi.fn(async (..._args: unknown[]) => undefined),
  };
  const owner = new ContextTreeOperationOwner(registry as unknown as ConnectionRegistry);
  const config = {
    id: randomUUID(),
    revision: 3,
    computerId,
    status: "suspended",
    runtimeConfig: { revision: 7, contextTrees: [{ alias: "old", repository: "acme/old" }] },
  } as AgentAdminConfig;
  const agents = {
    getConfigById: vi.fn(async () => config),
    updateContextTreeSelection: vi.fn(async () => config),
  };
  const input: ContextTreeOperationRequest = {
    alias: "memory",
    operationId: randomUUID(),
    expectedRevision: 3,
    expectedRuntimeConfigRevision: 7,
    action: "connect",
    repository: "Acme/Memory",
  };
  const service = new ContextTreeOperationService(agents, owner);
  const start = { agentId: config.id, computerId, requireStopped: true, input };
  const answer = async (repository = input.repository, override = {}) => {
    const frame = registry.send.mock.calls[0]?.[2] as unknown as ContextTreeOperationFrame;
    const business = owner.businessOptions();
    const response = {
      type: "context-tree:operation:result",
      requestId: frame.requestId,
      result: { status: "completed", repository },
    };
    const parsed = business.parse(response);
    expect(parsed).toEqual(response);
    if (!parsed) throw new Error("Context Tree response was not parsed");
    await business.handle(parsed, { computerId, instanceId, ...override } as RuntimeBusinessContext);
  };
  return { owner, config, agents, input, service, start, registry, answer };
}
afterEach(() => vi.useRealTimers());
it("disconnects offline and unbound without remote execution", async () => {
  const f = fixture();
  f.config.computerId = null;
  expect(
    await f.service.run("user", f.config.id, { ...f.input, alias: "old", action: "disconnect", repository: null }),
  ).toEqual({
    status: "completed",
    repository: null,
  });
  expect(f.registry.send).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
    "user",
    f.config.id,
    { revision: 3, runtimeConfigRevision: 7, computerId: null, status: "suspended" },
    [],
  );
});
it.each(["expectedRevision", "expectedRuntimeConfigRevision"] as const)(
  "rejects stale %s before dispatch",
  async (key) => {
    const f = fixture();
    expect(await f.service.run("user", f.config.id, { ...f.input, [key]: 99 })).toEqual({
      status: "failed",
      code: "stale_configuration",
    });
    expect(f.registry.send).not.toHaveBeenCalled();
  },
);
it("requires authorization and suspension", async () => {
  const f = fixture();
  f.agents.getConfigById.mockRejectedValueOnce(new Error("permission denied"));
  await expect(f.service.run("user", f.config.id, f.input)).rejects.toThrow("permission denied");
  f.config.status = "active";
  expect(await f.service.run("user", f.config.id, f.input)).toEqual({ status: "failed", code: "pause_required" });
  expect(f.registry.send).not.toHaveBeenCalled();
});
it("accepts case-insensitive repository identity and passes every fence to the transaction", async () => {
  const f = fixture();
  const pending = f.service.run("user", f.config.id, f.input);
  await vi.waitFor(() => expect(f.registry.send).toHaveBeenCalled());
  await f.answer("acme/memory");
  expect(await pending).toEqual({ status: "completed", repository: "acme/memory" });
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
    "user",
    f.config.id,
    { revision: 3, runtimeConfigRevision: 7, computerId: f.config.computerId, status: "suspended" },
    [
      { alias: "old", repository: "acme/old" },
      { alias: "memory", repository: "Acme/Memory" },
    ],
  );
});
it("rejects mismatched repository results", async () => {
  const f = fixture();
  const pending = f.service.run("user", f.config.id, f.input);
  await vi.waitFor(() => expect(f.registry.send).toHaveBeenCalled());
  await f.answer("other/tree");
  expect(await pending).toEqual({ status: "failed", code: "failed" });
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});
it("reports an atomic revision or placement conflict after remote work", async () => {
  const f = fixture();
  f.agents.updateContextTreeSelection.mockRejectedValue(
    Object.assign(new Error("changed"), { code: "AGENT_REVISION_CONFLICT" }),
  );
  const pending = f.service.run("user", f.config.id, f.input);
  await vi.waitFor(() => expect(f.registry.send).toHaveBeenCalled());
  await f.answer();
  expect(await pending).toEqual({ status: "failed", code: "stale_configuration" });
});
it("admits one operation per Computer and fences responses by connection instance", async () => {
  const f = fixture();
  const pending = f.owner.start(f.start);
  expect(await f.owner.start(f.start)).toEqual({ status: "failed", code: "busy" });
  const settled = vi.fn();
  void pending.then(settled);
  await f.answer(undefined, { instanceId: randomUUID() });
  expect(settled).not.toHaveBeenCalled();
  await f.answer();
  expect(await pending).toMatchObject({ status: "completed" });
});
it("times out uncertain creation and releases admission", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const pending = f.owner.start({ ...f.start, input: { ...f.input, action: "create" } });
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await pending).toEqual({ status: "failed", code: "publication_uncertain" });
  const next = f.owner.start(f.start);
  f.owner.close();
  expect(await next).toEqual({ status: "failed", code: "computer_unavailable" });
});
it("rejects missing Computer capability before sending", async () => {
  const f = fixture();
  f.registry.supportsCapability.mockReturnValue(false);
  expect(await f.owner.start(f.start)).toEqual({ status: "failed", code: "capability_missing" });
  expect(f.registry.send).not.toHaveBeenCalled();
});

it.each(["create", "connect", "disconnect"] as const)("classifies shutdown during %s", async (action) => {
  const f = fixture();
  const pending = f.owner.start({
    ...f.start,
    input: { ...f.input, action, repository: action === "disconnect" ? null : f.input.repository },
  });
  f.owner.close();
  expect(await pending).toEqual({
    status: "failed",
    code: action === "create" ? "publication_uncertain" : "computer_unavailable",
  });
});

it("rejects alias and repository collisions before remote work and treats identical attachments as idempotent", async () => {
  const f = fixture();
  expect(await f.service.run("user", f.config.id, { ...f.input, alias: "old" })).toEqual({
    status: "failed",
    code: "alias_conflict",
  });
  expect(await f.service.run("user", f.config.id, { ...f.input, repository: "ACME/OLD" })).toEqual({
    status: "failed",
    code: "repository_conflict",
  });
  f.config.status = "active";
  expect(await f.service.run("user", f.config.id, { ...f.input, alias: "old", repository: "ACME/OLD" })).toEqual({
    status: "completed",
    repository: "acme/old",
  });
  expect(f.registry.send).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});
it("disconnects one alias while retaining the other connection", async () => {
  const f = fixture();
  f.config.runtimeConfig.contextTrees.push({ alias: "memory", repository: "acme/memory" });
  expect(await f.service.run("user", f.config.id, { ...f.input, action: "disconnect", repository: null })).toEqual({
    status: "completed",
    repository: null,
  });
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith("user", f.config.id, expect.any(Object), [
    { alias: "old", repository: "acme/old" },
  ]);
});
it("rejects a new connection at the tree limit before any remote work", async () => {
  const f = fixture();
  f.config.runtimeConfig.contextTrees = Array.from({ length: CONTEXT_TREES_MAX }, (_, index) => ({
    alias: `tree-${index}`,
    repository: `acme/tree-${index}`,
  }));
  const cloud = {
    computerKind: vi.fn(async () => "cloud" as const),
    run: vi.fn(async () => ({ status: "completed" as const, repository: "acme/memory" })),
  };
  const service = new ContextTreeOperationService(f.agents, f.owner, cloud);
  expect(await service.run("user", f.config.id, f.input)).toEqual({ status: "failed", code: "tree_limit_reached" });
  expect(cloud.computerKind).not.toHaveBeenCalled();
  expect(cloud.run).not.toHaveBeenCalled();
  expect(f.registry.send).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});
it("allows disconnect and idempotent requests at the tree limit", async () => {
  const f = fixture();
  const connections = Array.from({ length: CONTEXT_TREES_MAX }, (_, index) => ({
    alias: `tree-${index}`,
    repository: `acme/tree-${index}`,
  }));
  f.config.runtimeConfig.contextTrees = connections;
  expect(
    await f.service.run("user", f.config.id, { ...f.input, alias: "tree-0", action: "disconnect", repository: null }),
  ).toEqual({ status: "completed", repository: null });
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
    "user",
    f.config.id,
    expect.any(Object),
    connections.slice(1),
  );
  f.registry.send.mockClear();
  expect(await f.service.run("user", f.config.id, { ...f.input, alias: "tree-0", repository: "ACME/TREE-0" })).toEqual({
    status: "completed",
    repository: "acme/tree-0",
  });
  expect(f.registry.send).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledTimes(1);
});
