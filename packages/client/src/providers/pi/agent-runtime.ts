import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { BaseAgentRuntime } from "../../agent-runtime/base-agent-runtime.js";
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
import { assertBinding, assertJsonValue } from "../../agent-runtime/validation.js";
import { type PiRpcClient, PiRpcError, PiRpcProcess, type PiRpcProcessSpawnOptions } from "./rpc-wire.js";

const execFileAsync = promisify(execFile);
const PI_BINDING_SCHEMA_VERSION = 1;
const PI_PROVIDER_ID = "pi";
const PI_MINIMUM_VERSION = [0, 80, 6] as const;
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const PI_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const PI_RESOURCE_DISABLE_ARGUMENTS = [
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
] as const;

export const PI_AGENT_RUNTIME_MANIFEST: AgentRuntimeManifest = Object.freeze({
  providerId: PI_PROVIDER_ID,
  displayName: "Pi",
  contractVersion: AGENT_RUNTIME_CONTRACT_VERSION,
  bindingSchemaVersion: PI_BINDING_SCHEMA_VERSION,
});

interface PiProviderConfiguration {
  readonly appendSystemPrompt?: string;
  readonly sessionName?: string;
}

interface PiRuntimeOptions {
  readonly binding: AgentRuntimeBinding;
  readonly configuration?: AgentRunConfiguration;
  readonly createClient: (args: readonly string[]) => PiRpcClient;
  readonly eventSink: AgentRuntimeEventSink;
  readonly policy: AgentRuntimePolicy;
  readonly resume: boolean;
  readonly sessionDirectory?: string;
}

