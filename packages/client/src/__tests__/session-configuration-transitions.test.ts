import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  computeDirectInputHash,
  computeLegacyDirectInputHash,
  computeLegacyRuntimeSnapshotHashes,
  computeRuntimeImMessageSemanticHash,
  computeRuntimeSnapshotHashes,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { agentRuntimePaths, sessionBindingPath, snapshotPath } from "../runtime/runtime-paths.js";
import {
  type LocalSessionBinding,
  SESSION_BINDING_SCHEMA_VERSION,
  SessionBindingStore,
} from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import * as durableFiles from "../storage/durable-file.js";

const legacyLayouts = ["0.1.0", "self-configuration"] as const;
type SnapshotLayout = "current" | (typeof legacyLayouts)[number];
type Fixture = Awaited<ReturnType<typeof fixture>>;
const homes: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe.each(legacyLayouts)("Session configuration transitions from %s", (layout) => {
  it.each(["codex", "claude-code"] as const)(
    "SCT-01 preserves the %s conversation, history and original receipts during compatible migration",
    async (provider) => {
      const f = await fixture(layout, provider);
      const request = withRuntime(f, currentSnapshot(f.original, 2));
      const before = await persistedState(f);
      const prepared = await validateAndPrepare(f.store, request);

      expect(prepared.binding.runtimeBinding).toEqual(f.binding.runtimeBinding);
      await expectPreservedHistory(f, prepared.binding);
      expect(prepared.binding.lastEffectiveSnapshotHash).toBe(
        computeRuntimeSnapshotHashes(request.runtime).effectiveSnapshotHash,
      );
      expect(
        JSON.parse(await readFile(snapshotPath(f.home, "agent-1", prepared.binding.lastEffectiveSnapshotHash), "utf8")),
      ).toMatchObject({ execution: request.runtime.execution });
      expect(await readFile(f.originalSnapshotPath, "utf8")).toBe(before.snapshots[f.originalSnapshotFile]);

      const restarted = openStore(f.home);
      expect(await validateAndPrepare(restarted, request)).toEqual(prepared);
      expect((await persistedState(f)).snapshots).toHaveProperty(f.originalSnapshotFile);
    },
  );

  it("SCT-02 allows the existing format-only migration at an unchanged sequence", async () => {
    const f = await fixture(layout);
    const runtime = currentSnapshot(f.original, 1);
    const prepared = await validateAndPrepare(f.store, withRuntime(f, runtime));
    expect(prepared.binding.runtimeBinding).toEqual(f.binding.runtimeBinding);
    expect(prepared.binding.appliedSessionRevisionSequence).toBe(1);
    await expectPreservedHistory(f, prepared.binding);
  });

  it("SCT-03 validates a newer Soul without writes before committing it across restart", async () => {
    const f = await fixture(layout);
    const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), "Soul"));
    const hashes = computeRuntimeSnapshotHashes(request.runtime);
    const before = await persistedState(f);
    for (const store of [f.store, openStore(f.home)]) {
      await store.validatePreparation(request, hashes);
      expect(await persistedState(f)).toEqual(before);
    }
    const prepared = await f.store.prepare(request, hashes);
    expect(prepared.binding.runtimeBinding).toBeUndefined();
    expect(await openStore(f.home).prepare(request, hashes)).toEqual(prepared);
    await expectPreservedHistory(f, prepared.binding);
  });

  it("SCT-04 reconciles a newer Soul and admits the pending message after restart", async () => {
    const f = await fixture(layout);
    const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), "Soul"));
    const prepareAgent = vi.spyOn(f.workspace, "prepareAgent");
    const prepareSession = vi.spyOn(f.workspace, "prepareSession");
    for (const reconciler of [f.reconciler, createReconciler(f)]) {
      await expect(reconciler.reconcile({ ...request, requestId: randomUUID() })).resolves.toMatchObject({
        status: "ready",
      });
      expect(reconciler.checkDelivery(delivery(request.runtime, "pending"))).toBeUndefined();
    }
    expect(prepareAgent).toHaveBeenCalledOnce();
    expect(prepareSession).toHaveBeenCalledOnce();
    expect((await f.store.read("agent-1", "session-1"))?.runtimeBinding).toBeUndefined();
  });

  it("SCT-05 #980: prepares a newer Soul directly from the legacy binding", async () => {
    const f = await fixture(layout);
    const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), "Soul"));
    const prepared = await validateAndPrepare(f.store, request);
    expect(prepared.binding.runtimeBinding).toBeUndefined();
    expect(prepared.binding.sessionId).toBe(f.binding.sessionId);
    await expectPreservedHistory(f, prepared.binding);
    expect(await validateAndPrepare(openStore(f.home), request)).toEqual(prepared);
  });

  it("SCT-06 #980: reconciles a newer Soul and durably accepts the pending message once", async () => {
    const f = await fixture(layout);
    const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), "Soul"));
    await expect(f.reconciler.reconcile(request)).resolves.toMatchObject({ status: "ready" });
    expect(f.reconciler.checkDelivery(delivery(request.runtime, "pending"))).toBeUndefined();
    const binding = await f.store.read("agent-1", "session-1");
    expect(binding?.runtimeBinding).toBeUndefined();
    expect(binding?.recentRecordedInputs).toEqual(f.binding.recentRecordedInputs);
    await expectSingleCustody(f, request.runtime);
  });

  it.each(["Soul", "model", "reasoning effort"] as const)(
    "SCT-07 replaces the conversation for a newer %s after compatible migration has completed",
    async (change) => {
      const f = await fixture(layout);
      await validateAndPrepare(f.store, withRuntime(f, currentSnapshot(f.original, 2)));
      const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 3), change));
      await expect(f.reconciler.reconcile(request)).resolves.toMatchObject({ status: "ready" });
      const prepared = await validateAndPrepare(f.store, request);
      expect(prepared.binding.runtimeBinding).toBeUndefined();
      await expectPreservedHistory(f, prepared.binding);
      expect(f.reconciler.checkDelivery(delivery(request.runtime, "pending"))).toBeUndefined();
      await expectSingleCustody(f, request.runtime);
    },
  );

  it.each([
    "missing snapshot",
    "altered snapshot",
    "binding hash mismatch",
    "snapshot Agent mismatch",
    "workspace mismatch",
    "Provider mismatch",
    "artifact mismatch",
    "stale placement",
    "stale Agent revision",
    "stale Session revision",
    "same revision Soul conflict",
  ] as const)("SCT-08 protects %s without changing durable state", async (scenario) => {
    const f = await fixture(layout);
    const request = withRuntime(f, currentSnapshot(f.original, 2));
    const store = await applyInvalidScenario(f, request, scenario);
    const before = await persistedState(f);
    const hashes = computeRuntimeSnapshotHashes(request.runtime);
    const code = scenario === "stale placement" ? "stale" : "conflict";
    await expect(store.validatePreparation(request, hashes)).rejects.toMatchObject({ code });
    await expect(store.prepare(request, hashes)).rejects.toMatchObject({ code });
    expect(await persistedState(f)).toEqual(before);
  });

  it.each(["accepted", "starting", "running", "reporting"] as const)(
    "SCT-09 fences migration and Soul changes while a %s Turn remains unresolved",
    async (phase) => {
      const f = await fixture(layout);
      const pending = delivery(f.original, "unresolved");
      const report = completedReport(pending, "unresolved-turn");
      await durableFiles.writeDurableJson(f.bindingPath, {
        ...f.binding,
        unresolvedTurn: {
          requestId: pending.requestId,
          deliveryId: pending.deliveryId,
          inputHash: computeLegacyDirectInputHash(pending, layout),
          turnId: report.turnId,
          phase,
          ...(phase === "running" ? { providerTurnId: "native-unresolved-turn" } : {}),
          ...(phase === "reporting" ? { report, resultHash: report.resultHash } : {}),
        },
      });
      const before = await persistedState(f);
      for (const change of [false, true]) {
        const migrated = currentSnapshot(f.original, 2);
        const request = withRuntime(f, change ? changedSnapshot(migrated, "Soul") : migrated);
        const hashes = computeRuntimeSnapshotHashes(request.runtime);
        await expect(f.store.validatePreparation(request, hashes)).rejects.toMatchObject({ code: "recovery_required" });
        await expect(f.store.prepare(request, hashes)).rejects.toMatchObject({ code: "recovery_required" });
        expect(await persistedState(f)).toEqual(before);
      }
    },
  );
});

