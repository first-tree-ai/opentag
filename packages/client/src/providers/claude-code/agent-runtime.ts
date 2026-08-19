import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { BaseAgentRuntime } from "../../agent-runtime/base-agent-runtime.js";
import { AgentProviderError, AgentRuntimeError } from "../../agent-runtime/errors.js";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
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
  type AgentRuntimeWorkspace,
  type CreateAgentRuntimeRequest,
  type JsonValue,
  type ResumeAgentRuntimeRequest,
} from "../../agent-runtime/types.js";
import { assertBinding, assertJsonValue } from "../../agent-runtime/validation.js";
import { ClaudeCodeProcess, type ClaudeCodeProcessClient, type ClaudeCodeProcessSpawnOptions } from "./process-wire.js";

const execFileAsync = promisify(execFile);
const CLAUDE_CODE_BINDING_SCHEMA_VERSION = 1;
const CLAUDE_CODE_PROVIDER_ID = "claude-code";
const CLAUDE_CODE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultracode"]);
const CLAUDE_CODE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
const CLAUDE_CODE_NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

export const CLAUDE_CODE_AGENT_RUNTIME_MANIFEST: AgentRuntimeManifest = Object.freeze({
  providerId: CLAUDE_CODE_PROVIDER_ID,
  displayName: "Claude Code",
  contractVersion: AGENT_RUNTIME_CONTRACT_VERSION,
  bindingSchemaVersion: CLAUDE_CODE_BINDING_SCHEMA_VERSION,
});

interface ClaudeCodeProviderConfiguration {
  readonly appendSystemPrompt?: string;
  readonly maxBudgetUsd?: number;
  readonly maxTurns?: number;
}

interface ClaudeCodeRuntimeOptions {
  readonly binding: AgentRuntimeBinding;
  readonly configuration?: AgentRunConfiguration;
  readonly createProcess: (args: readonly string[]) => ClaudeCodeProcessClient;
  readonly eventSink: AgentRuntimeEventSink;
  readonly resume: boolean;
  readonly workspace: AgentRuntimeWorkspace;
  readonly policy: AgentRuntimePolicy;
}

export interface ClaudeCodeAgentRuntimeFactoryOptions {
  readonly process?: {
    readonly args?: readonly string[];
    readonly command?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly maxLineBytes?: number;
    readonly maxStderrBytes?: number;
    readonly spawnProcess?: (
      command: string,
      args: readonly string[],
      options: ClaudeCodeProcessSpawnOptions,
    ) => ChildProcessWithoutNullStreams;
  };
  readonly createProcess?: (cwd: string, args: readonly string[]) => ClaudeCodeProcessClient;
  readonly createSessionId?: () => string;
  readonly probeRunner?: () => Promise<{
    readonly credential: boolean;
    readonly streamJson: boolean;
    readonly version: string;
  }>;
}