export interface PiAgentRuntimeFactoryOptions {
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
      options: PiRpcProcessSpawnOptions,
    ) => ChildProcessWithoutNullStreams;
  };
  readonly createClient?: (cwd: string, args: readonly string[]) => PiRpcClient;
  readonly createSessionId?: () => string;
  readonly probeRunner?: () => Promise<{
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

interface PiTerminal {
  readonly error?: string;
  readonly status: "aborted" | "completed" | "failed";
  readonly stopReason: string;
}

interface PiTextBlock {
  readonly id: string;
  completed: boolean;
  text: string;
}

interface PiAssistantMessage {
  readonly blocks: Map<number, PiTextBlock>;
  readonly id: string;
}

interface PiTool {
  readonly name: string;
}

export class PiAgentRuntime extends BaseAgentRuntime {
  readonly #sessionId: string;
  readonly #policy: AgentRuntimePolicy;
  readonly #configuration?: AgentRunConfiguration;
  readonly #sessionDirectory?: string;
  readonly #createClient: (args: readonly string[]) => PiRpcClient;
  readonly #tools = new Map<string, PiTool>();
  #client?: PiRpcClient;
  #unsubscribe?: () => void;
  #context?: AgentProviderRunContext;
  #eventTail: Promise<void> = Promise.resolve();
  #terminal?: Deferred<PiTerminal>;
  #promptAccepted?: Deferred<void>;
  #providerFailure?: Error;
  #currentTurnId?: string;
  #currentAssistant?: PiAssistantMessage;
  #turnSequence = 0;
  #assistantSequence = 0;
  #lastText?: string;
  #lastStopReason?: string;
  #lastError?: string;
  #model?: { readonly id: string; readonly provider: string };
  #usage: AgentUsage = {};
  #sessionExists: boolean;
  #sessionFileHash?: string;
  #terminalClaimed = false;

  constructor(options: PiRuntimeOptions) {
    super({
      manifest: PI_AGENT_RUNTIME_MANIFEST,
      capabilities: { steer: "supported", interactions: "unsupported" },
      eventSink: options.eventSink,
      binding: options.binding,
    });
    const binding = parsePiBinding(options.binding);
    this.#sessionId = binding.sessionId;
    this.#sessionFileHash = binding.sessionFileHash;
    this.#policy = options.policy;
    this.#configuration = options.configuration;
    this.#sessionDirectory = options.sessionDirectory;
    this.#createClient = options.createClient;
    this.#sessionExists = options.resume;
  }

  protected async executeRun(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
  ): Promise<AgentProviderRunResult> {
    this.#resetRun(context);
    let client: PiRpcClient | undefined;
    try {
      client = this.#createClient(this.#arguments(request));
      this.#client = client;
      this.#unsubscribe = client.subscribe((message) => this.#enqueue(message));
      const state = requireRecord(
        await client.request({ type: "get_state" }, context.signal),
        "Pi get_state returned invalid data",
      );
      const sessionId = requireUuid(state.sessionId, "Pi get_state sessionId");
      if (sessionId !== this.#sessionId) throw protocolError("Pi opened another session");
      const sessionFile = requireAbsolutePath(state.sessionFile, "Pi get_state sessionFile is not absolute");
      const messageCount = requireNonNegativeSafeInteger(state.messageCount, "Pi get_state messageCount is invalid");
      const sessionFileHash = fingerprint(sessionFile);
      if (!this.#sessionExists && messageCount !== 0) {
        throw protocolError("Pi create opened an existing conversation");
      }
      if (this.#sessionFileHash && this.#sessionFileHash !== sessionFileHash) {
        throw protocolError("Pi opened another session file");
      }
      if (!this.#sessionFileHash) {
        this.#sessionFileHash = sessionFileHash;
        await context.updateBinding(piBinding(this.#sessionId, sessionFileHash));
      }
      this.#sessionExists = true;
      this.#model = parseModel(state.model);
      await client.request({ type: "prompt", message: piInput(request) }, context.signal);
      this.#promptAccepted?.resolve();
      const terminal = await this.#terminal?.promise;
      /* v8 ignore next -- resetRun always creates the terminal before Provider I/O begins. */
      if (!terminal) throw protocolError("Pi run has no terminal state");
      await this.#eventTail;
      if (this.#providerFailure) throw this.#providerFailure;
      return this.#runResult(terminal);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Pi run failed");
      this.#promptAccepted?.reject(failure);
      const causalFailure = this.#providerFailure ?? failure;
      if (!context.signal.aborted && isIrrecoverablePiFailure(causalFailure)) this.closeForProviderFailure();
      if (causalFailure instanceof AgentProviderError) throw causalFailure;
      throw new AgentProviderError(
        causalFailure instanceof PiRpcError && causalFailure.code === "protocol"
          ? "provider_protocol_error"
          : "provider_error",
        causalFailure.message,
        { cause: causalFailure },
      );
      /* v8 ignore next -- finally is mandatory cleanup; V8 reports a synthetic branch for its closing token. */
    } finally {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      await client?.close().catch(() => undefined);
      this.#client = undefined;
      this.#context = undefined;
      this.#terminal = undefined;
      this.#promptAccepted = undefined;
      this.#currentTurnId = undefined;
      this.#currentAssistant = undefined;
      this.#tools.clear();
    }
  }

  protected async steerProvider(request: AgentSteerRequest): Promise<void> {
    /* v8 ignore next -- BaseAgentRuntime admits steer only while executeRun owns an active prompt. */
    if (!this.#promptAccepted) throw new AgentRuntimeError("run_mismatch", "there is no active Pi prompt");
    await this.#promptAccepted.promise;
    const client = this.#client;
    /* v8 ignore next -- the client remains owned until the active Provider Run leaves executeRun. */
    if (!client) throw new AgentRuntimeError("run_mismatch", "there is no active Pi process");
    await client.request({ type: "steer", message: piItems(request.input.items) });
  }

  protected async abortProvider(_request: AgentAbortRequest): Promise<void> {
    if (this.#terminalClaimed) return;
    await this.#client?.request({ type: "abort" }, AbortSignal.timeout(2_000));
  }

  protected async closeProvider(): Promise<void> {
    await this.#client?.close();
  }

  #resetRun(context: AgentProviderRunContext): void {
    this.#context = context;
    this.#eventTail = Promise.resolve();
    this.#terminal = deferred<PiTerminal>();
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
      ...PI_RESOURCE_DISABLE_ARGUMENTS,
      "--session-id",
      this.#sessionId,
      ...(this.#sessionDirectory ? ["--session-dir", this.#sessionDirectory] : []),
      ...piPolicyArguments(this.#policy),
      ...(configuration?.model ? ["--model", configuration.model] : []),
      ...(configuration?.reasoningEffort ? ["--thinking", configuration.reasoningEffort] : []),
      ...(provider.appendSystemPrompt ? ["--append-system-prompt", provider.appendSystemPrompt] : []),
      ...(provider.sessionName ? ["--name", provider.sessionName] : []),
    ];
  }

  #enqueue(message: Readonly<Record<string, unknown>>): void {
    this.#claimTerminalAtIngress(message);
    const next = this.#eventTail.then(async () => {
      /* v8 ignore next -- unsubscribe detaches the only event source before Run context cleanup. */
      if (!this.#context) return;
      await this.#handleMessage(message);
    });
    this.#eventTail = next.catch((error: unknown) => {
      this.#failProvider(error instanceof Error ? error : protocolError("Pi event processing failed"));
    });
  }

  #claimTerminalAtIngress(message: Readonly<Record<string, unknown>>): void {
    if (message.type !== "agent_settled" || !this.#context) return;
    this.#context.claimTerminal();
    this.#terminalClaimed = true;
  }

  async #handleMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    const type = requireString(message.type, "Pi event has no type");
    if (type === "opentag/process_error") {
      throw message.error instanceof Error
        ? message.error
        : new AgentProviderError("provider_error", "Pi process failed");
    }
    if (type === "extension_ui_request") {
      throw protocolError("Pi requested extension UI while extensions are disabled");
    }
    if (type === "agent_start") return;
    if (type === "turn_start") {
      if (this.#currentTurnId) throw protocolError("Pi started overlapping turns");
      this.#turnSequence += 1;
      this.#currentTurnId = `pi-turn-${this.#turnSequence}`;
      await this.#requireContext().emit({ type: "model_turn_started", modelTurnId: this.#currentTurnId });
      return;
    }
    if (type === "turn_end") {
      const turnId = this.#currentTurnId;
      if (!turnId) throw protocolError("Pi ended a turn that was not active");
      if (this.#currentAssistant || this.#tools.size > 0) {
        throw protocolError("Pi ended a turn with unfinished child events");
      }
      await this.#requireContext().emit({ type: "model_turn_completed", modelTurnId: turnId });
      this.#currentTurnId = undefined;
      return;
    }
    if (type === "message_start") {
      this.#requireActiveTurn("Pi started a message outside an active turn");
      await this.#startMessage(requireRecord(message.message, "Pi message_start has no message"));
      return;
    }
    if (type === "message_update") {
      this.#requireActiveTurn("Pi updated a message outside an active turn");
      await this.#updateMessage(requireRecord(message.assistantMessageEvent, "Pi message_update has no delta"));
      return;
    }
    if (type === "message_end") {
      this.#requireActiveTurn("Pi ended a message outside an active turn");
      await this.#endMessage(requireRecord(message.message, "Pi message_end has no message"));
      return;
    }
    if (type === "tool_execution_start") {
      this.#requireActiveTurn("Pi started a tool outside an active turn");
      await this.#startTool(message);
      return;
    }
    if (type === "tool_execution_update") {
      this.#requireActiveTurn("Pi updated a tool outside an active turn");
      await this.#updateTool(message);
      return;
    }
    if (type === "tool_execution_end") {
      this.#requireActiveTurn("Pi ended a tool outside an active turn");
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
        code: "pi_extension_error",
        message: typeof message.error === "string" ? message.error : "Pi extension failed",
      });
      return;
    }
    if (type === "auto_retry_start") {
      await this.#requireContext().emit({
        type: "provider_warning",
        code: "pi_auto_retry",
        message: typeof message.errorMessage === "string" ? message.errorMessage : "Pi is retrying the model request",
      });
      return;
    }
    await this.#emitProviderEvent(message);
  }

  async #startMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (message.role !== "assistant") return;
    if (this.#currentAssistant) throw protocolError("Pi started overlapping assistant messages");
    this.#assistantSequence += 1;
    this.#currentAssistant = { id: `pi-message-${this.#assistantSequence}`, blocks: new Map() };
  }

  #requireActiveTurn(message: string): void {
    if (!this.#currentTurnId) throw protocolError(message);
  }

  async #updateMessage(update: Readonly<Record<string, unknown>>): Promise<void> {
    const current = this.#currentAssistant;
    if (!current) throw protocolError("Pi emitted an assistant update without an active message");
    const type = requireString(update.type, "Pi assistant update has no type");
    if (type === "text_start") {
      const index = requireIndex(update.contentIndex);
      if (current.blocks.has(index)) throw protocolError("Pi reused a text content index");
      const block = { id: `${current.id}:text:${index}`, text: "", completed: false };
      current.blocks.set(index, block);
      await this.#requireContext().emit({ type: "message_started", messageId: block.id });
      return;
    }
    if (type === "text_delta") {
      const block = current.blocks.get(requireIndex(update.contentIndex));
      if (!block || block.completed) throw protocolError("Pi text delta has no active content block");
      const delta = requireString(update.delta, "Pi text delta has no text", true);
      block.text += delta;
      await this.#requireContext().emit({ type: "message_delta", messageId: block.id, delta });
      return;
    }
    if (type === "text_end") {
      const block = current.blocks.get(requireIndex(update.contentIndex));
      if (!block || block.completed) throw protocolError("Pi text end has no active content block");
      const text = requireString(update.content, "Pi text end has no text", true);
      if (block.text !== text) throw protocolError("Pi text stream does not match its completed content");
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
      if (type === "done") requireStopReason(update.reason, "Pi assistant done reason is invalid");
      await this.#emitProviderEvent({ type: "assistant_update", updateType: type });
      return;
    }
    if (type.startsWith("thinking_")) {
      const contentIndex = requireIndex(update.contentIndex);
      if (type === "thinking_delta") requireString(update.delta, "Pi thinking delta has no text", true);
      else if (type === "thinking_end") requireString(update.content, "Pi thinking end has no text", true);
      else if (type !== "thinking_start") throw protocolError("Pi assistant thinking update is unsupported");
      await this.#emitProviderEvent({ type: "assistant_update", updateType: type, contentIndex });
      return;
    }
    if (type.startsWith("toolcall_")) {
      const contentIndex = requireIndex(update.contentIndex);
      if (type === "toolcall_delta") requireString(update.delta, "Pi tool-call delta has no text", true);
      else if (type === "toolcall_end") requireRecord(update.toolCall, "Pi tool-call end has no tool call");
      else if (type !== "toolcall_start") throw protocolError("Pi assistant tool-call update is unsupported");
      await this.#emitProviderEvent({ type: "assistant_update", updateType: type, contentIndex });
      return;
    }
    throw protocolError("Pi assistant update type is unsupported");
  }

  async #endMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (message.role !== "assistant") return;
    const current = this.#currentAssistant;
    if (!current) throw protocolError("Pi ended an assistant message that was not active");
    const content = requireArray(message.content, "Pi assistant content is invalid");
    const textParts: string[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const item = requireRecord(content[index], "Pi assistant content block is invalid");
      if (item.type !== "text") continue;
      const text = requireString(item.text, "Pi assistant text block has no text", true);
      textParts.push(text);
      let block = current.blocks.get(index);
      if (!block) {
        block = { id: `${current.id}:text:${index}`, text, completed: true };
        current.blocks.set(index, block);
        await this.#requireContext().emit({ type: "message_started", messageId: block.id });
        if (text) await this.#requireContext().emit({ type: "message_delta", messageId: block.id, delta: text });
        await this.#requireContext().emit({ type: "message_completed", messageId: block.id, text });
      } else if (!block.completed || block.text !== text) {
        throw protocolError("Pi completed assistant content does not match its text stream");
      }
    }
    this.#lastText = textParts.join("\n");
    this.#lastStopReason = requireStopReason(message.stopReason, "Pi assistant message has invalid stop reason");
    if (typeof message.errorMessage === "string") this.#lastError = message.errorMessage;
    const usage = parseUsage(message.usage);
    if (usage) {
      this.#usage = addUsage(this.#usage, usage);
      await this.#requireContext().emit({ type: "usage_updated", usage: this.#usage });
    }
    this.#currentAssistant = undefined;
  }

  async #startTool(message: Readonly<Record<string, unknown>>): Promise<void> {
    const toolCallId = requireString(message.toolCallId, "Pi tool start has no toolCallId");
    if (this.#tools.has(toolCallId)) throw protocolError("Pi reused an active toolCallId");
    const name = requireString(message.toolName, "Pi tool start has no toolName");
    this.#tools.set(toolCallId, { name });
    await this.#requireContext().emit({
      type: "tool_started",
      toolCallId,
      name,
      ...(message.args !== undefined ? { input: toJsonValue(message.args) } : {}),
    });
  }

  async #updateTool(message: Readonly<Record<string, unknown>>): Promise<void> {
    const toolCallId = requireString(message.toolCallId, "Pi tool update has no toolCallId");
    if (!this.#tools.has(toolCallId)) throw protocolError("Pi tool update has no active tool");
    await this.#requireContext().emit({
      type: "tool_updated",
      toolCallId,
      update: toJsonValue(message.partialResult ?? {}),
    });
  }

  async #endTool(message: Readonly<Record<string, unknown>>): Promise<void> {
    const toolCallId = requireString(message.toolCallId, "Pi tool end has no toolCallId");
    const tool = this.#tools.get(toolCallId);
    if (!tool) throw protocolError("Pi tool end has no active tool");
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
      throw protocolError("Pi settled with unfinished protocol state");
    }
    const stopReason = this.#lastStopReason;
    if (!stopReason) throw protocolError("Pi settled without an assistant result");
    const status = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
    this.#terminal?.resolve({
      status,
      stopReason,
      ...(this.#lastError ? { error: this.#lastError } : {}),
    });
  }

  #runResult(terminal: PiTerminal): AgentProviderRunResult {
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
        error: { code: "run_aborted", message: terminal.error ?? "Pi run was aborted" },
        diagnostics,
      };
    }
    return {
      status: "failed",
      output,
      ...(usage ? { usage } : {}),
      error: { code: "provider_error", message: terminal.error ?? "Pi model request failed" },
      diagnostics,
    };
  }

  async #emitProviderEvent(payload: JsonValue | Readonly<Record<string, unknown>>): Promise<void> {
    await this.#requireContext().emit({
      type: "provider_event",
      providerId: PI_PROVIDER_ID,
      schemaVersion: 1,
      payload: toJsonValue(payload),
    });
  }

  #requireContext(): AgentProviderRunContext {
    /* v8 ignore next -- the serial event queue drops events after the active Run context is cleared. */
    if (!this.#context) throw protocolError("Pi event arrived without an active run");
    return this.#context;
  }

  #failProvider(error: Error): void {
    /* v8 ignore next -- the serial event queue records only the first causal Provider failure. */
    if (this.#providerFailure) return;
    this.#providerFailure = error;
    this.#terminal?.reject(error);
    this.#promptAccepted?.reject(error);
    void this.#client?.close().catch(() => undefined);
    this.closeForProviderFailure();
  }
}

