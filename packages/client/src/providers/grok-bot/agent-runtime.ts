import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { BaseAgentRuntime } from "../../agent-runtime/base-agent-runtime.js";
import { composeRuntimeEnvironment } from "../../agent-runtime/environment.js";
import { AgentProviderError, AgentRuntimeError } from "../../agent-runtime/errors.js";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  AGENT_RUNTIME_TEXT_MAX_BYTES,
  type AgentAbortRequest,
  type AgentPromptRequest,
  type AgentProviderRunContext,
  type AgentProviderRunResult,
  type AgentRunConfiguration,
  type AgentRuntimeBinding,
  type AgentRuntimeEventSink,
  type AgentRuntimeFactory,
  type AgentRuntimeManifest,
  type AgentRuntimePolicy,
  type AgentRuntimeProbeRequest,
  type AgentRuntimeProbeResult,
  type AgentSteerRequest,
  type AgentUsage,
  type CreateAgentRuntimeRequest,
  type JsonValue,
  type ResumeAgentRuntimeRequest,
} from "../../agent-runtime/types.js";
import {
  assertBinding,
  assertJsonValue,
  assertSystemPrompt,
  runWithAbortSignal,
} from "../../agent-runtime/validation.js";
import { createLogger } from "../../observability/logger.js";
import {
  type GrokBotRpcClient,
  GrokBotRpcError,
  GrokBotRpcProcess,
  type GrokBotRpcProcessSpawnOptions,
} from "./rpc-wire.js";

const execFileAsync = promisify(execFile);
const GROK_BOT_BINDING_SCHEMA_VERSION = 1;
const GROK_BOT_PROVIDER_ID = "grok-bot";
const logger = createLogger("provider-grok-bot-runtime");
const GROK_BOT_MINIMUM_VERSION = [0, 1, 0] as const;
const GROK_BOT_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const GROK_BOT_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const GROK_BOT_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const GROK_BOT_RESOURCE_DISABLE_ARGUMENTS = ["--offline", "--no-extensions", "--no-skills", "--no-approve"] as const;

export const GROK_BOT_AGENT_RUNTIME_MANIFEST: AgentRuntimeManifest = Object.freeze({
  providerId: GROK_BOT_PROVIDER_ID,
  displayName: "Grok Bot",
  contractVersion: AGENT_RUNTIME_CONTRACT_VERSION,
  bindingSchemaVersion: GROK_BOT_BINDING_SCHEMA_VERSION,
});

interface GrokBotProviderConfiguration {
  readonly sessionName?: string;
}

interface GrokBotRuntimeOptions {
  readonly binding: AgentRuntimeBinding;
  readonly configuration?: AgentRunConfiguration;
  readonly createClient: (args: readonly string[]) => GrokBotRpcClient;
  readonly eventSink: AgentRuntimeEventSink;
  readonly policy: AgentRuntimePolicy;
  readonly resume: boolean;
  readonly sessionDirectory?: string;
  readonly systemPrompt: string;
}

export interface GrokBotAgentRuntimeFactoryOptions {
  readonly process?: {
    readonly args?: readonly string[];
    readonly command?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly maxLineBytes?: number;
    readonly maxStderrBytes?: number;
    readonly requestTimeoutMs?: number;
    readonly sessionDirectory?: string;
    readonly spawnProcess?: (
      command: string,
      args: readonly string[],
      options: GrokBotRpcProcessSpawnOptions,
    ) => ChildProcessWithoutNullStreams;
  };
  readonly createClient?: (
    cwd: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ) => GrokBotRpcClient;
  readonly createSessionId?: () => string;
  readonly probeRunner?: (signal?: AbortSignal) => Promise<{
    readonly credential: boolean;
    readonly rpc: boolean;
    readonly version: string;
  }>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
}

interface GrokBotTerminal {
  readonly error?: string;
  readonly status: "aborted" | "completed" | "failed";
  readonly stopReason: string;
}

interface GrokBotTextBlock {
  readonly id: string;
  completed: boolean;
  text: string;
}

interface GrokBotAssistantMessage {
  readonly blocks: Map<number, GrokBotTextBlock>;
  readonly id: string;
}

interface GrokBotTool {
  readonly name: string;
}

export class GrokBotAgentRuntime extends BaseAgentRuntime {
  readonly #sessionId: string;
  readonly #policy: AgentRuntimePolicy;
  readonly #configuration?: AgentRunConfiguration;
  readonly #sessionDirectory?: string;
  readonly #systemPrompt: string;
  readonly #createClient: (args: readonly string[]) => GrokBotRpcClient;
  readonly #tools = new Map<string, GrokBotTool>();
  #client?: GrokBotRpcClient;
  #unsubscribe?: () => void;
  #context?: AgentProviderRunContext;
  #eventTail: Promise<void> = Promise.resolve();
  #terminal?: Deferred<GrokBotTerminal>;
  #promptAccepted?: Deferred<void>;
  #providerFailure?: Error;
  #currentTurnId?: string;
  #currentAssistant?: GrokBotAssistantMessage;
  #turnSequence = 0;
  #assistantSequence = 0;
  #lastText?: string;
  #lastStopReason?: string;
  #lastError?: string;
  #model?: { readonly id: string; readonly provider: string };
  #usage: AgentUsage = {};
  #sessionExists: boolean;
  #sessionFileHash?: string;
  #pendingSessionFileHash = "";
  #terminalClaimed = false;

