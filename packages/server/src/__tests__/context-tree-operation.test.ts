import { randomUUID } from "node:crypto";
import { type AgentAdminConfig, CONTEXT_TREES_MAX, type ContextTreeOperationRequest } from "@opentag/shared";
import { expect, it, vi } from "vitest";
import { ContextTreeOperationService } from "../services/agents/context-tree-operation-service.js";

function fixture() {
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const registry = {
    currentInstanceId: vi.fn(() => instanceId),
    supportsCapability: vi.fn(() => true),
  };
  const config = {
    id: randomUUID(),
    revision: 3,
    computerId,
    status: "suspended",
    runtimeConfig: {
      revision: 7,
      contextTrees: [{ kind: "git" as const, path: ".", ref: "main", repository: "acme/old" }],
    },
  } as AgentAdminConfig;
  const agents = {
    getConfigById: vi.fn(async () => config),
    updateContextTreeSelection: vi.fn(async () => config),
  };
  const input: ContextTreeOperationRequest = {
    kind: "git" as const,
    path: ".",
    ref: "main",
    expectedRevision: 3,
    expectedRuntimeConfigRevision: 7,
    action: "connect",
    repository: "Acme/Memory",
  };
  const github = {
    computerKind: vi.fn(async () => "local" as const),
    run: vi.fn(async () => ({ status: "completed" as const, repository: "acme/memory", ref: "main" })),
  };
  const service = new ContextTreeOperationService(agents, registry, github);
  return { config, agents, input, service, registry, github };
}
it("disconnects offline and unbound without remote execution", async () => {
  const f = fixture();
  f.config.computerId = null;
  expect(
    await f.service.run("user", f.config.id, {
      ...f.input,
      kind: "git" as const,
      path: ".",
      ref: "main",
      action: "disconnect",
      repository: "acme/old",
    }),
  ).toEqual({
    status: "completed",
    repository: null,
  });
  expect(f.github.run).not.toHaveBeenCalled();
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
    expect(f.github.run).not.toHaveBeenCalled();
  },
);
it("requires authorization and suspension", async () => {
  const f = fixture();
  f.agents.getConfigById.mockRejectedValueOnce(new Error("permission denied"));
  await expect(f.service.run("user", f.config.id, f.input)).rejects.toThrow("permission denied");
  f.config.status = "active";
  expect(await f.service.run("user", f.config.id, f.input)).toEqual({ status: "failed", code: "pause_required" });
  expect(f.github.run).not.toHaveBeenCalled();
});
it("accepts case-insensitive repository identity and passes every fence to the transaction", async () => {
  const f = fixture();
  const pending = f.service.run("user", f.config.id, f.input);
  expect(await pending).toEqual({ status: "completed", repository: "acme/memory", ref: "main" });
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
    "user",
    f.config.id,
    { revision: 3, runtimeConfigRevision: 7, computerId: f.config.computerId, status: "suspended" },
    [
      { kind: "git" as const, path: ".", ref: "main", repository: "acme/old" },
      { kind: "git" as const, path: ".", ref: "main", repository: "Acme/Memory" },
    ],
  );
});
it("saves the resolved default branch and does not duplicate an existing connection", async () => {
  const f = fixture();
  const start = f.github.run.mockResolvedValue({ status: "completed", repository: "Acme/Memory", ref: "trunk" });
  const input = { ...f.input, ref: "HEAD" };
  await f.service.run("user", f.config.id, input);
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
    "user",
    f.config.id,
    expect.any(Object),
    expect.arrayContaining([{ kind: "git", repository: "Acme/Memory", path: ".", ref: "trunk" }]),
  );
  f.config.runtimeConfig.contextTrees.push({ kind: "git", repository: "acme/memory", path: ".", ref: "trunk" });
  f.agents.updateContextTreeSelection.mockClear();
  await f.service.run("user", f.config.id, input);
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
  start.mockResolvedValue({ status: "completed", repository: "Acme/Memory", ref: "HEAD" });
  expect(await f.service.run("user", f.config.id, input)).toEqual({ status: "failed", code: "failed" });
});

it("rejects mismatched repository results", async () => {
  const f = fixture();
  f.github.run.mockResolvedValue({ status: "completed", repository: "other/tree", ref: "main" });
  const pending = f.service.run("user", f.config.id, f.input);
  expect(await pending).toEqual({ status: "failed", code: "failed" });
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});
it("reports an atomic revision or placement conflict after remote work", async () => {
  const f = fixture();
  f.agents.updateContextTreeSelection.mockRejectedValue(
    Object.assign(new Error("changed"), { code: "AGENT_REVISION_CONFLICT" }),
  );
  const pending = f.service.run("user", f.config.id, f.input);
  expect(await pending).toEqual({ status: "failed", code: "stale_configuration" });
});
it("treats an identical source as idempotent", async () => {
  const f = fixture();
  f.config.status = "active";
  expect(await f.service.run("user", f.config.id, { ...f.input, repository: "ACME/OLD" })).toEqual({
    status: "completed",
    repository: "acme/old",
  });
  expect(f.github.run).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});
it("disconnects one source while retaining the other connection", async () => {
  const f = fixture();
  f.config.runtimeConfig.contextTrees.push({ kind: "git" as const, path: ".", ref: "main", repository: "acme/memory" });
  expect(
    await f.service.run("user", f.config.id, { ...f.input, action: "disconnect", repository: "acme/memory" }),
  ).toEqual({
    status: "completed",
    repository: null,
  });
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith("user", f.config.id, expect.any(Object), [
    { kind: "git" as const, path: ".", ref: "main", repository: "acme/old" },
  ]);
});
it("rejects a new connection at the tree limit before any remote work", async () => {
  const f = fixture();
  f.config.runtimeConfig.contextTrees = Array.from({ length: CONTEXT_TREES_MAX }, (_, index) => ({
    kind: "git" as const,
    path: ".",
    ref: "main",
    repository: `acme/tree-${index}`,
  }));
  const cloud = {
    computerKind: vi.fn(async () => "cloud" as const),
    run: vi.fn(async () => ({ status: "completed" as const, repository: "acme/memory" })),
  };
  const service = new ContextTreeOperationService(f.agents, f.registry, cloud);
  expect(await service.run("user", f.config.id, f.input)).toEqual({ status: "failed", code: "tree_limit_reached" });
  expect(cloud.computerKind).not.toHaveBeenCalled();
  expect(cloud.run).not.toHaveBeenCalled();
  expect(f.github.run).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});
it("allows disconnect and idempotent requests at the tree limit", async () => {
  const f = fixture();
  const connections = Array.from({ length: CONTEXT_TREES_MAX }, (_, index) => ({
    kind: "git" as const,
    path: ".",
    ref: "main",
    repository: `acme/tree-${index}`,
  }));
  f.config.runtimeConfig.contextTrees = connections;
  expect(
    await f.service.run("user", f.config.id, {
      ...f.input,
      kind: "git" as const,
      path: ".",
      ref: "main",
      action: "disconnect",
      repository: "acme/tree-0",
    }),
  ).toEqual({ status: "completed", repository: null });
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(
    "user",
    f.config.id,
    expect.any(Object),
    connections.slice(1),
  );
  f.github.run.mockClear();
  expect(
    await f.service.run("user", f.config.id, {
      ...f.input,
      kind: "git" as const,
      path: ".",
      ref: "main",
      repository: "ACME/TREE-0",
    }),
  ).toEqual({
    status: "completed",
    repository: "acme/tree-0",
  });
  expect(f.github.run).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).toHaveBeenCalledTimes(1);
});
