import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import type {
  ProviderCliCatalogArtifact,
  ProviderCliCatalogEntry,
  ProviderCliFetcher,
  ProviderCliProvider,
} from "@opentag/client";
import { PROVIDER_CLI_CATALOG } from "@opentag/client";

/**
 * Minimal provider-cli fixtures for CLI-layer tests. Kept deliberately small; the
 * exhaustive fixtures live in packages/client tests. Nothing here touches the network
 * beyond a loopback server or the real account home.
 */

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export interface FileTreeSnapshotEntry {
  readonly hash: string;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly rel: string;
}

/** Recursively snapshot regular files under `root` by relative path, digest, mode, and mtime. */
export async function snapshotFileTree(root: string): Promise<readonly FileTreeSnapshotEntry[]> {
  const entries: FileTreeSnapshotEntry[] = [];
  async function walk(path: string): Promise<void> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) await walk(join(path, child.name));
      return;
    }
    if (!info.isFile()) return;
    entries.push({
      hash: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      mode: info.mode,
      mtimeMs: info.mtimeMs,
      rel: relative(root, path) || ".",
    });
  }
  await walk(root);
  return entries.sort((left, right) => left.rel.localeCompare(right.rel));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function fakeCliScript(provider: ProviderCliProvider, version: string, surfaceExit = 0): string {
  const entry = PROVIDER_CLI_CATALOG.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`unknown provider ${provider}`);
  const versionInvocation = entry.probes.versionArgs.join(" ");
  const surfaceInvocation = entry.probes.surfaceArgs.join(" ");
  const versionOutput = provider === "feishu" ? `lark-cli version ${version}` : `Using slack v${version}`;
  return [
    "#!/bin/sh",
    'while [ "$#" -gt 0 ]; do',
    `  case "$1" in`,
    `    ${entry.probes.versionArgs[0]}|${entry.probes.surfaceArgs[0]}) break ;;`,
    "    *) shift ;;",
    "  esac",
    "done",
    'case "$*" in',
    `  "${versionInvocation}")`,
    `    printf '%s\\n' ${shellQuote(versionOutput)}`,
    "    exit 0 ;;",
    `  "${surfaceInvocation}")`,
    "    echo surface-ok",
    `    exit ${surfaceExit} ;;`,
    "esac",
    'echo "unexpected args: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
}

export async function writeFakeCli(directory: string, provider: ProviderCliProvider, version: string): Promise<string> {
  const entry = PROVIDER_CLI_CATALOG.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`unknown provider ${provider}`);
  await mkdir(directory, { recursive: true });
  const target = join(directory, entry.command);
  await writeFile(target, fakeCliScript(provider, version), { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

function octal(value: number, length: number): Uint8Array {
  const text = value.toString(8).padStart(length - 1, "0");
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length - 1; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

function writeString(target: Uint8Array, offset: number, value: string, length: number): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

/** Build a ustar archive with a single executable member. */
export function buildTarGz(name: string, content: string, mode = 0o755): Uint8Array {
  const body = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  writeString(header, 0, name, 100);
  header.set(octal(mode, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(body.length, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeString(header, 257, "ustar", 6);
  header[263] = 0x30;
  header[264] = 0x30;
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(octal(checksum, 7), 148);
  header[155] = 0;
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  const end = new Uint8Array(1024);
  const tar = new Uint8Array(header.length + padded.length + end.length);
  tar.set(header, 0);
  tar.set(padded, 512);
  tar.set(end, 512 + padded.length);
  return gzipSync(tar);
}

export function sha256Hex(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface FixtureHttpServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureHttpServer(routes: Map<string, Uint8Array>): Promise<FixtureHttpServer> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = routes.get(url.pathname);
    if (!body) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-length", body.byteLength);
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface ManagedFixture {
  readonly catalog: readonly ProviderCliCatalogEntry[];
  /** Test-only fetcher for the loopback fixture server; production rejects non-HTTPS. */
  readonly fetcher: ProviderCliFetcher;
  readonly close: () => Promise<void>;
}

/** Test-only fetcher for loopback fixture servers; the production fetcher requires HTTPS. */
export const loopbackFetcher: ProviderCliFetcher = async ({ url, maxBytes, timeoutMs }) => {
  if (!url.startsWith("http://127.0.0.1:")) {
    throw new Error(`loopbackFetcher only serves loopback fixture URLs, got: ${url}`);
  }
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`fixture download failed with HTTP ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > maxBytes) throw new Error("fixture body exceeds maxBytes");
  return body;
};

/** A fixture catalog + loopback server serving one managed artifact for this host. */
export async function makeManagedFixture(provider: ProviderCliProvider, version: string): Promise<ManagedFixture> {
  const real = PROVIDER_CLI_CATALOG.find((candidate) => candidate.provider === provider);
  if (!real) throw new Error(`unknown provider ${provider}`);
  const executablePath = real.artifacts[0]?.executablePath ?? real.command;
  const executableContent = fakeCliScript(provider, version);
  const archive = buildTarGz(executablePath, executableContent);
  const routes = new Map<string, Uint8Array>();
  const server = await startFixtureHttpServer(routes);
  const routePath = `/${provider}.tar.gz`;
  routes.set(routePath, archive);
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const artifact: ProviderCliCatalogArtifact = {
    platform,
    arch,
    archiveType: "tar.gz",
    url: `${server.baseUrl}${routePath}`,
    sha256: sha256Hex(archive),
    archiveBytes: archive.byteLength,
    maxExtractedBytes: archive.byteLength * 16 + 4 * 1024 * 1024,
    executablePath,
    executableSha256: sha256Hex(executableContent),
    executableBytes: new TextEncoder().encode(executableContent).byteLength,
  };
  return {
    fetcher: loopbackFetcher,
    catalog: [
      {
        provider,
        command: real.command,
        displayName: real.displayName,
        version,
        compatibility: real.compatibility,
        probes: real.probes,
        managedEnvironment: real.managedEnvironment,
        managedArguments: real.managedArguments,
        license: real.license,
        artifacts: [artifact],
      },
    ],
    close: server.close,
  };
}