  constructor(options: GrokBotRuntimeOptions) {
    super({
      manifest: GROK_BOT_AGENT_RUNTIME_MANIFEST,
      capabilities: { steer: "supported", interactions: "unsupported" },
      eventSink: options.eventSink,
      binding: options.binding,
    });
    const binding = parseGrokBotBinding(options.binding);
    this.#sessionId = binding.sessionId;
    this.#sessionFileHash = binding.sessionFileHash;
    this.#policy = options.policy;
    this.#configuration = options.configuration;
    this.#sessionDirectory = options.sessionDirectory;
    this.#systemPrompt = options.systemPrompt;
    this.#createClient = options.createClient;
    this.#sessionExists = options.resume;
  }

  protected async executeRun(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
  ): Promise<AgentProviderRunResult> {
    this.#resetRun(context);
    let client: GrokBotRpcClient | undefined;
    let cleanupFailure: Error | undefined;
    let result: AgentProviderRunResult;
    try {
      client = this.#createClient(this.#arguments(request));
      this.#client = client;
      this.#unsubscribe = client.subscribe((message) => this.#enqueue(message));
      const state = requireRecord(
        await client.request({ type: "get_state" }, context.signal),
        "Grok Bot get_state returned invalid data",
      );
      await this.#restoreSessionState(state, context);
      await client.request({ type: "prompt", message: grokBotInput(request) }, context.signal);
      this.#promptAccepted?.resolve();
      const terminal = await this.#terminal?.promise;
      if (!terminal) throw protocolError("Grok Bot run has no terminal state");
      await this.#eventTail;
      if (this.#providerFailure) throw this.#providerFailure;
      result = this.#runResult(terminal);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Grok Bot run failed");
      logger.debug({ code: "provider_run_failed", error: failure.message }, "Grok Bot provider run failed");
      this.#promptAccepted?.reject(failure);
      const causalFailure = this.#providerFailure ?? failure;
      if (!context.signal.aborted && isIrrecoverableGrokBotFailure(causalFailure)) this.closeForProviderFailure();
      if (causalFailure instanceof AgentProviderError) throw causalFailure;
      throw new AgentProviderError(
        causalFailure instanceof GrokBotRpcError && causalFailure.code === "protocol"
          ? "provider_protocol_error"
          : "provider_error",
        causalFailure.message,
        { cause: causalFailure },
      );
    } finally {
      cleanupFailure = await this.#cleanupRun(client);
    }
    if (cleanupFailure && result.status !== "failed") {
      throw new AgentProviderError("provider_error", cleanupFailure.message, { cause: cleanupFailure });
    }
    return result;
  }

  async #restoreSessionState(
    state: Readonly<Record<string, unknown>>,
    context: AgentProviderRunContext,
  ): Promise<void> {
    const sessionId = requireUuid(state.sessionId, "Grok Bot get_state sessionId");
    if (sessionId !== this.#sessionId) throw protocolError("Grok Bot opened another session");
    const sessionFile = requireAbsolutePath(state.sessionFile, "Grok Bot get_state sessionFile is not absolute");
    const messageCount = requireNonNegativeSafeInteger(
      state.messageCount,
      "Grok Bot get_state messageCount is invalid",
    );
    const sessionFileHash = fingerprint(sessionFile);
    if (!this.#sessionExists && messageCount !== 0) {
      throw protocolError("Grok Bot create opened an existing conversation");
    }
    if (this.#sessionFileHash && this.#sessionFileHash !== sessionFileHash) {
      throw protocolError("Grok Bot opened another session file");
    }
    if (this.#sessionFileHash && messageCount === 0) {
      throw protocolError("Grok Bot session has no conversation history");
    }
    this.#pendingSessionFileHash = sessionFileHash;
    this.#sessionExists = true;
    this.#model = parseModel(state.model);
    if (!this.#sessionFileHash && messageCount !== 0) {
      await this.#materializeSession(context, sessionFileHash);
    }
  }

  async #materializeSession(context: AgentProviderRunContext, sessionFileHash: string): Promise<void> {
    if (this.#sessionFileHash) return;
    await context.updateBinding(grokBotBinding(this.#sessionId, sessionFileHash));
    this.#sessionFileHash = sessionFileHash;
  }

  async #cleanupRun(client: GrokBotRpcClient | undefined): Promise<Error | undefined> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    let failure: Error | undefined;
    try {
      await client?.close();
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Grok Bot provider close failed");
      logger.debug({ code: "provider_close_failed", error: failure.message }, "Grok Bot provider close failed");
    }
    this.#client = undefined;
    this.#context = undefined;
    this.#terminal = undefined;
    this.#promptAccepted = undefined;
    this.#currentTurnId = undefined;
    this.#currentAssistant = undefined;
    this.#tools.clear();
    if (failure) this.closeForProviderFailure();
    return failure;
  }

  protected override async steerProvider(request: AgentSteerRequest): Promise<void> {
    if (!this.#promptAccepted) throw new AgentRuntimeError("run_mismatch", "there is no active Grok Bot prompt");
    await this.#promptAccepted.promise;
    const client = this.#client;
    if (!client) throw new AgentRuntimeError("run_mismatch", "there is no active Grok Bot process");
    await client.request({ type: "steer", message: grokBotItems(request.input.items) });
  }

  protected override async abortProvider(_request: AgentAbortRequest): Promise<void> {
    if (this.#terminalClaimed) return;
    await this.#client?.request({ type: "abort" }, AbortSignal.timeout(2_000));
  }

  protected async closeProvider(): Promise<void> {
    await this.#client?.close();
  }

  #resetRun(context: AgentProviderRunContext): void {
    this.#context = context;
    this.#eventTail = Promise.resolve();
    this.#terminal = deferred<GrokBotTerminal>();
    this.#promptAccepted = deferred<void>();
    void this.#terminal.promise.catch(() => undefined);
    void this.#promptAccepted.promise.catch(() => undefined);
    this.#providerFailure = undefined;
    this.#currentTurnId = undefined;
    this.#currentAssistant = undefined;
    this.#turnSequence = 0;
    this.#assistantSequence = 0;
    this.#lastText = undefined;
    this.#lastStopReason = undefined;
    this.#lastError = undefined;
    this.#model = undefined;
    this.#usage = {};
    this.#tools.clear();
    this.#terminalClaimed = false;
  }

  #arguments(request: AgentPromptRequest): readonly string[] {
    const configuration = mergeConfiguration(this.#configuration, request.configuration);
    const provider = parseProviderConfiguration(configuration?.provider);
    return [
      "--mode",
      "rpc",
      ...GROK_BOT_RESOURCE_DISABLE_ARGUMENTS,
      "--session-id",
      this.#sessionId,
      ...(this.#sessionDirectory ? ["--session-dir", this.#sessionDirectory] : []),
      ...grokBotPolicyArguments(this.#policy),
      ...(configuration?.model ? ["--model", configuration.model] : []),
      ...(configuration?.reasoningEffort ? ["--thinking", configuration.reasoningEffort] : []),
      "--append-system-prompt",
      this.#systemPrompt,
      ...(provider.sessionName ? ["--name", provider.sessionName] : []),
    ];
  }

  #enqueue(message: Readonly<Record<string, unknown>>): void {
    this.#claimTerminalAtIngress(message);
    const next = this.#eventTail.then(async () => {
      if (!this.#context) return;
      await this.#handleMessage(message);
    });
    this.#eventTail = next.catch((error: unknown) => {
      this.#failProvider(error instanceof Error ? error : protocolError("Grok Bot event processing failed"));
    });
  }

  #claimTerminalAtIngress(message: Readonly<Record<string, unknown>>): void {
    if (message.type !== "agent_settled" || !this.#context) return;
    this.#context.claimTerminal();
    this.#terminalClaimed = true;
  }

  async #handleMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    const type = requireString(message.type, "Grok Bot event has no type");
    if (type === "opentag/process_error") {
      throw message.error instanceof Error
        ? message.error
        : new AgentProviderError("provider_error", "Grok Bot process failed");
    }
    if (type === "extension_ui_request") {
      throw protocolError("Grok Bot requested extension UI while extensions are disabled");
    }
    if (type === "agent_start") return;
    if (type === "turn_start") {
      if (this.#currentTurnId) throw protocolError("Grok Bot started overlapping turns");
      this.#turnSequence += 1;
      this.#currentTurnId = `grok-bot-turn-${this.#turnSequence}`;
      await this.#requireContext().emit({ type: "model_turn_started", modelTurnId: this.#currentTurnId });
      return;
    }
    if (type === "turn_end") {
      const turnId = this.#currentTurnId;
      if (!turnId) throw protocolError("Grok Bot ended a turn that was not active");
      if (this.#currentAssistant || this.#tools.size > 0) {
        throw protocolError("Grok Bot ended a turn with unfinished child events");
      }
      await this.#requireContext().emit({ type: "model_turn_completed", modelTurnId: turnId });
      this.#currentTurnId = undefined;
      return;
    }
    if (type === "message_start") {
      this.#requireActiveTurn("Grok Bot started a message outside an active turn");
      await this.#startMessage(requireRecord(message.message, "Grok Bot message_start has no message"));
      return;
    }
    if (type === "message_update") {
      this.#requireActiveTurn("Grok Bot updated a message outside an active turn");
      await this.#updateMessage(requireRecord(message.assistantMessageEvent, "Grok Bot message_update has no delta"));
      return;
    }
    if (type === "message_end") {
      this.#requireActiveTurn("Grok Bot ended a message outside an active turn");
      await this.#endMessage(requireRecord(message.message, "Grok Bot message_end has no message"));
      return;
    }
    if (type === "tool_execution_start") {
      this.#requireActiveTurn("Grok Bot started a tool outside an active turn");
      await this.#startTool(message);
      return;
    }
    if (type === "tool_execution_update") {
      this.#requireActiveTurn("Grok Bot updated a tool outside an active turn");
      await this.#updateTool(message);
      return;
    }
    if (type === "tool_execution_end") {
      this.#requireActiveTurn("Grok Bot ended a tool outside an active turn");
      await this.#endTool(message);
      return;
    }
    if (type === "agent_end") {
      await this.#emitProviderEvent({ type, willRetry: message.willRetry === true });
      return;
    }
    if (type === "agent_settled") {
      this.#settleAgent();
      return;
    }
    if (type === "extension_error") {
      await this.#requireContext().emit({
        type: "provider_warning",
        code: "grok_bot_extension_error",
        message: typeof message.error === "string" ? message.error : "Grok Bot extension failed",
      });
      return;
    }
    if (type === "auto_retry_start") {
      await this.#requireContext().emit({
        type: "provider_warning",
        code: "grok_bot_auto_retry",
        message:
          typeof message.errorMessage === "string" ? message.errorMessage : "Grok Bot is retrying the model request",
      });
      return;
    }
    await this.#emitProviderEvent(message);
  }

  async #startMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (message.role !== "assistant") return;
    if (this.#currentAssistant) throw protocolError("Grok Bot started overlapping assistant messages");
    this.#assistantSequence += 1;
    this.#currentAssistant = { id: `grok-bot-message-${this.#assistantSequence}`, blocks: new Map() };
  }

  #requireActiveTurn(message: string): void {
    if (!this.#currentTurnId) throw protocolError(message);
  }

  async #updateMessage(update: Readonly<Record<string, unknown>>): Promise<void> {
    const current = this.#currentAssistant;
    if (!current) throw protocolError("Grok Bot emitted an assistant update without an active message");
    const type = requireString(update.type, "Grok Bot assistant update has no type");
    if (type === "text_start") {
      const index = requireIndex(update.contentIndex);
      if (current.blocks.has(index)) throw protocolError("Grok Bot reused a text content index");
      const block = { id: `${current.id}:text:${index}`, text: "", completed: false };
      current.blocks.set(index, block);
      await this.#requireContext().emit({ type: "message_started", messageId: block.id });
      return;
    }
    if (type === "text_delta") {
      const block = current.blocks.get(requireIndex(update.contentIndex));
      if (!block || block.completed) throw protocolError("Grok Bot text delta has no active content block");
      const delta = requireString(update.delta, "Grok Bot text delta has no text", true);
      block.text += delta;
      await this.#requireContext().emit({ type: "message_delta", messageId: block.id, delta });
      return;
    }
    if (type === "text_end") {
      const block = current.blocks.get(requireIndex(update.contentIndex));
      if (!block || block.completed) throw protocolError("Grok Bot text end has no active content block");
      const text = requireString(update.content, "Grok Bot text end has no text", true);
      if (block.text !== text) throw protocolError("Grok Bot text stream does not match its completed content");
      block.completed = true;
      await this.#requireContext().emit({ type: "message_completed", messageId: block.id, text });
      return;
    }
    if (type === "error") {
      const failedMessage = record(update.error) ?? record(update.partial);
      if (typeof failedMessage?.errorMessage === "string") this.#lastError = failedMessage.errorMessage;
      await this.#emitProviderEvent({ type: "assistant_update", updateType: type });
      return;
    }
    if (type === "start" || type === "done") {
      if (type === "done") requireStopReason(update.reason, "Grok Bot assistant done reason is invalid");
      await this.#emitProviderEvent({ type: "assistant_update", updateType: type });
      return;
    }
    if (type.startsWith("thinking_")) {
      const contentIndex = requireIndex(update.contentIndex);
      if (type === "thinking_delta") requireString(update.delta, "Grok Bot thinking delta has no text", true);
      else if (type === "thinking_end") requireString(update.content, "Grok Bot thinking end has no text", true);
      else if (type !== "thinking_start") throw protocolError("Grok Bot assistant thinking update is unsupported");
      await this.#emitProviderEvent({ type: "assistant_update", updateType: type, contentIndex });
      return;
    }
    if (type.startsWith("toolcall_")) {
      const contentIndex = requireIndex(update.contentIndex);
      if (type === "toolcall_delta") requireString(update.delta, "Grok Bot tool-call delta has no text", true);
      else if (type === "toolcall_end") requireRecord(update.toolCall, "Grok Bot tool-call end has no tool call");
      else if (type !== "toolcall_start") throw protocolError("Grok Bot assistant tool-call update is unsupported");
      await this.#emitProviderEvent({ type: "assistant_update", updateType: type, contentIndex });
      return;
    }
    throw protocolError("Grok Bot assistant update type is unsupported");
  }

  async #endMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (message.role !== "assistant") return;
    const current = this.#currentAssistant;
    if (!current) throw protocolError("Grok Bot ended an assistant message that was not active");
    const content = requireArray(message.content, "Grok Bot assistant content is invalid");
    const textParts: string[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const item = requireRecord(content[index], "Grok Bot assistant content block is invalid");
      if (item.type !== "text") continue;
      const text = requireString(item.text, "Grok Bot assistant text block has no text", true);
      textParts.push(text);
      let block = current.blocks.get(index);
      if (!block) {
        block = { id: `${current.id}:text:${index}`, text, completed: true };
        current.blocks.set(index, block);
        await this.#requireContext().emit({ type: "message_started", messageId: block.id });
        if (text) await this.#requireContext().emit({ type: "message_delta", messageId: block.id, delta: text });
        await this.#requireContext().emit({ type: "message_completed", messageId: block.id, text });
      } else if (!block.completed || block.text !== text) {
        throw protocolError("Grok Bot completed assistant content does not match its text stream");
      }
    }
    this.#lastText = textParts.join("\n");
    this.#lastStopReason = requireStopReason(message.stopReason, "Grok Bot assistant message has invalid stop reason");
    if (typeof message.errorMessage === "string") this.#lastError = message.errorMessage;
    const usage = parseUsage(message.usage);
    if (usage) {
      this.#usage = addUsage(this.#usage, usage);
      await this.#requireContext().emit({ type: "usage_updated", usage: this.#usage });
    }
    this.#currentAssistant = undefined;
    await this.#materializeSession(this.#requireContext(), this.#pendingSessionFileHash);
  }

  async #startTool(message: Readonly<Record<string, unknown>>): Promise<void> {
    const toolCallId = requireString(message.toolCallId, "Grok Bot tool start has no toolCallId");
    if (this.#tools.has(toolCallId)) throw protocolError("Grok Bot reused an active toolCallId");
    const name = requireString(message.toolName, "Grok Bot tool start has no toolName");
    this.#tools.set(toolCallId, { name });
    await this.#requireContext().emit({
      type: "tool_started",
      toolCallId,
      name,
      ...(message.args !== undefined ? { input: toJsonValue(message.args) } : {}),
    });
  }

  async #updateTool(message: Readonly<Record<string, unknown>>): Promise<void> {
    const toolCallId = requireString(message.toolCallId, "Grok Bot tool update has no toolCallId");
    if (!this.#tools.has(toolCallId)) throw protocolError("Grok Bot tool update has no active tool");
    await this.#requireContext().emit({
      type: "tool_updated",
      toolCallId,
      update: toJsonValue(message.partialResult ?? {}),
    });
  }

  async #endTool(message: Readonly<Record<string, unknown>>): Promise<void> {
    const toolCallId = requireString(message.toolCallId, "Grok Bot tool end has no toolCallId");
    const tool = this.#tools.get(toolCallId);
    if (!tool) throw protocolError("Grok Bot tool end has no active tool");
    this.#tools.delete(toolCallId);
    await this.#requireContext().emit({
      type: "tool_completed",
      toolCallId,
      name: tool.name,
      status: message.isError === true ? "failed" : "completed",
      ...(message.result !== undefined ? { output: toJsonValue(message.result) } : {}),
    });
  }

  #settleAgent(): void {
    if (this.#currentTurnId || this.#currentAssistant || this.#tools.size > 0) {
      throw protocolError("Grok Bot settled with unfinished protocol state");
    }
    const stopReason = this.#lastStopReason;
    if (!stopReason) throw protocolError("Grok Bot settled without an assistant result");
    const status = stopReason === "stop" ? "completed" : stopReason === "aborted" ? "aborted" : "failed";
    this.#terminal?.resolve({
      status,
      stopReason,
      ...(this.#lastError ? { error: this.#lastError } : {}),
    });
  }

  #runResult(terminal: GrokBotTerminal): AgentProviderRunResult {
    const output = this.#lastText ? [{ type: "text" as const, text: this.#lastText }] : [];
    const usage = hasUsage(this.#usage) ? this.#usage : undefined;
    const diagnostics: JsonValue = {
      providerSessionId: this.#sessionId,
      stopReason: terminal.stopReason,
      ...(this.#model ? { model: this.#model } : {}),
    };
    if (terminal.status === "completed") {
      return { status: "completed", output, ...(usage ? { usage } : {}), diagnostics };
    }
    if (terminal.status === "aborted") {
      return {
        status: "aborted",
        output,
        ...(usage ? { usage } : {}),
        error: { code: "run_aborted", message: terminal.error ?? "Grok Bot run was aborted" },
        diagnostics,
      };
    }
    return {
      status: "failed",
      output,
      ...(usage ? { usage } : {}),
      error: { code: "provider_error", message: terminal.error ?? grokBotFailedStopMessage(terminal.stopReason) },
      diagnostics,
    };
  }

  async #emitProviderEvent(payload: JsonValue | Readonly<Record<string, unknown>>): Promise<void> {
    await this.#requireContext().emit({
      type: "provider_event",
      providerId: GROK_BOT_PROVIDER_ID,
      schemaVersion: 1,
      payload: toJsonValue(payload),
    });
  }

  #requireContext(): AgentProviderRunContext {
    if (!this.#context) throw protocolError("Grok Bot event arrived without an active run");
    return this.#context;
  }

  #failProvider(error: Error): void {
    if (this.#providerFailure) return;
    this.#providerFailure = error;
    this.#terminal?.reject(error);
    this.#promptAccepted?.reject(error);
    void this.#client?.close().catch((closeError: unknown) => {
      logger.debug({ code: "provider_close_failed", error: String(closeError) }, "Grok Bot provider close failed");
    });
    this.closeForProviderFailure();
  }
}

