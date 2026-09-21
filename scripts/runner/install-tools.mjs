import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUNNER_PINS } from "./pins.mjs";

function fail(message) {
  throw new Error(message);
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function readBoundedBody(response, maxBytes) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) fail("download exceeds the reviewed size bound");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      fail("download exceeds the reviewed size bound");
    }
    chunks.push(value);
  }
  const buffer = Buffer.alloc(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

export async function downloadVerified({ url, sha256, bytes, fetchImpl = fetch, fetcher }) {
  const body = fetcher
    ? Buffer.from(await fetcher({ url, maxBytes: bytes, timeoutMs: 120_000 }))
    : await readBoundedBody(
        await fetchImpl(url, { redirect: "follow" }).then((response) => {
          if (!response.ok) fail(`download failed for ${url}: ${response.status}`);
          return response;
        }),
        bytes,
      );
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