describe("Current-format Session configuration transitions", () => {
  it.each(["warm", "cold"])("SCT-26 applies the one-time runtime revision repair in a %s Client", async (process) => {
    const f = await fixture("current");
    if (process === "warm") {
      await expect(f.reconciler.reconcile(withRuntime(f, f.original))).resolves.toMatchObject({ status: "ready" });
    }
    const runtime = structuredClone(f.original);
    runtime.revision.agent.sequence = 2;
    runtime.revision.session.sequence = 2;
    const reconciler = process === "warm" ? f.reconciler : createReconciler(f);
    await expect(reconciler.reconcile(withRuntime(f, runtime))).resolves.toMatchObject({ status: "ready" });
    const prepared = await validateAndPrepare(openStore(f.home), withRuntime(f, runtime));
    expect(prepared.binding.runtimeBinding).toBeUndefined();
    await expectPreservedHistory(f, prepared.binding);
    await expectSingleCustody(f, runtime);
  });

  it.each([
    ["warm", true],
    ["warm", false],
    ["cold", true],
    ["cold", false],
  ] as const)("SCT-25 applies an owner opt-in change in a %s Client to %s", async (process, enabled) => {
    const f = await fixture("current", "codex", { selfConfigurationEnabled: !enabled });
    if (process === "warm") {
      await expect(f.reconciler.reconcile(withRuntime(f, f.original))).resolves.toMatchObject({ status: "ready" });
    }
    const runtime = currentSnapshot(f.original, 2);
    runtime.selfConfigurationEnabled = enabled;
    const reconciler = process === "warm" ? f.reconciler : createReconciler(f);
    await expect(reconciler.reconcile(withRuntime(f, runtime))).resolves.toMatchObject({ status: "ready" });
    expect(reconciler.checkDelivery(delivery(runtime, "pending"))).toBeUndefined();
    const prepared = await validateAndPrepare(openStore(f.home), withRuntime(f, runtime));
    expect(prepared.binding.runtimeBinding).toBeUndefined();
    await expectPreservedHistory(f, prepared.binding);
    await expectSingleCustody(f, runtime);
    await expect(createReconciler(f).reconcile(withRuntime(f, runtime))).resolves.toMatchObject({ status: "ready" });
  });

  it("SCT-24 rechecks unresolved work committed after the configuration preflight", async () => {
    const f = await fixture("current");
    await expect(f.reconciler.reconcile(withRuntime(f, f.original))).resolves.toMatchObject({ status: "ready" });
    const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), "Soul"));
    const hashes = computeRuntimeSnapshotHashes(request.runtime);
    await f.store.validatePreparation(request, hashes);
    const pending = delivery(f.original, "racing-delivery");
    await f.store.recordAccepted(pending, computeDirectInputHash(pending), "racing-turn");
    const before = await persistedState(f);

    await expect(f.store.prepare(request, hashes)).rejects.toMatchObject({ code: "recovery_required" });
    for (const requestId of [randomUUID(), randomUUID()]) {
      await expect(f.reconciler.reconcile({ ...request, requestId })).resolves.toMatchObject({
        status: "rejected",
        reason: "unresolved_turn",
      });
    }
    expect(f.reconciler.getSession("session-1")?.effectiveSnapshotHash).toBe(f.binding.lastEffectiveSnapshotHash);
    expect(await persistedState(f)).toEqual(before);
  });

  it("SCT-10 retains an unchanged native binding after a process restart", async () => {
    const f = await fixture("current");
    const before = await persistedState(f);
    const prepared = await validateAndPrepare(openStore(f.home), withRuntime(f, f.original));
    expect(prepared.binding).toEqual(f.binding);
    const after = await persistedState(f);
    expect(JSON.parse(after.binding)).toEqual(JSON.parse(before.binding));
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.history).toBe(before.history);
  });

  it.each(["Soul", "model", "reasoning effort"] as const)(
    "SCT-11 replaces the native binding for a newer %s and preserves delivery deduplication",
    async (change) => {
      const f = await fixture("current");
      const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), change));
      const prepared = await validateAndPrepare(f.store, request);
      expect(prepared.binding.runtimeBinding).toBeUndefined();
      await expectPreservedHistory(f, prepared.binding);
      await expectSingleCustody(f, request.runtime);
    },
  );

  it.each(["model", "reasoning effort"] as const)(
    "SCT-12 rejects same-revision %s conflicts after restart",
    async (change) => {
      const f = await fixture("current");
      const before = await persistedState(f);
      const request = withRuntime(f, changedSnapshot(f.original, change));
      const store = openStore(f.home);
      await expect(validateAndPrepare(store, request)).rejects.toMatchObject({ code: "conflict" });
      expect(await persistedState(f)).toEqual(before);
    },
  );

  it("SCT-14 rejects a same-revision Soul conflict both warm and after restart", async () => {
    const f = await fixture("current");
    await expect(f.reconciler.reconcile(withRuntime(f, f.original))).resolves.toMatchObject({ status: "ready" });
    const runtime = changedSnapshot(f.original, "Soul");
    runtime.revision.agent.id = "conflicting-agent-revision";
    const request = withRuntime(f, runtime);
    const before = await persistedState(f);
    await expect(f.reconciler.reconcile(request)).resolves.toMatchObject({
      status: "rejected",
      reason: "configuration_conflict",
    });
    expect(await persistedState(f)).toEqual(before);

    await expect(createReconciler(f).reconcile({ ...request, requestId: randomUUID() })).resolves.toMatchObject({
      status: "rejected",
      reason: "session_binding_conflict",
    });
    expect(await persistedState(f)).toEqual(before);
  });

  it("SCT-15 rejects a same-revision Soul conflict after restart using the persisted Agent configuration", async () => {
    const f = await fixture("current");
    const runtime = changedSnapshot(f.original, "Soul");
    runtime.revision.agent.id = "conflicting-agent-revision";
    const before = await persistedState(f);
    const result = await createReconciler(f).reconcile(withRuntime(f, runtime));
    expect(result.status).toBe("rejected");
    expect(await persistedState(f)).toEqual(before);
  });

  it.each(["running", "reporting"] as const)(
    "SCT-16 waits for an active %s Turn before applying a newer Soul",
    async (phase) => {
      const f = await fixture("current");
      await expect(f.reconciler.reconcile(withRuntime(f, f.original))).resolves.toMatchObject({ status: "ready" });
      f.reconciler.setActivity("session-1", { phase, deliveryId: "active-delivery", turnId: "active-turn" });
      const before = await persistedState(f);
      const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), "Soul"));
      await expect(f.reconciler.reconcile(request)).resolves.toMatchObject({
        status: "busy",
        reason: "agent_configuration_busy",
      });
      expect(await persistedState(f)).toEqual(before);
    },
  );
});

