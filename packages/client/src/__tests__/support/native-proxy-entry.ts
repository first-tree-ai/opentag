/** Subprocess entry for cross-package native tests. Client and Server never import each other's internals. */
import { chmod, chown, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  closeBridgeSockets,
  createBridgeSocketResources,
  listenBridgeProxySockets,
  publishExecutionMaterial,
} from "../../cloud-runtime/bridge-material.js";
import type { RuntimeCredentialRelay } from "../../runtime/runtime-credential-relay.js";
import { RuntimeProxyDataConnection } from "../../runtime/runtime-proxy-data-client.js";
import { RuntimeProxyLoopbackAdapter } from "../../runtime/runtime-proxy-loopback-adapter.js";
import { buildRuntimeProxyEnvironment, RuntimeProxyMaterialStore } from "../../runtime/runtime-proxy-material.js";
import { cloudEntryFixture } from "./cloud-entry-fixture.js";

interface Input {
  root: string;
  executionId: string;
  sessionId: string;
  bindingId: string;
  capability: string;
  ticket: string;
  url: string;
  cloud: boolean;
}
process.once("message", (input: Input) => {
  void start(input).catch((error: unknown) => {
    process.send?.({ error: String(error) });
    process.exitCode = 1;
    process.disconnect?.();
  });
});
async function start(input: Input) {
  const data = await RuntimeProxyDataConnection.connect(input);
  const store = new RuntimeProxyMaterialStore({ home: input.root });
  const layout = store.executionLayout(input.sessionId, input.executionId);
  const adapter = await RuntimeProxyLoopbackAdapter.start({
    githubApiSocket: true,
    executionId: input.executionId,
    materialDir: layout.executionDir,
    verifyHandle: (provider, handle) => provider === "github" && handle === "otrh_fixture",
    openStream: (request) => data.openStream({ ...request, bindingId: input.bindingId, capability: input.capability }),
    logger: { debug() {}, warn() {} },
  });
  const routing = buildRuntimeProxyEnvironment({
    layout,
    executionId: input.executionId,
    adapterCaCertPath: adapter.caCertPath,
    connectProxyUrl: adapter.connectProxyUrl,
    slackApiHost: adapter.slackApiHost,
    handles: new Map([["github", "otrh_fixture"]]),
    cliMetadata: () => undefined,
  });
  await store.publish({
    sessionId: input.sessionId,
    executionId: input.executionId,
    platform: process.platform,
    adapterCaCertPath: adapter.caCertPath,
    handles: new Map([["github", "otrh_fixture"]]),
    environment: routing,
    githubApiSocketPath: adapter.githubApiSocketPath,
    githubGitSocketPath: adapter.githubGitSocketPath,
  });
  const resources = createBridgeSocketResources();
  let cloudEntry: string | undefined;
  let cloudBin: string | undefined;
  if (input.cloud) {
    const published = join(input.root, `public-${input.executionId}`);
    const relay = {
      executionId: input.executionId,
      providers: [{ provider: "github" }],
      localHandleFor: () => "otrh_fixture",
      cliMetadataFor: () => undefined,
    } as unknown as RuntimeCredentialRelay;
    await publishExecutionMaterial({ adapter, relay }, published, {
      includeEntryPrograms: true,
      publicMountPath: published,
    });
    await listenBridgeProxySockets(resources, adapter, published);
    await mkdir(join(input.root, "sandbox-home"), { recursive: true });
    if (process.getuid?.() === 0) {
      await chmod(input.root, 0o777);
      await chown(join(input.root, "sandbox-home"), 10000, 10000);
    }
    cloudEntry = join(published, "fixture-entry.mjs");
    cloudBin = join(published, "bin");
    await writeFile(cloudEntry, await cloudEntryFixture(published, input.root));
  }
  process.send?.({
    environment: { HOME: input.root, PATH: `${store.shimDir(input.sessionId)}:${process.env.PATH}`, ...routing },
    cloudEntry,
    cloudBin,
  });
  process.once("disconnect", () => {
    void (async () => {
      await closeBridgeSockets(resources);
      await adapter.close();
      await data.close();
      await store.cleanupSession(input.sessionId);
    })();
  });
}
