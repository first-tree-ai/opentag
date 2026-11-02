import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDirectInputHash,
  computeRuntimeImSteerInputHash,
  type RunnerClientFrame,
  type RunnerServerFrame,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerSlackEventsRoute } from "../../api/slack-events.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  slackWebhookReceipts,
  users,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { AgentService } from "../../services/agents/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { SlackAdapter } from "../../services/im-bindings/slack/adapter.js";
import { SlackWebhookReceiptStore } from "../../services/im-bindings/slack/webhook-receipt-store.js";
import { EffectiveRuntimeSnapshotAssembler } from "../../services/runtime-config/index.js";
import { CloudDeliveryOwner } from "../../services/sandboxes/cloud-delivery-owner.js";
import { createStaticCloudModelCatalog } from "../../services/sandboxes/cloud-model-catalog.js";
import { CloudModelGrantService } from "../../services/sandboxes/cloud-model-grants.js";
import { CloudRuntimeFence } from "../../services/sandboxes/cloud-runtime-fence.js";
import { type RunnerControlSocket, RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SandboxService } from "../../services/sandboxes/sandbox-service.js";
import { SessionService } from "../../services/sessions/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const nativeFixture = fileURLToPath(
  new URL("../../../../client/src/__tests__/fixtures/cloud-native-input-ledger.mjs", import.meta.url),
);
const ledgerCli = fileURLToPath(new URL("../../../../../scripts/verify-im-input-ledger.mjs", import.meta.url));
const VERSION = "0.0.5";
const MODEL = "ledger-model";
const cloudIdentities = { enabled: true as const, runnerVersion: VERSION, storageBase: "gs://synthetic/ledger" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

type NativeInput = {
  agentId: string;
  sessionId: string;
  deliveryId: string;
  requestId: string;
  textHash: string;
  nativeEvents: number;
  markers: string[];
};
type PeerEvent =
  | { kind: "frame"; frame: RunnerClientFrame }
  | ({ kind: "native_input" } & NativeInput)
  | { kind: "ready" | "model_ready" }
  | { kind: "journal"; entries: unknown[] }
  | { kind: "error"; message: string };
class NativePeer {
  readonly child: ChildProcess;
  readonly errors: string[] = [];
  readonly inputs: NativeInput[] = [];
  readonly exited: Promise<void>;
  ready = false;
  modelReady = false;
  entries: unknown[] | undefined;
  #tail = Promise.resolve();
  constructor(
    directory: string,
    scope: RunnerScope & { resourceUid: string },
    onFrame: (frame: RunnerClientFrame) => Promise<void>,
  ) {
    this.child = spawn(process.execPath, ["--import", "tsx", nativeFixture], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.on("error", (error) => this.errors.push(String(error)));
    this.child.stderr?.on("data", (chunk) => this.errors.push(chunk.toString().slice(0, 2000)));
    this.child.on("message", (value) => {
      const event = value as PeerEvent;
      if (event.kind === "ready") this.ready = true;
      else if (event.kind === "model_ready") this.modelReady = true;
      else if (event.kind === "native_input") this.inputs.push(event);
      else if (event.kind === "journal") this.entries = event.entries;
      else if (event.kind === "error") this.errors.push(event.message);
      else if (event.kind === "frame")
        this.#tail = this.#tail
          .then(() => onFrame(event.frame))
          .catch((error) => {
            this.errors.push(String(error));
          });
    });
    this.send({ kind: "init", directory, scope });
  }
  send(message: unknown) {
    this.child.send(message as object);
  }
  async close() {
    if (this.child.connected) this.send({ kind: "close" });
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.exited;
    clearTimeout(kill);
  }
}

async function lane(tag: "A" | "B", service: ImBindingService) {
  const accountId = randomUUID();
  await client.database
    .insert(users)
    .values({ id: accountId, email: `${tag}@ledger.test`, displayName: `Ledger ${tag}` });
  const cloud = await new ComputerService(
    client.database,
    {
      getActiveUserById: async () => {
        throw new Error("Unused account projection");
      },
    },
    { cloudIdentities },
  ).ensureCloudComputerForAccount(accountId);
  const agent = await new AgentService(client.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `ledger-${tag.toLowerCase()}`,
    displayName: `Ledger ${tag}`,
    runtimeProvider: "pi",
    computerId: cloud.computerId,
  });
  await client.database
    .update(agentRuntimeConfigs)
    .set({ instructions: "Synthetic ledger task.", model: MODEL })
    .where(eq(agentRuntimeConfigs.agentId, agent.id));
  const appId = `A_LEDGER_${tag}`;
  const channelId = `D_LEDGER_${tag}`;
  const signingSecret = `synthetic-signing-${tag}`;
  const binding = await service.activateSlack(
    {
      intent: "create",
      agentId: agent.id,
      appId,
      teamId: "T_LEDGER",
      botUserId: `U_BOT_${tag}`,
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: `synthetic-token-${tag}`,
      signingSecret,
      installedAt: new Date(),
    },
    `B_BOT_${tag}`,
  );
  const sandbox = await new SandboxService(client.database, new SessionService(client.database), {
    cloudIdentities,
  }).ensureForAccount(accountId, {
    imBindingId: binding.imBindingId,
    channelId,
    conversationKind: "dm",
    kind: "channel",
  });
  const resourceName = `projects/synthetic/locations/test/instances/ots-ledger-${tag.toLowerCase()}-1`;
  const resourceUid = `synthetic-${tag}`;
  await client.database
    .update(sandboxes)
    .set({
      lifecycle: "ready",
      environmentGeneration: 1,
      currentResourceName: resourceName,
      currentResourceUid: resourceUid,
    })
    .where(eq(sandboxes.id, sandbox.sandboxId));
  return {
    tag,
    agentId: agent.id,
    computerId: cloud.computerId,
    sessionId: sandbox.sessionId,
    appId,
    channelId,
    signingSecret,
    scope: {
      sandboxId: sandbox.sandboxId,
      sessionId: sandbox.sessionId,
      environmentGeneration: 1,
      resourceName,
      resourceUid,
    },
  };
}
type Lane = Awaited<ReturnType<typeof lane>>;

function envelope(target: Lane, ordinal: number, seconds: number) {
  return {
    type: "event_callback",
    api_app_id: target.appId,
    team_id: "T_LEDGER",
    event_id: `Ev_${target.tag}_${ordinal}`,
    event_time: seconds,
    authorizations: [{ team_id: "T_LEDGER", user_id: `U_BOT_${target.tag}`, is_bot: true }],
    event: {
      type: "message",
      channel_type: "im",
      channel: target.channelId,
      user: "U_HUMAN",
      text: `SYNTHETIC_${target.tag}_INPUT_${String(ordinal).padStart(4, "0")}`,
      ts: `${seconds}.${String(ordinal).padStart(6, "0")}`,
    },
  };
}
async function post(url: string, target: Lane, ordinal: number, seconds: number) {
  const body = JSON.stringify(envelope(target, ordinal, seconds));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", target.signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
  const response = await fetch(`${url}/api/v1/im-bindings/slack/events`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  await response.text();
}
function makeDeliveryOwner() {
  const hub = new RunnerHub();
  const grants = new CloudModelGrantService("synthetic-ledger-secret-at-least-32-characters", {
    catalog: createStaticCloudModelCatalog([MODEL]),
    maxStreamsPerToken: 2,
    ttlSeconds: 600,
  });
  const owner = new CloudDeliveryOwner({
    database: client.database,
    custody: new PostgresRuntimeCustodyStore(client.database),
    fence: new CloudRuntimeFence(),
    hub,
    modelGrants: grants,
    modelBaseUrl: "https://server.example.test/api/v1/cloud-model",
  });
  return { hub, grants, owner };
}
function makeWorker(owner: CloudDeliveryOwner, targets: Lane[]) {
  return new ImDeliveryWorker({
    database: client.database,
    assembler: new EffectiveRuntimeSnapshotAssembler(client.database),
    registry: new ConnectionRegistry(),
    domain: {} as never,
    cloudDelivery: owner,
    cloudAllocation: {
      ensureSandbox: async () => {
        throw new Error("Synthetic Sandbox already exists");
      },
      ensureEnvironmentAllocated: async () => "ready",
      readyAllocation: async (sandboxId) => targets.find((target) => target.scope.sandboxId === sandboxId)?.scope,
    },
    intervalMs: 60_000,
  });
}

async function deliverPending(worker: ImDeliveryWorker, targets: Lane[]) {
  for (let round = 0; round < 65; round++) {
    for (const target of targets) await worker.notifyCloudRunnerReady(target.scope);
    const pending = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.state, "pending"));
    if (pending.length === 0) return;
  }
  throw new Error("Synthetic input queue did not drain within its input-count bound");
}