export class GrokBotAgentRuntimeFactory implements AgentRuntimeFactory {
  readonly manifest = GROK_BOT_AGENT_RUNTIME_MANIFEST;
  readonly #createSessionId: () => string;
  readonly #createClient: (
    cwd: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
    pathPrepend?: string,
  ) => GrokBotRpcClient;
  readonly #probeRunner: (signal?: AbortSignal) => Promise<{
    readonly credential: boolean;
    readonly rpc: boolean;
    readonly version: string;
  }>;
  readonly #sessionDirectory?: string;

  constructor(options: GrokBotAgentRuntimeFactoryOptions = {}) {
    this.#createSessionId = options.createSessionId ?? randomUUID;
    const environment = grokBotAgentRuntimeEnvironment(options.process?.env ?? process.env);
    const command = options.process?.command ?? "grok-bot";
    const prefix = options.process?.args ?? [];
    const sessionDirectory = options.process?.sessionDirectory;
    if (sessionDirectory && !isAbsolute(sessionDirectory)) {
      throw new AgentRuntimeError("configuration_invalid", "Grok Bot sessionDirectory must be absolute");
    }
    this.#sessionDirectory = sessionDirectory;
    this.#createClient =
      options.createClient ??
      ((cwd, args, workspaceEnvironment, pathPrepend) =>
        new GrokBotRpcProcess({
          command,
          args: [...prefix, ...args],
          cwd,
          env: composeRuntimeEnvironment(environment, workspaceEnvironment, pathPrepend),
          maxLineBytes: options.process?.maxLineBytes,
          maxStderrBytes: options.process?.maxStderrBytes,
          requestTimeoutMs: options.process?.requestTimeoutMs,
          spawnProcess: options.process?.spawnProcess,
        }));
    this.#probeRunner = options.probeRunner ?? ((signal) => probeGrokBot(command, environment, signal));
  }

  async probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    const issues: AgentRuntimeProbeResult["issues"][number][] = [];
    try {
      validateConfiguration(request.configuration);
    } catch (error) {
      issues.push({ code: "configuration_invalid", message: (error as Error).message });
    }
    let version: string | undefined;
    try {
      const result = await runWithAbortSignal(this.#probeRunner, request.signal);
      version = result.version;
      if (!result.rpc) issues.push({ code: "version_incompatible", message: "Grok Bot RPC mode is unavailable" });
      if (!result.credential)
        issues.push({ code: "credential_missing", message: "Grok Bot has no configured model credential" });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      logger.debug({ code: "probe_execution_failed", error: String(error) }, "Grok Bot probe execution failed");
      issues.push({ code: "artifact_missing", message: "Grok Bot CLI could not be executed" });
    }
    return { ready: issues.length === 0, ...(version ? { version } : {}), issues };
  }

  create(request: CreateAgentRuntimeRequest): Promise<GrokBotAgentRuntime> {
    return this.#open(request, "create");
  }

  resume(request: ResumeAgentRuntimeRequest): Promise<GrokBotAgentRuntime> {
    return this.#open(request, "resume");
  }

  async #open(
    request: CreateAgentRuntimeRequest | ResumeAgentRuntimeRequest,
    mode: "create" | "resume",
  ): Promise<GrokBotAgentRuntime> {
    validateFactoryRequest(request);
    validateConfiguration(request.configuration);
    const binding =
      mode === "resume" && "binding" in request
        ? request.binding
        : grokBotBinding(requireUuid(this.#createSessionId(), "generated Grok Bot session id"));
    assertBinding(binding, this.manifest);
    parseGrokBotBinding(binding);
    try {
      await request.eventSink({ type: "binding_changed", binding });
      return new GrokBotAgentRuntime({
        binding,
        configuration: request.configuration,
        createClient: (args) =>
          this.#createClient(request.workspace.cwd, args, request.workspace.environment, request.workspace.pathPrepend),
        eventSink: request.eventSink,
        policy: request.policy,
        resume: mode === "resume",
        sessionDirectory: this.#sessionDirectory,
        systemPrompt: request.systemPrompt,
      });
    } catch (error) {
      logger.debug({ code: "runtime_create_failed", error: String(error) }, "Grok Bot runtime creation failed");
      throw new AgentRuntimeError(mode === "create" ? "create_failed" : "resume_failed", `Grok Bot ${mode} failed`, {
        cause: error,
      });
    }
  }
}

export function grokBotAgentRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const exact = new Set([
    "APPDATA",
    "COMSPEC",
    "GROK_API_KEY",
    "GROK_BOT_HOME",
    "GROK_BOT_SESSION_DIR",
    "GROK_BOT_TELEMETRY",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "LOGNAME",
    "NODE_EXTRA_CA_CERTS",
    "OPENTAG_HOME",
    "OPENTAG_PROVIDER_ENV_FILE",
    "OPENTAG_SESSION_PROOF_FILE",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "USERPROFILE",
    "WINDIR",
    "XAI_API_KEY",
    "http_proxy",
    "https_proxy",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || key.startsWith("AWS_") || key.startsWith("GROK_"))) {
      environment[key] = value;
    }
  }
  return environment;
}