interface ClaudeCodeTerminal {
  readonly errors: readonly string[];
  readonly isError: boolean;
  readonly numTurns?: number;
  readonly permissionDenials: readonly Record<string, unknown>[];
  readonly result?: string;
  readonly sessionId: string;
  readonly stopReason?: string;
  readonly subtype: string;
  readonly totalCostUsd?: number;
  readonly usage?: {
    readonly cachedInputTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

interface TextBlockState {
  readonly id: string;
  completed: boolean;
  started: boolean;
  text: string;
}

interface ToolState {
  readonly name: string;
}

export class ClaudeCodeAgentRuntime extends BaseAgentRuntime {
  readonly #sessionId: string;
  readonly #workspace: AgentRuntimeWorkspace;
  readonly #policy: AgentRuntimePolicy;
  readonly #configuration?: AgentRunConfiguration;
  readonly #createProcess: (args: readonly string[]) => ClaudeCodeProcessClient;
  readonly #textBlocks = new Map<string, TextBlockState>();
  readonly #tools = new Map<string, ToolState>();
  readonly #toolBlocks = new Map<string, string>();
  readonly #startedModelTurns = new Set<string>();
  readonly #completedModelTurns = new Set<string>();
  #process?: ClaudeCodeProcessClient;
  #context?: AgentProviderRunContext;
  #eventTail: Promise<void> = Promise.resolve();
  #terminal?: ClaudeCodeTerminal;
  #providerFailure?: Error;
  #currentMessageId?: string;
  #sessionExists: boolean;
  #terminalClaimed = false;

  constructor(options: ClaudeCodeRuntimeOptions) {
    super({
      manifest: CLAUDE_CODE_AGENT_RUNTIME_MANIFEST,
      capabilities: { steer: "unsupported", interactions: "unsupported" },
      eventSink: options.eventSink,
      binding: options.binding,
    });
    this.#sessionId = parseClaudeCodeBinding(options.binding);
    this.#workspace = options.workspace;
    this.#policy = options.policy;
    this.#configuration = options.configuration;
    this.#createProcess = options.createProcess;
    this.#sessionExists = options.resume;
  }

  protected async executeRun(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
  ): Promise<AgentProviderRunResult> {
    this.#context = context;
    this.#terminal = undefined;
    this.#providerFailure = undefined;
    this.#currentMessageId = undefined;
    this.#terminalClaimed = false;
    this.#textBlocks.clear();
    this.#tools.clear();
    this.#toolBlocks.clear();
    this.#startedModelTurns.clear();
    this.#completedModelTurns.clear();
    let process: ClaudeCodeProcessClient | undefined;
    try {
      process = this.#createProcess(this.#arguments(request));
      this.#process = process;
      await process.execute(claudeCodeInput(request), (message) => this.#enqueue(message), context.signal);
      await this.#eventTail;
      if (this.#providerFailure) throw this.#providerFailure;
      if (!this.#terminal) throw protocolError("Claude Code exited without a result message");
      return claudeCodeRunResult(this.#terminal);
    } catch (error) {
      if (context.signal.aborted) throw error;
      this.closeForProviderFailure();
      if (error instanceof AgentProviderError) throw error;
      throw new AgentProviderError(
        "provider_error",
        error instanceof Error ? error.message : "Claude Code run failed",
        {
          cause: error,
        },
      );
      /* v8 ignore next -- finally is mandatory cleanup; V8 reports a synthetic branch for its closing token. */
    } finally {
      await process?.close().catch(() => undefined);
      this.#process = undefined;
      this.#context = undefined;
      this.#currentMessageId = undefined;
      this.#textBlocks.clear();
      this.#tools.clear();
      this.#toolBlocks.clear();
    }
  }

  protected async abortProvider(_request: AgentAbortRequest): Promise<void> {
    if (this.#terminalClaimed) return;
    await this.#process?.interrupt();
  }

  protected async closeProvider(): Promise<void> {
    await this.#process?.close();
  }

  #arguments(request: AgentPromptRequest): readonly string[] {
    const configuration = mergeConfiguration(this.#configuration, request.configuration);
    const provider = parseProviderConfiguration(configuration?.provider);
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-chrome",
      "--setting-sources",
      "",
      ...(this.#sessionExists ? ["--resume", this.#sessionId] : ["--session-id", this.#sessionId]),
      ...claudeCodePolicyArguments(this.#workspace, this.#policy),
      ...(configuration?.model ? ["--model", configuration.model] : []),
      ...(configuration?.reasoningEffort ? ["--effort", configuration.reasoningEffort] : []),
      ...(provider.appendSystemPrompt ? ["--append-system-prompt", provider.appendSystemPrompt] : []),
      ...(provider.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(provider.maxBudgetUsd)] : []),
      ...(provider.maxTurns !== undefined ? ["--max-turns", String(provider.maxTurns)] : []),
    ];
    return args;
  }

  #enqueue(message: Readonly<Record<string, unknown>>): void {
    this.#claimTerminalAtIngress(message);
    const next = this.#eventTail.then(async () => {
      if (!this.#context) return;
      await this.#handleMessage(message);
    });
    this.#eventTail = next.catch((error: unknown) => {
      this.#failProvider(error instanceof Error ? error : protocolError("Claude Code event processing failed"));
    });
  }

  #claimTerminalAtIngress(message: Readonly<Record<string, unknown>>): void {
    if (message.type !== "result" || !this.#context) return;
    try {
      parseTerminal(message, this.#sessionId);
      this.#context.claimTerminal();
      this.#terminalClaimed = true;
    } catch {
      // The serial event queue preserves the authoritative fail-closed error path.
    }
  }

  async #handleMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    const type = requireString(message.type, "Claude Code message has no type");
    if (type === "stream_event") {
      await this.#handleStreamEvent(requireRecord(message.event, "Claude Code stream event is invalid"));
      return;
    }
    if (type === "assistant") {
      await this.#handleAssistant(message);
      return;
    }
    if (type === "user") {
      await this.#handleUser(message);
      return;
    }
    if (type === "system" && message.subtype === "init") {
      const sessionId = requireString(message.session_id, "Claude Code init has no session id");
      if (!this.#sessionExists && sessionId !== this.#sessionId) {
        throw protocolError("Claude Code initialized another session");
      }
      this.#sessionExists = true;
      await this.#emitProviderEvent({
        type,
        subtype: "init",
        session_id: sessionId,
        ...(typeof message.model === "string" ? { model: message.model } : {}),
        ...(typeof message.claude_code_version === "string"
          ? { claude_code_version: message.claude_code_version }
          : {}),
      });
      return;
    }
    if (type === "result") {
      const terminal = parseTerminal(message, this.#sessionId);
      this.#sessionExists = true;
      await this.#completeOutstandingTools(terminal);
      if (terminal.usage) await this.#requireContext().emit({ type: "usage_updated", usage: terminal.usage });
      this.#terminal = terminal;
      return;
    }
    await this.#emitProviderEvent(message);
  }

  async #handleStreamEvent(event: Readonly<Record<string, unknown>>): Promise<void> {
    const type = requireString(event.type, "Claude Code stream event has no type");
    if (type === "message_start") {
      const message = requireRecord(event.message, "Claude Code message_start has no message");
      const id = requireString(message.id, "Claude Code message_start has no id");
      this.#currentMessageId = id;
      await this.#startModelTurn(id);
      return;
    }
    if (type === "content_block_start") {
      const block = requireRecord(event.content_block, "Claude Code content block is invalid");
      await this.#startContentBlock(requireIndex(event.index), block);
      return;
    }
    if (type === "content_block_delta") {
      const delta = requireRecord(event.delta, "Claude Code content delta is invalid");
      await this.#updateContentBlock(requireIndex(event.index), delta);
      return;
    }
    if (type === "content_block_stop") {
      await this.#stopContentBlock(requireIndex(event.index));
      return;
    }
    if (type === "message_delta") {
      const usage = parseUsage(event.usage);
      if (usage) await this.#requireContext().emit({ type: "usage_updated", usage });
      return;
    }
    if (type === "message_stop") {
      const id = this.#requireCurrentMessageId();
      if (!this.#completedModelTurns.has(id)) {
        this.#completedModelTurns.add(id);
        await this.#requireContext().emit({ type: "model_turn_completed", modelTurnId: id });
      }
      this.#currentMessageId = undefined;
      return;
    }
    await this.#emitProviderEvent({ type: "stream_event", event: toJsonValue(event) });
  }

  async #handleAssistant(envelope: Readonly<Record<string, unknown>>): Promise<void> {
    const message = requireRecord(envelope.message, "Claude Code assistant message is invalid");
    const id = requireString(message.id, "Claude Code assistant message has no id");
    const alreadyStarted = this.#startedModelTurns.has(id);
    await this.#startModelTurn(id);
    const content = requireArray(message.content, "Claude Code assistant content is invalid");
    for (let index = 0; index < content.length; index += 1) {
      const block = requireRecord(content[index], "Claude Code assistant block is invalid");
      const key = blockKey(id, index);
      if (block.type === "text") {
        const text = requireString(block.text, "Claude Code text block has no text", true);
        const state = this.#textBlocks.get(key);
        if (!state?.completed) await this.#emitCompleteText(key, text);
      } else if (block.type === "tool_use") {
        const toolId = requireString(block.id, "Claude Code tool use has no id");
        if (!this.#tools.has(toolId)) {
          const name = requireString(block.name, "Claude Code tool use has no name");
          this.#tools.set(toolId, { name });
          await this.#requireContext().emit({
            type: "tool_started",
            toolCallId: toolId,
            name,
            ...(block.input !== undefined ? { input: toJsonValue(block.input) } : {}),
          });
        }
      }
    }
    if (!alreadyStarted && !this.#completedModelTurns.has(id)) {
      this.#completedModelTurns.add(id);
      await this.#requireContext().emit({ type: "model_turn_completed", modelTurnId: id });
    }
    if (typeof envelope.error === "string") {
      await this.#requireContext().emit({
        type: "provider_warning",
        code: "claude_code_assistant_error",
        message: envelope.error,
      });
    }
  }

  async #handleUser(envelope: Readonly<Record<string, unknown>>): Promise<void> {
    const message = requireRecord(envelope.message, "Claude Code user message is invalid");
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const candidate of content) {
      const block = record(candidate);
      if (block?.type !== "tool_result") continue;
      const toolCallId = requireString(block.tool_use_id, "Claude Code tool result has no tool id");
      const tool = this.#tools.get(toolCallId);
      if (!tool) continue;
      this.#tools.delete(toolCallId);
      await this.#requireContext().emit({
        type: "tool_completed",
        toolCallId,
        name: tool.name,
        status: block.is_error === true ? "failed" : "completed",
        ...(block.content !== undefined ? { output: toJsonValue(block.content) } : {}),
      });
    }
  }

  async #startContentBlock(index: number, block: Readonly<Record<string, unknown>>): Promise<void> {
    const messageId = this.#requireCurrentMessageId();
    const key = blockKey(messageId, index);
    if (block.type === "text") {
      const state: TextBlockState = { id: key, completed: false, started: true, text: "" };
      this.#textBlocks.set(key, state);
      await this.#requireContext().emit({ type: "message_started", messageId: key });
      const text = typeof block.text === "string" ? block.text : "";
      if (text) {
        state.text += text;
        await this.#requireContext().emit({ type: "message_delta", messageId: key, delta: text });
      }
      return;
    }
    if (block.type === "tool_use") {
      const toolCallId = requireString(block.id, "Claude Code tool use has no id");
      const name = requireString(block.name, "Claude Code tool use has no name");
      this.#tools.set(toolCallId, { name });
      this.#toolBlocks.set(key, toolCallId);
      const event: {
        type: "tool_started";
        toolCallId: string;
        name: string;
        input?: JsonValue;
      } = {
        type: "tool_started",
        toolCallId,
        name,
      };
      if (block.input !== undefined) event.input = toJsonValue(block.input);
      await this.#requireContext().emit(event);
      return;
    }
    await this.#emitProviderEvent({ type: "content_block_start", index, block: toJsonValue(block) });
  }

  async #updateContentBlock(index: number, delta: Readonly<Record<string, unknown>>): Promise<void> {
    const messageId = this.#requireCurrentMessageId();
    const key = blockKey(messageId, index);
    if (delta.type === "text_delta") {
      const text = requireString(delta.text, "Claude Code text delta has no text", true);
      const state = this.#textBlocks.get(key);
      if (!state) throw protocolError("Claude Code text delta has no matching block");
      state.text += text;
      await this.#requireContext().emit({ type: "message_delta", messageId: state.id, delta: text });
      return;
    }
    if (delta.type === "input_json_delta") {
      const partialJson = requireString(delta.partial_json, "Claude Code tool delta has no JSON", true);
      const toolCallId = this.#toolBlocks.get(key);
      if (!toolCallId) throw protocolError("Claude Code tool delta has no matching tool");
      await this.#requireContext().emit({
        type: "tool_updated",
        toolCallId,
        update: { partialJson },
      });
      return;
    }
    await this.#emitProviderEvent({ type: "content_block_delta", index, delta: toJsonValue(delta) });
  }

  async #stopContentBlock(index: number): Promise<void> {
    const messageId = this.#requireCurrentMessageId();
    const key = blockKey(messageId, index);
    this.#toolBlocks.delete(key);
    const state = this.#textBlocks.get(key);
    if (!state || state.completed) return;
    state.completed = true;
    await this.#requireContext().emit({ type: "message_completed", messageId: state.id, text: state.text });
  }

  async #emitCompleteText(key: string, text: string): Promise<void> {
    let state = this.#textBlocks.get(key);
    if (!state) {
      state = { id: key, completed: false, started: false, text: "" };
      this.#textBlocks.set(key, state);
    }
    if (!state.started) {
      state.started = true;
      await this.#requireContext().emit({ type: "message_started", messageId: key });
    }
    if (!state.text && text) {
      state.text = text;
      await this.#requireContext().emit({ type: "message_delta", messageId: key, delta: text });
    }
    state.completed = true;
    await this.#requireContext().emit({ type: "message_completed", messageId: key, text });
  }

  async #startModelTurn(id: string): Promise<void> {
    if (this.#startedModelTurns.has(id)) return;
    this.#startedModelTurns.add(id);
    await this.#requireContext().emit({ type: "model_turn_started", modelTurnId: id });
  }

  async #completeOutstandingTools(terminal: ClaudeCodeTerminal): Promise<void> {
    const denied = new Set(
      terminal.permissionDenials
        .map((item) => item.tool_use_id)
        .filter((value): value is string => typeof value === "string"),
    );
    for (const [toolCallId, tool] of this.#tools) {
      await this.#requireContext().emit({
        type: "tool_completed",
        toolCallId,
        name: tool.name,
        status: denied.has(toolCallId) ? "declined" : "failed",
      });
    }
    this.#tools.clear();
  }

  async #emitProviderEvent(payload: JsonValue | Readonly<Record<string, unknown>>): Promise<void> {
    await this.#requireContext().emit({
      type: "provider_event",
      providerId: CLAUDE_CODE_PROVIDER_ID,
      schemaVersion: 1,
      payload: toJsonValue(payload),
    });
  }

  #requireCurrentMessageId(): string {
    if (!this.#currentMessageId) throw protocolError("Claude Code content event has no active message");
    return this.#currentMessageId;
  }

  #requireContext(): AgentProviderRunContext {
    /* v8 ignore next -- the serial envelope queue drops messages after the active Run context is cleared. */
    if (!this.#context) throw protocolError("Claude Code event arrived without an active run");
    return this.#context;
  }

  #failProvider(error: Error): void {
    if (this.#providerFailure) return;
    this.#providerFailure = error;
    void this.#process?.close().catch(() => undefined);
    this.closeForProviderFailure();
  }
}

