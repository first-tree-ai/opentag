import type {
  CodexAppServerMessage,
  CodexAppServerRequest,
  InteractiveCodexAppServerClient,
} from "../../providers/codex/app-server-wire.js";

export function nativeMcpApprovalParams(): Record<string, unknown> {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "probe",
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_description: "Read a synthetic constant.",
      tool_params: {
        api_key: "synthetic-probe-secret",
        query: "constant",
        cwd: "/synthetic/tool-directory",
        reason: "tool reason",
        itemId: "tool-item",
        threadId: "tool-thread",
        turnId: "tool-turn",
        approvalId: "tool-approval",
        environmentId: "tool-environment",
        commandActions: [{ command: "synthetic command" }],
        availableDecisions: ["tool-option"],
        proposedExecpolicyAmendment: ["tool-policy"],
        nested: {
          serverName: "argument-server",
          cwd: "/synthetic/nested-directory",
          api_key: "nested-synthetic-secret",
          values: [1, true, null, { reason: "nested reason" }],
        },
      },
      tool_params_display: [],
    },
    message: 'Allow the probe MCP server to run tool "read_probe"?',
    requestedSchema: { type: "object", properties: {} },
  };
}

export class McpApprovalCodexClient implements InteractiveCodexAppServerClient {
  readonly responses: unknown[] = [];
  toolCalls = 0;
  readonly #notifications = new Set<(message: CodexAppServerMessage) => void>();
  readonly #requests = new Set<(request: CodexAppServerRequest) => void>();

  async initialize(): Promise<void> {}

  async request(method: string): Promise<unknown> {
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method !== "turn/start") throw new Error(`Unexpected method: ${method}`);
    this.#emit({ method: "turn/started", params: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    for (const listener of this.#requests) {
      listener({ id: "mcp-approval", method: "mcpServer/elicitation/request", params: nativeMcpApprovalParams() });
    }
    return { turn: { id: "turn-1", status: "inProgress", items: [] } };
  }

  async notify(): Promise<void> {}

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  subscribeServerRequests(listener: (request: CodexAppServerRequest) => void): () => void {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }

  async respondServerRequest(_id: number | string, result: unknown): Promise<void> {
    this.responses.push(result);
    if (JSON.stringify(result) === JSON.stringify({ action: "accept", content: {} })) this.toolCalls += 1;
  }

  complete(): void {
    this.#emit({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: "mcp-approval" } });
    this.#emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "result",
              type: "agentMessage",
              phase: "final_answer",
              text: this.toolCalls ? "probe constant" : "Tool not invoked",
            },
          ],
        },
      },
    });
  }

  async rejectServerRequest(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.#emit({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
    });
  }

  async close(): Promise<void> {}

  #emit(message: CodexAppServerMessage): void {
    for (const listener of this.#notifications) listener(message);
  }
}