async function probeGrokBot(
  command: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ readonly credential: boolean; readonly rpc: boolean; readonly version: string }> {
  const execution = { encoding: "utf8" as const, env: environment, signal, timeout: 5_000, windowsHide: true };
  const versionResult = await execFileAsync(command, ["--version"], execution);
  const version = versionResult.stdout.trim();
  let help = "";
  try {
    help = (await execFileAsync(command, [...GROK_BOT_RESOURCE_DISABLE_ARGUMENTS, "--help"], execution)).stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.debug({ code: "probe_help_failed", error: String(error) }, "Grok Bot help probe failed");
    help = "";
  }
  const requiredOptions = [
    "--mode",
    "rpc",
    "--session-id",
    "--session-dir",
    ...GROK_BOT_RESOURCE_DISABLE_ARGUMENTS,
    "--tools",
    "--model",
    "--thinking",
    "--append-system-prompt",
    "--name",
  ];
  const rpc = supportsGrokBotProtocol(version) && requiredOptions.every((token) => help.includes(token));
  let credential = false;
  try {
    const loginStatus = await execFileAsync(command, ["login", "status"], execution);
    credential = loginStatus.stdout.includes("authenticated") || loginStatus.stdout.includes("logged in");
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.debug({ code: "probe_login_failed", error: String(error) }, "Grok Bot login probe failed");
    credential = false;
  }
  return { credential, rpc, version };
}

