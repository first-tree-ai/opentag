import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNNER_PINS } from "./pins.mjs";

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000];
const RETRY_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

class TransientDownloadError extends Error {}

function fail(message) {
  throw new Error(message);
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function readBoundedBody(response, maxBytes, signal) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) fail("download exceeds the reviewed size bound");
    return buffer;
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        fail("download exceeds the reviewed size bound");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const buffer = Buffer.alloc(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

async function waitForDownloadRetry(delayMs, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readDownloadResponse(response, url, bytes, signal) {
  if (!response.ok) {
    await response.body?.cancel();
    const message = `download failed for ${url}: ${response.status}`;
    if (RETRY_STATUSES.has(response.status)) throw new TransientDownloadError(message);
    fail(message);
  }
  return readBoundedBody(response, bytes, signal);
}

async function downloadWithRetry({ url, bytes, fetchImpl, timeoutMs, signal: cancel }) {
  cancel?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Artifact download timed out", "TimeoutError")),
    timeoutMs,
  );
  const signal = cancel ? AbortSignal.any([cancel, deadline.signal]) : deadline.signal;
  try {
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        const response = await fetchImpl(url, { redirect: "follow", signal });
        const body = await readDownloadResponse(response, url, bytes, signal);
        signal.throwIfAborted();
        return body;
      } catch (error) {
        signal.throwIfAborted();
        const delay = RETRY_DELAYS_MS[attempt];
        const transient =
          error instanceof TransientDownloadError || RETRY_NETWORK_CODES.has(error?.cause?.code ?? error?.code);
        if (delay === undefined || !transient) throw error;
        await waitForDownloadRetry(delay, signal);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadVerified({
  url,
  sha256,
  bytes,
  fetchImpl = fetch,
  fetcher,
  signal,
  timeoutMs = 120_000,
}) {
  const body = fetcher
    ? Buffer.from(await fetcher({ url, maxBytes: bytes, timeoutMs, signal }))
    : await downloadWithRetry({ url, bytes, fetchImpl, timeoutMs, signal });
  signal?.throwIfAborted();
  if (body.byteLength !== bytes) fail(`size mismatch for ${url}: expected ${bytes}, got ${body.byteLength}`);
  const actual = sha256Buffer(body);
  if (actual !== sha256) fail(`sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`);
  return body;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function writeRootOwnedFile(path, contents, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

export function writeExecShim({ dest, name, nodePath, cliPath }) {
  writeRootOwnedFile(join(dest, name), `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\n`);
}

export function writePiShim({ dest, nodePath, cliPath }) {
  writeExecShim({ dest, name: "pi", nodePath, cliPath });
}

export function writeContextTreeShim({ dest, nodePath, cliPath }) {
  writeExecShim({ dest, name: "context-tree", nodePath, cliPath });
}

export function writeRunnerShim({ dest, nodePath, cliPath }) {
  writeExecShim({ dest, name: "opentag-runner", nodePath, cliPath });
}

export function writeOpenTagShim({ dest, nodePath, cliPath, binName = "opentag" }) {
  writeExecShim({ dest, name: binName, nodePath, cliPath });
  if (binName !== "opentag") writeExecShim({ dest, name: "opentag", nodePath, cliPath });
}

export async function installGh({ dest, pins = RUNNER_PINS, fetchImpl, extractTar }) {
  const archive = await downloadVerified({ ...pins.gh, fetchImpl });
  const executable = extractTar(archive, pins.gh.archiveMember);
  writeRootOwnedFile(join(dest, "gh"), executable);
}