export class PiAgentRuntimeFactory implements AgentRuntimeFactory {
  readonly manifest = PI_AGENT_RUNTIME_MANIFEST;
  readonly #createSessionId: () => string;
  readonly #createClient: (cwd: string, args: readonly string[]) => PiRpcClient;
  readonly #probeRunner: () => Promise<{
    readonly credential: boolean;
    readonly rpc: boolean;
    readonly version: string;
  }>;
  readonly #sessionDirectory?: string;

  constructor(options: PiAgentRuntimeFactoryOptions = {}) {
    this.#createSessionId = options.createSessionId ?? randomUUID;
    const environment = piAgentRuntimeEnvironment(options.process?.env ?? process.env);
    const command = options.process?.command ?? "pi";
    const prefix = options.process?.args ?? [];
    const sessionDirectory = options.process?.sessionDirectory;
    if (sessionDirectory && !isAbsolute(sessionDirectory)) {
      throw new AgentRuntimeError("configuration_invalid", "Pi sessionDirectory must be absolute");
    }
    this.#sessionDirectory = sessionDirectory;
    this.#createClient =
      options.createClient ??
      ((cwd, args) =>
        new PiRpcProcess({
          command,
          args: [...prefix, ...args],
          cwd,
          env: environment,
          maxLineBytes: options.process?.maxLineBytes,
          maxStderrBytes: options.process?.maxStderrBytes,
          requestTimeoutMs: options.process?.requestTimeoutMs,
          spawnProcess: options.process?.spawnProcess,
        }));
    this.#probeRunner = options.probeRunner ?? (() => probePi(command, environment));
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
      const result = await this.#probeRunner();
      version = result.version;
      if (!result.rpc) issues.push({ code: "version_incompatible", message: "Pi RPC mode is unavailable" });
      if (!result.credential)
        issues.push({ code: "credential_missing", message: "Pi has no configured model credential" });
    } catch {
      issues.push({ code: "artifact_missing", message: "Pi CLI could not be executed" });
    }
    return { ready: issues.length === 0, ...(version ? { version } : {}), issues };
  }

  create(request: CreateAgentRuntimeRequest): Promise<PiAgentRuntime> {
    return this.#open(request, "create");
  }

  resume(request: ResumeAgentRuntimeRequest): Promise<PiAgentRuntime> {
    return this.#open(request, "resume");
  }

  async #open(
    request: CreateAgentRuntimeRequest | ResumeAgentRuntimeRequest,
    mode: "create" | "resume",
  ): Promise<PiAgentRuntime> {
    validateFactoryRequest(request);
    validateConfiguration(request.configuration);
    const binding =
      mode === "resume" && "binding" in request
        ? request.binding
        : piBinding(requireUuid(this.#createSessionId(), "generated Pi session id"));
    assertBinding(binding, this.manifest);
    const parsedBinding = parsePiBinding(binding);
    if (mode === "resume" && !parsedBinding.sessionFileHash) {
      throw new AgentRuntimeError("binding_incompatible", "Pi binding does not identify a materialized session");
    }
    try {
      await request.eventSink({ type: "binding_changed", binding });
      return new PiAgentRuntime({
        binding,
        configuration: request.configuration,
        createClient: (args) => this.#createClient(request.workspace.cwd, args),
        eventSink: request.eventSink,
        policy: request.policy,
        resume: mode === "resume",
        sessionDirectory: this.#sessionDirectory,
      });
    } catch (error) {
      throw new AgentRuntimeError(mode === "create" ? "create_failed" : "resume_failed", `Pi ${mode} failed`, {
        cause: error,
      });
    }
  }
}

export function piAgentRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const exact = new Set([
    "AI_GATEWAY_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANT_LING_API_KEY",
    "APPDATA",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    "AZURE_OPENAI_RESOURCE_NAME",
    "CEREBRAS_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_GATEWAY_ID",
    "COMSPEC",
    "DEEPSEEK_API_KEY",
    "FIREWORKS_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GROQ_API_KEY",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "KIMI_API_KEY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "LOGNAME",
    "MINIMAX_API_KEY",
    "MISTRAL_API_KEY",
    "MOONSHOT_API_KEY",
    "NODE_EXTRA_CA_CERTS",
    "NVIDIA_API_KEY",
    "OPENCODE_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "PATH",
    "PATHEXT",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "PI_OFFLINE",
    "PI_PACKAGE_DIR",
    "PI_SHARE_VIEWER_URL",
    "PI_TELEMETRY",
    "QWEN_TOKEN_PLAN_API_KEY",
    "QWEN_TOKEN_PLAN_CN_API_KEY",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TOGETHER_API_KEY",
    "USER",
    "USERPROFILE",
    "WINDIR",
    "XAI_API_KEY",
    "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "http_proxy",
    "https_proxy",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || key.startsWith("AWS_"))) environment[key] = value;
  }
  return environment;
}