describe.each(["current", ...legacyLayouts] as const)("Persisted %s revision boundaries", (layout) => {
  describe.each([true, false])("with native binding: %s", (nativeBinding) => {
    it.each([
      "newer Agent",
      "newer Session",
      "same Agent content",
      "same Session content",
      "new Session conflicting Agent",
      "new Agent conflicting Session",
      "stale Agent",
      "stale Session",
    ] as const)("SCT-17 checks %s independently after restart", async (scenario) => {
      const f = await fixture(layout);
      if (!nativeBinding) {
        delete f.binding.runtimeBinding;
        await durableFiles.writeDurableJson(f.bindingPath, f.binding);
      }
      const runtime = revisionScenario(f.original, layout, scenario);
      const request = withRuntime(f, runtime);
      const store = openStore(f.home);
      const before = await persistedState(f);
      if (scenario === "newer Agent" || scenario === "newer Session") {
        const prepared = await validateAndPrepare(store, request);
        expect(prepared.binding.runtimeBinding).toBeUndefined();
        await expectPreservedHistory(f, prepared.binding);
        expect(await validateAndPrepare(openStore(f.home), request)).toEqual(prepared);
      } else {
        const hashes = computeRuntimeSnapshotHashes(runtime);
        await expect(store.validatePreparation(request, hashes)).rejects.toMatchObject({
          name: "SessionBindingConflictError",
        });
        await expect(store.prepare(request, hashes)).rejects.toMatchObject({ name: "SessionBindingConflictError" });
        expect(await persistedState(f)).toEqual(before);
      }
    });

    it("SCT-18 rejects changed configuration when the original snapshot is missing", async () => {
      const f = await fixture(layout);
      if (!nativeBinding) {
        delete f.binding.runtimeBinding;
        await durableFiles.writeDurableJson(f.bindingPath, f.binding);
      }
      await rm(f.originalSnapshotPath);
      const before = await persistedState(f);
      const request = withRuntime(f, changedSnapshot(currentSnapshot(f.original, 2), "Soul"));
      await expect(validateAndPrepare(openStore(f.home), request)).rejects.toMatchObject({ code: "conflict" });
      expect(await persistedState(f)).toEqual(before);
    });
  });

  it.each(["completed", "cancelled"] as const)(
    "SCT-19 preserves steer redelivery semantics after a %s target and configuration replacement",
    async (outcome) => {
      const f = await fixture(layout);
      const root = delivery(f.original, "root");
      const pending = delivery(f.original, "steer");
      const reportBody = {
        ...completedReport(root, "root-turn"),
        outcome,
        executionEffects: outcome === "completed" ? ("completed" as const) : ("may_have_occurred" as const),
        ...(outcome === "cancelled" ? { errorReason: "client_shutdown" as const } : {}),
      };
      const report = { ...reportBody, resultHash: computeTurnResultHash(reportBody) };
      await durableFiles.writeDurableJson(f.bindingPath, {
        ...f.binding,
        unresolvedTurn: {
          requestId: root.requestId,
          deliveryId: root.deliveryId,
          turnId: report.turnId,
          inputHash: layout === "current" ? computeDirectInputHash(root) : computeLegacyDirectInputHash(root, layout),
          phase: "reporting",
          report,
          resultHash: report.resultHash,
        },
      });
      const steer = {
        type: "im:steer" as const,
        requestId: pending.requestId,
        deliveryId: pending.deliveryId,
        imMessageId: pending.imMessageId,
        agentId: pending.agentId,
        sessionId: pending.sessionId,
        placementGeneration: pending.placementGeneration,
        rootDeliveryId: root.deliveryId,
        expectedTurnId: report.turnId,
        attention: "direct" as const,
        content: pending.content,
      };
      const receipt = await f.store.recordSteer(steer, computeRuntimeImMessageSemanticHash(steer));
      await f.store.recordResult("agent-1", "session-1", report.turnId, report.resultHash);
      const receipts = (await f.store.read("agent-1", "session-1"))?.recentRecordedInputs;
      const runtime = changedSnapshot(currentSnapshot(f.original, 2), "Soul");
      const prepared = await validateAndPrepare(openStore(f.home), withRuntime(f, runtime));
      expect(prepared.binding.recentRecordedInputs).toEqual(receipts);
      expect(prepared.binding.recentRecordedInputs).toContainEqual(expect.objectContaining({ report }));
      const redelivery = { ...pending, requestId: randomUUID(), runtime };
      const result = await openStore(f.home).recordAccepted(
        redelivery,
        computeDirectInputHash(redelivery),
        "next-turn",
      );
      if (outcome === "completed") expect(result).toMatchObject({ status: "absorbed", recorded: receipt });
      else expect(result).toMatchObject({ status: "committed", unresolvedTurn: { deliveryId: pending.deliveryId } });
    },
  );
});

