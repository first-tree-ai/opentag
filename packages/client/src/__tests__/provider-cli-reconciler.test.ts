import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IM_CLI_PROVIDERS, RUNTIME_CAPABILITY, RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import {
  computeFileIdentity,
  computeTargetFingerprint,
  PROVIDER_CLI_LOCK_BUSY_MAX_ATTEMPTS,
  PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS,
  type ProviderCliInspection,
  ProviderCliReconciler,
  type ProviderCliReconcilerOptions,
  ProviderCliValidationRunner,
  type RuntimeBusinessFrame,
  readProviderCliSelection,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "../index.js";
import { type RecordedLog, recordingLogger } from "./recording-logger.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const grantId = "55555555-5555-4555-8555-555555555555";
const agentId = "22222222-2222-4222-8222-222222222222";
const integrationId = "33333333-3333-4333-8333-333333333333";
const otherIntegrationId = "66666666-6666-4666-8666-666666666666";

const requirement = {
  type: "provider-cli:requirement" as const,
  operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
  requestId,
  provider: "slack" as const,
  agentId,
  integrationId,
  credentialGeneration: 2,
  expectedIdentity: { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" },
};

function connection(options: { capabilityVersion?: (capability: string) => number | undefined } = {}) {
  const listeners = new Set<(frame: { readonly type: string } & Record<string, unknown>) => void | Promise<void>>();
  const send = vi.fn<ProviderCliReconcilerOptions["connection"]["send"]>(async () => undefined);
  const setImCliReadiness = vi.fn(
    (..._args: Parameters<ProviderCliReconcilerOptions["connection"]["setImCliReadiness"]>) => undefined,
  );
  return {
    send,
    subscribeBusinessFrames: (
      listener: Parameters<ProviderCliReconcilerOptions["connection"]["subscribeBusinessFrames"]>[0],
    ) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capabilityVersion: options.capabilityVersion ?? (() => 1),
    setImCliReadiness,
    emit(frame: { readonly type: string } & Record<string, unknown>) {
      return Promise.all([...listeners].map((listener) => listener(frame)));
    },
  };
}

const prewarm = {
  type: "provider-cli:prewarm" as const,
  requestId,
  providers: [...IM_CLI_PROVIDERS],
};

type ReadyInspection = ProviderCliInspection & {
  readonly fingerprint: string;
  readonly selection: NonNullable<ProviderCliInspection["selection"]>;
};

function readyInspect(overrides: Partial<ReadyInspection> = {}): ReadyInspection {
  return {
    provider: "slack",
    state: "ready",
    readiness: "ready" as const,
    fingerprint: "v1:abc",
    selection: {
      kind: "managed" as const,
      path: "/bin/true",
      version: "4.7.0",
      generation: 1,
      trust: "catalog-verified" as const,
    },
    launcher: { path: "/bin/true", status: "valid" },
    globalCommand: { active: true, path: "/bin/true", resolvedPath: "/bin/true" },
    warnings: [],
    ...overrides,
  };
}

function notReadyInspect(
  provider: "feishu" | "slack",
  readiness: "install" | "unavailable",
  diagnostic: ProviderCliInspection["diagnostic"],
): ProviderCliInspection {
  return {
    provider,
    state: readiness === "install" ? "absent" : "unavailable",
    readiness,
    launcher: { path: `/tmp/${provider}`, status: "missing" },
    globalCommand: { active: false },
    warnings: [],
    ...(diagnostic ? { diagnostic } : {}),
  };
}

async function externalReadyFixture() {
  const accountHome = await mkdtemp(join(tmpdir(), "opentag-reconcile-ready-"));
  const layout = resolveProviderCliAccountLayout(accountHome);
  await mkdir(layout.state, { recursive: true });
  const target = join(accountHome, "slack");
  await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const identity = await computeFileIdentity(target);
  const fingerprint = computeTargetFingerprint(identity, "4.7.0");
  const selection = await writeProviderCliSelection(
    layout,
    "slack",
    {
      kind: "external",
      executablePath: identity.path,
      fingerprint,
      trust: "catalog-verified",
      version: "4.7.0",
    },
    undefined,
  );
  return {
    inspection: readyInspect({
      fingerprint,
      selection: {
        kind: "external",
        path: identity.path,
        version: "4.7.0",
        generation: selection.generation,
        trust: "catalog-verified",
      },
    }),
    layout,
    selection,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve: () => resolve() };
}

function holdFirstInspect(result: () => ProviderCliInspection | Promise<ProviderCliInspection>) {
  const gate = deferred();
  let hold = true;
  const inspect = vi.fn(async () => {
    if (hold) {
      hold = false;
      await gate.promise;
    }
    return result();
  });
  return { inspect, release: () => gate.resolve() };
}

function isAbortFailure(error: unknown, reason?: unknown): boolean {
  if (reason !== undefined && error === reason) return true;
  return error instanceof Error && error.name === "AbortError";
}

function grantFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: "provider-cli:validation:grant",
    requestId: grantId,
    requirementRequestId: requestId,
    provider: "slack",
    agentId,
    integrationId,
    credentialGeneration: 2,
    expiresAt: "2026-08-31T00:00:20.000Z",
    expectedIdentity: requirement.expectedIdentity,
    grant: { provider: "slack", botAccessToken: "xoxb-secret" },
    ...overrides,
  };
}