function supportsGrokBotProtocol(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  if (actual.some((part) => !Number.isSafeInteger(part))) return false;
  const firstDifference = actual.findIndex((part, index) => part !== GROK_BOT_MINIMUM_VERSION[index]);
  return (
    firstDifference === -1 ||
    (actual[firstDifference] as number) > (GROK_BOT_MINIMUM_VERSION[firstDifference] as number)
  );
}

function validateFactoryRequest(request: CreateAgentRuntimeRequest): void {
  if (!request || typeof request !== "object" || typeof request.eventSink !== "function") {
    throw new AgentRuntimeError("configuration_invalid", "eventSink is required");
  }
  if (!request.workspace || !isAbsolute(request.workspace.cwd)) {
    throw new AgentRuntimeError("configuration_invalid", "workspace.cwd must be absolute");
  }
  assertSystemPrompt(request.systemPrompt);
  for (const root of request.workspace.writableRoots ?? []) {
    if (!isAbsolute(root)) throw new AgentRuntimeError("configuration_invalid", "writable roots must be absolute");
  }
  if (request.policy.approvals !== "never") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Grok Bot requires approvals=never because it has no approval gate",
    );
  }
  if (request.policy.fileSystem === "workspace-write") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Grok Bot cannot confine writes to workspace roots without a sandbox",
    );
  }
  if (request.policy.fileSystem === "read-only" && (request.workspace.writableRoots?.length ?? 0) > 0) {
    throw new AgentRuntimeError("configuration_invalid", "read-only policy cannot have writable roots");
  }
  if (request.hostedTools !== undefined) {
    throw new AgentRuntimeError("configuration_invalid", "Grok Bot RPC does not implement common hosted tools");
  }
  validateToolPolicy(request.policy);
}