describe("Current snapshot integrity", () => {
  it.each([true, false])("SCT-20 restores an exact missing snapshot with native binding: %s", async (native) => {
    const f = await fixture("current");
    if (!native) {
      delete f.binding.runtimeBinding;
      await durableFiles.writeDurableJson(f.bindingPath, f.binding);
    }
    await rm(f.originalSnapshotPath);
    const prepared = await validateAndPrepare(openStore(f.home), withRuntime(f, f.original));
    expect(prepared.binding).toEqual(f.binding);
    expect(JSON.parse(await readFile(f.originalSnapshotPath, "utf8"))).toEqual(f.original);
  });

  it.each(["Agent ID", "Session ID", "Session hash", "snapshot content"])(
    "SCT-21 rejects current-format %s inconsistency before preparation",
    async (scenario) => {
      const f = await fixture("current");
      const runtime = structuredClone(f.original);
      if (scenario === "Agent ID") runtime.revision.agent.id = "conflicting";
      if (scenario === "Session ID") runtime.revision.session.id = "conflicting";
      if (scenario === "Session hash") {
        await durableFiles.writeDurableJson(f.bindingPath, { ...f.binding, sessionConfigHash: "0".repeat(64) });
      }
      if (scenario === "snapshot content") {
        await durableFiles.writeDurableJson(f.originalSnapshotPath, changedSnapshot(f.original, "Soul"));
      }
      const before = await persistedState(f);
      const prepareAgent = vi.spyOn(f.workspace, "prepareAgent");
      await expect(f.reconciler.reconcile(withRuntime(f, runtime))).resolves.toMatchObject({ status: "rejected" });
      expect(prepareAgent).not.toHaveBeenCalled();
      expect(await persistedState(f)).toEqual(before);
    },
  );
});

