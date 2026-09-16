import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextTreeOperationFrame } from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
import { ContextTreeSettings, contextTreeStagingName } from "../runtime/context-tree-settings.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const frame = (action: "connect" | "create" | "disconnect" = "create"): ContextTreeOperationFrame => ({
  type: "context-tree:operation",
  requestId: randomUUID(),
  computerId: randomUUID(),
  agentId: randomUUID(),
  requireStopped: false,
  input: {
    operationId: randomUUID(),
    expectedRevision: 1,
    expectedRuntimeConfigRevision: 1,
    action,
    repository: action === "disconnect" ? null : "acme/memory",
  },
});
async function fixture(failureCode?: string) {
  const home = await mkdtemp(join(tmpdir(), "opentag-ct-settings-"));
  roots.push(home);
  const run = vi.fn(async (args: readonly string[]) =>
    args[0] === "connect" && args[1]?.endsWith("-context-tree")
      ? { payload: {}, failureCode: "NOT_FOUND" }
      : args[0] === "publish" && failureCode
        ? { payload: {}, failureCode }
        : { payload: { tree: { path: "/tree" } } },
  );
  const hasAgentSessions = vi.fn(() => false);
  const settings = new ContextTreeSettings({
    home,
    environment: {},
    run,
    hasAgentSessions,
    exclusive: async (operation) => operation(),
  });
  return { home, settings, run, hasAgentSessions };
}
it("creates and publishes once, verifies the tree and removes the isolated project connection", async () => {
  const { settings, run, home } = await fixture();
  const request = frame();
  expect(await settings.run(request)).toEqual({ status: "completed", repository: "acme/memory" });
  expect(run.mock.calls.map(([args]) => args[0])).toEqual([
    "connect",
    "create",
    "publish",
    "connect",
    "verify",
    "disconnect",
  ]);
  expect(run.mock.calls[0]?.[0]).toContain(
    join(home, "state", "context-tree-operations", contextTreeStagingName("acme/memory")),
  );
  await settings.run(request);
  expect(run).toHaveBeenCalledTimes(6);
  await settings.run({ ...request, input: { ...request.input, operationId: randomUUID() } });
  expect(run.mock.calls.filter(([args]) => args[0] === "publish")).toHaveLength(1);
});
it.each(["PUBLISH_INCOMPLETE", "TIMEOUT"])(
  "never repeats uncertain publication after %s, including with another operation ID",
  async (code) => {
    const { settings, run, home } = await fixture(code);
    const request = frame();
    expect(await settings.run(request)).toEqual({ status: "failed", code: "publication_uncertain" });
    const restarted = new ContextTreeSettings({ ...settings.options, home });
    expect(await restarted.run({ ...request, input: { ...request.input, operationId: randomUUID() } })).toEqual({
      status: "failed",
      code: "publication_uncertain",
    });
    expect(run.mock.calls.filter(([args]) => args[0] === "publish")).toHaveLength(1);
  },
);
it.each([
  ["GITHUB_AUTH", "authentication_required"],
  ["GITHUB_PERMISSION", "permission_denied"],
  ["REPOSITORY_EXISTS", "repository_exists"],
])("reports %s separately", async (code, expected) => {
  const { settings } = await fixture(code);
  expect(await settings.run(frame())).toEqual({ status: "failed", code: expected });
});
it("rejects reused operation identities and waits for stopped runtimes", async () => {
  const { settings, hasAgentSessions, run } = await fixture();
  const request = frame("connect");
  hasAgentSessions.mockReturnValue(true);
  expect(await settings.run({ ...request, requireStopped: true })).toEqual({ status: "failed", code: "busy" });
  expect(run).not.toHaveBeenCalled();
  hasAgentSessions.mockReturnValue(false);
  await settings.run(request);
  expect(await settings.run({ ...request, agentId: randomUUID() })).toEqual({
    status: "failed",
    code: "stale_configuration",
  });
});
it("does not mutate the live project connection during disconnect validation", async () => {
  const { settings, run } = await fixture();
  expect(await settings.run(frame("disconnect"))).toEqual({ status: "completed", repository: null });
  expect(run).not.toHaveBeenCalled();
});

it("uses a readable, case-insensitive staging identity inside the CLI naming limit", () => {
  const name = contextTreeStagingName("Acme/Team-Memory");
  expect(name).toMatch(/^acme-team-memory-[0-9a-f]{12}$/);
  expect(name).toBe(contextTreeStagingName("acme/team-memory"));
  expect(contextTreeStagingName(`acme/${"a".repeat(99)}`).length).toBeLessThanOrEqual(40);
});
it("preserves publication spelling and deduplicates concurrent identical work", async () => {
  const { settings, run } = await fixture();
  const request = frame();
  request.input.repository = "Acme/Memory";
  const first = settings.run(request);
  expect(settings.run({ ...request, requestId: randomUUID() })).toBe(first);
  expect(await settings.run({ ...request, agentId: randomUUID() })).toEqual({ status: "failed", code: "busy" });
  expect(await first).toEqual({ status: "completed", repository: "Acme/Memory" });
  expect(run.mock.calls.find(([args]) => args[0] === "publish")?.[0][1]).toBe("Acme/Memory");
});
it("never starts queued work after the total budget expires", async () => {
  const { settings, run } = await fixture();
  const queue: Array<() => Promise<unknown>> = [];
  const blocked = new ContextTreeSettings({
    ...settings.options,
    budgetMs: 30,
    exclusive: (operation) =>
      new Promise((resolve, reject) => {
        queue.push(() => operation().then(resolve, reject));
      }),
  });
  expect(await blocked.run(frame("connect"))).toEqual({ status: "failed", code: "failed" });
  for (const operation of queue) await operation().catch(() => undefined);
  expect(run).not.toHaveBeenCalled();
});
it("retains publication protection when shutdown interrupts publishing", async () => {
  const { settings, home } = await fixture();
  let publishing = false;
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "publish") {
      publishing = true;
      return new Promise<{ payload: unknown }>(() => undefined);
    }
    return { payload: { tree: { path: "/tree" } } };
  });
  const interrupted = new ContextTreeSettings({ ...settings.options, run });
  const request = frame();
  const pending = interrupted.run(request);
  await vi.waitFor(() => expect(publishing).toBe(true));
  interrupted.close();
  expect(await pending).toEqual({ status: "failed", code: "publication_uncertain" });
  const restarted = new ContextTreeSettings({ ...settings.options, home, run });
  expect(await restarted.run({ ...request, input: { ...request.input, operationId: randomUUID() } })).toEqual({
    status: "failed",
    code: "publication_uncertain",
  });
  expect(run.mock.calls.filter(([args]) => args[0] === "publish")).toHaveLength(1);
});
it("fences operation replay by both revisions", async () => {
  const { settings } = await fixture();
  const request = frame("connect");
  await settings.run(request);
  expect(await settings.run({ ...request, input: { ...request.input, expectedRuntimeConfigRevision: 2 } })).toEqual({
    status: "failed",
    code: "stale_configuration",
  });
});
