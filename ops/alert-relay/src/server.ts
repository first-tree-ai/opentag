import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { deliver, type Log } from "./deliver.ts";
import type { FeishuClient } from "./feishu.ts";
import { parseIncident } from "./incident.ts";

function authorized(header: string | undefined, config: Pick<Config, "username" | "password">): boolean {
  const expected = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header ?? ""), hash(expected));
}

function reply(response: ServerResponse, code: number, status: string) {
  response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ status }));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 65_536) throw new Error("Notification body too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type Feishu = Pick<FeishuClient, "token" | "send" | "urgent">;

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  feishu: Feishu,
  log: Log,
  signal: AbortSignal,
) {
  let incident: ReturnType<typeof parseIncident>;
  try {
    incident = parseIncident(await body(request), config);
  } catch {
    return reply(response, 400, "invalid_notification");
  }
  try {
    return reply(response, 200, await deliver(incident, config, feishu, log, signal));
  } catch {
    log("ERROR", "relay_request_failed", {});
    return reply(response, 503, "delivery_unavailable");
  }
}

export function relayServer(config: Config, feishu: Feishu, log: Log) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (request, response) => {
    const route = `${request.method} ${request.url}`;
    if (route === "GET /healthz") return reply(response, 200, "ok");
    if (!authorized(request.headers.authorization, config)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="monitoring"');
      return reply(response, 401, "unauthorized");
    }
    const signal = AbortSignal.timeout(8_000);
    if (route === "GET /readyz") {
      try {
        await feishu.token(signal);
        return reply(response, 200, "ready");
      } catch {
        return reply(response, 503, "dependencies_unavailable");
      }
    }
    if (route !== "POST /monitoring") return reply(response, 404, "not_found");
    if (!request.headers["content-type"]?.startsWith("application/json")) return reply(response, 415, "json_required");
    return forward(request, response, config, feishu, log, signal);
  });
}