describe.each(legacyLayouts)("Legacy %s permission boundaries", (layout) => {
  it.each([1, 2])("SCT-22 handles network widening at revision %s without native reuse", async (sequence) => {
    const f = await fixture(layout, "codex", { execution: { approvalPolicy: "never", networkAccess: false } });
    const runtime = currentSnapshot(f.original, sequence);
    runtime.execution.networkAccess = true;
    const before = await persistedState(f);
    if (sequence === 1) {
      await expect(validateAndPrepare(f.store, withRuntime(f, runtime))).rejects.toMatchObject({ code: "conflict" });
      expect(await persistedState(f)).toEqual(before);
    } else {
      const prepared = await validateAndPrepare(f.store, withRuntime(f, runtime));
      expect(prepared.binding.runtimeBinding).toBeUndefined();
      await expectPreservedHistory(f, prepared.binding);
    }
  });

  it.each([1, 2])("SCT-23 respects self-configuration history at revision %s", async (sequence) => {
    const f = await fixture(layout);
    const runtime = currentSnapshot(f.original, sequence);
    runtime.selfConfigurationEnabled = !f.original.selfConfigurationEnabled;
    const before = await persistedState(f);
    if (layout === "self-configuration" && sequence === 1) {
      await expect(validateAndPrepare(f.store, withRuntime(f, runtime))).rejects.toMatchObject({ code: "conflict" });
      expect(await persistedState(f)).toEqual(before);
    } else {
      const prepared = await validateAndPrepare(f.store, withRuntime(f, runtime));
      expect(prepared.binding.runtimeBinding).toEqual(layout === "0.1.0" ? f.binding.runtimeBinding : undefined);
      await expectPreservedHistory(f, prepared.binding);
    }
  });
});

