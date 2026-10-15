import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RuntimeCapabilityStore } from "../runtime-credentials/capability-store.js";
import { RuntimeCredentialBroker } from "../runtime-credentials/credential-broker.js";
import { RuntimeProviderProxyTransport } from "../runtime-credentials/data-transport.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import type { ProviderProxyAdapter, ProviderProxyRequest } from "../runtime-credentials/provider-proxy-adapter.js";
import type { RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import { RuntimeProxyTicketStore } from "../runtime-credentials/ticket-store.js";
import { runtimeExecutionProviderBinding } from "../runtime-credentials/types.js";
import { GitHubProviderAdapter } from "../services/github-proxy/github-provider-adapter.js";
import { GitHubRuntimePolicy } from "../services/github-proxy/runtime-policy.js";

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const BINDING = "00000000-0000-4000-8000-0000000000b1";

function scopeSnapshot(): RuntimeScopeSnapshot {
  return {
    sessionId: "session-1",
    sessionKind: "channel",
    sessionEnded: false,
    channelId: "C1",
    threadKey: null,
    binding: {
      id: BINDING,
      agentId: AGENT,
      provider: "slack",
      status: "active",
      credentialGeneration: 1,
      externalAppId: null,
      externalTeamId: "T",
      externalTeamBrand: null,
      externalBotId: "B",
      slackInstallationId: "00000000-0000-4000-8000-0000000000d1",
    },
    slackInstallation: {
      id: "00000000-0000-4000-8000-0000000000d1",
      agentId: AGENT,
      status: "active",
      credentialGeneration: 1,
      externalTeamId: "T",
      externalBotId: "B",
    },
    agent: {
      id: AGENT,
      status: "active",
      revision: 1,
      computerId: COMPUTER,
      createdByUserId: "00000000-0000-4000-8000-0000000000e1",
    },
    placement: { computerId: COMPUTER, generation: 1 },
    computer: { id: COMPUTER, kind: "local", ownerAccountId: "00000000-0000-4000-8000-0000000000e1" },
    sandbox: null,
  };
}

class Socket extends EventEmitter {
  readonly sent: Buffer[] = [];
  readyState = 1;
  send(data: string | Buffer) {
    this.sent.push(Buffer.from(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  json() {
    return this.sent
      .filter((b) => b[0] === 123)
      .map((b) => JSON.parse(b.toString()) as { type: string; code?: string });
  }
}

/** Production broker, task authority, user-identity adapter and data transport; no public network or real user token. */
describe.each(["local", "cloud"] as const)("%s GitHub stream execution authority", (origin) => {
  it.each(["preparing", "streaming", "credit"] as const)(
    "cancels a disconnected account while %s without revoking its shared token",
    async (stage) => {
      const executions = new RuntimeExecutionRegistry();
      const capabilities = new RuntimeCapabilityStore();
      const snapshot = scopeSnapshot();
      const connectionId = randomUUID();
      const record = executions.open({
        runId: randomUUID(),
        accountId: snapshot.computer.ownerAccountId,
        agentId: AGENT,
        agentRevision: 1,
        sessionId: snapshot.sessionId,
        computerId: COMPUTER,
        instanceId: "instance",
        connectionId: "connection",
        placementGeneration: 1,
        source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() },
        purpose: "execution",
        computerKind: origin,
        ...(origin === "cloud"
          ? { sandbox: { sandboxId: randomUUID(), resourceUid: "uid", environmentGeneration: 1 } }
          : {}),
        providers: new Map([
          [
            `github:${connectionId}`,
            runtimeExecutionProviderBinding("github", connectionId, {
              provider: "github",
              connectionId,
              authority: "user-task",
            }),
          ],
        ]),
      });
      const connection = {
        id: connectionId,
        accountId: record.accountId,
        status: "active",
        authorizationVersion: "7",
        credentialGeneration: "3",
        accessExpiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      const database = {
        select: (projection: Record<string, unknown>) => {
          const chain = {
            from: () => chain,
            innerJoin: () => chain,
            where: () => ("contextTrees" in projection ? Promise.resolve([]) : chain),
            limit: async () => [{ id: "accepted-human" }],
          };
          return chain;
        },
      };
      const policy = new GitHubRuntimePolicy({
        database: database as never,
        management: { getOverview: async () => ({ connection }) } as never,
      });
      const broker = new RuntimeCredentialBroker({
        capabilities,
        executions,
        scopeResolver: { load: async () => snapshot, assertExecutionFence: () => undefined },
        policy,
        gitHubAdmission: policy,
        materialResolvers: {},
        ...(origin === "cloud"
          ? {
              connectionFence: {
                isCurrent: () => true,
                currentControlIdentity: () => ({
                  kind: "cloud" as const,
                  computerId: COMPUTER,
                  installationId: "installation",
                  credentialId: "credential",
                }),
              },
              cloudControlActive: () => true,
            }
          : {}),
      });
      const grant = await broker.acquire({ execution: record, provider: "github", bindingId: connectionId });
      if (grant.status !== "succeeded") throw new Error("Grant rejected");
      const tickets = new RuntimeProxyTicketStore();
      const { ticket } = tickets.issue({
        executionId: record.executionId,
        computerId: COMPUTER,
        instanceId: record.instanceId,
        connectionId: record.connectionId,
      });
      let unblock = () => {};
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let started = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let requestSignal: AbortSignal | undefined;
      const adapter: ProviderProxyAdapter = new GitHubProviderAdapter({
        management: {
          getExecutionUserCredential: async () => ({
            accessToken: "ghu_owner",
            githubUserId: "owner",
            credentialGeneration: 1n,
            accessExpiresAt: new Date(Date.now() + 60000),
          }),
        },
        transport: {
          request: async (input) => {
            requestSignal = input.signal;
            input.signal.addEventListener("abort", unblock, { once: true });
            if (stage === "preparing") {
              started();
              await gate;
              input.signal.throwIfAborted();
            }
            return { status: 200, headers: {}, body: body({ signal: input.signal }) };
          },
        },
      });
      async function* body(request: Pick<ProviderProxyRequest, "signal">) {
        if (stage === "credit") {
          yield Buffer.alloc(1048576, 65);
          started();
          yield Buffer.from("private-tail");
        } else {
          yield Buffer.from("authorized-prefix");
          started();
          await gate;
          request.signal.throwIfAborted();
          yield Buffer.from("private-tail");
        }
      }
      const socket = new Socket();
      new RuntimeProviderProxyTransport({
        broker,
        adapters: new Map([["github", adapter]]),
        tickets,
        executions,
        revalidateIntervalMs: 10,
      }).attach(socket as never);
      const send = (value: unknown) => socket.emit("message", Buffer.from(JSON.stringify(value)), false);
      try {
        send({ type: "auth", ticket });
        send({
          type: "open",
          streamId: 1,
          capability: grant.token,
          provider: "github",
          bindingId: connectionId,
          method: "GET",
          path: "/owner/repo.git/info/refs?service=git-upload-pack",
          headers: { "x-opentag-provider-origin": "github.com" },
        });
        await ready;
        connection.status = "disconnected";
        await vi.waitFor(() =>
          expect(socket.json()).toContainEqual(
            expect.objectContaining({
              type: stage === "preparing" ? "error" : "cancel",
              code: "credential_scope_denied",
            }),
          ),
        );
        expect(requestSignal?.aborted).toBe(true);
        expect(socket.sent.some((b) => b.toString().includes("private-tail"))).toBe(false);
      } finally {
        unblock();
        socket.close();
        executions.closeAll("execution_closed");
      }
    },
  );
});
