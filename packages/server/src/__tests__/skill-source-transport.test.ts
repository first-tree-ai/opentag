import { createServer, type Server } from "node:http";
import { SKILL_ERROR_CODES } from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SkillSourceFetcher } from "../services/skills/source/source-fetcher.js";
import { nodeSkillSourceTransport } from "../services/skills/source/source-transport.js";

/**
 * The production transport against a real socket: the address pin, the declared and delivered byte
 * caps, and the refusal to follow a redirect.
 *
 * The origin is a loopback HTTP server the test owns. The subject is the socket layer, so a stub
 * would prove nothing; what is asserted is which address the transport dialed and what it did with
 * the answer.
 */

const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((r) => server.close(() => r()))));
});

function origin(
  handler: (request: { host: string | undefined; url: string | undefined }) => {
    status?: number;
    body?: string;
    contentLength?: number;
    delayMs?: number;
    endless?: boolean;
    /** Writes `body` and then keeps the socket open, so only the client can end the exchange. */
    stall?: boolean;
    headers?: Record<string, string>;
  },
): Promise<{
  port: number;
  seen: { host: string | undefined; url: string | undefined }[];
  /** How many response bytes left the origin, so "not drained" is observable. */
  written: () => number;
  /** Whether the origin saw its connection closed by the client. */
  closed: () => boolean;
}> {
  const seen: { host: string | undefined; url: string | undefined }[] = [];
  let written = 0;
  let closed = false;
  const server = createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url });
    response.on("close", () => {
      closed = true;
    });
    const answer = handler({ host: request.headers.host, url: request.url });
    const body = answer.body ?? "";
    const headers: Record<string, string> = { "content-type": "text/plain", ...answer.headers };
    if (answer.contentLength !== undefined) headers["content-length"] = String(answer.contentLength);
    const send = () => {
      response.writeHead(answer.status ?? 200, headers);
      if (answer.stall === true) {
        written += Buffer.byteLength(body);
        response.write(body);
        return;
      }
      if (answer.endless === true) {
        // A peer that keeps writing until it is stopped. Nothing here cooperates with being drained.
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const pump = () => {
          if (response.destroyed) return;
          written += chunk.byteLength;
          if (response.write(chunk)) setImmediate(pump);
          else response.once("drain", pump);
        };
        pump();
        return;
      }
      written += Buffer.byteLength(body);
      response.end(body);
    };
    if (answer.delayMs === undefined) send();
    else setTimeout(send, answer.delayMs).unref();
  });
  openServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        seen,
        written: () => written,
        closed: () => closed,
      });
    });
  });
}

