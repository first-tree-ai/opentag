import { relative, resolve } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  type InputRejectReason,
  OPENTAG_MESSAGE_TOOLS,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type RuntimeUsage,
  type TurnFailureReason,
} from "@opentag/shared";
import type { RuntimeLocalPolicy } from "../../runtime/session-reconciler.js";
import {
  type CodexAppServerClient,
  CodexAppServerError,
  type CodexAppServerMessage,
  CodexAppServerProcess,
  type CodexDynamicToolCall,
  type CodexDynamicToolResult,
  type CodexSpawnOptions,
} from "./app-server-wire.js";

export const CODEX_V0_NOTIFICATION_LIMIT = 128;
export const CODEX_V0_NOTIFICATION_BYTES = 1024 * 1024;
export const CODEX_V0_ITEM_LIMIT = 128;
export const CODEX_V0_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const OPENTAG_MESSAGE_TOOL_SET: ReadonlySet<string> = new Set(OPENTAG_MESSAGE_TOOLS);

export const CODEX_V0_APP_SERVER_ARGS = [
  "app-server",
  "--stdio",
  "--disable",
  "apps",
  "--disable",
  "auth_elicitation",
  "--disable",
  "browser_use",
  "--disable",
  "browser_use_external",
  "--disable",
  "browser_use_full_cdp_access",
  "--disable",
  "computer_use",
  "--disable",
  "goals",
  "--disable",
  "hooks",
  "--disable",
  "image_generation",
  "--disable",
  "in_app_browser",
  "--disable",
  "multi_agent",
  "--disable",
  "plugins",
  "--disable",
  "remote_plugin",
  "--disable",
  "skill_mcp_dependency_install",
  "--disable",
  "tool_call_mcp_elicitation",
  "-c",
  "mcp_servers={}",
  "-c",
  'web_search="disabled"',
  "-c",
  "tools.view_image=false",
  "-c",
  "memories.use_memories=false",
  "-c",
  "memories.generate_memories=false",
  "-c",
  "allow_login_shell=false",
  "-c",
  'shell_environment_policy.inherit="all"',
  "-c",
  'shell_environment_policy.filters={ PATH = "include", LANG = "include", LC_ALL = "include" }',
] as const;

const SAFE_ENVIRONMENT_KEYS = [
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TMPDIR",
  "USER",
  "WINDIR",
] as const;

export type CodexTraceItemType = "agent_message" | "command" | "file_change" | "tool" | "other";

export interface CodexTraceSink {
  itemCompleted(itemType: CodexTraceItemType, status: "completed" | "failed"): void;
  turnCompleted(outcome: CodexTurnOutcome): void;
  turnStarted(): void;
  usageUpdated(usage: RuntimeUsage): void;
  warning(code: string, message: string): void;
}

export type CodexTurnOutcome = "completed" | "failed" | "cancelled" | "unknown";

export interface CodexTurnResult {
  finalText?: string;
  outcome: CodexTurnOutcome;
  providerThreadId: string;
  providerTurnId: string;
  usage?: RuntimeUsage;
}

export interface CodexTurnRunOptions {
  agentsFile: string;
  cwd: string;
  onThreadReady(threadId: string): Promise<void> | void;
  onTurnStarted(turnId: string): Promise<void> | void;
  onDynamicToolCall?(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult>;
  providerThreadId?: string;
  request: DirectImMessageDeliveryRequest;
  signal?: AbortSignal;
  supplementalContext?: string;
  trace?: CodexTraceSink;
}

export interface CodexAdapterOptions {
  clientVersion: string;
  createClient?: (cwd: string) => CodexAppServerClient;
  process?: Omit<CodexSpawnOptions, "cwd">;
}

export class CodexTurnError extends Error {
  constructor(
    readonly reason: TurnFailureReason,
    readonly executionEffects: "not_started" | "may_have_occurred",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexTurnError";
  }
}

export class CodexLocalPolicy implements RuntimeLocalPolicy {
  validate(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
    if (snapshot.execution.approvalPolicy !== "never" || snapshot.execution.networkAccess) {
      return "configuration_unsupported";
    }
    // Only the three OpenTag-hosted IM functions are allowed. They are
    // dynamically served by the daemon and never expose provider credentials.
    if (snapshot.allowedTools.some((tool) => !OPENTAG_MESSAGE_TOOL_SET.has(tool))) {
      return "configuration_unsupported";
    }
    if (snapshot.reasoningEffort && !CODEX_V0_REASONING_EFFORTS.has(snapshot.reasoningEffort)) {
      return "configuration_unsupported";
    }
    return undefined;
  }
}

export class CodexAdapter {
  readonly #clientVersion: string;
  readonly #createClient: (cwd: string) => CodexAppServerClient;

