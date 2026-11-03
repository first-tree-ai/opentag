import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { imMessageDeliveries, imMessages, slackWebhookReceipts } from "../../db/schema/index.js";
import { createInboundFixture } from "./inbound-receipt-recovery-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const fixture = fileURLToPath(new URL("./slack-inbound-process.mjs", import.meta.url));
const children = new Map<ChildProcess, Promise<NodeJS.Signals | null>>();
const cleanup: Array<() => Promise<unknown>> = [];
let database: MigratedTestDatabase;

beforeAll(async () => {
  database = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => database.reset());
afterEach(async () => {
  for (const [child, exited] of children) {
    child.kill("SIGKILL");
    await exited;
  }
  children.clear();
  while (cleanup.length) await cleanup.pop()?.();
});
afterAll(async () => database?.stop());

async function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    stdio: ["pipe", "ignore", "pipe", "ipc"],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4_096);
  });
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("exit", (_code, signal) => resolve(signal)),
  );
  children.set(child, exited);
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Synthetic Server start timed out: ${stderr}`)), 15_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      const url = (message as { url?: unknown }).url;
      if (typeof url === "string") resolve(url);
      else reject(new Error("Synthetic Server did not publish its loopback URL"));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Synthetic Server exited before ready: ${stderr}`));
    });
  });
  child.stdin?.end(JSON.stringify({ databaseUrl: database.databaseUrl }));
  return { child, exited, url: await ready };
}

it.skipIf(process.platform === "win32")(
  "recovers acknowledged Slack input after a real Server SIGKILL using the normal recovery sweep",
  async () => {
    const f = await createInboundFixture(database.databaseUrl);
    cleanup.push(f.close);
    await f.service.activateSlack(
      {
        intent: "create",
        agentId: f.agent.id,
        appId: "A_PROCESS",
        teamId: "T_PROCESS",
        botUserId: "U_BOT",
        grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        botAccessToken: "synthetic-bot-token",
        signingSecret: "synthetic-signing-secret",
        installedAt: new Date(),
      },
      "B_BOT",
    );
    const event = {
      type: "event_callback",
      api_app_id: "A_PROCESS",
      team_id: "T_PROCESS",
      event_id: "Ev_PROCESS",
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: "T_PROCESS", user_id: "U_BOT", is_bot: true }],
      event: {
        type: "message",
        channel_type: "im",
        channel: "D_PROCESS",
        user: "U_HUMAN",
        text: "synthetic accepted input survives process death",
        ts: `${Math.floor(Date.now() / 1000)}.000001`,
      },
    };
    const send = (url: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify(event);
      const signature = createHmac("sha256", "synthetic-signing-secret")
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");
      return fetch(`${url}/api/v1/im-bindings/slack/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
    };
    const receipt = async () => (await f.client.database.select().from(slackWebhookReceipts))[0];
    const first = await startServer();
    await f.client.sql.unsafe(
      "create function fail_process_inbox() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure' using errcode='40001'; end $$",
    );
    await f.client.sql.unsafe(
      "create trigger fail_process_inbox before insert on im_messages for each row execute function fail_process_inbox()",
    );
    try {
      expect((await send(first.url)).status).toBe(200);
      await expect.poll(async () => (await receipt())?.status).toBe("failed");
      expect(first.child.kill("SIGKILL")).toBe(true);
      expect(await first.exited).toBe("SIGKILL");
      children.delete(first.child);
    } finally {
      await f.client.sql.unsafe("drop trigger fail_process_inbox on im_messages");
      await f.client.sql.unsafe("drop function fail_process_inbox()");
    }
    const accepted = await receipt();
    expect(accepted?.status).toBe("failed");
    expect(accepted?.workPayload).not.toBeNull();
    expect(await f.client.database.select().from(imMessages)).toHaveLength(0);

    const replacement = await startServer();
    await expect.poll(async () => (await receipt())?.status, { timeout: 12_000 }).toBe("processed");
    expect(await receipt()).toMatchObject({ id: accepted?.id, receivedAt: accepted?.receivedAt, workPayload: null });
    const messages = await f.client.database.select().from(imMessages);
    const deliveries = await f.client.database.select().from(imMessageDeliveries);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ providerEventId: event.event_id, externalMessageId: event.event.ts });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ messageId: messages[0]?.id, state: "pending" });
    expect((await send(replacement.url)).status).toBe(200);
    expect(await f.client.database.select().from(imMessages)).toHaveLength(1);
    expect(await f.client.database.select().from(imMessageDeliveries)).toHaveLength(1);
  },
  45_000,
);
