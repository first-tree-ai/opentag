import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { type GitHubProxyFailureCode, githubProxyHeaders } from "@opentag/shared";
import type { ProviderProxyResponse } from "../../runtime-credentials/provider-proxy-adapter.js";
import { classifyOutboundDestination } from "../outbound/destination-policy.js";
import { allowedDownloadTarget, githubRequestTarget } from "./http-target.js";

export class GitHubProxyError extends Error {
  constructor(readonly code: GitHubProxyFailureCode) {
    super(code);
  }
}
export interface GitHubHttpRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  token: string;
  signal: AbortSignal;
}
export interface GitHubHttpTransportOptions {
  /** Injection seam for offline TLS/HTTP fixtures; production always uses verified HTTPS. */
  connect?: (url: URL, options: https.RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  idleTimeoutMs?: number;
}

/** Raw HTTP bytes, one attempt, bounded idle waits. No fetch decompression or API interpretation. */
export class GitHubHttpTransport {
  constructor(readonly options: GitHubHttpTransportOptions = {}) {}

  async request(input: GitHubHttpRequest): Promise<ProviderProxyResponse> {
    let url = input.url;
    let authenticated = true;
    for (let hop = 0; ; hop++) {
      input.signal.throwIfAborted();
      const headers = requestHeaders(input, authenticated, hop);
      const response = await this.#open(url, { ...input, headers }, hop === 0);
      const status = response.statusCode ?? 502;
      const outgoing = responseHeaders(response);
      const location = response.headers.location;
      if (![301, 302, 303, 307, 308].includes(status) || !location)
        return { status, headers: outgoing, body: this.#body(response) };
      if (!["GET", "HEAD"].includes(input.method)) {
        // Do not replay writes or disclose signed cross-origin redirect capabilities.
        const next = redirectTarget(location, url, input);
        if (!next || next.origin !== input.url.origin) delete outgoing.location;
        return { status, headers: outgoing, body: this.#body(response) };
      }
      const next = redirectTarget(location, url, input);
      response.destroy();
      if (!next || hop >= 5) throw new GitHubProxyError("github_download_target_unsupported");
      authenticated = authenticated && next.origin === url.origin;
      url = next;
    }
  }

  async #open(url: URL, input: GitHubHttpRequest, sendBody: boolean): Promise<IncomingMessage> {
    const verdict = await boundedLookup(
      classifyOutboundDestination(url, this.options.resolveAddresses),
      input.signal,
      this.options.idleTimeoutMs ?? 60_000,
    );
    input.signal.throwIfAborted();
    if (!verdict.ok || !verdict.pin)
      throw new GitHubProxyError(
        !verdict.ok && verdict.failure.kind === "unreachable" ? "github_dns_failed" : "github_destination_blocked",
      );
    const pin = verdict.pin;
    return new Promise((resolve, reject) => {
      let outgoing: ClientRequest;
      try {
        outgoing = (this.options.connect ?? ((target, options, listener) => https.request(target, options, listener)))(
          url,
          {
            method: input.method,
            headers: input.headers,
            signal: input.signal,
            agent: false,
            // Pin the checked DNS answer while preserving hostname verification and SNI.
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [{ address: pin.address, family: pin.family }]);
              else callback(null, pin.address, pin.family);
            },
          },
          (response) => {
            outgoing.setTimeout(0);
            resolve(response);
          },
        );
      } catch (error) {
        reject(classifyConnectionError(error instanceof Error ? error : new Error("Connection failed")));
        return;
      }
      outgoing.on("error", (error) => reject(classifyConnectionError(error)));
      outgoing.setTimeout(this.options.idleTimeoutMs ?? 60_000, () =>
        outgoing.destroy(new GitHubProxyError("github_timeout")),
      );
      void pumpBody(outgoing, sendBody ? input.body : emptyBody());
    });
  }

  async *#body(response: IncomingMessage): AsyncIterable<Uint8Array> {
    const iterator = response[Symbol.asyncIterator]();
    try {
      for (;;) {
        const timer = setTimeout(
          () => response.destroy(new GitHubProxyError("github_timeout")),
          this.options.idleTimeoutMs ?? 60_000,
        );
        let chunk: IteratorResult<Uint8Array>;
        try {
          chunk = await iterator.next();
        } finally {
          clearTimeout(timer);
        }
        if (chunk.done) return;
        yield chunk.value;
      }
    } catch (error) {
      throw error instanceof GitHubProxyError ? error : new GitHubProxyError("github_response_truncated");
    } finally {
      response.destroy();
    }
  }
}

function waitWritable(request: ClientRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      request.off("drain", drain);
      request.off("error", fail);
      request.off("close", closed);
    };
    const drain = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => {
      cleanup();
      resolve();
    };
    request.once("drain", drain);
    request.once("error", fail);
    request.once("close", closed);
  });
}
function classifyConnectionError(error: Error): GitHubProxyError {
  if (error instanceof GitHubProxyError) return error;
  const code = "code" in error ? String(error.code) : "";
  return new GitHubProxyError(/CERT|TLS|SSL/.test(code) ? "github_tls_failed" : "github_connect_failed");
}

/** DNS resolution itself may stall before a socket exists; cancellation must still release the stream. */
function boundedLookup<T>(lookup: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new GitHubProxyError("github_timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    void lookup.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      () => {
        cleanup();
        reject(new GitHubProxyError("github_dns_failed"));
      },
    );
  });
}

function responseHeaders(response: IncomingMessage): Record<string, string> {
  return githubProxyHeaders(
    Object.fromEntries(
      Object.entries(response.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
      ),
    ),
  );
}
function redirectTarget(location: string, url: URL, input: GitHubHttpRequest): URL | undefined {
  try {
    const next = new URL(location, url);
    if (next.username || next.password || next.hash) throw new GitHubProxyError("github_download_target_unsupported");
    if (next.origin === input.url.origin) githubRequestTarget(next.hostname, next.pathname + next.search, input.method);
    else if (!allowedDownloadTarget(next)) throw new GitHubProxyError("github_download_target_unsupported");
    return next;
  } catch {
    return undefined;
  }
}
async function* emptyBody(): AsyncIterable<Uint8Array> {}
async function pumpBody(outgoing: ClientRequest, body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const chunk of body) {
      if (outgoing.destroyed) return;
      if (chunk.byteLength === 0) continue;
      if (!outgoing.headersSent && !outgoing.hasHeader("content-length"))
        outgoing.setHeader("transfer-encoding", "chunked");
      if (!outgoing.write(chunk)) await waitWritable(outgoing);
    }
    if (!outgoing.destroyed) outgoing.end();
  } catch {
    outgoing.destroy(new GitHubProxyError("github_request_body_failed"));
  }
}

function requestHeaders(input: GitHubHttpRequest, authenticated: boolean, hop: number): Record<string, string> {
  const headers = githubProxyHeaders(input.headers);
  if (hop > 0) delete headers["content-length"];
  if (!headers["user-agent"]) headers["user-agent"] = "opentag-github-proxy";
  if (authenticated)
    headers.authorization =
      input.url.hostname === "github.com"
        ? `Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`
        : `Bearer ${input.token}`;
  return headers;
}
