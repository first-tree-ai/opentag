import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeFileIdentity,
  computeTargetFingerprint,
  ProviderCliManager,
  ProviderCliReconciler,
  type ProviderCliReconcilerOptions,
  ProviderCliValidationRunner,
  readProviderCliSelection,
  resolveProviderCliAccountLayout,
  writeProviderCliSelection,
} from "../index.js";
import { loopbackFetcher, makeFixtureCatalog, makeTempDir, startFixtureHttpServer } from "./fixtures/provider-cli.js";
import { slackProductCliScript, snapshotFileTree } from "./fixtures/provider-cli-product.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const grantId = "55555555-5555-4555-8555-555555555555";
const agentId = "22222222-2222-4222-8222-222222222222";
const integrationId = "33333333-3333-4333-8333-333333333333";
const expectedIdentity = { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" };

const requirement = {
  type: "provider-cli:requirement" as const,
  operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
  requestId,
  provider: "slack" as const,
  agentId,
  integrationId,
  credentialGeneration: 2,
  expectedIdentity,
};

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await execFileAsync("chmod", ["-R", "u+w", path]).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    }),
  );
});

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

function grantFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: "provider-cli:validation:grant",
    requestId: grantId,
    requirementRequestId: requestId,
    provider: "slack",
    agentId,
    integrationId,
    credentialGeneration: 2,
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    expectedIdentity,
    grant: { provider: "slack", botAccessToken: "xoxb-secret" },
    ...overrides,
  };
}

function sentTypes(runtime: ReturnType<typeof connection>): string[] {
  return runtime.send.mock.calls.map((call) => {
    const frame = call[0] as { status?: string; type: string };
    return frame.status ? `${frame.type}:${frame.status}` : frame.type;
  });
}

describe("provider CLI product reconcile", () => {
  it("does not inspect, download, or mutate account-global files without an active binding", async () => {
    const accountHome = await makeTempDir("opentag-product-nobinding-");
    tempDirs.push(accountHome);
    const fetcher = vi.fn(async () => {
      throw new Error("account-global Provider CLI download must not run without a binding");
    });
    const inspect = vi.fn();
    const ensure = vi.fn();
    const run = vi.fn();
    const runtime = connection();
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager: {
        inspect,
        ensure,
        layout: resolveProviderCliAccountLayout(accountHome),
      },
      validation: { run, cleanupAll: vi.fn() },
    });
    closers.push(async () => reconciler.close());
    const before = await snapshotFileTree(accountHome);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(inspect).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
    expect(await snapshotFileTree(accountHome)).toEqual(before);

    new ProviderCliManager({
      accountHome,
      env: { PATH: "" },
      fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await snapshotFileTree(accountHome)).toEqual(before);
  });

  it("repairs through inspect→managed install→reinspect, then fail-closes generation and selection drift", async () => {
    const accountHome = await makeTempDir("opentag-product-repair-");
    const openTagHome = await makeTempDir("opentag-product-repair-home-");
    tempDirs.push(accountHome, openTagHome);
    const invocationLog = join(accountHome, "slack-invocations.log");
    const routes = new Map<string, Uint8Array | { body: Uint8Array; truncateTo: number } | null>();
    const server = await startFixtureHttpServer(routes);
    closers.push(async () => server.close());
    const fixture = makeFixtureCatalog({
      provider: "slack",
      version: "4.7.0",
      baseUrl: server.baseUrl,
      executableContent: slackProductCliScript({ invocationLog, version: "4.7.0" }),
    });
    routes.set(fixture.routePath, fixture.archive);
    const manager = new ProviderCliManager({
      accountHome,
      catalog: [fixture.entry],
      env: { PATH: "" },
      fetcher: loopbackFetcher,
    });
    const ensure = vi.spyOn(manager, "ensure");
    const runtime = connection();
    const reconciler = new ProviderCliReconciler({
      connection: runtime,
      manager,
      validation: new ProviderCliValidationRunner({ home: openTagHome }),
    });
    closers.push(async () => reconciler.close());

    const before = await snapshotFileTree(accountHome);
    expect(before).toEqual([]);

    await runtime.emit(requirement);
    expect(ensure).toHaveBeenCalledWith("slack", { mode: "managed-only" });
    expect(await ensure.mock.results[0]?.value).toMatchObject({ ok: true, action: "installed-managed" });
    expect(server.requests.length).toBeGreaterThan(0);
    expect(sentTypes(runtime)).toEqual(["provider-cli:artifact:status:checking", "provider-cli:artifact:status:ready"]);
    const selection = await readProviderCliSelection(manager.layout, "slack");
    expect(selection).toMatchObject({ generation: 1, selection: { kind: "managed", version: "4.7.0" } });
    const ready = await reconciler.readySelectionForRun("slack");
    expect(ready).toMatchObject({ generation: 1, version: "4.7.0" });

    await runtime.emit(grantFrame());
    expect(runtime.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "provider-cli:validation:result", status: "ready", requestId: grantId }),
      expect.anything(),
    );
    expect(JSON.stringify(runtime.send.mock.calls)).not.toContain("xoxb-secret");
    const invocations = await readFile(invocationLog, "utf8");
    expect(invocations).toMatch(/api auth\.test/);
    expect(invocations.split("\n").filter((line) => line.includes("auth.test"))).toHaveLength(1);

    const nextRequestId = "99999999-9999-4999-8999-999999999999";
    await runtime.emit({ ...requirement, requestId: nextRequestId, credentialGeneration: 3 });
    await runtime.emit(grantFrame());
    expect(
      (await readFile(invocationLog, "utf8")).split("\n").filter((line) => line.includes("auth.test")),
    ).toHaveLength(1);
    expect(ensure).toHaveBeenCalledTimes(1);

    const replacement = join(accountHome, "slack-next");
    await writeFile(replacement, slackProductCliScript({ invocationLog, version: "4.7.0" }), { mode: 0o700 });
    const identity = await computeFileIdentity(replacement);
    const fingerprint = computeTargetFingerprint(identity, "4.7.0");
    await writeProviderCliSelection(
      manager.layout,
      "slack",
      {
        kind: "external",
        executablePath: identity.path,
        fingerprint,
        trust: "catalog-verified",
        version: "4.7.0",
      },
      selection ?? undefined,
    );
    await expect(reconciler.readySelectionForRun("slack")).resolves.toBeUndefined();
    const recovered = await reconciler.readySelectionForRun("slack");
    expect(recovered?.generation).toBeGreaterThan(1);
    expect(recovered?.version).toBe("4.7.0");
  }, 20_000);
});