describe.each([
  ["current", true],
  ["0.1.0", false],
  ["self-configuration", false],
  ["0.1.0", true],
  ["self-configuration", true],
] as const)("Interrupted %s Session transitions with Soul change: %s", (layout, changeSoul) => {
  it.each(["before snapshot", "before binding", "after binding"] as const)(
    "SCT-13 restarts safely after interruption %s and accepts a new delivery only once",
    async (stage) => {
      const f = await fixture(layout);
      const migrated = currentSnapshot(f.original, 2);
      const request = withRuntime(f, changeSoul ? changedSnapshot(migrated, "Soul") : migrated);
      const hashes = computeRuntimeSnapshotHashes(request.runtime);
      const nextSnapshotPath = snapshotPath(f.home, "agent-1", hashes.effectiveSnapshotHash);
      const before = await persistedState(f);
      const write = durableFiles.writeDurableJson;
      const target = stage === "before snapshot" ? nextSnapshotPath : f.bindingPath;
      const interruption = vi.spyOn(durableFiles, "writeDurableJson").mockImplementation(async (path, value) => {
        if (path !== target) return write(path, value);
        if (stage === "after binding") await write(path, value);
        throw new Error("simulated transition interruption");
      });
      try {
        await expect(validateAndPrepare(f.store, request)).rejects.toThrow("simulated transition interruption");
        expect(interruption).toHaveBeenCalledWith(target, expect.anything());
      } finally {
        interruption.mockRestore();
      }
      const interrupted = await persistedState(f);
      expect(interrupted.snapshots[f.originalSnapshotFile]).toBe(before.snapshots[f.originalSnapshotFile]);
      if (stage === "before snapshot") expect(interrupted).toEqual(before);
      else {
        expect(JSON.parse(await readFile(nextSnapshotPath, "utf8"))).toMatchObject(request.runtime);
        if (stage === "before binding") expect(interrupted.binding).toBe(before.binding);
        else expect(JSON.parse(interrupted.binding).lastEffectiveSnapshotHash).toBe(hashes.effectiveSnapshotHash);
      }

      const restarted = openStore(f.home);
      const prepared = await validateAndPrepare(restarted, request);
      expect(prepared.binding.runtimeBinding).toEqual(changeSoul ? undefined : f.binding.runtimeBinding);
      await expectPreservedHistory(f, prepared.binding);
      expect(await validateAndPrepare(restarted, request)).toEqual(prepared);
      await expectSingleCustody(f, request.runtime);
    },
  );
});

function revisionScenario(original: EffectiveRuntimeSnapshot, layout: SnapshotLayout, scenario: string) {
  const runtime = layout === "current" ? structuredClone(original) : currentSnapshot(original, 1);
  if (["newer Agent", "same Agent content", "new Session conflicting Agent"].includes(scenario)) {
    runtime.instructions.agent = "Changed Soul";
  }
  if (["newer Session", "same Session content", "new Agent conflicting Session"].includes(scenario)) {
    runtime.model = "changed-model";
  }
  if (["newer Agent", "new Agent conflicting Session"].includes(scenario)) {
    runtime.revision.agent = { sequence: 2, id: "new-agent" };
  }
  if (["newer Session", "new Session conflicting Agent"].includes(scenario)) {
    runtime.revision.session = { sequence: 2, id: "new-session" };
  }
  if (scenario === "stale Agent") runtime.revision.agent.sequence = 0;
  if (scenario === "stale Session") runtime.revision.session.sequence = 0;
  return runtime;
}

