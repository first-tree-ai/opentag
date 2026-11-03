import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { registerSlackEventsRoute } from "../../api/slack-events.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { ApplicationCipher } from "../../services/crypto.ts";
import { ImMessageInbox } from "../../services/im/index.ts";
import { ImBindingService } from "../../services/im-bindings/index.ts";
import { SlackAdapter } from "../../services/im-bindings/slack/adapter.ts";
import { SlackWebhookReceiptStore } from "../../services/im-bindings/slack/webhook-receipt-store.ts";

const { databaseUrl } = JSON.parse(readFileSync(0, "utf8"));
const client = createDatabaseClient(databaseUrl);
const server = Fastify({ logger: false });
registerSlackEventsRoute(server, {
  imBindings: new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7))),
  inbox: new ImMessageInbox(client.database),
  receipts: new SlackWebhookReceiptStore(client.database),
  createAdapter: (installation) =>
    new SlackAdapter({
      api: {},
      token: installation.botAccessToken,
      appId: installation.appId,
      teamId: installation.teamId,
      botUserId: installation.botUserId,
      botId: installation.botId,
    }),
});
const url = await server.listen({ host: "127.0.0.1", port: 0 });
process.send({ url });