export class ClaudeCodeAgentRuntimeFactory implements AgentRuntimeFactory {
  readonly manifest = CLAUDE_CODE_AGENT_RUNTIME_MANIFEST;
  readonly #createSessionId: () => string;
  readonly #createProcess: (cwd: string, args: readonly string[]) => ClaudeCodeProcessClient;
  readonly #probeRunner: () => Promise<{
    readonly credential: boolean;
    readonly streamJson: boolean;
    readonly version: string;
  }>;

  constructor(options: ClaudeCodeAgentRuntimeFactoryOptions = {}) {
    this.#createSessionId = options.createSessionId ?? randomUUID;
    const environment = options.process?.env ?? claudeCodeAgentRuntimeEnvironment();
    const command = options.process?.command ?? "claude";
    const prefix = options.process?.args ?? [];
    this.#createProcess =
      options.createProcess ??
      ((cwd, args) =>
        new ClaudeCodeProcess({
          command,
          args: [...prefix, ...args],
          cwd,
          env: environment,
          maxLineBytes: options.process?.maxLineBytes,
          maxStderrBytes: options.process?.maxStderrBytes,
          spawnProcess: options.process?.spawnProcess,
        }));
    this.#probeRunner = options.probeRunner ?? (() => probeClaudeCode(command, environment));
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
      if (!result.streamJson) {
        issues.push({ code: "version_incompatible", message: "Claude Code stream-json mode is unavailable" });
      }
      if (!result.credential) {
        issues.push({ code: "credential_missing", message: "Claude Code credentials were not found" });
      }
    } catch {
      issues.push({ code: "artifact_missing", message: "Claude Code CLI could not be executed" });
    }
    return { ready: issues.length === 0, ...(version ? { version } : {}), issues };
  }

  create(request: CreateAgentRuntimeRequest): Promise<ClaudeCodeAgentRuntime> {
    return this.#open(request, "create");
  }

  resume(request: ResumeAgentRuntimeRequest): Promise<ClaudeCodeAgentRuntime> {
    return this.#open(request, "resume");
  }

  async #open(
    request: CreateAgentRuntimeRequest | ResumeAgentRuntimeRequest,
    mode: "create" | "resume",
  ): Promise<ClaudeCodeAgentRuntime> {
    validateFactoryRequest(request);
    validateConfiguration(request.configuration);
    const binding =
      mode === "resume" && "binding" in request
        ? request.binding
        : claudeCodeBinding(requireUuid(this.#createSessionId(), "generated Claude Code session id"));
    assertBinding(binding, this.manifest);
    parseClaudeCodeBinding(binding);
    try {
      await request.eventSink({ type: "binding_changed", binding });
      return new ClaudeCodeAgentRuntime({
        binding,
        configuration: request.configuration,
        createProcess: (args) => this.#createProcess(request.workspace.cwd, args),
        eventSink: request.eventSink,
        resume: mode === "resume",
        workspace: request.workspace,
        policy: request.policy,
      });
    } catch (error) {
      throw new AgentRuntimeError(mode === "create" ? "create_failed" : "resume_failed", `Claude Code ${mode} failed`, {
        cause: error,
      });
    }
  }
}

export function claudeCodeAgentRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const exact = new Set([
    "APPDATA",
    "CLOUD_ML_REGION",
    "COMSPEC",
    "GCLOUD_PROJECT",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "LOGNAME",
    "NODE_EXTRA_CA_CERTS",
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
    "https_proxy",
    "http_proxy",
  ]);
  const prefixes = ["ANTHROPIC_", "AWS_", "CLAUDE_CODE_", "GOOGLE_"];
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))) {
      environment[key] = value;
    }
  }
  return environment;
}