async function fixture(
  layout: SnapshotLayout,
  provider: "codex" | "claude-code" = "codex",
  overrides: Partial<EffectiveRuntimeSnapshot> = {},
) {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-session-transition-"));
  homes.push(home);
  const original: EffectiveRuntimeSnapshot = {
    agentId: "agent-1",
    provider,
    contextTrees: [],
    revision: { agent: { sequence: 1, id: "agent-original" }, session: { sequence: 1, id: "session-original" } },
    instructions: { platform: "platform", agent: "Research and writing", session: "session" },
    model: "original-model",
    reasoningEffort: "low",
    workspace: { workspaceId: "workspace-1", mode: "empty_on_create", sharing: "agent" },
    execution:
      layout === "current"
        ? { approvalPolicy: "on-request", networkAccess: false, allowCommands: [] }
        : { approvalPolicy: "never", networkAccess: true },
    ...(layout === "0.1.0" ? {} : { selfConfigurationEnabled: true }),
    ...overrides,
  };
  const hashes =
    layout === "current"
      ? computeRuntimeSnapshotHashes(original)
      : computeLegacyRuntimeSnapshotHashes(original, layout);
  const store = openStore(home);
  const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
  await workspace.prepareAgent(original, hashes);
  const historyPath = resolve(await workspace.cwd("agent-1"), "user-history.txt");
  await writeFile(historyPath, "Keep the user's existing workspace and history.\n");
  const oldDelivery = delivery(original, "historical");
  const report = completedReport(oldDelivery, "historical-turn");
  const binding: LocalSessionBinding = {
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    sessionId: "session-1",
    agentId: "agent-1",
    workspaceId: original.workspace.workspaceId,
    placementGeneration: 1,
    provider,
    providerHomeIdentity: "a".repeat(64),
    runtimeBinding: {
      providerId: provider,
      schemaVersion: 1,
      payload: provider === "codex" ? { threadId: "original-thread" } : { sessionId: "original-conversation" },
    },
    appliedSessionRevisionSequence: 1,
    appliedSessionRevisionId: original.revision.session.id,
    sessionConfigHash: hashes.sessionConfigHash,
    lastEffectiveSnapshotHash: hashes.effectiveSnapshotHash,
    recentRecordedInputs: [
      {
        kind: "turn",
        deliveryId: oldDelivery.deliveryId,
        requestId: oldDelivery.requestId,
        turnId: report.turnId,
        resultHash: report.resultHash,
        report,
        inputHash:
          layout === "current"
            ? computeDirectInputHash(oldDelivery)
            : computeLegacyDirectInputHash(oldDelivery, layout),
      },
    ],
  };
  const paths = agentRuntimePaths(home, "agent-1");
  await durableFiles.ensurePrivateDirectory(home, paths.sessions);
  await durableFiles.ensurePrivateDirectory(home, paths.snapshots);
  const bindingPath = sessionBindingPath(home, "agent-1", "session-1");
  const originalSnapshotPath = snapshotPath(home, "agent-1", hashes.effectiveSnapshotHash);
  await durableFiles.writeDurableJson(originalSnapshotPath, original);
  await durableFiles.writeDurableJson(bindingPath, binding);
  const installationId = randomUUID();
  const reconciler = new SessionReconciler({ installationId, preparation: workspace });
  return {
    home,
    original,
    store,
    workspace,
    binding,
    bindingPath,
    originalSnapshotPath,
    historyPath,
    installationId,
    reconciler,
    originalSnapshotFile: originalSnapshotPath.slice(paths.snapshots.length + 1),
  };
}

function openStore(home: string) {
  return new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
}

async function applyInvalidScenario(f: Fixture, request: ReturnType<typeof withRuntime>, scenario: string) {
  switch (scenario) {
    case "missing snapshot":
      await rm(f.originalSnapshotPath);
      break;
    case "altered snapshot":
      await writeFile(f.originalSnapshotPath, JSON.stringify(changedSnapshot(f.original, "Soul")));
      break;
    case "snapshot Agent mismatch":
      await writeFile(f.originalSnapshotPath, JSON.stringify({ ...f.original, agentId: "another-agent" }));
      break;
    case "binding hash mismatch":
      await durableFiles.writeDurableJson(f.bindingPath, { ...f.binding, sessionConfigHash: "0".repeat(64) });
      break;
    case "workspace mismatch":
      request.runtime.workspace.workspaceId = "another-workspace";
      break;
    case "Provider mismatch":
      request.runtime.provider = "claude-code";
      break;
    case "artifact mismatch":
      return new SessionBindingStore({ home: f.home, providerArtifactIdentity: () => "b".repeat(64) });
    case "stale placement":
      request.placementGeneration = 0;
      break;
    case "stale Agent revision":
      request.runtime.revision.agent.sequence = 0;
      break;
    case "stale Session revision":
      request.runtime.revision.session.sequence = 0;
      break;
    case "same revision Soul conflict":
      request.runtime = changedSnapshot(currentSnapshot(f.original, 1), "Soul");
      break;
    default:
      throw new Error(`Unknown invalid scenario: ${scenario}`);
  }
  return f.store;
}

function createReconciler(f: Fixture) {
  return new SessionReconciler({
    installationId: f.installationId,
    preparation: new AgentWorkspaceManager({ home: f.home, bindingStore: openStore(f.home) }),
  });
}