  constructor(options: CodexAdapterOptions) {
    this.#clientVersion = options.clientVersion;
    this.#createClient =
      options.createClient ??
      ((cwd) =>
        new CodexAppServerProcess({
          command: options.process?.command,
          args: options.process?.args ?? [...CODEX_V0_APP_SERVER_ARGS],
          cwd,
          env: options.process?.env ?? codexProviderEnvironment(),
          expectedCodexHome: options.process?.expectedCodexHome,
          maxLineBytes: options.process?.maxLineBytes,
          requestTimeoutMs: options.process?.requestTimeoutMs,
          spawnProcess: options.process?.spawnProcess,
        }));
  }

  async runTurn(options: CodexTurnRunOptions): Promise<CodexTurnResult> {
    const client = this.#createClient(options.cwd);
    const pending: CodexAppServerMessage[] = [];
    let pendingBytes = 0;
    let providerThreadId: string | undefined;
    let providerTurnId: string | undefined;
    let turnStartAttempted = false;
    let processing = Promise.resolve();
    let terminal: ProviderTurn | undefined;
    let terminalResolve: (() => void) | undefined;
    let terminalFailure: Error | undefined;
    const terminalReady = new Promise<void>((resolvePromise) => {
      terminalResolve = resolvePromise;
    });
    const completedItems = new Map<string, Record<string, unknown>>();
    const completedItemIds = new Set<string>();
    let completedItemBytes = 0;
    let latestUsage: RuntimeUsage | undefined;
    let turnStartedTraced = false;
    let terminalTraced = false;
    let notificationsReady = false;

    const fail = (error: Error) => {
      if (terminalFailure) return;
      terminalFailure = error;
      terminalResolve?.();
    };
    const processNotification = async (message: CodexAppServerMessage): Promise<void> => {
      const method = message.method;
      if (method === "opentag/processError") {
        const params = record(message.params);
        fail(params?.error instanceof Error ? params.error : protocolError("Codex process failed"));
        return;
      }
      if (!isTurnNotification(method)) return;
      if (!notificationsReady) {
        const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
        if (pending.length >= CODEX_V0_NOTIFICATION_LIMIT || pendingBytes + bytes > CODEX_V0_NOTIFICATION_BYTES) {
          fail(protocolError("Codex early notification buffer exceeded its limit"));
          return;
        }
        pending.push(message);
        pendingBytes += bytes;
        return;
      }
      const params = requireRecord(message.params, `Invalid ${method} notification`);
      const notificationThreadId = requireString(params.threadId, `Invalid ${method} thread ID`);
      if (notificationThreadId !== providerThreadId) throw protocolError("Codex notification thread ID mismatch");

      if (method === "turn/started") {
        const turn = parseTurn(params.turn, "turn/started");
        if (turn.id !== providerTurnId || turn.status !== "inProgress") {
          throw protocolError("Codex turn/started identity or status mismatch");
        }
        if (!turnStartedTraced) {
          turnStartedTraced = true;
          options.trace?.turnStarted();
        }
        return;
      }

      const notificationTurnId =
        method === "turn/completed"
          ? parseTurn(params.turn, "turn/completed").id
          : requireString(params.turnId, `Invalid ${method} turn ID`);
      if (notificationTurnId !== providerTurnId) {
        if (method === "thread/tokenUsage/updated") return;
        throw protocolError(`Codex ${method} turn ID mismatch`);
      }

      if (method === "item/completed") {
        const item = requireRecord(params.item, "Invalid item/completed item");
        const itemId = requireString(item.id, "Invalid completed item ID");
        if (completedItemIds.has(itemId)) throw protocolError("Codex emitted a duplicate completed item ID");
        completedItemIds.add(itemId);
        const normalized = normalizeCompletedItem(item);
        completedItemBytes += Buffer.byteLength(JSON.stringify(normalized), "utf8");
        if (completedItemIds.size > CODEX_V0_ITEM_LIMIT || completedItemBytes > CODEX_V0_NOTIFICATION_BYTES) {
          throw protocolError("Codex completed item buffer exceeded its limit");
        }
        if (normalized.type === "agentMessage") completedItems.set(itemId, normalized);
        options.trace?.itemCompleted(traceItemType(item), traceItemStatus(item));
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        latestUsage = parseUsage(params.tokenUsage);
        options.trace?.usageUpdated(latestUsage);
        return;
      }
      const completed = parseTurn(params.turn, "turn/completed");
      if (completed.status === "inProgress") throw protocolError("Codex completed a Turn with an active status");
      if (terminal) throw protocolError("Codex emitted duplicate turn/completed notifications");
      terminal = completed;
      const outcome = outcomeFor(completed.status);
      if (!terminalTraced) {
        terminalTraced = true;
        options.trace?.turnCompleted(outcome);
      }
      terminalResolve?.();
    };

    const unsubscribe = client.subscribe((message) => {
      processing = processing
        .then(() => processNotification(message))
        .catch((error: unknown) => {
          fail(error instanceof Error ? error : protocolError("Codex notification processing failed"));
        });
    });
    const abort = () => fail(new CodexAppServerError("aborted", "Codex Turn was aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });

    let result: CodexTurnResult | undefined;
    let failure: CodexTurnError | undefined;
    try {
      options.signal?.throwIfAborted();
      if (options.request.runtime.allowedTools.length > 0 && !client.setDynamicToolHandler) {
        throw protocolError("Codex App Server does not support hosted dynamic tools");
      }
      client.setDynamicToolHandler?.(async (call) => {
        if (
          !options.onDynamicToolCall ||
          !providerThreadId ||
          !providerTurnId ||
          call.threadId !== providerThreadId ||
          call.turnId !== providerTurnId ||
          call.namespace !== null ||
          !options.request.runtime.allowedTools.includes(call.tool)
        ) {
          return { success: false, text: "OpenTag rejected this tool call." };
        }
        return options.onDynamicToolCall(call);
      });
      await client.initialize(this.#clientVersion, options.signal);
      const threadResponse = await this.#openThread(client, options);
      providerThreadId = threadResponse.threadId;
      await options.onThreadReady(providerThreadId);

      turnStartAttempted = true;
      const turnResponse = parseTurnStartResponse(
        await client.request(
          "turn/start",
          turnStartParams(options.request, providerThreadId, options.cwd, options.supplementalContext),
          options.signal,
        ),
      );
      providerTurnId = turnResponse.id;
      if (turnResponse.status !== "inProgress") throw protocolError("Codex turn/start returned a terminal Turn");
      await options.onTurnStarted(providerTurnId);
      if (!turnStartedTraced) {
        turnStartedTraced = true;
        options.trace?.turnStarted();
      }

      notificationsReady = true;
      const early = pending.splice(0);
      pendingBytes = 0;
      for (const message of early) processing = processing.then(() => processNotification(message));
      await processing;
      await terminalReady;
      await processing;
      if (terminalFailure) throw terminalFailure;
      if (!terminal) throw protocolError("Codex did not provide an authoritative terminal Turn");
      const finalText = selectFinalText(terminal.items, completedItems);
      if (terminal.status === "completed" && !finalText) {
        throw new CodexTurnError(
          "provider_empty_result",
          "may_have_occurred",
          "Codex completed without a final answer",
        );
      }
      if (finalText && Buffer.byteLength(finalText, "utf8") > RUNTIME_FINAL_TEXT_MAX_BYTES) {
        throw new CodexTurnError("output_too_large", "may_have_occurred", "Codex final output exceeds the limit");
      }
      result = {
        ...(finalText ? { finalText } : {}),
        outcome: outcomeFor(terminal.status),
        providerThreadId,
        providerTurnId,
        ...(latestUsage ? { usage: latestUsage } : {}),
      };
    } catch (error) {
      failure = classifyCodexError(error, Boolean(options.providerThreadId), turnStartAttempted);
    }
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    client.setDynamicToolHandler?.(undefined);
    if (options.signal?.aborted && providerThreadId && providerTurnId) {
      await client.interrupt(providerThreadId, providerTurnId);
    }
    try {
      await client.close();
    } catch {
      failure = new CodexTurnError(
        "provider_teardown_failed",
        turnStartAttempted ? "may_have_occurred" : "not_started",
        "Codex process teardown failed",
      );
    }
    if (failure) throw failure;
    if (!result) throw new CodexTurnError("provider_protocol_error", "not_started", "Codex returned no Turn result");
    return result;
  }

  async #openThread(client: CodexAppServerClient, options: CodexTurnRunOptions): Promise<ParsedThreadResponse> {
    const runtime = options.request.runtime;
    const instructionCwd = resolve(options.cwd, "..");
    const common = {
      approvalPolicy: "never",
      cwd: instructionCwd,
      sandbox: "workspace-write",
      ...(runtime.model ? { model: runtime.model } : {}),
    };
    const response = options.providerThreadId
      ? await client.request("thread/resume", { ...common, threadId: options.providerThreadId }, options.signal)
      : await client.request(
          "thread/start",
          {
            ...common,
            ephemeral: false,
            serviceName: "OpenTag",
            dynamicTools: codexDynamicToolSpecs(runtime.allowedTools),
          },
          options.signal,
        );
    return parseThreadResponse(response, {
      agentsFile: options.agentsFile,
      cwd: instructionCwd,
      expectedThreadId: options.providerThreadId,
      model: runtime.model,
    });
  }
}

export function codexDynamicToolSpecs(allowedTools: readonly string[]): Array<Record<string, unknown>> {
  return allowedTools.map((name) => ({
    type: "function",
    name,
    description:
      name === "opentag_message_send"
        ? "Send a new message to the current OpenTag IM conversation."
        : name === "opentag_message_reply"
          ? "Reply to a visible OpenTag IM message in the current conversation."
          : "Add an emoji reaction to a visible OpenTag IM message.",
    inputSchema:
      name === "opentag_message_react"
        ? {
            type: "object",
            additionalProperties: false,
            properties: {
              requestId: {
                type: "string",
                format: "uuid",
                description: "Stable operation ID. Reuse it when retrying the same logical write.",
              },
              targetImMessageId: { type: "string", format: "uuid" },
              emoji: { type: "string" },
            },
            required: ["requestId", "targetImMessageId", "emoji"],
          }
        : name === "opentag_message_reply"
          ? {
              type: "object",
              additionalProperties: false,
              properties: {
                requestId: {
                  type: "string",
                  format: "uuid",
                  description: "Stable operation ID. Reuse it when retrying the same logical write.",
                },
                replyToImMessageId: { type: "string", format: "uuid" },
                text: { type: "string" },
              },
              required: ["requestId", "replyToImMessageId", "text"],
            }
          : {
              type: "object",
              additionalProperties: false,
              properties: {
                requestId: {
                  type: "string",
                  format: "uuid",
                  description: "Stable operation ID. Reuse it when retrying the same logical write.",
                },
                text: { type: "string" },
              },
              required: ["requestId", "text"],
            },
  }));
}

export function codexProviderEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

export function buildOpenTagRuntimeContext(request: DirectImMessageDeliveryRequest): string {
  const sessionInstructions = request.runtime.instructions.session?.trim() || "No additional Session instructions.";
  return [
    "OpenTag managed runtime context (not user-authored).",
    `Agent: ${request.agentId}`,
    `Session: ${request.sessionId}`,
    `Agent revision: ${request.runtime.revision.agent.sequence}/${request.runtime.revision.agent.id}`,
    `Session revision: ${request.runtime.revision.session.sequence}/${request.runtime.revision.session.id}`,
    "Reload and obey the managed AGENTS.md before acting.",
    "For the same logical IM write retry, reuse the exact same requestId; never mint a new ID after an unknown result.",
    "Session instructions:",
    sessionInstructions,
  ].join("\n");
}

function turnStartParams(
  request: DirectImMessageDeliveryRequest,
  threadId: string,
  cwd: string,
  supplementalContext?: string,
) {
  const runtime = request.runtime;
  return {
    threadId,
    cwd,
    approvalPolicy: "never",
    input: [
      { type: "text", text: buildOpenTagRuntimeContext(request) },
      { type: "text", text: request.content.text },
      ...(request.content.history?.length
        ? [
            {
              type: "text",
              text: `Bounded prior IM history${request.content.historyTruncated ? " (truncated)" : ""}:\n${request.content.history
                .map((item) => `[${item.occurredAt}] ${item.imMessageId}: ${item.text}`)
                .join("\n")}`,
            },
          ]
        : []),
      ...(supplementalContext ? [{ type: "text", text: supplementalContext }] : []),
    ],
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.reasoningEffort ? { effort: runtime.reasoningEffort } : {}),
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
}

interface ParsedThreadResponse {
  threadId: string;
}

function parseThreadResponse(
  value: unknown,
  expected: { agentsFile: string; cwd: string; expectedThreadId?: string; model?: string },
): ParsedThreadResponse {
  const response = requireRecord(value, "Invalid Codex Thread response");
  const thread = requireRecord(response.thread, "Invalid Codex Thread");
  const threadId = requireString(thread.id, "Invalid Codex Thread ID");
  if (expected.expectedThreadId && threadId !== expected.expectedThreadId) {
    throw protocolError("Codex resumed a different Thread");
  }
  if (thread.ephemeral !== false) throw protocolError("Codex Thread is not persistent");
  if (resolve(requireString(response.cwd, "Invalid Codex Thread cwd")) !== resolve(expected.cwd)) {
    throw protocolError("Codex Thread cwd mismatch");
  }
  if (response.approvalPolicy !== "never") throw protocolError("Codex approval policy was widened");
  const sandbox = requireRecord(response.sandbox, "Invalid Codex sandbox response");
  if (sandbox.type !== "workspaceWrite" || sandbox.networkAccess === true) {
    throw protocolError("Codex sandbox policy was widened");
  }
  if (expected.model && response.model !== expected.model) throw protocolError("Codex model mismatch");
  if (!Array.isArray(response.instructionSources)) throw protocolError("Codex instruction sources are missing");
  const expectedInstructions = resolve(expected.agentsFile);
  if (
    !response.instructionSources.some(
      (source) => typeof source === "string" && resolve(source) === expectedInstructions,
    )
  ) {
    throw protocolError("Codex did not load the managed AGENTS.md");
  }
  return { threadId };
}

interface ProviderTurn {
  id: string;
  items: Record<string, unknown>[];
  status: "completed" | "failed" | "inProgress" | "interrupted";
}

function parseTurnStartResponse(value: unknown): ProviderTurn {
  const response = requireRecord(value, "Invalid Codex turn/start response");
  return parseTurn(response.turn, "turn/start");
}

function parseTurn(value: unknown, source: string): ProviderTurn {
  const turn = requireRecord(value, `Invalid Codex ${source} Turn`);
  const status = turn.status;
  if (status !== "completed" && status !== "failed" && status !== "inProgress" && status !== "interrupted") {
    throw protocolError(`Invalid Codex ${source} status`);
  }
  if (!Array.isArray(turn.items) || turn.items.some((item) => !record(item))) {
    throw protocolError(`Invalid Codex ${source} items`);
  }
  if (turn.items.length > CODEX_V0_ITEM_LIMIT) throw protocolError(`Codex ${source} has too many items`);
  const itemIds = new Set<string>();
  for (const item of turn.items as Record<string, unknown>[]) {
    const itemId = requireString(item.id, `Invalid Codex ${source} item ID`);
    requireString(item.type, `Invalid Codex ${source} item type`);
    if (itemIds.has(itemId)) throw protocolError(`Codex ${source} has duplicate item IDs`);
    itemIds.add(itemId);
    if (item.type === "agentMessage") normalizeCompletedItem(item);
  }
  return {
    id: requireString(turn.id, `Invalid Codex ${source} ID`),
    items: turn.items as Record<string, unknown>[],
    status,
  };
}

function normalizeCompletedItem(item: Record<string, unknown>): Record<string, unknown> {
  const id = requireString(item.id, "Invalid completed item ID");
  const type = requireString(item.type, "Invalid completed item type");
  if (type !== "agentMessage") return { id, type };
  const text = requireString(item.text, "Invalid completed Agent message", CODEX_V0_NOTIFICATION_BYTES);
  const phase = item.phase;
  if (phase !== undefined && phase !== null && phase !== "commentary" && phase !== "final_answer") {
    throw protocolError("Invalid completed Agent message phase");
  }
  return { id, type, text, phase: phase ?? null };
}

function parseUsage(value: unknown): RuntimeUsage {
  const tokenUsage = requireRecord(value, "Invalid Codex token usage");
  const last = requireRecord(tokenUsage.last, "Invalid Codex last-turn token usage");
  const inputTokens = requireSequence(last.inputTokens, "Invalid Codex input token usage");
  const cachedInputTokens = requireSequence(last.cachedInputTokens, "Invalid Codex cached token usage");
  const outputTokens = requireSequence(last.outputTokens, "Invalid Codex output token usage");
  return { inputTokens, cachedInputTokens, outputTokens };
}

function selectFinalText(
  terminalItems: Record<string, unknown>[],
  completedItems: ReadonlyMap<string, Record<string, unknown>>,
): string | undefined {
  const byId = new Map(completedItems);
  for (const item of terminalItems) {
    if (typeof item.id === "string") byId.set(item.id, item);
  }
  const items = [...byId.values()];
  let legacy: string | undefined;
  let final: string | undefined;
  for (const item of items) {
    if (item.type !== "agentMessage" || typeof item.text !== "string" || item.text.trim().length === 0) continue;
    if (item.phase === "final_answer") final = item.text;
    else if (item.phase === null || item.phase === undefined) legacy = item.text;
  }
  return final ?? legacy;
}

function traceItemType(item: Record<string, unknown>): CodexTraceItemType {
  if (item.type === "agentMessage") return "agent_message";
  if (item.type === "commandExecution") return "command";
  if (item.type === "fileChange") return "file_change";
  if (
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "collabAgentToolCall" ||
    item.type === "imageGeneration"
  ) {
    return "tool";
  }
  return "other";
}

function traceItemStatus(item: Record<string, unknown>): "completed" | "failed" {
  if (item.type === "agentMessage") return "completed";
  return item.status === "completed" ? "completed" : "failed";
}

function outcomeFor(status: ProviderTurn["status"]): CodexTurnOutcome {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "cancelled";
  if (status === "failed") return "failed";
  return "unknown";
}

function classifyCodexError(error: unknown, wasResume: boolean, turnStartAttempted: boolean): CodexTurnError {
  if (error instanceof CodexTurnError) return error;
  if (error instanceof CodexAppServerError && error.code === "aborted") {
    return new CodexTurnError(
      "turn_timeout",
      turnStartAttempted ? "may_have_occurred" : "not_started",
      "Codex Turn was aborted",
      { cause: error },
    );
  }
  if (turnStartAttempted) {
    return new CodexTurnError("turn_state_unknown", "may_have_occurred", "Codex Turn state is unknown", {
      cause: error,
    });
  }
  if (wasResume) {
    return new CodexTurnError("session_resume_failed", "not_started", "Codex Session could not be resumed", {
      cause: error,
    });
  }
  if (error instanceof CodexAppServerError && error.code === "protocol") {
    return new CodexTurnError("provider_protocol_error", "not_started", "Codex protocol validation failed", {
      cause: error,
    });
  }
  return new CodexTurnError("provider_start_failed", "not_started", "Codex could not start the Turn", {
    cause: error,
  });
}

function isTurnNotification(method: unknown): method is string {
  return (
    method === "turn/started" ||
    method === "item/completed" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/completed"
  );
}

function protocolError(message: string): CodexAppServerError {
  return new CodexAppServerError("protocol", message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) throw protocolError(message);
  return parsed;
}

function requireString(value: unknown, message: string, maxBytes = 4096): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw protocolError(message);
  }
  return value;
}

function requireSequence(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw protocolError(message);
  return value;
}

export function safeRelativeTracePath(workspace: string, candidate: string): string | undefined {
  const value = relative(resolve(workspace), resolve(candidate));
  return value && !value.startsWith("..") && !value.includes("\\") ? value : undefined;
}