async function probeClaudeCode(
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly credential: boolean; readonly streamJson: boolean; readonly version: string }> {
  const execution = { encoding: "utf8" as const, env: environment, timeout: 5_000, windowsHide: true };
  const [versionResult, helpResult] = await Promise.all([
    execFileAsync(command, ["--version"], execution),
    execFileAsync(command, ["--help"], execution),
  ]);
  const version = versionResult.stdout.trim();
  if (!version) throw new Error("Claude Code CLI returned no version");
  const streamJson =
    helpResult.stdout.includes("stream-json") &&
    helpResult.stdout.includes("--session-id") &&
    helpResult.stdout.includes("--resume");
  const credential = hasCredentialEnvironment(environment) || (await probeClaudeCodeCredential(command, execution));
  return { credential, streamJson, version };
}

async function probeClaudeCodeCredential(
  command: string,
  execution: {
    readonly encoding: "utf8";
    readonly env: NodeJS.ProcessEnv;
    readonly timeout: number;
    readonly windowsHide: boolean;
  },
): Promise<boolean> {
  let output: string;
  try {
    output = (await execFileAsync(command, ["auth", "status", "--json"], execution)).stdout;
  } catch (error) {
    output = (error as Error & { readonly stdout: string }).stdout;
  }
  if (!output) return false;
  try {
    return record(JSON.parse(output))?.loggedIn === true;
  } catch {
    return false;
  }
}

