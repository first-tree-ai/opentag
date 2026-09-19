import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ServiceLogger } from "../observability/service-logger.js";
import { S3SkillObjectStore } from "../services/skills/index.js";

const KEY = `skills/accounts/acc/agents/agent/skills/skill/${"a".repeat(64)}.tar.gz`;
const SECRET = "super-secret-access-key-value";

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let baseUrl: string;
let respond: (request: IncomingMessage, response: ServerResponse) => void;
const recorded: RecordedRequest[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    recorded.push({ method: request.method, url: request.url, headers: request.headers });
    respond(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  recorded.length = 0;
  respond = (_request, response) => {
    response.writeHead(200, { "content-length": "0" });
    response.end();
  };
});

function store(
  overrides: {
    endpoint?: string;
    forcePathStyle?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    logger?: ServiceLogger;
  } = {},
) {
  return new S3SkillObjectStore({
    config: {
      endpoint: overrides.endpoint ?? baseUrl,
      region: "us-east-1",
      bucket: "opentag-skills",
      accessKeyId: "opentag",
      secretAccessKey: SECRET,
      forcePathStyle: overrides.forcePathStyle ?? true,
    },
    ...(overrides.fetchImpl ? { fetch: overrides.fetchImpl } : {}),
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  });
}

async function failure(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("S3SkillObjectStore", () => {
  it("signs path-style requests and sends the real payload hash", async () => {
    const bodies: Buffer[] = [];
    respond = (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks));
        response.writeHead(200, { "content-length": "0" });
        response.end();
      });
    };
    const payload = new TextEncoder().encode("archive-bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    await store().put(KEY, payload, { sha256 });

    const request = recorded[0];
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe(`/opentag-skills/${KEY}`);
    expect(String(request?.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request?.headers["x-amz-content-sha256"]).toBe(sha256);
    expect(bodies[0]?.toString("utf8")).toBe("archive-bytes");
  });

  it("builds a virtual-hosted URL when path style is disabled", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(null, { status: 200 });
    };
    await store({ endpoint: "http://minio.example.test", forcePathStyle: false, fetchImpl }).put(
      KEY,
      new TextEncoder().encode("x"),
      { sha256: "a".repeat(64) },
    );
    expect(new URL(urls[0] ?? "").host).toBe("opentag-skills.minio.example.test");
    expect(new URL(urls[0] ?? "").pathname).toBe(`/${KEY}`);
  });

  it("maps head and get responses to typed results", async () => {
    respond = (_request, response) => {
      response.writeHead(200, { "content-length": "5" });
      response.end("hello");
    };
    const objectStore = store();
    expect(await objectStore.head(KEY)).toEqual({ bytes: 5 });
    const body = Buffer.from(await new Response(await objectStore.get(KEY)).arrayBuffer());
    expect(body.toString("utf8")).toBe("hello");

    respond = (_request, response) => {
      response.writeHead(404);
      response.end();
    };
    expect(await objectStore.head(KEY)).toBeNull();
    await failure(objectStore.get(KEY), "not_found");
  });

  it("maps 503 to unavailable and 403 to rejected", async () => {
    const objectStore = store();
    respond = (_request, response) => {
      response.writeHead(503);
      response.end();
    };
    await failure(objectStore.put(KEY, new Uint8Array([1]), { sha256: "a".repeat(64) }), "unavailable");
    respond = (_request, response) => {
      response.writeHead(403);
      response.end();
    };
    await failure(objectStore.delete(KEY), "rejected");
  });

  it("maps a stalled transfer to unavailable", async () => {
    respond = (_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-length": "0" });
        response.end();
      }, 300);
    };
    await failure(store({ timeoutMs: 25 }).head(KEY), "unavailable");
  });

  it("never writes the secret access key to a log line", async () => {
    const lines: string[] = [];
    const logger: ServiceLogger = {
      debug: (bindings, message) => lines.push(`${JSON.stringify(bindings)} ${message}`),
      info: (bindings, message) => lines.push(`${JSON.stringify(bindings)} ${message}`),
      warn: (bindings, message) => lines.push(`${JSON.stringify(bindings)} ${message}`),
      error: (bindings, message) => lines.push(`${JSON.stringify(bindings)} ${message}`),
    };
    const objectStore = store({ logger });
    await objectStore.put(KEY, new TextEncoder().encode("x"), { sha256: "a".repeat(64) });
    await objectStore.head(KEY);
    await objectStore.delete(KEY);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