function currentSnapshot(original: EffectiveRuntimeSnapshot, sequence: number): EffectiveRuntimeSnapshot {
  return {
    ...structuredClone(original),
    selfConfigurationEnabled: original.selfConfigurationEnabled ?? false,
    revision: {
      agent: { sequence, id: `agent-current-${sequence}` },
      session: { sequence, id: `session-current-${sequence}` },
    },
    execution: { approvalPolicy: "on-request", networkAccess: original.provider === "claude-code", allowCommands: [] },
  };
}

function changedSnapshot(original: EffectiveRuntimeSnapshot, change: "Soul" | "model" | "reasoning effort") {
  const changed = structuredClone(original);
  if (change === "Soul") changed.instructions.agent = "Software engineering";
  if (change === "model") changed.model = "replacement-model";
  if (change === "reasoning effort") changed.reasoningEffort = "high";
  return changed;
}

function withRuntime(f: Fixture, runtime: EffectiveRuntimeSnapshot) {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    installationId: f.installationId,
    agentId: "agent-1",
    sessionId: "session-1",
    placementGeneration: 1,
    desired: "ready",
    runtime,
  } satisfies SessionReconcileRequest;
}

async function validateAndPrepare(store: SessionBindingStore, request: SessionReconcileRequest) {
  if (!request.runtime) throw new Error("The test must provide a runtime snapshot");
  const hashes = computeRuntimeSnapshotHashes(request.runtime);
  await store.validatePreparation(request, hashes);
  return store.prepare(request, hashes);
}

async function persistedState(f: Fixture) {
  const snapshots = agentRuntimePaths(f.home, "agent-1").snapshots;
  const entries = await Promise.all(
    (await readdir(snapshots)).sort().map(async (name) => [name, await readFile(resolve(snapshots, name), "utf8")]),
  );
  return {
    binding: await readFile(f.bindingPath, "utf8"),
    snapshots: Object.fromEntries(entries) as Record<string, string>,
    history: await readFile(f.historyPath, "utf8"),
  };
}

async function expectPreservedHistory(f: Fixture, binding: LocalSessionBinding) {
  expect(binding).toMatchObject({
    sessionId: f.binding.sessionId,
    agentId: f.binding.agentId,
    workspaceId: f.binding.workspaceId,
    placementGeneration: f.binding.placementGeneration,
    recentRecordedInputs: f.binding.recentRecordedInputs,
  });
  expect(JSON.parse(await readFile(f.originalSnapshotPath, "utf8"))).toEqual(f.original);
  expect(await readFile(f.historyPath, "utf8")).toBe("Keep the user's existing workspace and history.\n");
}

async function expectSingleCustody(f: Fixture, runtime: EffectiveRuntimeSnapshot) {
  const pending = delivery(runtime, "pending");
  const hash = computeDirectInputHash(pending);
  const store = openStore(f.home);
  await expect(store.recordAccepted(pending, hash, "pending-turn")).resolves.toMatchObject({ status: "committed" });
  await expect(openStore(f.home).recordAccepted(pending, hash, "pending-turn")).resolves.toMatchObject({
    status: "existing",
  });
  const report = completedReport(pending, "pending-turn");
  await store.updateUnresolved("agent-1", "session-1", report.turnId, "reporting", {
    report,
    resultHash: report.resultHash,
  });
  await store.recordResult("agent-1", "session-1", report.turnId, report.resultHash);
  await expect(openStore(f.home).recordAccepted(pending, hash, "pending-turn")).resolves.toMatchObject({
    status: "recorded",
    recorded: { inputHash: hash, report, resultHash: report.resultHash },
  });
  expect((await store.read("agent-1", "session-1"))?.recentRecordedInputs).toEqual([
    ...f.binding.recentRecordedInputs,
    expect.objectContaining({ deliveryId: pending.deliveryId, turnId: "pending-turn" }),
  ]);
}

function delivery(runtime: EffectiveRuntimeSnapshot, id: string): DirectImMessageDeliveryRequest {
  return {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId: `delivery-${id}`,
    imMessageId: `message-${id}`,
    agentId: "agent-1",
    sessionId: "session-1",
    placementGeneration: 1,
    attention: "direct",
    runtime,
    content: {
      kind: "text",
      text: `Message ${id}`,
      providerRef: {
        provider: "slack",
        appId: "app-1",
        teamId: "team-1",
        botUserId: "bot-1",
        channelId: "channel-1",
        messageTs: `1710000000.${id}`,
      },
    },
  };
}

function completedReport(request: DirectImMessageDeliveryRequest, turnId: string): TurnReportRequest {
  const body = {
    deliveryId: request.deliveryId,
    turnId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    finalText: "Historical result",
    traceSummary: { lastSequence: 1, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
