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
import { GitPublicationError } from "../services/github-proxy/git-packets.js";
import type { GitReadRequest } from "../services/github-proxy/git-read-transport.js";
import { handleGitSmartHttp } from "../services/github-proxy/git-smart-http.js";
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

/** Production broker, target policy, Git adapter and data transport; no public network or real user token. */
describe.each(["local", "cloud"] as const)("%s GitHub stream target authority", (origin) => {
  it.each(["preparing", "streaming", "credit"] as const)(
    "cancels revoked repository access while %s and releases the lease",
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
      let allowed = true;
      const resolveRepository = vi.fn(async () => {
        if (!allowed) throw new GitPublicationError("scope_denied");
        return {
          installationId: "11",
          repositoryId: "22",
          fullName: "owner/repo",
          defaultBranch: "main",
          authorizationVersion: 7n,
          credentialGeneration: 3n,
        };
      });
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
        management: { getOverview: async () => ({ connection }), resolveRepository } as never,
        execution: executions,
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
      const release = vi.fn(async () => {});
      const adapter: ProviderProxyAdapter = {
        handle: async (request, authorization) => {
          requestSignal = request.signal;
          request.signal.addEventListener("abort", unblock, { once: true });
          return handleGitSmartHttp(
            {
              policy,
              leases: { acquire: async () => ({ token: "ghu_scoped_stream_token", release }) } as never,
              publication: {} as never,
              metadata: async () => ({ id: 22, full_name: "owner/repo", default_branch: "main" }),
              reads: {
                handle: async (input: GitReadRequest) => {
                  await input.revalidate();
                  if (stage === "preparing") {
                    started();
                    await gate;
                    request.signal.throwIfAborted();
                  }
                  return { status: 200, headers: {}, body: body(request) };
                },
              } as never,
            },
            request,
            authorization,
            new URL(`https://github.com${request.path}`),
          );
        },
      };
      async function* body(request: ProviderProxyRequest) {
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
        allowed = false;
        await vi.waitFor(() =>
          expect(socket.json()).toContainEqual(
            expect.objectContaining({ type: stage === "preparing" ? "error" : "cancel", code: "scope_denied" }),
          ),
        );
        expect(requestSignal?.aborted).toBe(true);
        await vi.waitFor(() => expect(release).toHaveBeenCalled());
        expect(socket.sent.some((b) => b.toString().includes("private-tail"))).toBe(false);
      } finally {
        unblock();
        socket.close();
        executions.closeAll("execution_closed");
      }
    },
  );
});