function validateToolPolicy(policy: AgentRuntimePolicy): void {
  if (policy.tools.mode === "allow-list") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Grok Bot RPC does not implement the common hosted-tool allow-list contract",
    );
  }
  if (
    policy.fileSystem === "unrestricted" &&
    policy.network === "disabled" &&
    policy.tools.mode === "provider-default"
  ) {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Grok Bot provider-default tools include unrestricted bash network access",
    );
  }
}

function validateConfiguration(configuration: AgentRunConfiguration | undefined): void {
  if (!configuration) return;
  if (configuration.model !== undefined && configuration.model.trim().length === 0) {
    throw new AgentRuntimeError("configuration_invalid", "model must be non-empty");
  }
  if (configuration.reasoningEffort && !GROK_BOT_THINKING_LEVELS.has(configuration.reasoningEffort)) {
    throw new AgentRuntimeError("configuration_invalid", "Grok Bot thinking level is unsupported");
  }
  parseProviderConfiguration(configuration.provider);
}

function parseProviderConfiguration(value: JsonValue | undefined): GrokBotProviderConfiguration {
  if (value === undefined) return {};
  assertJsonValue(value, "configuration.provider");
  const object = record(value);
  if (!object)
    throw new AgentRuntimeError("configuration_invalid", "Grok Bot provider configuration must be an object");
  const allowed = new Set(["sessionName"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key))
      throw new AgentRuntimeError("configuration_invalid", `unknown Grok Bot configuration field: ${key}`);
  }
  const sessionName = boundedConfigurationString(object.sessionName, "sessionName", 4_096);
  return {
    ...(sessionName ? { sessionName } : {}),
  };
}