async function probePi(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly credential: boolean; readonly rpc: boolean; readonly version: string }> {
  const execution = { encoding: "utf8" as const, env: environment, timeout: 5_000, windowsHide: true };
  const versionResult = await execFileAsync(command, ["--version"], execution);
  const version = versionResult.stdout.trim();
  let help = "";
  try {
    help = (await execFileAsync(command, ["--help"], execution)).stdout;
  } catch {
    help = "";
  }
  const requiredOptions = [
    "--mode",
    "rpc",
    "--session-id",
    "--session-dir",
    ...PI_RESOURCE_DISABLE_ARGUMENTS,
    "--tools",
    "--model",
    "--thinking",
    "--append-system-prompt",
    "--name",
  ];
  const rpc = supportsPiProtocol(version) && requiredOptions.every((token) => help.includes(token));
  let credential = false;
  try {
    const models = await execFileAsync(command, [...PI_RESOURCE_DISABLE_ARGUMENTS, "--list-models"], execution);
    credential = models.stdout.trim().split(/\r?\n/).length > 1;
  } catch {
    credential = false;
  }
  return { credential, rpc, version };
}

function supportsPiProtocol(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  if (actual.some((part) => !Number.isSafeInteger(part))) return false;
  const firstDifference = actual.findIndex((part, index) => part !== PI_MINIMUM_VERSION[index]);
  return (
    firstDifference === -1 || (actual[firstDifference] as number) > (PI_MINIMUM_VERSION[firstDifference] as number)
  );
}