function connectPeer(target: Lane, directory: string, control: ReturnType<typeof makeDeliveryOwner>) {
  let peer: NativePeer;
  let dropVerified = target.tag === "A";
  let dropSteer = target.tag === "B";
  let dropReportAck = true;
  let lastSteer: RunnerServerFrame | undefined;
  const sent: RunnerServerFrame[] = [];
  const received: RunnerClientFrame[] = [];
  const dropped: string[] = [];
  const socket: RunnerControlSocket = {
    close() {},
    send(frame) {
      sent.push(frame);
      if (frame.type === "delivery:verified" && dropVerified) {
        dropVerified = false;
        dropped.push("verified");
        return;
      }
      if (frame.type === "delivery:steer") lastSteer = frame;
      if (frame.type === "delivery:report:ack" && dropReportAck) {
        dropReportAck = false;
        dropped.push("report_ack");
        peer.send({ kind: "reconcile" });
        return;
      }
      peer.send({ kind: "frame", frame });
    },
  };
  control.hub.attach(target.scope, socket);
  control.hub.markReady(
    target.scope,
    {
      sandboxName: `synthetic-${target.tag}`,
      rootfs: "/opt/sandbox-root",
      nodeVersion: process.version,
      piVersion: "0.84.2",
      runnerVersion: VERSION,
      reportedAt: new Date().toISOString(),
    },
    socket,
  );
  const connection = control.owner.attachConnection({
    computerId: target.computerId,
    installationId: randomUUID(),
    scope: target.scope,
    socket,
    imInputVersion: 1,
  });
  peer = new NativePeer(directory, target.scope, async (frame) => {
    received.push(frame);
    if (frame.type === "delivery:received") {
      const [frozen] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, frame.deliveryId));
      const dispatch = sent.find((value) => value.type === "delivery:run" && value.requestId === frame.requestId);
      assert(dispatch?.type === "delivery:run");
      expect(frozen?.dispatchPayload).toEqual(dispatch.delivery);
      expect(frozen?.dispatchInputHash).toBe(computeDirectInputHash(dispatch.delivery));
      await control.owner.handleDeliveryReceived(connection, frame);
    } else if (frame.type === "delivery:report") await control.owner.handleDeliveryReport(connection, frame);
    else if (frame.type === "delivery:steer:result") {
      expect(lastSteer?.type === "delivery:steer" ? computeRuntimeImSteerInputHash(lastSteer.steer) : undefined).toBe(
        frame.inputHash,
      );
      if (dropSteer) {
        dropSteer = false;
        dropped.push("steer_result");
        assert(lastSteer);
        peer.send({ kind: "frame", frame: lastSteer });
        return;
      }
      await control.owner.handleSteerResult(connection, frame);
    } else throw new Error(`Unexpected Runner frame ${frame.type}`);
  });
  return { peer, sent, received, target, dropped };
}