function hasCredentialEnvironment(environment: NodeJS.ProcessEnv): boolean {
  const directCredentials = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ];
  if (directCredentials.some((key) => Boolean(environment[key]))) return true;
  return ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_VERTEX"].some(
    (key) => environment[key] === "1",
  );
}

function validateFactoryRequest(request: CreateAgentRuntimeRequest): void {
  if (!request || typeof request !== "object" || typeof request.eventSink !== "function") {
    throw new AgentRuntimeError("configuration_invalid", "eventSink is required");
  }
  if (!request.workspace || !isAbsolute(request.workspace.cwd)) {
    throw new AgentRuntimeError("configuration_invalid", "workspace.cwd must be absolute");
  }
  const cwd = resolve(request.workspace.cwd);
  for (const root of request.workspace.writableRoots ?? []) {
    if (!isAbsolute(root)) throw new AgentRuntimeError("configuration_invalid", "writable roots must be absolute");
  }
  if (request.policy.approvals !== "never") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Claude Code requires approvals=never because interactive control is unsupported",
    );
  }
  if (request.policy.fileSystem === "read-only" && (request.workspace.writableRoots?.length ?? 0) > 0) {
    throw new AgentRuntimeError("configuration_invalid", "read-only policy cannot have writable roots");
  }
  if (request.policy.fileSystem === "read-only" && request.policy.network === "enabled") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Claude Code cannot guarantee read-only filesystem with enabled network",
    );
  }
  if (request.policy.fileSystem === "unrestricted" && request.policy.network === "disabled") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Claude Code cannot restrict network in unrestricted filesystem mode",
    );
  }
  const roots = request.workspace.writableRoots;
  if (request.policy.fileSystem === "workspace-write" && roots && !roots.some((root) => resolve(root) === cwd)) {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Claude Code workspace-write policy must include workspace.cwd in writable roots",
    );
  }
  if (request.policy.fileSystem === "read-only" && request.policy.tools.mode === "allow-list") {
    for (const tool of request.policy.tools.names) {
      if (!(CLAUDE_CODE_READ_ONLY_TOOLS as readonly string[]).includes(tool)) {
        throw new AgentRuntimeError("configuration_invalid", `Claude Code read-only policy cannot allow tool: ${tool}`);
      }
    }
  }
  validateToolPolicy(request.policy);
}