function boundedConfigurationString(
  value: unknown,
  field: string,
  maxBytes = AGENT_RUNTIME_TEXT_MAX_BYTES,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new AgentRuntimeError("configuration_invalid", `Grok Bot ${field} must be a non-empty bounded string`);
  }
  return value;
}

function mergeConfiguration(
  base: AgentRunConfiguration | undefined,
  override: AgentRunConfiguration | undefined,
): AgentRunConfiguration | undefined {
  if (!base) {
    validateConfiguration(override);
    return override;
  }
  if (!override) return base;
  const merged: AgentRunConfiguration = {
    ...base,
    ...override,
    provider: {
      ...parseProviderConfiguration(base.provider),
      ...parseProviderConfiguration(override.provider),
    },
  };
  validateConfiguration(merged);
  return merged;
}

function grokBotPolicyArguments(policy: AgentRuntimePolicy): readonly string[] {
  if (policy.fileSystem === "read-only") {
    return ["--tools", GROK_BOT_READ_ONLY_TOOLS.join(",")];
  }
  return [];
}

function grokBotInput(request: AgentPromptRequest): string {
  return grokBotItems(request.input.items);
}

function grokBotItems(items: readonly { readonly text: string }[]): string {
  return items.map((item) => item.text).join("\n");
}

function grokBotBinding(sessionId: string, sessionFileHash?: string): AgentRuntimeBinding {
  return {
    providerId: GROK_BOT_PROVIDER_ID,
    schemaVersion: GROK_BOT_BINDING_SCHEMA_VERSION,
    payload: { sessionId, ...(sessionFileHash ? { sessionFileHash } : {}) },
  };
}

