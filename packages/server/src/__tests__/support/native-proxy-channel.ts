import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { RuntimeCapabilityStore } from "../../runtime-credentials/capability-store.js";
import { RuntimeCredentialBroker } from "../../runtime-credentials/credential-broker.js";
import { RuntimeProviderProxyTransport } from "../../runtime-credentials/data-transport.js";
import { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import type { ProviderProxyAdapter } from "../../runtime-credentials/provider-proxy-adapter.js";
import type { RuntimeScopeSnapshot } from "../../runtime-credentials/scope-resolver.js";
import { RuntimeProxyTicketStore } from "../../runtime-credentials/ticket-store.js";
import { runtimeExecutionProviderBinding } from "../../runtime-credentials/types.js";
import { GitHubRuntimePolicy } from "../../services/github-proxy/runtime-policy.js";

/** Real broker/task policy, ticket, WebSocket wire, Client adapter and execution material. */
export async function nativeProxyChannel(root: string, adapter: ProviderProxyAdapter, cloud = false) {
  const accountId = randomUUID(),
    agentId = randomUUID(),
    computerId = randomUUID(),
    sessionId = randomUUID(),
    bindingId = randomUUID();
  const executions = new RuntimeExecutionRegistry();
  const capabilities = new RuntimeCapabilityStore();
  const record = executions.open({
    runId: randomUUID(),
    accountId,
    agentId,
    agentRevision: 1,
    sessionId,
    computerId,
    instanceId: "fixture",
    connectionId: "fixture",
    placementGeneration: 1,
    source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() },
    purpose: "execution",
    computerKind: cloud ? "cloud" : "local",
    ...(cloud ? { sandbox: { sandboxId: randomUUID(), resourceUid: "fixture", environmentGeneration: 1 } } : {}),
    providers: new Map([
      [
        `github:${bindingId}`,
        runtimeExecutionProviderBinding("github", bindingId, {
          provider: "github",
          connectionId: bindingId,
          authority: "user-task",
        }),
      ],
    ]),
  });
  const connection = {
    id: bindingId,
    accountId,
    status: "active",
    authorizationVersion: "1",
    credentialGeneration: "1",
    accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  // Database authority is independently exercised against both PostgreSQL and embedded PostgreSQL.
  const database = {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: async () => [{ id: "accepted-human" }],
      };
      return chain;
    },
  };
  const policy = new GitHubRuntimePolicy({
    database: database as never,
    management: { getOverview: async () => ({ connection }) } as never,
  });
  const snapshot = {
    sessionId,
    sessionKind: "channel",
    sessionEnded: false,
    channelId: "fixture",
    threadKey: null,
    binding: { id: bindingId, agentId, provider: "slack", status: "active", credentialGeneration: 1 },
    agent: { id: agentId, status: "active", revision: 1, computerId, createdByUserId: accountId },
    placement: { computerId, generation: 1 },
    computer: { id: computerId, kind: cloud ? "cloud" : "local", ownerAccountId: accountId },
    sandbox: null,
  } as RuntimeScopeSnapshot;
  const broker = new RuntimeCredentialBroker({
    executions,
    capabilities,
    policy,
    gitHubAdmission: policy,
    materialResolvers: {},
    scopeResolver: { load: async () => snapshot, assertExecutionFence: () => undefined },
    ...(cloud
      ? {
          connectionFence: {
            isCurrent: () => true,
            currentControlIdentity: () => ({
              kind: "cloud" as const,
              computerId,
              installationId: "fixture",
              credentialId: "fixture",
            }),
          },
          cloudControlActive: () => true,
        }
      : {}),
  });
  const grant = await broker.acquire({ execution: record, provider: "github", bindingId });
  if (grant.status !== "succeeded") throw Error("Native fixture grant rejected");
  const tickets = new RuntimeProxyTicketStore();
  const { ticket } = tickets.issue({
    executionId: record.executionId,
    computerId,
    instanceId: "fixture",
    connectionId: "fixture",
  });
  const transport = new RuntimeProviderProxyTransport({
    broker,
    tickets,
    executions,
    adapters: new Map([["github", adapter]]),
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections: ReturnType<typeof transport.attach>[] = [];
  server.on("connection", (socket) => connections.push(transport.attach(socket)));
  await once(server, "listening");
  const child = fork(
    fileURLToPath(new URL("../../../../client/src/__tests__/support/native-proxy-entry.ts", import.meta.url)),
    [],
    { execArgv: ["--import", "tsx"], silent: true },
  );
  let diagnostic = "";
  child.stderr?.on("data", (chunk) => {
    diagnostic += String(chunk);
  });
  const ready = new Promise<{ environment: NodeJS.ProcessEnv; cloudEntry?: string; cloudBin?: string }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error(`Native Client start timed out: ${diagnostic}`));
      }, 15_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`Native Client exited ${code}: ${diagnostic}`));
      });
      child.once(
        "message",
        (result: { error?: string; environment: NodeJS.ProcessEnv; cloudEntry?: string; cloudBin?: string }) => {
          clearTimeout(timer);
          result.error ? reject(Error(result.error)) : resolve(result);
        },
      );
    },
  );
  child.send({
    root,
    cloud,
    executionId: record.executionId,
    sessionId,
    bindingId,
    capability: grant.token,
    ticket,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  try {
    const material = await ready;
    let closing: Promise<void> | undefined;
    return {
      ...material,
      connections,
      close() {
        closing ??= (async () => {
          const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined;
          if (child.connected) child.disconnect();
          await exited;
          for (const socket of server.clients) socket.terminate();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          executions.close(record.executionId, "execution_closed");
        })();
        return closing;
      },
    };
  } catch (error) {
    child.kill();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    throw error;
  }
}
