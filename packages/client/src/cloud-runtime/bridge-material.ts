import { once } from "node:events";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { RuntimeCredentialRelay } from "../runtime/runtime-credential-relay.js";
import type { RuntimeProxyLoopbackAdapter } from "../runtime/runtime-proxy-loopback-adapter.js";
import {
  buildRuntimeProxyEnvironment,
  type RuntimeProxyExecutionLayout,
  renderRuntimeProxyGitCredentialHelper,
} from "../runtime/runtime-proxy-material.js";
import {
  CLOUD_CONNECT_PROXY_PORT,
  CLOUD_EXECUTION_MOUNT,
  CLOUD_SANDBOX_CA_FILE,
  CLOUD_SANDBOX_CA_PROGRAM,
  CLOUD_SANDBOX_ENTRY_PROGRAM,
  CLOUD_SLACK_API_PORT,
} from "./sandbox-entry.js";

/**
 * Shared per-execution public material publication (#633): handles, public CA, CLI config, and
 * opaque local endpoints — never a token. The Docker credential bridge mounts this directory into
 * the untrusted container; the native Runner mounts it into the Cloud Run Sandbox. Both callers
 * keep the trusted Relay/adapter outside the Sandbox boundary.
 */
export interface BridgeMaterialResources {
  adapter: RuntimeProxyLoopbackAdapter;
  relay: RuntimeCredentialRelay;
}

export interface PublishExecutionMaterialOptions {
  /**
   * Docker containers run the generated entry programs as their PID 1; the native Sandbox worker
   * is OpenTag code that imports the same logic directly, so it skips the generated programs.
   */
  includeEntryPrograms: boolean;
  /**
   * In-sandbox absolute path where `publicDirectory` becomes visible (the bind-mount destination,
   * plus the per-turn directory name for the native Sandbox). Defaults to the fixed mount point.
   */
  publicMountPath?: string;
}

export interface BridgeSocketResources {
  readonly servers: Server[];
  readonly sockets: Set<Socket>;
  closing: { value: boolean };
}

const MAX_PROXY_SOCKETS = 64;
const SOCKET_PATH_MAX_BYTES = 100;

export function createBridgeSocketResources(): BridgeSocketResources {
  return { closing: { value: false }, servers: [], sockets: new Set() };
}

/** Tear down every listener and in-flight bridged connection. */
export async function closeBridgeSockets(resources: BridgeSocketResources): Promise<void> {
  resources.closing.value = true;
  for (const socket of [...resources.sockets]) socket.destroy();
  resources.sockets.clear();
  await Promise.all(resources.servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
}

/**
 * Publish the per-execution PUBLIC material (CA certificate, proxy sockets, handles, CLI config)
 * into `publicDirectory` — the exact directory that becomes the read-only Sandbox mount. The
 * trusted CA private key and every handle secret stay in the adapter's private `materialDir`,
 * which callers must keep OUTSIDE `publicDirectory` (the native Runner mounts only this subtree).
 */
export async function publishExecutionMaterial(
  resources: BridgeMaterialResources,
  socketResources: BridgeSocketResources,
  publicDirectory: string,
  options: PublishExecutionMaterialOptions,
): Promise<string> {
  const { adapter, relay } = resources;
  const published = publicDirectory;
  const mount = options.publicMountPath ?? CLOUD_EXECUTION_MOUNT;
  await mkdir(published, { recursive: true, mode: 0o755 });
  await chmod(published, 0o755);
  const caFile = join(published, CLOUD_SANDBOX_CA_FILE);
  await copyFile(adapter.caCertPath, caFile);
  await chmod(caFile, 0o444);
  await listenProxySocket(socketResources, "connect", adapter.connectProxyUrl, join(published, "connect.sock"));
  await listenProxySocket(socketResources, "slack", adapter.slackApiHost, join(published, "slack.sock"));
  const handles = new Map(relay.providers.map((entry) => [entry.provider, relay.localHandleFor(entry.provider)]));
  const layout: RuntimeProxyExecutionLayout = {
    adapterCaCertPath: `${mount}/${CLOUD_SANDBOX_CA_FILE}`,
    executionDir: mount,
    gitCredentialHelperPath: `${mount}/git-credential-helper`,
    gitConfigPath: `${mount}/gitconfig`,
    larkConfigDir: "/tmp/opentag/lark",
    slackConfigDir: "/tmp/opentag/slack",
  };
  const environment = buildRuntimeProxyEnvironment({
    adapterCaCertPath: layout.adapterCaCertPath,
    cliMetadata: (provider) => relay.cliMetadataFor(provider),
    connectProxyUrl: `http://127.0.0.1:${CLOUD_CONNECT_PROXY_PORT}`,
    handles,
    layout,
    slackApiHost: `https://127.0.0.1:${CLOUD_SLACK_API_PORT}`,
  });
  await writePublicFile(
    join(published, "environment.json"),
    JSON.stringify({ executionId: relay.executionId, environment }),
  );
  if (options.includeEntryPrograms) {
    await writePublicFile(join(published, "entry.mjs"), CLOUD_SANDBOX_ENTRY_PROGRAM);
    await writePublicFile(join(published, "sandbox-ca.mjs"), CLOUD_SANDBOX_CA_PROGRAM);
  }
  await writePublicFile(join(published, "gitconfig"), "");
  await writePublicFile(
    join(published, "git-credential-helper"),
    renderRuntimeProxyGitCredentialHelper(handles.get("github") ?? "unavailable"),
    0o555,
  );
  await mkdir(join(published, "bin"), { mode: 0o755 });
  await writePublicFile(
    join(published, "bin", "slack"),
    `#!/bin/sh\nexec /opt/opentag/tools/bin/slack --apihost https://127.0.0.1:${CLOUD_SLACK_API_PORT} "$@"\n`,
    0o555,
  );
  return published;
}

async function listenProxySocket(
  resources: BridgeSocketResources,
  name: string,
  endpoint: string,
  socketPath: string,
): Promise<void> {
  const target = new URL(endpoint);
  const port = Number(target.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("Invalid loopback endpoint");
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES) {
    throw new Error(`The trusted ${name} socket path is too long`);
  }
  const server = createServer();
  server.on("connection", (client) => proxyLoopbackConnection(client, port, resources));
  resources.servers.push(server);
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o666);
}

/** Bridges one in-sandbox loopback connection to the trusted per-execution Unix socket. */
function proxyLoopbackConnection(client: Socket, port: number, resources: BridgeSocketResources): void {
  resources.sockets.add(client);
  client.once("close", () => resources.sockets.delete(client));
  if (resources.closing.value || resources.sockets.size > MAX_PROXY_SOCKETS) {
    client.destroy();
    return;
  }
  const remote = connect({ host: "127.0.0.1", port });
  resources.sockets.add(remote);
  const close = () => {
    client.destroy();
    remote.destroy();
    resources.sockets.delete(client);
    resources.sockets.delete(remote);
  };
  client.once("error", close);
  remote.once("error", close);
  client.once("close", close);
  remote.once("close", close);
  client.pipe(remote);
  remote.pipe(client);
}

export async function writePublicFile(path: string, content: string, mode = 0o444): Promise<void> {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}
