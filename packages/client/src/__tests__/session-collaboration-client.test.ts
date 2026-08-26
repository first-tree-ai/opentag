import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type SessionCollaborationCommandResult } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { assertHostedTools } from "../agent-runtime/validation.js";
import { SessionCollaborationClient } from "../runtime/session-collaboration-client.js";

describe("SessionCollaborationClient", () => {
  it("gates tools on negotiation and captures authoritative source identity", async () => {
    const sent: unknown[] = [];
    let supported = false;
    const connection = {
      supportsCapability: vi.fn(
        (capability: string) => supported && capability === RUNTIME_CAPABILITY.sessionCollaboration,
      ),
      send: vi.fn(async (frame: unknown) => {
        sent.push(frame);
      }),
    };
    const inbox = { accept: vi.fn() };
    const client = new SessionCollaborationClient({ connection, inbox, requestTimeoutMs: 1_000 });
    const binding = {
      agentId: randomUUID(),
      sessionId: randomUUID(),
      placementGeneration: 7,
      sessionKind: "visible" as const,
    };
    expect(client.hostedToolsForSession(binding)).toBeUndefined();

    supported = true;
    const tools = client.hostedToolsForSession(binding);
    expect(tools?.definitions.map(({ name }) => name)).toEqual(["create_internal_session", "send_session_message"]);
    expect(tools?.definitions.find(({ name }) => name === "send_session_message")?.description).toContain(
      "retry with the returned messageId",
    );
    const invocation = tools?.handler({
      runId: "run-1",
      toolCallId: "tool-1",
      name: "create_internal_session",
      input: { initialMessage: "Investigate the failure", overrides: { reasoningEffort: "high" } },
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as {
      requestId: string;
      sourceSessionId: string;
      sourcePlacementGeneration: number;
      initialMessage: { messageId: string };
    };
    expect(command).toMatchObject({
      sourceSessionId: binding.sessionId,
      sourcePlacementGeneration: 7,
    });
    expect(command.initialMessage.messageId).toMatch(/^[0-9a-f-]{36}$/);
    await client.handleCommandResult({
      type: "session:collaboration:result",
      requestId: command.requestId,
      messageId: command.initialMessage.messageId,
      sessionId: randomUUID(),
      status: "accepted",
    });
    await expect(invocation).resolves.toMatchObject({ success: true });
  });

  it("keeps production hosted tool definitions inside the portable Client Runtime contract", () => {
    const client = new SessionCollaborationClient({
      connection: {
        supportsCapability: () => true,
        send: vi.fn(),
      },
      inbox: { accept: vi.fn() },
    });
    const tools = client.hostedToolsForSession({
      agentId: randomUUID(),
      sessionId: randomUUID(),
      placementGeneration: 1,
      sessionKind: "visible",
    });
    expect(tools).toBeDefined();
    expect(() =>
      assertHostedTools(
        {
          fileSystem: "workspace-write",
          network: "disabled",
          approvals: "never",
          tools: { mode: "provider-default" },
        },
        tools,
      ),
    ).not.toThrow();
    expect(() =>
      assertHostedTools(
        {
          fileSystem: "workspace-write",
          network: "disabled",
          approvals: "never",
          tools: {
            mode: "allow-list",
            names: ["create_internal_session", "send_session_message"],
          },
        },
        tools,
      ),
    ).not.toThrow();
  });

  it("uses an explicit create message ID unchanged for a caller-driven retry", async () => {
    let command: { requestId: string; initialMessage: { messageId: string } } | undefined;
    const connection = {
      supportsCapability: () => true,
      send: vi.fn(async (frame: unknown) => {
        command = frame as { requestId: string; initialMessage: { messageId: string } };
      }),
    };
    const client = new SessionCollaborationClient({
      connection,
      inbox: { accept: vi.fn() },
      requestTimeoutMs: 1_000,
    });
    const messageId = randomUUID();
    const invocation = client
      .hostedToolsForSession({
        agentId: randomUUID(),
        sessionId: randomUUID(),
        placementGeneration: 1,
        sessionKind: "visible",
      })
      ?.handler({
        runId: "run-retry",
        toolCallId: "tool-retry",
        name: "create_internal_session",
        input: { initialMessage: "same work", messageId },
        signal: new AbortController().signal,
      });
    await vi.waitFor(() => expect(command).toBeDefined());
    expect(command?.initialMessage.messageId).toBe(messageId);
    await client.handleCommandResult({
      type: "session:collaboration:result",
      requestId: command?.requestId ?? randomUUID(),
      messageId,
      sessionId: randomUUID(),
      status: "unreachable",
      code: "runtime_unavailable",
    });
    expect(JSON.parse((await invocation)?.content[0]?.text ?? "{}")).toMatchObject({
      status: "unreachable",
      messageId,
    });
  });

  it("executes local plans through the inbox and preserves retry message IDs", async () => {
    const sent: unknown[] = [];
    const connection = {
      supportsCapability: () => true,
      send: vi.fn(async (frame: unknown) => {
        sent.push(frame);
      }),
    };
    const inbox = {
      accept: vi.fn(
        async (delivery: {
          requestId: string;
          messageId: string;
          targetSessionId: string;
          placementGeneration: number;
        }) => ({
          type: "session:message:deliver:result" as const,
          requestId: delivery.requestId,
          messageId: delivery.messageId,
          targetSessionId: delivery.targetSessionId,
          placementGeneration: delivery.placementGeneration,
          status: "accepted" as const,
        }),
      ),
    };
    const client = new SessionCollaborationClient({ connection, inbox, requestTimeoutMs: 1_000 });
    const sourceSessionId = randomUUID();
    const targetSessionId = randomUUID();
    const retryMessageId = randomUUID();
    const tools = client.hostedToolsForSession({
      agentId: randomUUID(),
      sessionId: sourceSessionId,
      placementGeneration: 3,
      sessionKind: "internal",
    });
    const invocation = tools?.handler({
      runId: "run-2",
      toolCallId: "tool-2",
      name: "send_session_message",
      input: { targetSessionId, message: "Done", messageId: retryMessageId },
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const command = sent[0] as { requestId: string; messageId: string };
    const result: SessionCollaborationCommandResult = {
      type: "session:collaboration:result",
      requestId: command.requestId,
      messageId: retryMessageId,
      sessionId: targetSessionId,
      status: "local",
      delivery: {
        type: "session:message:deliver",
        requestId: randomUUID(),
        messageId: retryMessageId,
        sourceSessionId,
        targetSessionId,
        agentId: randomUUID(),
        placementGeneration: 1,
        content: { kind: "text", text: "Done" },
        runtime: snapshot(),
      },
    };
    await client.handleCommandResult(result);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      type: "session:message:deliver:result",
      messageId: retryMessageId,
      status: "accepted",
    });
    await client.handleCommandResult({
      type: "session:collaboration:result",
      requestId: command.requestId,
      messageId: retryMessageId,
      sessionId: targetSessionId,
      status: "accepted",
    });
    const toolResult = await invocation;
    expect(inbox.accept).toHaveBeenCalledOnce();
    expect(JSON.parse(toolResult?.content[0]?.text ?? "{}")).toEqual({
      status: "accepted",
      messageId: retryMessageId,
      sessionId: targetSessionId,
    });
  });
});

function snapshot() {
  const agentId = randomUUID();
  return {
    revision: { agent: { sequence: 1, id: "a".repeat(64) }, session: { sequence: 1, id: "b".repeat(64) } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "platform", agent: "agent" },
    execution: { approvalPolicy: "never" as const, networkAccess: true },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
}
