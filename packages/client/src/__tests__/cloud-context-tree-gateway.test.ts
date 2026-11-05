import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RunnerClientFrame,
  RunnerCloudModelGrant,
  RuntimeCredentialClientFrame,
  RuntimeCredentialServerFrame,
} from "@opentag/shared";
import { RUNTIME_PROVIDER_PROXY_PATH } from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudCredentialChannel } from "../runner/cloud-credential-connection.js";
import { CloudJournal } from "../runner/cloud-journal.js";
import { CloudTurnRunner, type CloudTurnScope } from "../runner/cloud-turns.js";
import { NativeSandbox, SANDBOX_NODE, type SpawnProcess } from "../runner/native-sandbox.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

/*
 * The trusted parent opens the Context Tree command gateway only when it can run the pinned CLI.
 * A missing package must not fail the Cloud execution open: the Turn still runs, and the worker
 * sees no gateway URL, so it reports every selected source unavailable.
 */

const packageState = vi.hoisted(() => ({ missing: false }));
vi.mock("../runtime/context-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/context-tree.js")>();
  return {
    ...actual,
    resolveContextTreePackage: (...args: Parameters<typeof actual.resolveContextTreePackage>) =>
      packageState.missing ? undefined : actual.resolveContextTreePackage(...args),
  };
});

const MODEL_GRANT: RunnerCloudModelGrant = {
  baseUrl: "https://server.example.com/api/v1/cloud-model",
  model: "deepseek-v4.1-flash-expires-on-0910",
  token: "unit-execution-token-0123456789abcdef",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  contextWindow: 258_000,
  maxTokens: 8_192,
};
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  packageState.missing = false;
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function localSandbox(): NativeSandbox {
  const spawnProcess: SpawnProcess = (_command, args) => {
    const separator = args.indexOf("--");
    const [binary, ...rest] = args.slice(separator + 1);
    if (binary !== SANDBOX_NODE) throw new Error(`unexpected sandbox command ${binary ?? "<missing>"}`);
    return spawn(process.execPath, rest, { stdio: "pipe" });
  };
  const name = `ots-tree-cloud-${randomUUID().slice(0, 8)}`;
  return new NativeSandbox({ name, workspace: join(tmpdir(), `opentag-tree-cloud-ws-${name}`), spawnProcess });
}

/** Grants the Context Tree service on every execution open and answers only the frames used here. */
class ContextTreeCredentialChannel implements CloudCredentialChannel {
  executionId = randomUUID();
  readonly #credentials = new Set<(frame: RuntimeCredentialServerFrame) => void>();

  sendFrame(frame: RunnerClientFrame): void {
    if (frame.type !== "credential:frame") return;
    const response = this.#respond(frame.frame);
    if (!response) return;
    queueMicrotask(() => {
      for (const listener of [...this.#credentials]) listener(response);
    });
  }
  onCredentialFrame(listener: (frame: RuntimeCredentialServerFrame) => void): () => void {
    this.#credentials.add(listener);
    return () => this.#credentials.delete(listener);
  }
  onChannelState(): () => void {
    return () => undefined;
  }
  #respond(frame: RuntimeCredentialClientFrame): RuntimeCredentialServerFrame | undefined {
    if (frame.type === "runtime:execution:open")
      return {
        type: "runtime:execution:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: this.executionId,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        providers: [],
        services: [{ service: "context-tree", scopes: ["context-tree:git"] }],
      };
    if (frame.type === "runtime:proxy:ticket")
      return {
        type: "runtime:proxy:ticket:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: this.executionId,
        ticket: "t".repeat(43),
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        path: RUNTIME_PROVIDER_PROXY_PATH,
      };
    if (frame.type === "runtime:execution:close")
      return {
        type: "runtime:execution:closed",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: frame.executionId,
      };
    return undefined;
  }
}

async function runSelectedTreeTurn(): Promise<{ environment: Record<string, string>; logs: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-cloud-tree-gateway-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = join(directory, "private");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const sessionId = randomUUID();
  const scope: CloudTurnScope = {
    sandboxId: randomUUID(),
    sessionId,
    environmentGeneration: 1,
    resourceName: "projects/p/locations/r/instances/ots-s-x-1",
    resourceUid: "uid-1",
  };
  const logs: string[] = [];
  const environments: Record<string, string>[] = [];
  const runner = new CloudTurnRunner({
    credentialChannel: () => new ContextTreeCredentialChannel(),
    journal: await CloudJournal.open(join(directory, "journal")),
    log: (message) => logs.push(message),
    relayOptions: {
      dataConnectionFactory: async () => ({
        closed: false,
        close: async () => undefined,
        openStream: async () => ({}) as never,
        settled: async () => new Promise<void>(() => undefined),
      }),
    },
    runWorker: async () => {
      // The worker reads exactly this published manifest inside the Sandbox.
      const publicRoot = join(stateDirectory, "public");
      for (const turn of await readdir(publicRoot)) {
        const manifest = JSON.parse(await readFile(join(publicRoot, turn, "environment.json"), "utf8")) as {
          environment: Record<string, string>;
        };
        environments.push(manifest.environment);
      }
      return {
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          kind: "result",
          completion: { outcome: "completed", executionEffects: "completed", finalText: "done" },
        })}\n`,
      };
    },
    sandbox: localSandbox(),
    scope: () => scope,
    send: () => undefined,
    serverUrl: "https://server.example.com",
    stateDirectory,
  });
  cleanup.push(() => runner.close());
  const delivery = cloudDeliveryFixture({ sessionId });
  delivery.runtime.contextTrees = [{ kind: "git", repository: "acme/project", path: "docs", ref: "main" }];
  await runner.handleDeliveryRun({ type: "delivery:run", requestId: delivery.requestId, delivery });
  await runner.handleVerified({
    type: "delivery:verified",
    requestId: delivery.requestId,
    status: "verified",
    model: MODEL_GRANT,
  });
  await runner.waitForActive();
  expect(environments).toHaveLength(1);
  return { environment: environments[0] ?? {}, logs };
}

it("publishes the command gateway URL when the pinned CLI is present", async () => {
  const { environment } = await runSelectedTreeTurn();
  expect(environment.OPENTAG_CONTEXT_TREE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

it("still runs the Turn without a gateway when the Context Tree package is missing", async () => {
  packageState.missing = true;
  const { environment, logs } = await runSelectedTreeTurn();
  expect(environment.OPENTAG_CONTEXT_TREE_URL).toBeUndefined();
  expect(logs).toContain("Context Tree package is unavailable; opening the execution without the command gateway");
});
