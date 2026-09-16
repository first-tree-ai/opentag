import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { RuntimeProxyAuthorization } from "./credential-broker.js";
import type { ProviderProxyRequest, ProviderProxyResponse } from "./provider-proxy-adapter.js";
import {
  filterResponseHeaders,
  journalSafeResource,
  RuntimeProxyError,
  sanitizeRequestHeaders,
  singleChunk,
  UPSTREAM_TIMEOUT_MS,
  webBody,
} from "./provider-proxy-support.js";
import type { RuntimeUrlHandle } from "./url-handle-store.js";
import type { RuntimeWriteJournal } from "./write-journal.js";
import {
  beginWriteReceipt,
  classifyStatusWriteReceipt,
  completeWriteReceipt,
  completeWriteReceiptUnknown,
} from "./write-receipt.js";

export interface ForwardUploadWithReceiptInput {
  authorization: RuntimeProxyAuthorization;
  fetchImpl: typeof fetch;
  handle: RuntimeUrlHandle;
  journal: RuntimeWriteJournal;
  now: () => Date;
  request: ProviderProxyRequest;
}

/**
 * Forwards one execution-bound upload handle body under a durable write receipt. The receipt is
 * journaled before the first upstream byte using only safe request identity metadata (method,
 * handle path, content type) and the handle's resource id (or opaque handle id); the raw bytes,
 * the signed URL, and any provider token are never stored. The live fence is revalidated after
 * the async journal boundary. HTTP 2xx is the accepted upload stage; definite 4xx is a
 * rejection; transport/5xx/408/abort stay unknown and block a same-resource retry.
 */
export async function forwardUploadWithReceipt(input: ForwardUploadWithReceiptInput): Promise<ProviderProxyResponse> {
  const { authorization, fetchImpl, handle, journal, now, request } = input;
  const headers = sanitizeRequestHeaders(request.headers);
  const context = await beginWriteReceipt(journal, {
    executionId: request.executionId,
    now,
    operation: `${request.provider}.files.upload_bytes`,
    policyRevision: authorization.authorizationRevision,
    provider: request.provider,
    requestHash: uploadRequestHash(request, headers),
    resource: journalSafeResource(handle.resource ?? handle.handleId),
    sessionId: authorization.sessionId,
  });
  try {
    // The async journal boundary is over: revalidate the live fence before any upstream byte.
    await authorization.recheck(request.signal);
    const response = await fetchUpload(fetchImpl, request, handle.url, headers);
    const receipt = classifyStatusWriteReceipt(response.status);
    await completeWriteReceipt(journal, request.sessionId, context, receipt, now);
    if (receipt.state === "unknown") throw new RuntimeProxyError("write_outcome_unknown");
    return {
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      body: response.body ? webBody(response.body) : singleChunk(new Uint8Array(0)),
    };
  } catch (error) {
    await completeWriteReceiptUnknown(journal, request.sessionId, context, now);
    if (request.signal.aborted || (error instanceof RuntimeProxyError && error.code === "cancelled")) {
      throw new RuntimeProxyError("cancelled");
    }
    throw new RuntimeProxyError("write_outcome_unknown");
  }
}

/** Safe request identity: never the raw bytes, the signed URL, or any provider token. */
function uploadRequestHash(request: ProviderProxyRequest, headers: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify([request.method, request.path, headers["content-type"] ?? null]))
    .digest("hex");
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
