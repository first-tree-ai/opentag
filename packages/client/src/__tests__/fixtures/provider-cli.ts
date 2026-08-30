import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ProviderCliCatalogArtifact, ProviderCliCatalogEntry, ProviderCliProvider } from "../../index.js";
import { PROVIDER_CLI_CATALOG } from "../../index.js";

/**
 * Deterministic Provider CLI fixtures: shell-script stand-ins for the official CLIs,
 * hand-built tar.gz archives (including malicious shapes a system tar would refuse to
 * write), and a loopback HTTP server for managed-install downloads. No test touches
 * the public network, real provider binaries, or the real account home.
 */

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export interface FakeCliBehavior {
  readonly version: string;
  /** Exit code for the version probe; defaults to 0. */
  readonly versionExit?: number;
  /** Exit code for the surface probe; defaults to 0. */
  readonly surfaceExit?: number;
  /** Custom stdout for the version probe; defaults to the upstream format. */
  readonly versionOutput?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function defaultVersionOutput(provider: ProviderCliProvider, version: string): string {
  return provider === "feishu" ? `lark-cli version ${version}` : `Using slack v${version}`;
}

function realEntry(provider: ProviderCliProvider): ProviderCliCatalogEntry {
  const entry = PROVIDER_CLI_CATALOG.find((candidate) => candidate.provider === provider);
  if (!entry) throw new Error(`unknown provider ${provider}`);
  return entry;
}

/** Script body matching a provider's probe contract exactly. */
export function fakeCliScript(provider: ProviderCliProvider, behavior: FakeCliBehavior): string {
  const entry = realEntry(provider);
  const versionInvocation = entry.probes.versionArgs.join(" ");
  const surfaceInvocation = entry.probes.surfaceArgs.join(" ");
  const versionOutput = behavior.versionOutput ?? defaultVersionOutput(provider, behavior.version);
  return [
    "#!/bin/sh",
    "# Fixture CLI: drop managed-mode global flags (e.g. --skip-update) before dispatch.",
    'while [ "$#" -gt 0 ]; do',
    `  case "$1" in`,
    `    ${entry.probes.versionArgs[0]}|${entry.probes.surfaceArgs[0]}) break ;;`,
    "    *) shift ;;",
    "  esac",
    "done",
    'case "$*" in',
    `  ${shellQuotePattern(versionInvocation)})`,
    `    printf '%s\\n' ${shellQuote(versionOutput)}`,
    `    exit ${behavior.versionExit ?? 0} ;;`,
    `  ${shellQuotePattern(surfaceInvocation)})`,
    "    echo surface-ok",
    `    exit ${behavior.surfaceExit ?? 0} ;;`,
    "esac",
    'echo "unexpected args: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
}

function shellQuotePattern(value: string): string {
  // case patterns treat no characters specially here (letters, dashes, spaces only).
  return `"${value}"`;
}

/** Write an executable fake provider CLI under `directory` and return its path. */
export async function writeFakeCli(
  directory: string,
  provider: ProviderCliProvider,
  behavior: FakeCliBehavior,
): Promise<string> {
  const entry = realEntry(provider);
  await mkdir(directory, { recursive: true });
  const target = join(directory, entry.command);
  await writeFile(target, fakeCliScript(provider, behavior), { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}

export interface TarMemberSpec {
  readonly name: string;
  readonly content?: Uint8Array | string;
  readonly mode?: number;
  /** Only "file" and "dir" are safe; other typeflags build malicious fixtures. */
  readonly type?: "file" | "dir" | "symlink" | "hardlink" | "char" | "block" | "fifo";
  readonly linkname?: string;
}

function octal(value: number, length: number): Uint8Array {
  const text = value.toString(8).padStart(length - 1, "0");
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length - 1; index += 1) bytes[index] = text.charCodeAt(index);
  bytes[length - 1] = 0;
  return bytes;
}

function writeString(target: Uint8Array, offset: number, value: string, length: number): void {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.subarray(0, length), offset);
}

const TYPE_FLAGS: Record<NonNullable<TarMemberSpec["type"]>, number> = {
  file: 0x30, // '0'
  dir: 0x35, // '5'
  symlink: 0x32, // '2'
  hardlink: 0x31, // '1'
  char: 0x33, // '3'
  block: 0x34, // '4'
  fifo: 0x36, // '6'
};

/** Build a ustar archive buffer; names must fit the 100-byte field (fixtures only). */
export function buildTar(members: readonly TarMemberSpec[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const member of members) {
    const content =
      member.content === undefined
        ? new Uint8Array(0)
        : typeof member.content === "string"
          ? new TextEncoder().encode(member.content)
          : member.content;
    const type = member.type ?? "file";
    const size = type === "file" ? content.length : 0;
    const header = new Uint8Array(512);
    writeString(header, 0, member.name, 100);
    header.set(octal(member.mode ?? (type === "dir" ? 0o755 : 0o644), 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(size, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(0x20, 148, 156);
    header[156] = TYPE_FLAGS[type];
    writeString(header, 157, member.linkname ?? "", 100);
    writeString(header, 257, "ustar", 6);
    header[263] = 0x30;
    header[264] = 0x30;
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(octal(checksum, 7), 148);
    header[155] = 0;
    blocks.push(header);
    if (size > 0) {
      const padded = new Uint8Array(Math.ceil(size / 512) * 512);
      padded.set(content);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    total.set(block, offset);
    offset += block.length;
  }
  return total;
}

export function buildTarGz(members: readonly TarMemberSpec[]): Uint8Array {
  return gzipSync(buildTar(members));
}

export function sha256Hex(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface FixtureHttpServer {
  readonly baseUrl: string;
  readonly requests: readonly string[];
  close(): Promise<void>;
}

/**
 * Loopback fixture server. Routes map paths to bodies; `null` answers 500, and a
 * `{ truncateTo }` entry answers with only a prefix of the given body. The map is read
 * per request, so tests may add routes after the server starts.
 */
export async function startFixtureHttpServer(
  routes: ReadonlyMap<string, Uint8Array | { body: Uint8Array; truncateTo: number } | null>,
): Promise<FixtureHttpServer> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    const route = routes.get(url.pathname);
    if (route === undefined || route === null) {
      response.statusCode = route === null ? 500 : 404;
      response.end();
      return;
    }
    const payload = "truncateTo" in route ? route.body.subarray(0, route.truncateTo) : route;
    response.statusCode = 200;
    response.setHeader("content-length", payload.byteLength);
    response.end(payload);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface FixtureCatalogOptions {
  readonly provider: ProviderCliProvider;
  readonly version: string;
  /** Executable payload content; defaults to a working fake CLI script. */
  readonly executableContent?: string;
  readonly executablePath?: string;
  readonly archiveMembers?: readonly TarMemberSpec[];
  /** Full override of the served archive body (for wrong-digest/truncated cases). */
  readonly archiveBody?: Uint8Array;
  readonly baseUrl: string;
  readonly compatibility?: string;
}

export interface FixtureCatalog {
  readonly entry: ProviderCliCatalogEntry;
  readonly artifact: ProviderCliCatalogArtifact;
  readonly archive: Uint8Array;
  readonly routePath: string;
  /** Executable content the fixture catalog claims (used for trust digests). */
  readonly executableContent: string;
}

/** A reviewed-catalog-shaped entry pointing at the fixture server for this platform. */
export function makeFixtureCatalog(options: FixtureCatalogOptions): FixtureCatalog {
  const real = realEntry(options.provider);
  const executablePath = options.executablePath ?? real.artifacts[0]?.executablePath ?? real.command;
  const executableContent = options.executableContent ?? fakeCliScript(options.provider, { version: options.version });
  const archive =
    options.archiveBody ??
    buildTarGz(options.archiveMembers ?? [{ name: executablePath, content: executableContent, mode: 0o755 }]);
  const routePath = `/fixtures/${options.provider}-${options.version}.tar.gz`;
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const artifact: ProviderCliCatalogArtifact = {
    platform,
    arch,
    archiveType: "tar.gz",
    url: `${options.baseUrl}${routePath}`,
    sha256: sha256Hex(archive),
    archiveBytes: archive.byteLength,
    maxExtractedBytes: archive.byteLength * 16 + 4 * 1024 * 1024,
    executablePath,
    executableSha256: sha256Hex(executableContent),
    executableBytes: new TextEncoder().encode(executableContent).byteLength,
  };
  return {
    entry: {
      provider: options.provider,
      command: real.command,
      displayName: real.displayName,
      version: options.version,
      compatibility: options.compatibility ?? real.compatibility,
      probes: real.probes,
      managedEnvironment: real.managedEnvironment,
      managedArguments: real.managedArguments,
      license: real.license,
      artifacts: [artifact],
    },
    artifact,
    archive,
    routePath,
    executableContent,
  };
}