function validateFactoryRequest(request: CreateAgentRuntimeRequest): void {
  if (!request || typeof request !== "object" || typeof request.eventSink !== "function") {
    throw new AgentRuntimeError("configuration_invalid", "eventSink is required");
  }
  if (!request.workspace || !isAbsolute(request.workspace.cwd)) {
    throw new AgentRuntimeError("configuration_invalid", "workspace.cwd must be absolute");
  }
  for (const root of request.workspace.writableRoots ?? []) {
    if (!isAbsolute(root)) throw new AgentRuntimeError("configuration_invalid", "writable roots must be absolute");
  }
  if (request.policy.approvals !== "never") {
    throw new AgentRuntimeError("configuration_invalid", "Pi requires approvals=never because it has no approval gate");
  }
  if (request.policy.fileSystem === "workspace-write") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Pi cannot confine writes to workspace roots without a sandbox",
    );
  }
  if (request.policy.fileSystem === "read-only" && (request.workspace.writableRoots?.length ?? 0) > 0) {
    throw new AgentRuntimeError("configuration_invalid", "read-only policy cannot have writable roots");
  }
  if (request.hostedTools !== undefined) {
    throw new AgentRuntimeError("configuration_invalid", "Pi RPC does not implement common hosted tools");
  }
  validateToolPolicy(request.policy);
}