async function failureCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("nodeSkillSourceTransport", () => {
  it("dials the pinned address while keeping the hostname as identity", async () => {
    // The URL names a host that does not resolve; the pin says where to connect. The origin must see
    // the *hostname* in `Host`, because that is what the peer authenticates and routes on.
    const server = await origin(() => ({ body: "pinned" }));
    const response = await nodeSkillSourceTransport({
      url: new URL(`http://pinned.example:${server.port}/skills.json`),
      pin: { address: "127.0.0.1", family: 4 },
      maxBytes: 1024,
    });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.bytes)).toBe("pinned");
    expect(server.seen[0]?.host).toBe(`pinned.example:${server.port}`);
  });

  it("refuses a body whose declared length exceeds the cap, without buffering it", async () => {
    const server = await origin(() => ({ body: "", contentLength: 4096 }));
    expect(
      await failureCode(
        nodeSkillSourceTransport({
          url: new URL(`http://127.0.0.1:${server.port}/big`),
          maxBytes: 16,
        }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_TOO_LARGE);
  });

  it("refuses a body that exceeds the cap while it is delivered", async () => {
    const server = await origin(() => ({ body: "x".repeat(64) }));
    expect(
      await failureCode(
        nodeSkillSourceTransport({
          url: new URL(`http://127.0.0.1:${server.port}/big`),
          maxBytes: 16,
        }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_TOO_LARGE);
  });

  it("returns a redirect instead of following it", async () => {
    const server = await origin(() => ({
      status: 302,
      headers: { location: `http://127.0.0.1:9/elsewhere` },
    }));
    const response = await nodeSkillSourceTransport({
      url: new URL(`http://127.0.0.1:${server.port}/redirect`),
      maxBytes: 1024,
    });
    expect(response.status).toBe(302);
    expect(response.bytes.byteLength).toBe(0);
  });

  it("reads no body from an error response", async () => {
    const server = await origin(() => ({ status: 500, body: "y".repeat(1024) }));
    const response = await nodeSkillSourceTransport({
      url: new URL(`http://127.0.0.1:${server.port}/broken`),
      maxBytes: 16,
    });
    expect(response.status).toBe(500);
    expect(response.bytes.byteLength).toBe(0);
  });

  it("stops an error response instead of draining it", async () => {
    /*
     * A peer that never finishes writing must not be able to bill this deployment for bandwidth. The
     * status is known from the headers, so the response is destroyed there; a drain would keep reading
     * until the peer stopped or the deadline expired.
     */
    const server = await origin(() => ({ status: 500, endless: true }));
    const response = await nodeSkillSourceTransport({
      url: new URL(`http://127.0.0.1:${server.port}/endless`),
      maxBytes: 16,
      timeoutMs: 5_000,
    });
    expect(response.status).toBe(500);
    expect(response.bytes.byteLength).toBe(0);

    // The origin keeps pumping until the socket is gone; let it notice, then read where it stopped.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterDestroy = server.written();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.written()).toBe(afterDestroy);
  });

  it("reports an unreachable port as unreachable", async () => {
    expect(
      await failureCode(nodeSkillSourceTransport({ url: new URL("http://127.0.0.1:9/skills.json"), maxBytes: 16 })),
    ).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
  });

  it("bounds the deadline", async () => {
    // The origin answers far outside the budget, so the deadline — not the response — decides.
    const server = await origin(() => ({ body: "late", delayMs: 300 }));
    expect(
      await failureCode(
        nodeSkillSourceTransport({
          url: new URL(`http://127.0.0.1:${server.port}/slow`),
          maxBytes: 16,
          timeoutMs: 20,
        }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
  });

  it("closes the connection when the deadline expires mid-body", async () => {
    /*
     * The response has started and then stalls, so the timer is the only thing left that can end
     * this. Destroying the request has to take the socket with it: otherwise the peer holds an open
     * connection to a fetch that already failed.
     */
    const server = await origin(() => ({ body: "partial", stall: true }));
    expect(
      await failureCode(
        nodeSkillSourceTransport({
          url: new URL(`http://127.0.0.1:${server.port}/stalled`),
          maxBytes: 1024,
          timeoutMs: 20,
        }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.closed()).toBe(true);
  });

  it("refuses an already-aborted signal without dialing", async () => {
    // A signal that is already aborted never fires its listener, so a request built here would run
    // to its own deadline while the caller had long been told the fetch failed.
    const server = await origin(() => ({ body: "never read" }));
    const caller = new AbortController();
    caller.abort();
    expect(
      await failureCode(
        nodeSkillSourceTransport({
          url: new URL(`http://127.0.0.1:${server.port}/skills.json`),
          maxBytes: 1024,
          signal: caller.signal,
        }),
      ),
    ).toBe(SKILL_ERROR_CODES.SOURCE_UNREACHABLE);
    expect(server.seen).toHaveLength(0);
  });
});

describe("SkillSourceFetcher over the real transport", () => {
  it("maps a redirect to a blocked source", async () => {
    const server = await origin(() => ({ status: 301, headers: { location: "http://127.0.0.1:9/x" } }));
    const fetcher = new SkillSourceFetcher({ allowLoopback: true });
    expect(await failureCode(fetcher.fetchBytes(`http://127.0.0.1:${server.port}/x`))).toBe(
      SKILL_ERROR_CODES.SOURCE_BLOCKED,
    );
  });

  it("reads a document through the pinned transport", async () => {
    const server = await origin(() => ({ body: "index" }));
    const fetcher = new SkillSourceFetcher({ allowLoopback: true });
    const response = await fetcher.fetchBytes(`http://127.0.0.1:${server.port}/index.json`);
    expect(new TextDecoder().decode(response.bytes)).toBe("index");
  });
});