function validateToolPolicy(policy: AgentRuntimePolicy): void {
  if (policy.tools.mode !== "allow-list") return;
  if (policy.tools.names.length === 0) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code tool allow-list must not be empty");
  }
  for (const name of policy.tools.names) {
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
      throw new AgentRuntimeError("configuration_invalid", "Claude Code tool names must be bounded identifiers");
    }
    if (policy.network === "disabled" && (CLAUDE_CODE_NETWORK_TOOLS.has(name) || name.startsWith("mcp__"))) {
      throw new AgentRuntimeError(
        "configuration_invalid",
        `Claude Code network-disabled policy cannot allow tool: ${name}`,
      );
    }
  }
}

function validateConfiguration(configuration: AgentRunConfiguration | undefined): void {
  if (!configuration) return;
  if (configuration.model !== undefined && configuration.model.trim().length === 0) {
    throw new AgentRuntimeError("configuration_invalid", "model must be non-empty");
  }
  if (configuration.reasoningEffort && !CLAUDE_CODE_EFFORTS.has(configuration.reasoningEffort)) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code reasoning effort is unsupported");
  }
  parseProviderConfiguration(configuration.provider);
}

function parseProviderConfiguration(value: JsonValue | undefined): ClaudeCodeProviderConfiguration {
  if (value === undefined) return {};
  assertJsonValue(value, "configuration.provider");
  const object = record(value);
  if (!object) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code provider configuration must be an object");
  }
  const allowed = new Set(["appendSystemPrompt", "maxBudgetUsd", "maxTurns"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new AgentRuntimeError("configuration_invalid", `unknown Claude Code configuration field: ${key}`);
    }
  }
  const appendSystemPrompt = object.appendSystemPrompt;
  if (appendSystemPrompt !== undefined && (typeof appendSystemPrompt !== "string" || !appendSystemPrompt.trim())) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code appendSystemPrompt must be non-empty");
  }
  const maxBudgetUsd = object.maxBudgetUsd;
  if (
    maxBudgetUsd !== undefined &&
    (typeof maxBudgetUsd !== "number" || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)
  ) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code maxBudgetUsd must be positive");
  }
  const maxTurns = object.maxTurns;
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || (maxTurns as number) <= 0)) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code maxTurns must be a positive safe integer");
  }
  return {
    ...(typeof appendSystemPrompt === "string" ? { appendSystemPrompt } : {}),
    ...(typeof maxBudgetUsd === "number" ? { maxBudgetUsd } : {}),
    ...(typeof maxTurns === "number" ? { maxTurns } : {}),
  };
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