function validateToolPolicy(policy: AgentRuntimePolicy): void {
  if (policy.tools.mode === "allow-list") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Pi RPC does not implement the common hosted-tool allow-list contract",
    );
  }
  if (
    policy.fileSystem === "unrestricted" &&
    policy.network === "disabled" &&
    policy.tools.mode === "provider-default"
  ) {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Pi provider-default tools include unrestricted bash network access",
    );
  }
}

function validateConfiguration(configuration: AgentRunConfiguration | undefined): void {
  if (!configuration) return;
  if (configuration.model !== undefined && configuration.model.trim().length === 0) {
    throw new AgentRuntimeError("configuration_invalid", "model must be non-empty");
  }
  if (configuration.reasoningEffort && !PI_THINKING_LEVELS.has(configuration.reasoningEffort)) {
    throw new AgentRuntimeError("configuration_invalid", "Pi thinking level is unsupported");
  }
  parseProviderConfiguration(configuration.provider);
}

function parseProviderConfiguration(value: JsonValue | undefined): PiProviderConfiguration {
  if (value === undefined) return {};
  assertJsonValue(value, "configuration.provider");
  const object = record(value);
  if (!object) throw new AgentRuntimeError("configuration_invalid", "Pi provider configuration must be an object");
  const allowed = new Set(["appendSystemPrompt", "sessionName"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key))
      throw new AgentRuntimeError("configuration_invalid", `unknown Pi configuration field: ${key}`);
  }
  const appendSystemPrompt = boundedConfigurationString(object.appendSystemPrompt, "appendSystemPrompt");
  const sessionName = boundedConfigurationString(object.sessionName, "sessionName", 4_096);
  return {
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
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
    throw new AgentRuntimeError("configuration_invalid", `Pi ${field} must be a non-empty bounded string`);
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

function piPolicyArguments(policy: AgentRuntimePolicy): readonly string[] {
  if (policy.fileSystem === "read-only") {
    return ["--tools", PI_READ_ONLY_TOOLS.join(",")];
  }
  return [];
}

function piInput(request: AgentPromptRequest): string {
  return piItems(request.input.items);
}

function piItems(items: readonly { readonly text: string }[]): string {
  return items.map((item) => item.text).join("\n");
}

function piBinding(sessionId: string, sessionFileHash?: string): AgentRuntimeBinding {
  return {
    providerId: PI_PROVIDER_ID,
    schemaVersion: PI_BINDING_SCHEMA_VERSION,
    payload: { sessionId, ...(sessionFileHash ? { sessionFileHash } : {}) },
  };
}

function parsePiBinding(binding: AgentRuntimeBinding): {
  readonly sessionFileHash?: string;
  readonly sessionId: string;
} {
  const payload = record(binding.payload);
  if (!payload) throw new AgentRuntimeError("binding_incompatible", "Pi binding payload is invalid");
  for (const key of Object.keys(payload)) {
    if (key !== "sessionId" && key !== "sessionFileHash") {
      throw new AgentRuntimeError("binding_incompatible", `Pi binding field is unsupported: ${key}`);
    }
  }
  try {
    const sessionId = requireUuid(payload.sessionId, "Pi binding sessionId");
    const sessionFileHash = payload.sessionFileHash;
    if (
      sessionFileHash !== undefined &&
      (typeof sessionFileHash !== "string" || !/^[0-9a-f]{64}$/.test(sessionFileHash))
    ) {
      throw protocolError("Pi binding sessionFileHash is invalid");
    }
    return { sessionId, ...(sessionFileHash ? { sessionFileHash } : {}) };
  } catch (error) {
    throw new AgentRuntimeError("binding_incompatible", (error as Error).message, { cause: error });
  }
}

function parseModel(value: unknown): { readonly id: string; readonly provider: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const model = requireRecord(value, "Pi get_state model is invalid");
  return {
    id: requireString(model.id, "Pi get_state model has no id"),
    provider: requireString(model.provider, "Pi get_state model has no provider"),
  };
}

function parseUsage(value: unknown): AgentUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const result: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } = {};
  if (isNonNegativeNumber(usage.input)) result.inputTokens = usage.input;
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
  if (!Number.isSafeInteger(total)) throw protocolError(`Pi ${field} token usage overflowed`);
  return total;
}

function hasUsage(usage: AgentUsage): boolean {
  return usage.inputTokens !== undefined || usage.cachedInputTokens !== undefined || usage.outputTokens !== undefined;
}

function isIrrecoverablePiFailure(error: Error): boolean {
  return error instanceof AgentProviderError || (error instanceof PiRpcError && error.code !== "command");
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
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError("Pi content index is invalid");
  return value as number;
}

function requireUuid(value: unknown, field: string): string {
  const result = requireString(value, `${field} must be a UUID`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw protocolError(`${field} must be a UUID`);
  }
  return result;
}

function requireString(value: unknown, message: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > PI_RPC_EVENT_STRING_MAX_BYTES
  ) {
    throw protocolError(message);
  }
  return value;
}

const PI_RPC_EVENT_STRING_MAX_BYTES = 8 * 1024 * 1024;

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
  assertJsonValue(value, "Pi event payload");
  return value as JsonValue;
}

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError("provider_protocol_error", message);
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
  if (!PI_STOP_REASONS.has(stopReason)) throw protocolError(message);
  return stopReason;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