it.skipIf(process.platform === "win32")(
  "keeps the signed-ingress to native-Pi input ledger complete across batching and lost verification/steer/report acknowledgements",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-full-ledger-"));
    const service = new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)));
    const targets = await Promise.all([lane("A", service), lane("B", service)]);
    const app = Fastify({ logger: false });
    registerSlackEventsRoute(app, {
      imBindings: service,
      inbox: new ImMessageInbox(client.database),
      receipts: new SlackWebhookReceiptStore(client.database),
      createAdapter: (installation) =>
        new SlackAdapter({
          api: {} as never,
          token: installation.botAccessToken,
          appId: installation.appId,
          teamId: installation.teamId,
          botUserId: installation.botUserId,
          botId: installation.botId,
        }),
    });
    const control = makeDeliveryOwner();
    const worker = makeWorker(control.owner, targets);
    const peers: ReturnType<typeof connectPeer>[] = [];
    try {
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      const seconds = Math.floor(Date.now() / 1000);
      for (let n = 65; n >= 1; n--) {
        await Promise.all(targets.map((target) => post(url, target, n, seconds)));
        if (n % 16 === 0) await Promise.all(targets.map((target) => post(url, target, n, seconds)));
      }
      await expect
        .poll(
          async () =>
            (await client.database.select().from(slackWebhookReceipts)).filter((row) => row.status === "processed")
              .length,
          { timeout: 10_000 },
        )
        .toBe(130);
      expect(await client.database.select().from(imMessages)).toHaveLength(130);
      expect(await client.database.select().from(imMessageDeliveries)).toHaveLength(130);
      for (const target of targets) {
        const path = join(directory, target.tag);
        await mkdir(path);
        peers.push(connectPeer(target, path, control));
      }
      await expect.poll(() => peers.every(({ peer }) => peer.ready), { timeout: 15_000 }).toBe(true);
      for (const target of targets) await worker.notifyCloudRunnerReady(target.scope);
      const a = peers[0];
      assert(a);
      await expect
        .poll(
          async () =>
            (await client.database.select().from(imMessageDeliveries)).filter((row) => row.state === "accepted").length,
          { timeout: 10_000 },
        )
        .toBe(2);
      expect(a.peer.modelReady).toBe(false);
      await expect.poll(() => a.dropped.includes("verified")).toBe(true);
      expect(a.peer.inputs).toHaveLength(0);
      a.peer.send({ kind: "reconcile" });
      await expect.poll(() => peers.every(({ peer }) => peer.modelReady), { timeout: 15_000 }).toBe(true);
      await deliverPending(worker, targets);
      await expect
        .poll(
          async () =>
            (await client.database.select().from(imMessageDeliveries)).filter((row) => row.state === "steered").length,
          { timeout: 10_000 },
        )
        .toBe(128);
      for (const { peer } of peers) peer.send({ kind: "release" });
      await expect
        .poll(
          async () =>
            (await client.database.select().from(imMessageDeliveries)).filter((row) => row.reportedAt !== null).length,
          { timeout: 15_000 },
        )
        .toBe(2);
      await expect
        .poll(
          () => peers.every(({ sent }) => sent.filter((frame) => frame.type === "delivery:report:ack").length === 2),
          { timeout: 10_000 },
        )
        .toBe(true);
      for (const { peer } of peers) peer.send({ kind: "inspect" });
      await expect.poll(() => peers.every(({ peer }) => peer.entries?.length === 0), { timeout: 10_000 }).toBe(true);
      const messages = await client.database.select().from(imMessages);
      const deliveries = await client.database.select().from(imMessageDeliveries);
      const accepted = targets.flatMap((target) =>
        Array.from({ length: 65 }, (_, order) => {
          const inputId = envelope(target, order + 1, seconds).event.text;
          const message = messages.find((entry) => entry.content.fallbackText === inputId);
          assert(message);
          const delivery = deliveries.find(
            (entry) => entry.messageId === message.id && entry.sessionId === target.sessionId,
          );
          assert(delivery);
          return {
            inputId,
            agentId: target.agentId,
            sessionId: target.sessionId,
            streamId: `synthetic-${target.tag}`,
            order,
            contentHash: hash(inputId),
            source: {
              providerEventId: message.providerEventId,
              providerMessageId: message.externalMessageId,
              revisionKey: message.providerRevisionKey,
              imMessageId: message.id,
              deliveryId: delivery.id,
              placementGeneration: delivery.placementGeneration,
            },
          };
        }),
      );
      const received = peers.flatMap(({ peer }) =>
        peer.inputs.flatMap((event) =>
          event.markers.map((inputId) => ({
            inputId,
            agentId: event.agentId,
            sessionId: event.sessionId,
            contentHash: hash(inputId),
            injectionDeliveryId: event.deliveryId,
            injectionRequestId: event.requestId,
            nativeTextHash: event.textHash,
            boundary: "provider_input",
          })),
        ),
      );
      const file = join(directory, "ledger.json");
      const ledger = {
        environment: "synthetic",
        orderingBasis: "sender ordinal encoded in original Slack ts, posted in reverse order before dispatch",
        accepted,
        received,
      };
      await writeFile(file, JSON.stringify(ledger));
      const verdict = JSON.parse(
        execFileSync(process.execPath, [ledgerCli, file], { encoding: "utf8", timeout: 5_000 }),
      );
      expect(verdict).toMatchObject({ ok: true, accepted: 130, received: 130 });
      if (process.env.OPENTAG_INPUT_LEDGER_OUTPUT) {
        const transmissions = peers.map(({ target, sent, dropped }) => ({
          agentId: target.agentId,
          sessionId: target.sessionId,
          dropped,
          dispatches: sent.flatMap<{
            type: string;
            requestId: string;
            inputHash: string;
            members: { deliveryId: string; imMessageId: string }[];
          }>((frame) => {
            if (frame.type === "delivery:run")
              return [
                {
                  type: frame.type,
                  requestId: frame.requestId,
                  inputHash: computeDirectInputHash(frame.delivery),
                  members: [frame.delivery, ...(frame.delivery.batch ?? [])].map(({ deliveryId, imMessageId }) => ({
                    deliveryId,
                    imMessageId,
                  })),
                },
              ];
            if (frame.type === "delivery:steer")
              return [
                {
                  type: frame.type,
                  requestId: frame.requestId,
                  inputHash: computeRuntimeImSteerInputHash(frame.steer),
                  members: [frame.steer, ...(frame.steer.batch ?? [])].map(({ deliveryId, imMessageId }) => ({
                    deliveryId,
                    imMessageId,
                  })),
                },
              ];
            return [];
          }),
          reportAcks: sent.filter((frame) => frame.type === "delivery:report:ack").map((frame) => frame.status),
        }));
        await writeFile(
          process.env.OPENTAG_INPUT_LEDGER_OUTPUT,
          `${JSON.stringify({ ...ledger, verdict, transmissions }, null, 2)}\n`,
        );
      }
      for (const { peer, sent, received: frames, dropped, target } of peers) {
        expect(peer.errors).toEqual([]);
        expect(dropped).toEqual([target.tag === "A" ? "verified" : "steer_result", "report_ack"]);
        const dispatches = sent.filter((frame) => frame.type === "delivery:run" || frame.type === "delivery:steer");
        expect(peer.inputs).toHaveLength(dispatches.length);
        expect(sent.filter((frame) => frame.type === "delivery:report:ack").map((frame) => frame.status)).toEqual([
          "recorded",
          "already_recorded",
        ]);
        const reports = frames.filter((frame) => frame.type === "delivery:report");
        expect(reports).toHaveLength(2);
        expect(reports[0]?.report).toEqual(reports[1]?.report);
      }
    } finally {
      worker.stop();
      await Promise.all(peers.map(({ peer }) => peer.close()));
      control.grants.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
