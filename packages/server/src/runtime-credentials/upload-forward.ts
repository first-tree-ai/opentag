import { Readable } from "node:stream";
import type { RuntimeProxyAuthorization } from "./credential-broker.js";
import type { ProviderProxyRequest, ProviderProxyResponse } from "./provider-proxy-adapter.js";
import {
  filterResponseHeaders,
  RuntimeProxyError,
  sanitizeRequestHeaders,
  singleChunk,
  UPSTREAM_TIMEOUT_MS,
  webBody,
} from "./provider-proxy-support.js";
import type { RuntimeUrlHandle } from "./url-handle-store.js";
import { classifyStatusWriteOutcome } from "./write-outcome.js";

export interface ForwardUploadInput {
  authorization: RuntimeProxyAuthorization;
  fetchImpl: typeof fetch;
  handle: RuntimeUrlHandle;
  request: ProviderProxyRequest;
}

/**
 * Forwards one execution-bound upload handle body in a single upstream attempt. The live fence
 * is revalidated before any upstream byte and pre-send failures keep their own codes; the raw
 * bytes and the signed URL are never stored. HTTP 2xx is the accepted upload stage; a definite
 * 4xx rejection is relayed to the caller; transport failure, 5xx, or 408 surfaces as
 * `write_outcome_unknown`. The attempt is never journaled and never replayed: the caller
 * reconciles against the provider.
 */
export async function forwardUpload(input: ForwardUploadInput): Promise<ProviderProxyResponse> {
  const { authorization, fetchImpl, handle, request } = input;
  const headers = sanitizeRequestHeaders(request.headers);
  // Preflight boundary: the live fence fails with its own code (or `cancelled`) before any
  // upstream byte; only the send and its response classification map to `write_outcome_unknown`.
  try {
    await authorization.recheck(request.signal);
  } catch (error) {
    if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
    throw error;
  }
  try {
    const response = await fetchUpload(fetchImpl, request, handle.url, headers);
    const outcome = classifyStatusWriteOutcome(response.status);
    // An unconfirmed upload outcome must never reach the caller as a successful write.
    if (outcome.state === "unknown") throw new RuntimeProxyError("write_outcome_unknown");
    return {
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      body: response.body ? webBody(response.body) : singleChunk(new Uint8Array(0)),
    };
  } catch (error) {
    if (request.signal.aborted || (error instanceof RuntimeProxyError && error.code === "cancelled")) {
      throw new RuntimeProxyError("cancelled");
    }
    throw new RuntimeProxyError("write_outcome_unknown");
  }
}

/** Streams the upload body upstream without buffering it; the URL handle is never revisited. */
async function fetchUpload(
  fetchImpl: typeof fetch,
  request: ProviderProxyRequest,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS * 4)]),
    headers: { "content-type": headers["content-type"] ?? "application/octet-stream" },
    body: Readable.from(request.body),
    duplex: "half",
  };
  try {
    return await fetchImpl(url, init);
  } catch {
    if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
    throw new RuntimeProxyError("upstream_unavailable");
  }
}