function claudeCodePolicyArguments(workspace: AgentRuntimeWorkspace, policy: AgentRuntimePolicy): readonly string[] {
  const arguments_: string[] = [];
  const tools =
    policy.fileSystem === "read-only"
      ? policy.tools.mode === "allow-list"
        ? policy.tools.names
        : CLAUDE_CODE_READ_ONLY_TOOLS
      : policy.tools.mode === "allow-list"
        ? policy.tools.names
        : undefined;
  if (tools) arguments_.push("--tools", tools.join(","));
  if (policy.network === "disabled") {
    arguments_.push(
      "--disallowedTools",
      "WebFetch,WebSearch,mcp__*",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
    );
  }
  if (policy.fileSystem === "unrestricted") {
    arguments_.push("--permission-mode", "bypassPermissions");
    return arguments_;
  }
  const writableRoots = policy.fileSystem === "workspace-write" ? (workspace.writableRoots ?? [workspace.cwd]) : [];
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: writableRoots,
        ...(policy.fileSystem === "read-only" ? { denyWrite: ["/"] } : {}),
      },
      ...(policy.network === "disabled" ? { network: { allowedDomains: [] } } : {}),
    },
  };
  arguments_.push(
    "--permission-mode",
    policy.fileSystem === "read-only" ? "dontAsk" : "acceptEdits",
    "--settings",
    JSON.stringify(settings),
  );
  for (const root of writableRoots) {
    if (resolve(root) !== resolve(workspace.cwd)) arguments_.push("--add-dir", root);
  }
  return arguments_;
}

function claudeCodeInput(request: AgentPromptRequest): Readonly<Record<string, unknown>> {
  return {
    type: "user",
    message: {
      role: "user",
      content: request.input.items.map((item) => ({ type: "text", text: item.text })),
    },
    parent_tool_use_id: null,
  };
}

function claudeCodeBinding(sessionId: string): AgentRuntimeBinding {
  return {
    providerId: CLAUDE_CODE_PROVIDER_ID,
    schemaVersion: CLAUDE_CODE_BINDING_SCHEMA_VERSION,
    payload: { sessionId },
  };
}