function parseGrokBotBinding(binding: AgentRuntimeBinding): {
  readonly sessionFileHash?: string;
  readonly sessionId: string;
} {
  const payload = record(binding.payload);
  if (!payload) throw new AgentRuntimeError("binding_incompatible", "Grok Bot binding payload is invalid");
  for (const key of Object.keys(payload)) {
    if (key !== "sessionId" && key !== "sessionFileHash") {
      throw new AgentRuntimeError("binding_incompatible", `Grok Bot binding field is unsupported: ${key}`);
    }
  }
  try {
    const sessionId = requireUuid(payload.sessionId, "Grok Bot binding sessionId");
    const sessionFileHash = payload.sessionFileHash;
    if (
      sessionFileHash !== undefined &&
      (typeof sessionFileHash !== "string" || !/^[0-9a-f]{64}$/.test(sessionFileHash))
    ) {
      throw protocolError("Grok Bot binding sessionFileHash is invalid");
    }
    return { sessionId, ...(sessionFileHash ? { sessionFileHash } : {}) };
  } catch (error) {
    logger.debug({ code: "binding_invalid", error: String(error) }, "Grok Bot binding was rejected");
    throw new AgentRuntimeError("binding_incompatible", (error as Error).message, { cause: error });
  }
}

function parseModel(value: unknown): { readonly id: string; readonly provider: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const model = requireRecord(value, "Grok Bot get_state model is invalid");
  return {
    id: requireString(model.id, "Grok Bot get_state model has no id"),
    provider: requireString(model.provider, "Grok Bot get_state model has no provider"),
  };
}

function parseUsage(value: unknown): AgentUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const result: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } = {};
  const input = isNonNegativeNumber(usage.input) ? usage.input : undefined;
  const cacheWrite = isNonNegativeNumber(usage.cacheWrite) ? usage.cacheWrite : undefined;
  if (input !== undefined || cacheWrite !== undefined) {
    result.inputTokens = addTokenCounts(input, cacheWrite, "input");
  }
  if (isNonNegativeNumber(usage.cacheRead)) result.cachedInputTokens = usage.cacheRead;
  if (isNonNegativeNumber(usage.output)) result.outputTokens = usage.output;
  return hasUsage(result) ? result : undefined;
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  const inputTokens = addTokenCounts(left.inputTokens, right.inputTokens, "input");
  const cachedInputTokens = addTokenCounts(left.cachedInputTokens, right.cachedInputTokens, "cached input");
  const outputTokens = addTokenCounts(left.outputTokens, right.outputTokens, "output");
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function addTokenCounts(left: number | undefined, right: number | undefined, field: string): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  const total = (left ?? 0) + (right ?? 0);
  if (!Number.isSafeInteger(total)) throw protocolError(`Grok Bot ${field} token usage overflowed`);
  return total;
}

function hasUsage(usage: AgentUsage): boolean {
  return usage.inputTokens !== undefined || usage.cachedInputTokens !== undefined || usage.outputTokens !== undefined;
}

function isIrrecoverableGrokBotFailure(error: Error): boolean {
  return error instanceof AgentProviderError || (error instanceof GrokBotRpcError && error.code !== "command");
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function requireIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError("Grok Bot content index is invalid");
  return value as number;
}

function requireUuid(value: unknown, field: string): string {
  const result = requireString(value, `${field} must be a UUID`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw protocolError(`${field} must be a UUID`);
  }
  return result;
}

const GROK_BOT_RPC_EVENT_STRING_MAX_BYTES = 8 * 1024 * 1024;

function requireString(value: unknown, message: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > GROK_BOT_RPC_EVENT_STRING_MAX_BYTES
  ) {
    throw protocolError(message);
  }
  return value;
}

function requireArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError(message);
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw protocolError(message);
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  assertJsonValue(value, "Grok Bot event payload");
  return value as JsonValue;
}

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError("provider_protocol_error", message);
}

function grokBotFailedStopMessage(stopReason: string): string {
  if (stopReason === "length") return "Grok Bot stopped because the model reached its output limit";
  if (stopReason === "toolUse") return "Grok Bot stopped with unfinished tool use";
  return "Grok Bot model request failed";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireNonNegativeSafeInteger(value: unknown, message: string): number {
  if (!isNonNegativeNumber(value)) throw protocolError(message);
  return value;
}

function requireAbsolutePath(value: unknown, message: string): string {
  const path = requireString(value, message);
  if (!isAbsolute(path)) throw protocolError(message);
  return path;
}

function requireStopReason(value: unknown, message: string): string {
  const stopReason = requireString(value, message);
  if (!GROK_BOT_STOP_REASONS.has(stopReason)) throw protocolError(message);
  return stopReason;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
