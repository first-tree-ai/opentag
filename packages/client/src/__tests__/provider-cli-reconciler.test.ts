import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import {
  computeFileIdentity,
  computeTargetFingerprint,
  ProviderCliReconciler,
  type ProviderCliReconcilerOptions,
  ProviderCliValidationRunner,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "../index.js";

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

function connection(): ProviderCliReconcilerOptions["connection"] & {
  emit(frame: { readonly type: string } & Record<string, unknown>): Promise<unknown[]>;
  send: ReturnType<typeof vi.fn>;
} {
  const listeners = new Set<(frame: { readonly type: string } & Record<string, unknown>) => void | Promise<void>>();
  return {
    send: vi.fn(async () => undefined),
    subscribeBusinessFrames: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capabilityVersion: () => 1,
    emit(frame) {
      return Promise.all([...listeners].map((listener) => listener(frame)));
    },
  };
}

function readyInspect(overrides: Record<string, unknown> = {}) {
  return {
    readiness: "ready" as const,
    fingerprint: "v1:abc",
    selection: {
      kind: "managed" as const,
      path: "/bin/true",
      version: "4.7.0",
      generation: 1,
      trust: "catalog-verified" as const,
    },
    ...overrides,
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
  };
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
          runtime.send.mock.calls.filter((call) => call[0].status === "ready").map((call) => call[0].requestId),
        ),
      ].sort(),
    ).toEqual(["11111111-1111-4111-8111-111111111111", "77777777-7777-4777-8777-777777777777"].sort());
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
    expect(runtime.send.mock.calls.some((call) => call[0].type === "provider-cli:validation:result")).toBe(false);
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
    expect(runtime.send.mock.calls.some((call) => call[0].type === "provider-cli:validation:result")).toBe(false);
  });
});