function parseClaudeCodeBinding(binding: AgentRuntimeBinding): string {
  const payload = record(binding.payload);
  if (!payload) throw new AgentRuntimeError("binding_incompatible", "Claude Code binding payload is invalid");
  try {
    return requireUuid(payload.sessionId, "Claude Code binding sessionId");
  } catch (error) {
    throw new AgentRuntimeError("binding_incompatible", (error as Error).message, { cause: error });
  }
}

function parseTerminal(message: Readonly<Record<string, unknown>>, expectedSessionId: string): ClaudeCodeTerminal {
  const sessionId = requireUuid(message.session_id, "Claude Code result session id");
  if (sessionId !== expectedSessionId) throw protocolError("Claude Code result belongs to another session");
  const subtype = requireString(message.subtype, "Claude Code result has no subtype");
  const isError = message.is_error === true || subtype !== "success";
  const errors = Array.isArray(message.errors)
    ? message.errors.map((error) => requireString(error, "Claude Code result contains an invalid error"))
    : [];
  const permissionDenials = Array.isArray(message.permission_denials)
    ? message.permission_denials.map((item) => requireRecord(item, "Claude Code permission denial is invalid"))
    : [];
  const usage = parseUsage(message.usage);
  return {
    sessionId,
    subtype,
    isError,
    errors,
    permissionDenials,
    ...(typeof message.result === "string" ? { result: message.result } : {}),
    ...(typeof message.stop_reason === "string" ? { stopReason: message.stop_reason } : {}),
    ...(isNonNegativeNumber(message.num_turns) ? { numTurns: message.num_turns } : {}),
    ...(isNonNegativeNumber(message.total_cost_usd) ? { totalCostUsd: message.total_cost_usd } : {}),
    ...(usage ? { usage } : {}),
  };
}

function claudeCodeRunResult(terminal: ClaudeCodeTerminal): AgentProviderRunResult {
  const output = terminal.result === undefined ? [] : [{ type: "text" as const, text: terminal.result }];
  const diagnostics: JsonValue = {
    providerSessionId: terminal.sessionId,
    resultSubtype: terminal.subtype,
    permissionDenials: toJsonValue(terminal.permissionDenials),
    ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}),
    ...(terminal.numTurns !== undefined ? { numTurns: terminal.numTurns } : {}),
    ...(terminal.totalCostUsd !== undefined ? { totalCostUsd: terminal.totalCostUsd } : {}),
  };
  if (!terminal.isError) {
    return {
      status: "completed",
      output,
      ...(terminal.usage ? { usage: terminal.usage } : {}),
      diagnostics,
    };
  }
  return {
    status: "failed",
    output,
    ...(terminal.usage ? { usage: terminal.usage } : {}),
    error: {
      code: "provider_error",
      message: terminal.errors[0] ?? terminal.result ?? `Claude Code failed: ${terminal.subtype}`,
    },
    diagnostics,
  };
}

function parseUsage(
  value: unknown,
): { readonly inputTokens?: number; readonly cachedInputTokens?: number; readonly outputTokens?: number } | undefined {
  const source = record(value);
  if (!source) return undefined;
  const usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } = {};
  if (isNonNegativeNumber(source.input_tokens)) usage.inputTokens = source.input_tokens;
  if (isNonNegativeNumber(source.cache_read_input_tokens)) usage.cachedInputTokens = source.cache_read_input_tokens;
  if (isNonNegativeNumber(source.output_tokens)) usage.outputTokens = source.output_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function blockKey(messageId: string, index: number): string {
  return `${messageId}:content:${index}`;
}

function requireIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError("Claude Code content block has an invalid index");
  }
  return value as number;
}

function requireUuid(value: unknown, field: string): string {
  const result = requireString(value, `${field} must be a UUID`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw protocolError(`${field} must be a UUID`);
  }
  return result;
}

function toJsonValue(value: unknown): JsonValue {
  assertJsonValue(value, "Claude Code event payload");
  return value as JsonValue;
}

function protocolError(message: string): AgentProviderError {
  return new AgentProviderError("provider_protocol_error", message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw protocolError(message);
  return result;
}

function requireArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError(message);
  return value;
}

function requireString(value: unknown, message: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > 8 * 1024 * 1024
  ) {
    throw protocolError(message);
  }
  return value;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