describe("provider CLI reconciler", () => {
  it("does not inspect or mutate without a binding requirement", async () => {
    const inspect = vi.fn();
    const ensure = vi.fn();
    new ProviderCliReconciler({
      connection: connection(),
      manager: { inspect, ensure, layout: { root: "/tmp" } as never },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("inspects, auto-repairs with managed-only, reinspects, and publishes coarse artifact status", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ readiness: "install", diagnostic: { code: "not_installed" } })
      .mockResolvedValueOnce(fixture.inspection);
    const ensure = vi.fn().mockResolvedValue({ ok: true, action: "installed-managed" } as never);
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    expect(ensure).toHaveBeenCalledWith("slack", { mode: "managed-only" });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(runtime.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "provider-cli:artifact:status", status: "checking", requestId }),
      expect.anything(),
    );
    expect(runtime.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "provider-cli:artifact:status", status: "ready", requestId }),
      expect.anything(),
    );
    await reconciler.close();
  });

  it("revalidates drift but refuses the Run that discovered it", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const inspect = vi.fn().mockResolvedValue(fixture.inspection);
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    const stable = await reconciler.readySelectionForRun("slack");
    expect(stable).toMatchObject({ generation: fixture.selection.generation, path: fixture.inspection.selection.path });
    expect(
      runtime.send.mock.calls.filter((call) => (call[0] as RuntimeBusinessFrame).status === "checking"),
    ).toHaveLength(1);

    const replacement = join(dirname(fixture.inspection.selection.path), "slack-next");
    await writeFile(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const identity = await computeFileIdentity(replacement);
    const fingerprint = computeTargetFingerprint(identity, "4.7.0");
    const selection = await writeProviderCliSelection(
      fixture.layout,
      "slack",
      {
        kind: "external",
        executablePath: identity.path,
        fingerprint,
        trust: "catalog-verified",
        version: "4.7.0",
      },
      fixture.selection,
    );
    inspect.mockResolvedValue(
      readyInspect({
        fingerprint,
        selection: {
          kind: "external",
          path: identity.path,
          version: "4.7.0",
          generation: selection.generation,
          trust: "catalog-verified",
        },
      }),
    );

    await expect(reconciler.readySelectionForRun("slack")).resolves.toBeUndefined();
    expect(
      runtime.send.mock.calls.filter((call) => (call[0] as RuntimeBusinessFrame).status === "checking"),
    ).toHaveLength(2);
    expect(runtime.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "provider-cli:artifact:status", status: "ready" }),
      expect.anything(),
    );
    await expect(reconciler.readySelectionForRun("slack")).resolves.toMatchObject({
      generation: selection.generation,
      path: identity.path,
    });
    await reconciler.close();
  });

  it("does not treat a previously accepted then unavailable provider as initial confirmation", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    let failInspect = false;
    let inspection = fixture.inspection;
    const inspect = vi.fn(async () => {
      if (failInspect) throw new Error("Synthetic inspection failure");
      return inspection;
    });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    const accepted = await reconciler.readySelectionForRun("slack");
    expect(accepted).toMatchObject({ generation: fixture.selection.generation });

    failInspect = true;
    await runtime.emit({ ...requirement, requestId: "99999999-9999-4999-8999-999999999999" });
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "provider-cli:artifact:status", status: "unavailable" }),
      expect.anything(),
    );

    const replacement = join(dirname(fixture.inspection.selection.path), "slack-history");
    await writeFile(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const identity = await computeFileIdentity(replacement);
    const fingerprint = computeTargetFingerprint(identity, "4.7.0");
    const selection = await writeProviderCliSelection(
      fixture.layout,
      "slack",
      {
        kind: "external",
        executablePath: identity.path,
        fingerprint,
        trust: "catalog-verified",
        version: "4.7.0",
      },
      fixture.selection,
    );
    inspection = readyInspect({
      fingerprint,
      selection: {
        kind: "external",
        path: identity.path,
        version: "4.7.0",
        generation: selection.generation,
        trust: "catalog-verified",
      },
    });
    failInspect = false;

    await expect(reconciler.readySelectionForRun("slack")).resolves.toBeUndefined();
    await expect(reconciler.readySelectionForRun("slack")).resolves.toMatchObject({
      generation: selection.generation,
      path: identity.path,
    });
    expect(selection.generation).not.toBe(accepted?.generation);
    await reconciler.close();
  });

  it("admits concurrent first Runs after the in-flight initial reconcile when identity is unchanged", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const { inspect, release } = holdFirstInspect(() => fixture.inspection);
    const ensure = vi.fn();
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    const requirementJob = runtime.emit(requirement);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    const first = reconciler.readySelectionForRun("slack");
    const second = reconciler.readySelectionForRun("slack");
    await vi.waitFor(() => expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(ensure).not.toHaveBeenCalled();
    release();
    await requirementJob;
    await expect(first).resolves.toMatchObject({
      generation: fixture.selection.generation,
      path: fixture.inspection.selection.path,
      version: fixture.inspection.selection.version,
      fingerprint: fixture.inspection.fingerprint,
    });
    await expect(second).resolves.toMatchObject({
      generation: fixture.selection.generation,
      path: fixture.inspection.selection.path,
    });
    expect(ensure).not.toHaveBeenCalled();
    await reconciler.close();
  });

  it("keeps one waiter's abort independent of another waiter's initial admission", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const { inspect, release } = holdFirstInspect(() => fixture.inspection);
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    const requirementJob = runtime.emit(requirement);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    const cancelled = new AbortController();
    const aborted = reconciler.readySelectionForRun("slack", cancelled.signal);
    const surviving = reconciler.readySelectionForRun("slack");
    await vi.waitFor(() => expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3));
    cancelled.abort("turn_timeout");
    await expect(aborted).rejects.toSatisfy((error) => isAbortFailure(error, "turn_timeout"));
    release();
    await requirementJob;
    await expect(surviving).resolves.toMatchObject({ generation: fixture.selection.generation });
    await reconciler.close();
  });

  it("rejects an initial Run when selection generation changes during the wait", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const { inspect, release } = holdFirstInspect(async () => {
      const record = await readProviderCliSelection(fixture.layout, "slack");
      if (!record) return fixture.inspection;
      return readyInspect({
        fingerprint: record.selection.fingerprint,
        selection: {
          kind: "external",
          path:
            record.selection.kind === "external" ? record.selection.executablePath : fixture.inspection.selection.path,
          version: record.selection.version,
          generation: record.generation,
          trust: "catalog-verified",
        },
      });
    });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    const requirementJob = runtime.emit(requirement);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    const waiting = reconciler.readySelectionForRun("slack");
    await vi.waitFor(() => expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(2));
    const replacement = join(dirname(fixture.inspection.selection.path), "slack-rotated");
    await writeFile(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const identity = await computeFileIdentity(replacement);
    const fingerprint = computeTargetFingerprint(identity, "4.7.0");
    await writeProviderCliSelection(
      fixture.layout,
      "slack",
      {
        kind: "external",
        executablePath: identity.path,
        fingerprint,
        trust: "catalog-verified",
        version: "4.7.0",
      },
      fixture.selection,
    );
    release();
    await requirementJob;
    await expect(waiting).resolves.toBeUndefined();
    await reconciler.close();
  });

  it("does not admit a waiting Run after close even if reconcile later succeeds", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const { inspect, release } = holdFirstInspect(() => fixture.inspection);
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    const requirementJob = runtime.emit(requirement);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    const waiting = reconciler.readySelectionForRun("slack");
    await vi.waitFor(() => expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(2));
    const closing = reconciler.close();
    await expect(waiting).resolves.toBeUndefined();
    release();
    await Promise.all([requirementJob, closing]);
  });

  it("interrupts a pending initial readiness inspection when the caller aborts", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const gate = deferred();
    const entered = deferred();
    const inspect = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      return fixture.inspection;
    });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    const abort = new AbortController();
    const caller = reconciler.readySelectionForRun("slack", abort.signal).then(
      () => ({ outcome: "resolved" as const }),
      (error: unknown) => ({ outcome: "rejected" as const, error }),
    );
    await entered.promise;
    abort.abort("turn_timeout");
    const result = await Promise.race([
      caller,
      new Promise<{ outcome: string }>((resolve) => {
        setTimeout(() => resolve({ outcome: "still_waiting" }), 100);
      }),
    ]);
    expect(result.outcome).toBe("rejected");
    expect(isAbortFailure((result as { error?: unknown }).error, "turn_timeout")).toBe(true);
    gate.resolve();
    await caller;
    await reconciler.close();
  });

  it("observes a failed status publication that also cancels its caller", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const held = holdFirstInspect(() => fixture.inspection);
    const abort = new AbortController();
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect: held.inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    const requirementJob = runtime.emit(requirement);
    try {
      await vi.waitFor(() => expect(held.inspect).toHaveBeenCalledOnce());
      runtime.send.mockImplementationOnce(async () => {
        abort.abort("turn_timeout");
        throw new Error("Status transport closed");
      });
      await expect(reconciler.readySelectionForRun("slack", abort.signal)).rejects.toBe("turn_timeout");
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      held.release();
      await requirementJob;
      await reconciler.close();
    }
  });

  it("interrupts a pending final readiness recheck when the caller aborts", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const finalHold = deferred();
    const finalEntered = deferred();
    let inspectCalls = 0;
    const inspect = vi.fn(async () => {
      inspectCalls += 1;
      if (inspectCalls === 3) {
        finalEntered.resolve();
        await finalHold.promise;
      }
      return fixture.inspection;
    });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    const abort = new AbortController();
    const caller = reconciler.readySelectionForRun("slack", abort.signal).then(
      () => ({ outcome: "resolved" as const }),
      (error: unknown) => ({ outcome: "rejected" as const, error }),
    );
    await finalEntered.promise;
    abort.abort("turn_timeout");
    const result = await Promise.race([
      caller,
      new Promise<{ outcome: string }>((resolve) => {
        setTimeout(() => resolve({ outcome: "still_waiting" }), 100);
      }),
    ]);
    expect(result.outcome).toBe("rejected");
    finalHold.resolve();
    await caller;
    await reconciler.close();
  });

  it("fails closed when the live CLI is missing at the start of the wait", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const gate = deferred();
    let hold = true;
    const inspect = vi.fn(async () => {
      if (hold) {
        hold = false;
        await gate.promise;
        return fixture.inspection;
      }
      return notReadyInspect("slack", "install", { code: "not_installed" });
    });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    const requirementJob = runtime.emit(requirement);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    const waiting = reconciler.readySelectionForRun("slack");
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    gate.resolve();
    await requirementJob;
    await expect(waiting).resolves.toBeUndefined();
    await reconciler.close();
  });

  it("repairs version-incompatible external selections with managed-only", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ readiness: "unavailable", diagnostic: { code: "version_incompatible" } })
      .mockResolvedValueOnce(fixture.inspection);
    const ensure = vi.fn().mockResolvedValue({ ok: true, action: "installed-managed" } as never);
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    expect(ensure).toHaveBeenCalledWith("slack", { mode: "managed-only" });
  });

  it("waits out a foreground installer's lock and converges without a reconnect", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const sleep = vi.fn(async () => undefined);
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ readiness: "install", diagnostic: { code: "not_installed" } })
      .mockResolvedValue(fixture.inspection);
    const ensure = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, diagnostic: { code: "operation_in_progress" } })
      .mockResolvedValueOnce({ ok: false, diagnostic: { code: "operation_in_progress" } })
      .mockResolvedValue({ ok: true, action: "noop" });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      sleep,
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    await runtime.emit(requirement);

    expect(ensure).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(PROVIDER_CLI_LOCK_BUSY_RETRY_DELAY_MS);
    const statuses = runtime.send.mock.calls.map((call) => (call[0] as RuntimeBusinessFrame).status);
    expect(statuses).toEqual(["checking", "ready"]);
    await reconciler.close();
  });

  it("removes each shutdown listener after the normal lock-busy timer wins", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const shutdown = new AbortController();
    const addEventListener = vi.spyOn(shutdown.signal, "addEventListener");
    const removeEventListener = vi.spyOn(shutdown.signal, "removeEventListener");
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ readiness: "install", diagnostic: { code: "not_installed" } })
      .mockResolvedValue(fixture.inspection);
    const ensure = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, diagnostic: { code: "operation_in_progress" } })
      .mockResolvedValueOnce({ ok: false, diagnostic: { code: "operation_in_progress" } })
      .mockResolvedValue({ ok: true, action: "noop" });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      signal: shutdown.signal,
      sleep: vi.fn(async () => undefined),
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    await runtime.emit(requirement);

    expect(ensure).toHaveBeenCalledTimes(3);
    expect(addEventListener.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2);
    expect(removeEventListener.mock.calls.filter(([type]) => type === "abort")).toHaveLength(2);
    expect(shutdown.signal.aborted).toBe(false);
    await reconciler.close();
  });

  it("reports a terminal unavailable only after the lock-busy budget is exhausted", async () => {
    const runtime = connection();
    const sleep = vi.fn(async () => undefined);
    const inspect = vi.fn().mockResolvedValue({ readiness: "install", diagnostic: { code: "not_installed" } });
    const ensure = vi.fn().mockResolvedValue({ ok: false, diagnostic: { code: "operation_in_progress" } });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: { root: "/tmp" } as never },
      sleep,
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    await runtime.emit(requirement);

    expect(ensure).toHaveBeenCalledTimes(1 + PROVIDER_CLI_LOCK_BUSY_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(PROVIDER_CLI_LOCK_BUSY_MAX_ATTEMPTS);
    expect(runtime.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "provider-cli:artifact:status", status: "unavailable" }),
      expect.anything(),
    );
    await reconciler.close();
  });

  it("does not invoke another ensure after the shutdown signal wins the lock-busy wait", async () => {
    const runtime = connection();
    const shutdown = new AbortController();
    const sleep = vi.fn(async () => {
      shutdown.abort();
    });
    const inspect = vi.fn().mockResolvedValue({ readiness: "install", diagnostic: { code: "not_installed" } });
    const ensure = vi.fn().mockResolvedValue({ ok: false, diagnostic: { code: "operation_in_progress" } });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: { root: "/tmp" } as never },
      signal: shutdown.signal,
      sleep,
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    await runtime.emit(requirement);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledTimes(1);
    await reconciler.close();
  });

  it("publishes unavailable when inspect throws so the Server can retry", async () => {
    const runtime = connection();
    new ProviderCliReconciler({
      connection: runtime,
      manager: {
        inspect: vi.fn().mockRejectedValue(new Error("disk")),
        ensure: vi.fn(),
        layout: { root: "/tmp" } as never,
      },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    expect(runtime.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "provider-cli:artifact:status", status: "unavailable" }),
      expect.anything(),
    );
  });

  it("fails closed when a ready inspection has no matching selection record", async () => {
    const runtime = connection();
    new ProviderCliReconciler({
      connection: runtime,
      manager: {
        inspect: vi.fn().mockResolvedValue(readyInspect()),
        ensure: vi.fn(),
        layout: { root: "/tmp/opentag-missing-provider-cli-selection" } as never,
      },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    expect(runtime.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "provider-cli:artifact:status", status: "unavailable" }),
      expect.anything(),
    );
  });

  it("coalesces same-provider integrations into one managed repair and broadcasts each requestId", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    let ensureStarted = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = vi.fn().mockResolvedValue({ readiness: "install", diagnostic: { code: "not_installed" } });
    const ensure = vi.fn(async () => {
      ensureStarted += 1;
      await gate;
      inspect.mockResolvedValue(fixture.inspection);
      return { ok: true, action: "installed-managed" } as never;
    });
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    const first = runtime.emit(requirement);
    const second = runtime.emit({
      ...requirement,
      requestId: "77777777-7777-4777-8777-777777777777",
      integrationId: otherIntegrationId,
    });
    await vi.waitFor(() => expect(ensureStarted).toBe(1));
    release();
    await Promise.all([first, second]);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(
      [
        ...new Set(
          runtime.send.mock.calls
            .filter((call) => (call[0] as RuntimeBusinessFrame).status === "ready")
            .map((call) => (call[0] as RuntimeBusinessFrame).requestId),
        ),
      ].sort(),
    ).toEqual(["11111111-1111-4111-8111-111111111111", "77777777-7777-4777-8777-777777777777"].sort());
  });

  it("joins an in-flight managed repair before close and validation cleanup settle", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ readiness: "install", diagnostic: { code: "not_installed" } })
      .mockResolvedValue(fixture.inspection);
    const ensure = vi.fn(async () => {
      await gate;
      return { ok: true, action: "installed-managed" } as never;
    });
    const cleanupAll = vi.fn(async () => undefined);
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      validation: { run: vi.fn(), cleanupAll },
    });

    const handling = runtime.emit(requirement);
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce());
    const closing = reconciler.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleanupAll).not.toHaveBeenCalled();

    release();
    await Promise.all([handling, closing]);
    expect(cleanupAll).toHaveBeenCalledOnce();
    expect(runtime.send.mock.calls.some((call) => (call[0] as RuntimeBusinessFrame).status === "ready")).toBe(false);
  });

  it("rejects stale, duplicate, and expired grants before spawning validation", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const run = vi.fn();
    const inspect = vi.fn().mockResolvedValue(fixture.inspection);
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      now: () => Date.parse("2026-08-31T00:00:16.000Z"),
      validation: { run, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    await runtime.emit(grantFrame({ requirementRequestId: "88888888-8888-4888-8888-888888888888" }));
    expect(run).not.toHaveBeenCalled();
    await runtime.emit(grantFrame({ expiresAt: "2026-08-31T00:00:15.000Z" }));
    expect(run).not.toHaveBeenCalled();
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider-cli:validation:result",
        status: "retrying",
        reason: "validation_expired",
      }),
      expect.anything(),
    );
    await runtime.emit(grantFrame({ expiresAt: "2026-08-31T00:00:15.000Z" }));
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(runtime.send.mock.calls)).not.toContain("xoxb-secret");
  });

  it("rejects a grant whose expected identity differs from the active requirement", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const run = vi.fn();
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect: vi.fn().mockResolvedValue(fixture.inspection), ensure: vi.fn(), layout: fixture.layout },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      validation: { run, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    await runtime.emit(grantFrame({ expectedIdentity: { ...requirement.expectedIdentity, teamId: "T-other" } }));
    expect(run).not.toHaveBeenCalled();
  });

  it("reports artifact_changed without holding the grant when selection identity drifts", async () => {
    const accountHome = await mkdtemp(join(tmpdir(), "opentag-reconcile-"));
    const layout = resolveProviderCliAccountLayout(accountHome);
    await mkdir(layout.state, { recursive: true });
    const target = join(accountHome, "slack");
    await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const first = await writeProviderCliSelection(
      layout,
      "slack",
      {
        kind: "external",
        executablePath: target,
        fingerprint: `v1:${"a".repeat(64)}`,
        trust: "catalog-verified",
        version: "4.7.0",
      },
      undefined,
    );
    const runtime = connection();
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(
        readyInspect({
          fingerprint: first.selection.fingerprint,
          selection: {
            kind: "external",
            path: target,
            version: "4.7.0",
            generation: first.generation,
            trust: "catalog-verified",
          },
        }),
      )
      .mockResolvedValue(
        readyInspect({
          fingerprint: `v1:${"b".repeat(64)}`,
          selection: {
            kind: "external",
            path: target,
            version: "4.7.0",
            generation: first.generation + 1,
            trust: "catalog-verified",
          },
        }),
      );
    const run = vi.fn();
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      validation: { run, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    await writeProviderCliSelection(
      layout,
      "slack",
      {
        kind: "external",
        executablePath: target,
        fingerprint: `v1:${"b".repeat(64)}`,
        trust: "catalog-verified",
        version: "4.7.0",
      },
      first,
    );
    await runtime.emit(grantFrame());
    expect(run).not.toHaveBeenCalled();
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider-cli:validation:result",
        status: "retrying",
        reason: "artifact_changed",
      }),
      expect.anything(),
    );
  });

  it("passes the managed artifact digest into the immediate pre-spawn fingerprint check", async () => {
    const accountHome = await mkdtemp(join(tmpdir(), "opentag-reconcile-managed-"));
    const layout = resolveProviderCliAccountLayout(accountHome);
    await mkdir(layout.state, { recursive: true });
    const target = join(accountHome, "slack-managed");
    await writeFile(target, '#!/bin/sh\necho \'{"ok":true,"team_id":"T1","user_id":"U1","bot_id":"B1"}\'\n', {
      mode: 0o700,
    });
    const digest = "d".repeat(64);
    const identity = await computeFileIdentity(target);
    const fingerprint = computeTargetFingerprint(identity, "4.7.0", digest);
    const selection = await writeProviderCliSelection(
      layout,
      "slack",
      {
        kind: "managed",
        artifactId: `4.7.0/darwin-arm64/${digest}`,
        targetPath: identity.path,
        fingerprint,
        version: "4.7.0",
      },
      undefined,
    );
    const runtime = connection();
    const inspect = vi.fn().mockResolvedValue(
      readyInspect({
        fingerprint,
        selection: {
          kind: "managed",
          path: identity.path,
          version: "4.7.0",
          generation: selection.generation,
          trust: "catalog-verified",
        },
      }),
    );
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      validation: new ProviderCliValidationRunner({
        home: join(accountHome, "client-home"),
        now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      }),
    });
    await runtime.emit(requirement);
    await runtime.emit(grantFrame());
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "provider-cli:validation:result", status: "ready" }),
      expect.anything(),
    );
  });

  it("logs a validation result that is not ready so the reason survives on the Computer", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const logs: RecordedLog[] = [];
    const run = vi.fn(async (_request, fence) => ({
      ...fence,
      status: "needs_attention" as const,
      reason: "credential_rejected" as const,
    }));
    const inspect = vi.fn().mockResolvedValue(fixture.inspection);
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      logger: recordingLogger(logs),
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      validation: { run, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    await runtime.emit(grantFrame());
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "provider-cli:validation:result", status: "needs_attention" }),
      expect.anything(),
    );
    expect(logs).toContainEqual({
      level: "warn",
      message: "Provider CLI validation did not confirm readiness",
      fields: {
        code: "PROVIDER_CLI_VALIDATION_NOT_READY",
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "needs_attention",
        reason: "credential_rejected",
      },
    });
    await reconciler.close();
  });

  it("logs a retrying validation result at info because it is an expected transient", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const logs: RecordedLog[] = [];
    const run = vi.fn(async (_request, fence) => ({
      ...fence,
      status: "retrying" as const,
      reason: "provider_unreachable" as const,
    }));
    const inspect = vi.fn().mockResolvedValue(fixture.inspection);
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      logger: recordingLogger(logs),
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      validation: { run, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    await runtime.emit(grantFrame());
    expect(logs).toContainEqual({
      level: "info",
      message: "Provider CLI validation did not confirm readiness",
      fields: {
        code: "PROVIDER_CLI_VALIDATION_NOT_READY",
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "retrying",
        reason: "provider_unreachable",
      },
    });
    expect(logs.filter((entry) => entry.level === "warn")).toEqual([]);
    await reconciler.close();
  });

  it("drops the previous generation so a delayed old grant cannot spawn", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const run = vi.fn();
    const inspect = vi.fn().mockResolvedValue(fixture.inspection);
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: fixture.layout },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      validation: { run, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    await runtime.emit({ ...requirement, requestId: "99999999-9999-4999-8999-999999999999", credentialGeneration: 3 });
    await runtime.emit(grantFrame());
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts in-flight validation on cancel and does not publish a result", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const run = vi.fn(async (_request, _fence, signal?: AbortSignal) => {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    new ProviderCliReconciler({
      connection: runtime,
      manager: {
        inspect: vi.fn().mockResolvedValue(fixture.inspection),
        ensure: vi.fn(),
        layout: fixture.layout,
      },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      validation: { run: run as never, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    const grant = runtime.emit(grantFrame({ expiresAt: "2026-08-31T00:00:20.000Z" }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await runtime.emit({
      type: "provider-cli:cancel",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requirementRequestId: requestId,
      provider: "slack",
      agentId,
      integrationId,
      credentialGeneration: 2,
    });
    await grant;
    expect(
      runtime.send.mock.calls.some(
        (call) => (call[0] as RuntimeBusinessFrame).type === "provider-cli:validation:result",
      ),
    ).toBe(false);
    await runtime.emit({
      type: "provider-cli:cancel",
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      requirementRequestId: requestId,
      provider: "slack",
      agentId,
      integrationId,
      credentialGeneration: 2,
    });
  });

  it("discards in-flight validation results after shutdown abort", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const shutdown = new AbortController();
    const run = vi.fn(async (_request, _fence, signal?: AbortSignal) => {
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    new ProviderCliReconciler({
      connection: runtime,
      manager: {
        inspect: vi.fn().mockResolvedValue(fixture.inspection),
        ensure: vi.fn(),
        layout: fixture.layout,
      },
      now: () => Date.parse("2026-08-31T00:00:10.000Z"),
      signal: shutdown.signal,
      validation: { run: run as never, cleanupAll: vi.fn() },
    });
    await runtime.emit(requirement);
    const grant = runtime.emit(grantFrame({ expiresAt: "2026-08-31T00:00:20.000Z" }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    shutdown.abort();
    await grant;
    expect(
      runtime.send.mock.calls.some(
        (call) => (call[0] as RuntimeBusinessFrame).type === "provider-cli:validation:result",
      ),
    ).toBe(false);
  });

  it("inspects both official CLIs for setup without installing or validating credentials", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    let feishuInspection = notReadyInspect("feishu", "install", { code: "not_installed" });
    const ensure = vi.fn();
    const inspect = vi.fn(async (provider: "feishu" | "slack") => {
      if (provider === "slack") return fixture.inspection;
      return feishuInspection;
    });
    const run = vi.fn();
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      validation: { run, cleanupAll: vi.fn() },
    });
    await runtime.emit(prewarm);
    expect(ensure).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
    const published = runtime.setImCliReadiness.mock.calls.map(([observation]) => observation);
    expect(published).toContainEqual({ provider: "feishu", status: "checking" });
    expect(published).toContainEqual({ provider: "feishu", status: "install" });
    expect(published).toContainEqual({ provider: "slack", status: "checking" });
    expect(published).toContainEqual({ provider: "slack", status: "ready" });
    expect(
      published.filter((observation) => observation.provider === "slack" && observation.status === "install"),
    ).toHaveLength(0);
    feishuInspection = notReadyInspect("feishu", "unavailable", { code: "install_incomplete" });
    await reconciler.refreshPublishedImCliReadiness();
    expect(runtime.setImCliReadiness).toHaveBeenCalledWith({ provider: "feishu", status: "checking" });
    expect(runtime.setImCliReadiness).toHaveBeenLastCalledWith({ provider: "slack", status: "ready" });
    expect(runtime.setImCliReadiness).toHaveBeenCalledWith({ provider: "feishu", status: "unavailable" });
    expect(runtime.setImCliReadiness).toHaveBeenCalledWith({ provider: "slack", status: "ready" });
    await reconciler.close();
  });

  it("runs the idempotent auto ensure for a Server-owned existing-Computer preparation", async () => {
    const runtime = connection();
    const fixture = await externalReadyFixture();
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(notReadyInspect("slack", "install", { code: "not_installed" }))
      .mockResolvedValueOnce(fixture.inspection);
    const ensure = vi.fn().mockResolvedValue({ ok: true, action: "installed-managed" } as never);
    const refreshRuntimeProvider = vi.fn(async () => ({ provider: "codex" as const, status: "ready" as const }));
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: fixture.layout },
      refreshRuntimeProvider,
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });

    await runtime.emit({ ...prewarm, mode: "ensure", runtimeProvider: "codex", providers: ["slack"] });

    expect(refreshRuntimeProvider).toHaveBeenCalledWith("codex");
    expect(ensure).toHaveBeenCalledWith("slack", { mode: "auto" });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(runtime.setImCliReadiness.mock.calls.map(([observation]) => observation)).toEqual([
      { provider: "slack", status: "checking" },
      { provider: "slack", status: "ready" },
    ]);
    expect(runtime.send).toHaveBeenCalledWith(
      {
        type: "provider-cli:prewarm:result",
        requestId,
        runtime: { provider: "codex", status: "ready" },
        providers: [{ provider: "slack", status: "ready" }],
      },
      { priority: "result", signal: undefined },
    );
    await reconciler.close();
  });

  it("single-flights overlapping periodic inspections per provider", async () => {
    const runtime = connection();
    let hold = false;
    const release: Array<() => void> = [];
    const inspect = vi.fn((provider: "feishu" | "slack"): Promise<ProviderCliInspection> => {
      const result = notReadyInspect(provider, "install", { code: "not_installed" });
      if (!hold) return Promise.resolve(result);
      return new Promise((resolve) => release.push(() => resolve(result)));
    });
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure: vi.fn(), layout: { root: "/tmp" } as never },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(prewarm);
    inspect.mockClear();
    hold = true;

    const first = reconciler.refreshPublishedImCliReadiness();
    const second = reconciler.refreshPublishedImCliReadiness();
    await Promise.resolve();
    expect(inspect).toHaveBeenCalledTimes(2);
    for (const complete of release) complete();
    await Promise.all([first, second]);

    expect(inspect.mock.calls.map(([provider]) => provider).sort()).toEqual(["feishu", "slack"]);
    await reconciler.close();
  });

  it("ignores setup prewarm when the capability was not negotiated", async () => {
    const runtime = connection({
      capabilityVersion: (capability) => (capability === RUNTIME_CAPABILITY.providerCliPrewarm ? undefined : 1),
    });
    const inspect = vi.fn();
    const ensure = vi.fn();
    new ProviderCliReconciler({
      connection: runtime,
      manager: { inspect, ensure, layout: { root: "/tmp" } as never },
      validation: { run: vi.fn(), cleanupAll: vi.fn() },
    });
    await runtime.emit(prewarm);
    expect(inspect).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(runtime.setImCliReadiness).not.toHaveBeenCalled();
  });
});
