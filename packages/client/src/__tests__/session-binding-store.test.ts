import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  computeDirectInputHash,
  computeRuntimeSnapshotHashes,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { agentRuntimePaths, deriveRuntimeKey, sessionBindingPath, snapshotPath } from "../runtime/runtime-paths.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("SessionBindingStore", () => {
  it("C-16/C-17 persists immutable identities without storing a Home path or credential", async () => {
    const fixture = await bindingFixture();
    const binding = await fixture.store.read("agent-1", "session-1");
    expect(binding).toMatchObject({
      schemaVersion: 2,
      agentId: "agent-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      provider: "codex",
      providerHomeIdentity: fixture.homeIdentity,
    });
    const raw = await readFile(sessionBindingPath(fixture.home, "agent-1", "session-1"), "utf8");
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain("credential-canary");

    const mismatchedStore = new SessionBindingStore({
      home: fixture.home,
      providerArtifactIdentity: () => "b".repeat(64),
    });
    const mismatchedWorkspace = new AgentWorkspaceManager({ home: fixture.home, bindingStore: mismatchedStore });
    const mismatched = new SessionReconciler({ computerId: fixture.computerId, preparation: mismatchedWorkspace });
    await expect(mismatched.reconcile({ ...fixture.reconcile, requestId: randomUUID() })).rejects.toThrow(
      /identity|binding/i,
    );

    const unavailableStore = new SessionBindingStore({
      home: fixture.home,
      providerArtifactIdentity: () => undefined,
    });
    const unavailableWorkspace = new AgentWorkspaceManager({ home: fixture.home, bindingStore: unavailableStore });
    const unavailable = new SessionReconciler({ computerId: fixture.computerId, preparation: unavailableWorkspace });
    await expect(unavailable.reconcile({ ...fixture.reconcile, requestId: randomUUID() })).rejects.toThrow(
      "artifact identity is unavailable",
    );
  });

  it("stores each Session in an independent private file and isolates Agents", async () => {
    const fixture = await bindingFixture();
    const secondSession = { ...fixture.reconcile, requestId: randomUUID(), sessionId: "session-2" };
    const secondAgentRuntime = {
      ...snapshot(),
      agentId: "agent-2",
      workspace: { ...snapshot().workspace, workspaceId: "workspace-2" },
    };
    const secondAgent = {
      ...fixture.reconcile,
      requestId: randomUUID(),
      sessionId: "session-3",
      agentId: "agent-2",
      runtime: secondAgentRuntime,
    };

    await expect(
      Promise.all([fixture.reconciler.reconcile(secondSession), fixture.reconciler.reconcile(secondAgent)]),
    ).resolves.toEqual([expect.objectContaining({ status: "ready" }), expect.objectContaining({ status: "ready" })]);

    const firstPath = sessionBindingPath(fixture.home, "agent-1", "session-1");
    const secondPath = sessionBindingPath(fixture.home, "agent-1", "session-2");
    const otherAgentPath = sessionBindingPath(fixture.home, "agent-2", "session-3");
    expect(new Set([firstPath, secondPath, otherAgentPath]).size).toBe(3);
    await expect(readdir(agentRuntimePaths(fixture.home, "agent-1").sessions)).resolves.toHaveLength(2);
    await expect(readdir(agentRuntimePaths(fixture.home, "agent-2").sessions)).resolves.toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
      expect((await stat(agentRuntimePaths(fixture.home, "agent-1").sessions)).mode & 0o777).toBe(0o700);
    }
  });

  it("C-18 retains only the most recent 64 recorded input tombstones", async () => {
    const fixture = await bindingFixture();
    for (let index = 0; index < 65; index += 1) {
      const request = delivery(fixture.runtime, index);
      const inputHash = computeDirectInputHash(request);
      const turnId = `turn-${index}`;
      const resultHash = sha256(`result-${index}`);
      await fixture.store.recordAccepted(request, inputHash, turnId);
      await fixture.store.updateUnresolved("agent-1", "session-1", turnId, "reporting", { resultHash });
      await fixture.store.recordResult("agent-1", "session-1", turnId, resultHash);
    }
    const binding = await fixture.store.read("agent-1", "session-1");
    expect(binding?.recentRecordedInputs).toHaveLength(64);
    expect(binding?.recentRecordedInputs[0]?.deliveryId).toBe("delivery-1");
    expect(binding?.recentRecordedInputs.at(-1)?.deliveryId).toBe("delivery-64");
    const raw = await readFile(sessionBindingPath(fixture.home, "agent-1", "session-1"), "utf8");
    expect(raw).not.toContain("direct text 64");
  });

  it("C-19 enforces monotonic unresolved phases and reopens disk-only custody as recovery", async () => {
    const fixture = await bindingFixture();
    const request = delivery(fixture.runtime, 1);
    const inputHash = computeDirectInputHash(request);
    await fixture.store.recordAccepted(request, inputHash, "turn-1");
    await fixture.store.updateUnresolved("agent-1", "session-1", "turn-1", "starting");
    await fixture.store.updateUnresolved("agent-1", "session-1", "turn-1", "running", {
      providerTurnId: "provider-turn-1",
    });
    await expect(fixture.store.updateUnresolved("agent-1", "session-1", "turn-1", "starting")).rejects.toThrow(
      /backwards/,
    );

    const reopenedStore = new SessionBindingStore({
      home: fixture.home,
      providerArtifactIdentity: () => fixture.homeIdentity,
    });
    const reopenedWorkspace = new AgentWorkspaceManager({ home: fixture.home, bindingStore: reopenedStore });
    const reopened = new SessionReconciler({ computerId: fixture.computerId, preparation: reopenedWorkspace });
    await expect(reopened.reconcile({ ...fixture.reconcile, requestId: randomUUID() })).resolves.toMatchObject({
      status: "recovery_required",
      turn: { deliveryId: "delivery-1", turnId: "turn-1" },
    });
  });

  it("recreates a missing effective snapshot from the next Server reconcile", async () => {
    const fixture = await bindingFixture();
    const hashes = computeRuntimeSnapshotHashes(fixture.runtime);
    const path = snapshotPath(fixture.home, "agent-1", hashes.effectiveSnapshotHash);
    await rm(path);

    const reopenedStore = new SessionBindingStore({
      home: fixture.home,
      providerArtifactIdentity: () => fixture.homeIdentity,
    });
    const reopenedWorkspace = new AgentWorkspaceManager({ home: fixture.home, bindingStore: reopenedStore });
    const reopened = new SessionReconciler({ computerId: fixture.computerId, preparation: reopenedWorkspace });
    await expect(reopened.reconcile({ ...fixture.reconcile, requestId: randomUUID() })).resolves.toMatchObject({
      status: "ready",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(fixture.runtime);
  });

  it("keeps the immutable full Turn Report durable before and after acknowledgement", async () => {
    const fixture = await bindingFixture();
    const request = delivery(fixture.runtime, 1);
    const report = turnReport(request, "turn-1");
    await fixture.store.recordAccepted(request, computeDirectInputHash(request), report.turnId);
    await fixture.store.updateUnresolved("agent-1", "session-1", report.turnId, "reporting", {
      report,
      resultHash: report.resultHash,
    });

    const reopened = new SessionBindingStore({
      home: fixture.home,
      providerArtifactIdentity: () => fixture.homeIdentity,
    });
    expect((await reopened.read("agent-1", "session-1"))?.unresolvedTurn?.report).toEqual(report);
    await reopened.recordResult("agent-1", "session-1", report.turnId, report.resultHash);

    const recorded = await reopened.read("agent-1", "session-1");
    expect(recorded?.unresolvedTurn).toBeUndefined();
    expect(recorded?.recentRecordedInputs.at(-1)?.report).toEqual(report);
    await expect(reopened.recordResult("agent-1", "session-1", report.turnId, report.resultHash)).resolves.toEqual(
      recorded,
    );

    const active = delivery(fixture.runtime, 2);
    await reopened.recordAccepted(active, computeDirectInputHash(active), "turn-2");
    await expect(
      reopened.recordResult("agent-1", "session-1", report.turnId, report.resultHash),
    ).resolves.toMatchObject({ unresolvedTurn: { turnId: "turn-2" } });
  });

  it("C-16 fails closed when a binding JSON file is corrupted", async () => {
    const fixture = await bindingFixture();
    await writeFile(sessionBindingPath(fixture.home, "agent-1", "session-1"), "{not-json", "utf8");
    await expect(fixture.store.read("agent-1", "session-1")).rejects.toThrow(/invalid JSON/);
  });

  it("rejects invalid persisted Provider IDs in Session and Agent Runtime bindings", async () => {
    const fixture = await bindingFixture();
    const path = sessionBindingPath(fixture.home, "agent-1", "session-1");
    const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const invalidSession = structuredClone(original);
    invalidSession.provider = "";
    await writeFile(path, `${JSON.stringify(invalidSession)}\n`, "utf8");
    await expect(fixture.store.read("agent-1", "session-1")).rejects.toThrow("Session binding values are invalid");

    const invalidRuntime = structuredClone(original);
    invalidRuntime.runtimeBinding = { providerId: "Claude_Code", schemaVersion: 1, payload: {} };
    await writeFile(path, `${JSON.stringify(invalidRuntime)}\n`, "utf8");
    await expect(fixture.store.read("agent-1", "session-1")).rejects.toThrow("Agent Runtime binding is invalid");
  });

  it("reads Claude Code bindings from the existing Session binding v2 contract", async () => {
    const fixture = await bindingFixture();
    const path = sessionBindingPath(fixture.home, "agent-1", "session-1");
    const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    current.provider = "claude-code";
    current.runtimeBinding = {
      providerId: "claude-code",
      schemaVersion: 1,
      payload: { sessionId: randomUUID() },
    };
    await writeFile(path, `${JSON.stringify(current)}\n`, "utf8");

    await expect(fixture.store.read("agent-1", "session-1")).resolves.toMatchObject({
      schemaVersion: 2,
      provider: "claude-code",
      runtimeBinding: { providerId: "claude-code", schemaVersion: 1 },
    });
  });

  it("reads a legacy v1 Codex thread and rewrites only the opaque v2 binding", async () => {
    const fixture = await bindingFixture();
    const path = sessionBindingPath(fixture.home, "agent-1", "session-1");
    const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete current.runtimeBinding;
    current.schemaVersion = 1;
    current.providerThreadId = "legacy-thread";
    await writeFile(path, `${JSON.stringify(current)}\n`, "utf8");

    expect((await fixture.store.read("agent-1", "session-1"))?.runtimeBinding).toEqual({
      providerId: "codex",
      schemaVersion: 1,
      payload: { threadId: "legacy-thread" },
    });
    const reopenedWorkspace = new AgentWorkspaceManager({ home: fixture.home, bindingStore: fixture.store });
    const reopened = new SessionReconciler({ computerId: fixture.computerId, preparation: reopenedWorkspace });
    await expect(reopened.reconcile({ ...fixture.reconcile, requestId: randomUUID() })).resolves.toMatchObject({
      status: "ready",
    });
    const rewritten = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(rewritten).toMatchObject({
      schemaVersion: 2,
      runtimeBinding: { providerId: "codex", schemaVersion: 1, payload: { threadId: "legacy-thread" } },
    });
    expect(rewritten).not.toHaveProperty("providerThreadId");
  });

  it("does not reinterpret a legacy v1 Codex thread as a Claude Code binding", async () => {
    const fixture = await bindingFixture();
    const path = sessionBindingPath(fixture.home, "agent-1", "session-1");
    const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    delete current.runtimeBinding;
    current.schemaVersion = 1;
    current.provider = "claude-code";
    current.providerThreadId = "legacy-thread";
    await writeFile(path, `${JSON.stringify(current)}\n`, "utf8");

    await expect(fixture.store.read("agent-1", "session-1")).rejects.toThrow("Session binding values are invalid");
  });

  it("ignores the legacy runtime/agents binding without migrating or deleting it", async () => {
    const fixture = await unpreparedBindingFixture();
    const legacyPath = resolve(
      fixture.home,
      "data",
      "runtime",
      "agents",
      deriveRuntimeKey("agent", "agent-1"),
      "sessions",
      `${deriveRuntimeKey("session", "session-1")}.json`,
    );
    await mkdir(resolve(legacyPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(legacyPath, '{"legacy":true}\n', { mode: 0o600 });

    await expect(fixture.reconciler.reconcile(fixture.reconcile)).resolves.toMatchObject({ status: "ready" });
    expect(await readFile(legacyPath, "utf8")).toBe('{"legacy":true}\n');
    await expect(fixture.store.read("agent-1", "session-1")).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it.each(["type root", "Agent directory"] as const)(
    "fails closed when a direct binding read crosses a symlinked %s",
    async (linkLevel) => {
      const source = await bindingFixture();
      const fixture = await unpreparedBindingFixture();
      const external = await mkdtemp(resolve(tmpdir(), "opentag-binding-read-external-"));
      homes.push(external);
      const raw = await readFile(sessionBindingPath(source.home, "agent-1", "session-1"), "utf8");
      const agentKey = deriveRuntimeKey("agent", "agent-1");
      const sessionFile = `${deriveRuntimeKey("session", "session-1")}.json`;
      const paths = agentRuntimePaths(fixture.home, "agent-1");
      const externalBinding =
        linkLevel === "type root" ? resolve(external, agentKey, sessionFile) : resolve(external, sessionFile);

      if (linkLevel === "type root") {
        await mkdir(resolve(fixture.home, "data", "runtime"), { recursive: true, mode: 0o700 });
        await mkdir(resolve(external, agentKey), { recursive: true, mode: 0o700 });
        await symlink(external, resolve(fixture.home, "data", "runtime", "session-bindings"), "dir");
      } else {
        await mkdir(resolve(paths.sessions, ".."), { recursive: true, mode: 0o700 });
        await symlink(external, paths.sessions, "dir");
      }
      await writeFile(externalBinding, raw, { mode: 0o600 });

      await expect(fixture.store.read("agent-1", "session-1")).rejects.toThrow(/real director|directories/i);
      expect(await readFile(externalBinding, "utf8")).toBe(raw);
    },
  );

  it("does not mutate an external binding through a symlinked type root", async () => {
    const source = await bindingFixture();
    const fixture = await unpreparedBindingFixture();
    const external = await mkdtemp(resolve(tmpdir(), "opentag-binding-mutation-external-"));
    homes.push(external);
    const raw = await readFile(sessionBindingPath(source.home, "agent-1", "session-1"), "utf8");
    const agentKey = deriveRuntimeKey("agent", "agent-1");
    const sessionFile = `${deriveRuntimeKey("session", "session-1")}.json`;
    const externalAgent = resolve(external, agentKey);
    const externalBinding = resolve(externalAgent, sessionFile);
    const runtimeRoot = resolve(fixture.home, "data", "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await mkdir(externalAgent, { recursive: true, mode: 0o700 });
    await writeFile(externalBinding, raw, { mode: 0o600 });
    await symlink(external, resolve(runtimeRoot, "session-bindings"), "dir");
    const request = delivery(fixture.runtime, 77);

    await expect(
      fixture.store.recordAccepted(request, computeDirectInputHash(request), "turn-external"),
    ).rejects.toThrow(/real director|directories/i);
    expect(await readFile(externalBinding, "utf8")).toBe(raw);
  });

  it.each(["session-bindings", "effective-snapshots"] as const)(
    "fails closed on a symlinked %s type root",
    async (typeRoot) => {
      const fixture = await unpreparedBindingFixture();
      const external = await mkdtemp(resolve(tmpdir(), "opentag-binding-external-"));
      homes.push(external);
      const runtimeRoot = resolve(fixture.home, "data", "runtime");
      await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      await symlink(external, resolve(runtimeRoot, typeRoot), "dir");

      await expect(
        fixture.store.prepare(fixture.reconcile, computeRuntimeSnapshotHashes(fixture.runtime)),
      ).rejects.toThrow(/real director|directories/i);
      expect(await readdir(external)).toEqual([]);
    },
  );

  it.each(["session-bindings", "effective-snapshots"] as const)(
    "fails closed on a non-directory %s type root",
    async (typeRoot) => {
      const fixture = await unpreparedBindingFixture();
      const runtimeRoot = resolve(fixture.home, "data", "runtime");
      await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      await writeFile(resolve(runtimeRoot, typeRoot), "not-a-directory", "utf8");

      await expect(
        fixture.store.prepare(fixture.reconcile, computeRuntimeSnapshotHashes(fixture.runtime)),
      ).rejects.toThrow(/real director|directories/i);
    },
  );

  it.each(["sessions", "snapshots"] as const)("fails closed on a symlinked Agent %s directory", async (pathKey) => {
    const fixture = await unpreparedBindingFixture();
    const external = await mkdtemp(resolve(tmpdir(), "opentag-binding-agent-external-"));
    homes.push(external);
    const paths = agentRuntimePaths(fixture.home, "agent-1");
    const target = paths[pathKey];
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await symlink(external, target, "dir");

    await expect(
      fixture.store.prepare(fixture.reconcile, computeRuntimeSnapshotHashes(fixture.runtime)),
    ).rejects.toThrow(/real director|directories/i);
    expect(await readdir(external)).toEqual([]);
  });

  it.each(["sessions", "snapshots"] as const)("fails closed on a non-directory Agent %s path", async (pathKey) => {
    const fixture = await unpreparedBindingFixture();
    const paths = agentRuntimePaths(fixture.home, "agent-1");
    const target = paths[pathKey];
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, "not-a-directory", "utf8");

    await expect(
      fixture.store.prepare(fixture.reconcile, computeRuntimeSnapshotHashes(fixture.runtime)),
    ).rejects.toThrow(/real director|directories/i);
  });
});

async function bindingFixture() {
  const fixture = await unpreparedBindingFixture();
  await fixture.reconciler.reconcile(fixture.reconcile);
  return fixture;
}

async function unpreparedBindingFixture() {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-binding-test-"));
  homes.push(home);
  const computerId = randomUUID();
  const homeIdentity = "a".repeat(64);
  const store = new SessionBindingStore({ home, providerArtifactIdentity: () => homeIdentity });
  const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
  const reconciler = new SessionReconciler({ computerId, preparation: workspace });
  const runtime = snapshot();
  const reconcile: SessionReconcileRequest = {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
  return { computerId, home, homeIdentity, reconcile, reconciler, runtime, store, workspace };
}

function snapshot(): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId: "agent-1",
    provider: "codex",
    instructions: { platform: "platform", agent: "agent", session: "session" },
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
  };
}

function delivery(runtime: EffectiveRuntimeSnapshot, index: number): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: `delivery-${index}`,
    imMessageId: `message-${index}`,
    sessionId: "session-1",
    agentId: "agent-1",
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: `direct text ${index}`,
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "team-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: `1710000000.00000${index}`,
      },
    },
    runtime,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function turnReport(request: DirectImMessageDeliveryRequest, turnId: string): TurnReportRequest {
  const body = {
    deliveryId: request.deliveryId,
    turnId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "durable result",
    traceSummary: { lastSequence: 2, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
