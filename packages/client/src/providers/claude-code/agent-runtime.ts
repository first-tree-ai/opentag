import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { AgentRuntimeOptionsSchema, RuntimeModelSchema, RuntimeReasoningEffortSchema } from "@opentag/shared";
import { z } from "zod";
import { BaseAgentRuntime } from "../../agent-runtime/base-agent-runtime.js";
import { composeRuntimeEnvironment } from "../../agent-runtime/environment.js";
import { AgentProviderError, AgentRuntimeError } from "../../agent-runtime/errors.js";
import { classifiedProviderProbeIssue } from "../../agent-runtime/probe-failure.js";
import { providerFailureCode, providerProcessFailureCode } from "../../agent-runtime/provider-failure.js";
import {
  isNonNegativeNumber,
  parseHttpMcpGateway,
  protocolError,
  toJsonValue as protocolJsonValue,
  providerConfiguration,
  record,
  requireArray,
  requireIndex as requireProtocolIndex,
  requireProtocolString,
  requireRecord,
  requireUuid,
} from "../../agent-runtime/provider-utils.js";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  type AgentAbortRequest,
  type AgentHostedTools,
  type AgentInteractionResponse,
  type AgentPromptRequest,
  type AgentProviderRunContext,
  type AgentProviderRunResult,
  type AgentProviderSteerCustody,
  type AgentRunConfiguration,
  type AgentRuntimeBinding,
  type AgentRuntimeConfigurationOptionsRequest,
  type AgentRuntimeEventSink,
  type AgentRuntimeFactory,
  type AgentRuntimeManifest,
  type AgentRuntimePolicy,
  type AgentRuntimeProbeIssue,
  type AgentRuntimeProbeRequest,
  type AgentRuntimeProbeResult,
  type AgentSteerRequest,
  type CreateAgentRuntimeRequest,
  type JsonValue,
  type ResumeAgentRuntimeRequest,
} from "../../agent-runtime/types.js";
import {
  assertBinding,
  assertConfigurationStrings,
  assertHostedTools,
  assertJsonValue,
  assertSystemPrompt,
  runWithAbortSignal,
} from "../../agent-runtime/validation.js";
import { createLogger } from "../../observability/logger.js";
import { claudePermissionRules } from "../native-permissions.js";
import { probeClaudeEnvironmentCredential } from "./credential-probe.js";
import {
  type ClaudeCodeHostedToolBridge,
  createClaudeCodeBridgeIdentity,
  startClaudeCodeHostedToolBridge,
} from "./hosted-tool-bridge.js";
import {
  ClaudeCodeProcess,
  type ClaudeCodeProcessClient,
  ClaudeCodeProcessError,
  type ClaudeCodeProcessSpawnOptions,
} from "./process-wire.js";

const execFileAsync = promisify(execFile);
const CLAUDE_CODE_BINDING_SCHEMA_VERSION = 1;
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

const CLAUDE_CODE_SETTING_SOURCES = ["--setting-sources", "user,project,local"] as const;
const logger = createLogger("provider-claude-code-runtime");

export const CLAUDE_CODE_AGENT_RUNTIME_MANIFEST: AgentRuntimeManifest = Object.freeze({
  providerId: CLAUDE_CODE_PROVIDER_ID,
  displayName: "Claude Code",
  contractVersion: AGENT_RUNTIME_CONTRACT_VERSION,
  bindingSchemaVersion: CLAUDE_CODE_BINDING_SCHEMA_VERSION,
});

/**
 * The MCP gateway endpoint for one execution.
 *
 * Both fields are opaque to this provider: it writes them into the run's `mcp.json` and never
 * inspects, logs, or stores them. The token is execution-scoped, which is what makes writing a
 * bearer to a 0600 file in a temp directory acceptable at all.
 */
interface ClaudeCodeMcpGatewayConfiguration {
  readonly url: string;
  readonly token: string;
}

interface ClaudeCodeProviderConfiguration {
  readonly maxBudgetUsd?: number;
  readonly maxTurns?: number;
  readonly mcpGateway?: ClaudeCodeMcpGatewayConfiguration;
}

interface ClaudeCodeRuntimeOptions {
  readonly cwd: string;
  readonly policy: AgentRuntimePolicy;
  readonly binding: AgentRuntimeBinding;
  readonly configuration?: AgentRunConfiguration;
  readonly createProcess: (args: readonly string[]) => ClaudeCodeProcessClient;
  readonly emptyNativeToolAllowList?: boolean;
  readonly eventSink: AgentRuntimeEventSink;
  readonly hostedTools?: AgentHostedTools;
  readonly skillPaths: readonly string[];
  readonly resume: boolean;
  readonly startHostedToolBridge: typeof startClaudeCodeHostedToolBridge;
  readonly systemPrompt: string;
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
  readonly createProcess?: (
    cwd: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ) => ClaudeCodeProcessClient;
  readonly createSessionId?: () => string;
  readonly startHostedToolBridge?: typeof startClaudeCodeHostedToolBridge;
  readonly verifyCredential?: typeof probeClaudeEnvironmentCredential;
  readonly probeRunner?: (signal?: AbortSignal) => Promise<{
    readonly credential: boolean;
    readonly credentialIssue?: AgentRuntimeProbeIssue;
    readonly streamJson: boolean;
    readonly version: string;
  }>;
}

interface ClaudeCodeTerminal {
  readonly apiErrorStatus?: number;
  readonly errors: readonly string[];
  readonly isError: boolean;
  readonly numTurns?: number;
  readonly permissionDenials: readonly Record<string, unknown>[];
  readonly result?: string;
  readonly sessionId: string;
  readonly stopReason?: string;
  readonly subtype: string;
  readonly totalCostUsd?: number;
  /** Result texts of earlier results in this Run that were followed by steered input. */
  readonly earlierResults?: readonly string[];
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
  readonly #cwd: string;
  readonly #policy: AgentRuntimePolicy;
  readonly #permissions = new Map<string, Readonly<Record<string, unknown>>>();
  readonly #sessionId: string;
  readonly #configuration?: AgentRunConfiguration;
  readonly #createProcess: (args: readonly string[]) => ClaudeCodeProcessClient;
  readonly #emptyNativeToolAllowList: boolean;
  readonly #hostedTools?: AgentHostedTools;
  readonly #skillPaths: readonly string[];
  readonly #startHostedToolBridge: typeof startClaudeCodeHostedToolBridge;
  readonly #bridgeIdentity = createClaudeCodeBridgeIdentity();
  readonly #systemPrompt: string;
  readonly #textBlocks = new Map<string, TextBlockState>();
  readonly #tools = new Map<string, ToolState>();
  readonly #toolBlocks = new Map<string, string>();
  readonly #startedModelTurns = new Set<string>();
  readonly #completedModelTurns = new Set<string>();
  #process?: ClaudeCodeProcessClient;
  #eventTail: Promise<void> = Promise.resolve();
  #terminal?: ClaudeCodeTerminal;
  /** Results that steered input continued past; merged into the one terminal of this Run. */
  readonly #continuedTerminals: ClaudeCodeTerminal[] = [];
  #processReady?: ProcessReady;
  #providerFailure?: Error;
  #assistantError?: string;
  #currentMessageId?: string;
  #sessionExists: boolean;
  #terminalClaimed = false;

  constructor(options: ClaudeCodeRuntimeOptions) {
    super({
      manifest: CLAUDE_CODE_AGENT_RUNTIME_MANIFEST,
      capabilities: { steer: "supported", interactions: "supported" },
      eventSink: options.eventSink,
      binding: options.binding,
    });
    this.#sessionId = parseClaudeCodeBinding(options.binding);
    this.#cwd = options.cwd;
    this.#policy = options.policy;
    this.#configuration = options.configuration;
    this.#createProcess = options.createProcess;
    this.#emptyNativeToolAllowList = options.emptyNativeToolAllowList === true;
    this.#hostedTools = options.hostedTools;
    this.#skillPaths = options.skillPaths;
    this.#startHostedToolBridge = options.startHostedToolBridge;
    this.#systemPrompt = options.systemPrompt;
    this.#sessionExists = options.resume;
  }

  protected async executeRun(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
  ): Promise<AgentProviderRunResult> {
    this.providerContext = context;
    // A steer admitted before executeRun started may already be waiting on this slot.
    this.#processReady ??= deferredProcess();
    this.#terminal = undefined;
    this.#continuedTerminals.length = 0;
    this.#providerFailure = undefined;
    this.#assistantError = undefined;
    this.#currentMessageId = undefined;
    this.#terminalClaimed = false;
    this.#textBlocks.clear();
    this.#tools.clear();
    this.#toolBlocks.clear();
    this.#startedModelTurns.clear();
    this.#completedModelTurns.clear();
    let process: ClaudeCodeProcessClient | undefined;
    let hostedToolBridge: ClaudeCodeHostedToolBridge | undefined;
    try {
      try {
        /*
         * The gateway descriptor is read per run rather than at construction: its token is scoped to
         * the current execution, and this process is spawned fresh for every run, so the bridge
         * always writes the bearer that is live right now.
         */
        const mcpGateway = parseProviderConfiguration(
          mergeConfiguration(this.#configuration, request.configuration)?.provider,
        ).mcpGateway;
        hostedToolBridge = await this.#startHostedToolBridge(
          this.#hostedTools,
          request.runId,
          context.signal,
          this.#skillPaths,
          mcpGateway,
          this.#cwd,
          this.#bridgeIdentity,
        );
        if (request.compactContext && this.#sessionExists)
          await this.#compactContext(request, context, hostedToolBridge);
        process = this.#createProcess(this.#arguments(request, hostedToolBridge));
      } catch (error) {
        if (context.signal.aborted) throw error;
        logger.debug({ code: "provider_start_failed", error: String(error) }, "Claude Code provider startup failed");
        throw new AgentProviderError(
          "provider_start_failed",
          error instanceof Error ? error.message : "Claude Code failed before accepting input",
          { cause: error },
        );
      }
      this.#process = process;
      this.#processReady?.resolve(process);
      const { abandonedBackgroundWork } = await process.execute(
        claudeCodeInput(request),
        (message, terminal) => this.#enqueue(message, terminal),
        context.signal,
      );
      await this.#eventTail;
      if (this.#providerFailure) throw this.#providerFailure;
      if (!this.#terminal) throw protocolError("Claude Code exited without a result message");
      return {
        ...claudeCodeRunResult(this.#terminal, this.#assistantError),
        ...(abandonedBackgroundWork ? { abandonedBackgroundWork } : {}),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      logger.debug({ code: "provider_run_failed", error: String(error) }, "Claude Code provider run failed");
      this.closeForProviderFailure();
      if (this.#providerFailure) throw this.#providerFailure;
      if (error instanceof AgentProviderError) throw error;
      throw new AgentProviderError(
        error instanceof ClaudeCodeProcessError ? providerProcessFailureCode(error.code) : "provider_error",
        error instanceof Error ? error.message : "Claude Code run failed",
        {
          cause: error,
        },
      );
      /* v8 ignore next -- finally is mandatory cleanup; V8 reports a synthetic branch for its closing token. */
    } finally {
      await process?.close().catch((error: unknown) => {
        logger.debug({ code: "provider_close_failed", error: String(error) }, "Claude Code provider close failed");
      });
      await hostedToolBridge?.close();
      this.#processReady?.resolve(undefined);
      this.#processReady = undefined;
      this.#continuedTerminals.length = 0;
      this.#process = undefined;
      this.providerContext = undefined;
      this.#currentMessageId = undefined;
      this.#textBlocks.clear();
      this.#tools.clear();
      this.#toolBlocks.clear();
      this.#permissions.clear();
    }
  }

  /**
   * Claude Code compacts through its native `/compact` command, which has no RPC of its own, so it
   * runs in a process of its own before the Run's process. The next `--resume` then continues from
   * the compact boundary of the same native Session. Only an abort stops the Run.
   */
  async #compactContext(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
    hostedToolBridge: ClaudeCodeHostedToolBridge,
  ): Promise<void> {
    let compacted = false;
    let failure = "Claude Code did not compact the conversation";
    let process: ClaudeCodeProcessClient | undefined;
    try {
      process = this.#createProcess(this.#arguments(request, hostedToolBridge));
      this.#process = process;
      await process.execute(
        claudeCodeUserMessage([{ type: "text", text: "/compact" }]),
        (message) => {
          if (message.type === "system" && message.subtype === "compact_boundary") compacted = true;
          if (message.type === "result" && message.is_error === true && typeof message.result === "string")
            failure = message.result;
        },
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      failure = error instanceof Error ? error.message : failure;
    } finally {
      this.#process = undefined;
      await process?.close().catch((error: unknown) => {
        logger.debug({ code: "provider_close_failed", error: String(error) }, "Claude Code provider close failed");
      });
    }
    if (compacted) {
      logger.info({ runId: context.runId }, "Claude Code compacted the Session context");
      return;
    }
    await context.emit({ type: "provider_warning", code: "claude_compaction_failed", message: failure });
  }

  /**
   * Claude Code's stream-json input queues a user message written mid-query and attaches it at the
   * next tool boundary; input that arrives after the last tool call runs right after the current
   * result. Either way the provider session already holds the earlier input, so the Run continues
   * until Claude Code has started every steered message and emitted a result after it.
   *
   * A written steer is not yet owned by the provider: the process can exit before Claude Code starts
   * it. The returned custody reports whether `command_lifecycle` showed it started, so a Run that
   * fails first lets the caller deliver the input again instead of treating it as processed.
   */
  protected override async steerProvider(request: AgentSteerRequest): Promise<AgentProviderSteerCustody> {
    this.#processReady ??= deferredProcess();
    const process = await this.#processReady.promise;
    if (!process?.steer || this.#terminalClaimed || this.#providerFailure)
      throw new AgentRuntimeError("steer_not_sent", "Claude Code settled before steer was accepted");
    try {
      return await process.steer({ ...claudeCodeUserMessage(request.input.items), uuid: randomUUID() });
    } catch (error) {
      throw new AgentRuntimeError("run_mismatch", "Claude Code did not accept the steer input", { cause: error });
    }
  }

  protected override async abortProvider(_request: AgentAbortRequest): Promise<void> {
    if (this.#terminalClaimed) return;
    await this.#process?.interrupt();
  }

  protected async closeProvider(): Promise<void> {
    await this.#process?.close();
  }

  protected override async respondProvider(response: AgentInteractionResponse): Promise<void> {
    const input = this.#permissions.get(response.requestId);
    if (!input || !this.#process?.send || response.kind !== "approval")
      throw new AgentRuntimeError("interaction_not_found", "Claude Code approval is no longer pending");
    await this.#process.send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: response.requestId,
        response:
          response.decision === "accept"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "The user declined this action." },
      },
    });
    this.#permissions.delete(response.requestId);
  }

  #arguments(request: AgentPromptRequest, hostedToolBridge: ClaudeCodeHostedToolBridge): readonly string[] {
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
      ...CLAUDE_CODE_SETTING_SOURCES,
      "--plugin-dir",
      hostedToolBridge.pluginPath,
      "--mcp-config",
      hostedToolBridge.configPath,
      ...(this.#policy.approvals === "never" && hostedToolBridge.allowedTools.length > 0
        ? ["--allowedTools", ...hostedToolBridge.allowedTools]
        : []),
      ...(this.#sessionExists ? ["--resume", this.#sessionId] : ["--session-id", this.#sessionId]),
      "--permission-mode",
      this.#policy.approvals === "never" ? "bypassPermissions" : "acceptEdits",
      ...(this.#policy.approvals === "never" ? [] : ["--permission-prompt-tool", "stdio"]),
      "--settings",
      JSON.stringify({
        ...(this.#policy.approvals === "never"
          ? {}
          : { permissions: claudePermissionRules(this.#policy.allowedCommands ?? [], this.#policy.managedCli) }),
      }),
      ...(this.#emptyNativeToolAllowList ? ["--tools", ""] : []),
      ...(configuration?.model ? ["--model", configuration.model] : []),
      ...(configuration?.reasoningEffort ? ["--effort", configuration.reasoningEffort] : []),
      "--append-system-prompt",
      this.#systemPrompt,
      ...(provider.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(provider.maxBudgetUsd)] : []),
      ...(provider.maxTurns !== undefined ? ["--max-turns", String(provider.maxTurns)] : []),
    ];
    return args;
  }

  #enqueue(message: Readonly<Record<string, unknown>>, mayBeTerminal = true): void {
    // A result followed by still-queued steered input is not this Run's terminal.
    const terminal = mayBeTerminal && message.type === "result";
    if (terminal) this.#claimTerminalAtIngress(message);
    const next = this.#eventTail.then(async () => {
      if (!this.providerContext || this.#providerFailure) return;
      if (message.type === "control_request" || message.type === "control_cancel_request")
        await this.#handleControlMessage(message);
      else await this.#handleMessage(message, terminal);
    });
    this.#eventTail = next.catch((error: unknown) => {
      logger.debug({ code: "event_processing_failed", error: String(error) }, "Claude Code event processing failed");
      this.#failProvider(error instanceof Error ? error : protocolError("Claude Code event processing failed"));
    });
  }

  #claimTerminalAtIngress(message: Readonly<Record<string, unknown>>): void {
    if (!this.providerContext) return;
    try {
      parseTerminal(message, this.#sessionId);
      this.providerContext.claimTerminal();
      this.#terminalClaimed = true;
    } catch (error) {
      logger.debug(
        { code: "terminal_message_invalid", error: String(error) },
        "Claude Code terminal message was rejected",
      );
      // The serial event queue preserves the authoritative fail-closed error path.
    }
  }

  async #handleControlMessage(message: Readonly<Record<string, unknown>>): Promise<void> {
    const type = message.type;
    if (type === "control_request") {
      const id = requireString(message.request_id, "Claude Code control request has no id");
      const request = requireRecord(message.request, "Claude Code control request is invalid");
      if (request.subtype !== "can_use_tool" || !this.#process?.send)
        throw protocolError("Unsupported Claude Code control request");
      const input = requireRecord(request.input, "Claude Code permission input is invalid");
      this.#permissions.set(id, input);
      await this.requireProviderContext().requestInteraction({
        requestId: id,
        kind: "approval",
        title: `Approve ${requireString(request.tool_name, "Claude Code permission tool is invalid")}`,
        details: toJsonValue(input),
      });
      return;
    }
    const id = requireString(message.request_id, "Claude Code cancelled request has no id");
    this.#permissions.delete(id);
    await this.requireProviderContext().resolveInteraction(id, "cancel");
  }

  async #handleMessage(message: Readonly<Record<string, unknown>>, terminal: boolean): Promise<void> {
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
      if (sessionId !== this.#sessionId) {
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
      await this.#handleResult(message, terminal);
      return;
    }
    await this.#emitProviderEvent(message);
  }

  async #handleResult(message: Readonly<Record<string, unknown>>, terminal: boolean): Promise<void> {
    const parsed = parseTerminal(message, this.#sessionId);
    this.#sessionExists = true;
    await this.#completeOutstandingTools(parsed);
    if (!terminal) {
      // Steered input is still queued behind this result; Claude Code continues the same session.
      this.#continuedTerminals.push(parsed);
      return;
    }
    const merged = mergeTerminals(this.#continuedTerminals, parsed);
    if (merged.usage) await this.requireProviderContext().emit({ type: "usage_updated", usage: merged.usage });
    this.#terminal = merged;
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
      if (usage) await this.requireProviderContext().emit({ type: "usage_updated", usage });
      return;
    }
    if (type === "message_stop") {
      const id = this.#requireCurrentMessageId();
      if (!this.#completedModelTurns.has(id)) {
        this.#completedModelTurns.add(id);
        await this.requireProviderContext().emit({ type: "model_turn_completed", modelTurnId: id });
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
          await this.requireProviderContext().emit({
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
      await this.requireProviderContext().emit({ type: "model_turn_completed", modelTurnId: id });
    }
    if (typeof envelope.error === "string") {
      this.#assistantError = envelope.error;
      await this.requireProviderContext().emit({
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
      await this.requireProviderContext().emit({
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
      await this.requireProviderContext().emit({ type: "message_started", messageId: key });
      const text = typeof block.text === "string" ? block.text : "";
      if (text) {
        state.text += text;
        await this.requireProviderContext().emit({ type: "message_delta", messageId: key, delta: text });
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
      /* v8 ignore else -- Claude Code always attaches an input payload to tool_use blocks. */
      if (block.input !== undefined) event.input = toJsonValue(block.input);
      await this.requireProviderContext().emit(event);
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
      await this.requireProviderContext().emit({ type: "message_delta", messageId: state.id, delta: text });
      return;
    }
    if (delta.type === "input_json_delta") {
      const partialJson = requireString(delta.partial_json, "Claude Code tool delta has no JSON", true);
      const toolCallId = this.#toolBlocks.get(key);
      if (!toolCallId) throw protocolError("Claude Code tool delta has no matching tool");
      await this.requireProviderContext().emit({
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
    await this.requireProviderContext().emit({ type: "message_completed", messageId: state.id, text: state.text });
  }

  async #emitCompleteText(key: string, text: string): Promise<void> {
    let state = this.#textBlocks.get(key);
    if (!state) {
      state = { id: key, completed: false, started: false, text: "" };
      this.#textBlocks.set(key, state);
    }
    if (!state.started) {
      state.started = true;
      await this.requireProviderContext().emit({ type: "message_started", messageId: key });
    }
    if (!state.text && text) {
      state.text = text;
      await this.requireProviderContext().emit({ type: "message_delta", messageId: key, delta: text });
    }
    state.completed = true;
    await this.requireProviderContext().emit({ type: "message_completed", messageId: key, text });
  }

  async #startModelTurn(id: string): Promise<void> {
    if (this.#startedModelTurns.has(id)) return;
    this.#startedModelTurns.add(id);
    await this.requireProviderContext().emit({ type: "model_turn_started", modelTurnId: id });
  }

  async #completeOutstandingTools(terminal: ClaudeCodeTerminal): Promise<void> {
    const denied = new Set(
      terminal.permissionDenials
        .map((item) => item.tool_use_id)
        .filter((value): value is string => typeof value === "string"),
    );
    for (const [toolCallId, tool] of this.#tools) {
      await this.requireProviderContext().emit({
        type: "tool_completed",
        toolCallId,
        name: tool.name,
        status: denied.has(toolCallId) ? "declined" : "failed",
      });
    }
    this.#tools.clear();
  }

  async #emitProviderEvent(payload: JsonValue | Readonly<Record<string, unknown>>): Promise<void> {
    await this.requireProviderContext().emit({
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

  #failProvider(error: Error): void {
    logger.debug({ code: "provider_failure", error: error.message }, "Claude Code provider failure recorded");
    this.#providerFailure = error;
    /* v8 ignore next -- process teardown during a provider failure must not raise a second fault. */
    void this.#process?.close().catch((error: unknown) => {
      logger.debug(
        { code: "provider_close_failed", error: String(error) },
        "Claude Code provider close after failure failed",
      );
    });
    this.closeForProviderFailure();
  }
}

export class ClaudeCodeAgentRuntimeFactory implements AgentRuntimeFactory {
  readonly manifest = CLAUDE_CODE_AGENT_RUNTIME_MANIFEST;
  readonly #createSessionId: () => string;
  readonly #createProcess: (
    cwd: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
    pathPrepend?: string,
  ) => ClaudeCodeProcessClient;
  readonly #probeRunner: (signal?: AbortSignal) => Promise<{
    readonly credential: boolean;
    readonly credentialIssue?: AgentRuntimeProbeIssue;
    readonly streamJson: boolean;
    readonly version: string;
  }>;
  readonly #startHostedToolBridge: typeof startClaudeCodeHostedToolBridge;

  constructor(options: ClaudeCodeAgentRuntimeFactoryOptions = {}) {
    this.#createSessionId = options.createSessionId ?? randomUUID;
    const environment = claudeCodeAgentRuntimeEnvironment(options.process?.env);
    const command = options.process?.command ?? "claude";
    const prefix = options.process?.args ?? [];
    this.#createProcess =
      options.createProcess ??
      ((cwd, args, workspaceEnvironment, pathPrepend) =>
        new ClaudeCodeProcess({
          command,
          args: [...prefix, ...args],
          cwd,
          env: composeRuntimeEnvironment(environment, workspaceEnvironment, pathPrepend),
          maxLineBytes: options.process?.maxLineBytes,
          maxStderrBytes: options.process?.maxStderrBytes,
          spawnProcess: options.process?.spawnProcess,
        }));
    this.#probeRunner =
      options.probeRunner ?? ((signal) => probeClaudeCode(command, environment, signal, options.verifyCredential));
    this.#startHostedToolBridge = options.startHostedToolBridge ?? startClaudeCodeHostedToolBridge;
  }

  async probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    const issues: AgentRuntimeProbeResult["issues"][number][] = [];
    try {
      validateConfiguration(request.configuration);
    } catch (error) {
      logger.debug(
        { code: "probe_configuration_invalid", error: String(error) },
        "Claude Code probe configuration was rejected",
      );
      issues.push({ code: "configuration_invalid", message: (error as Error).message });
    }
    let version: string | undefined;
    try {
      const result = await runWithAbortSignal(this.#probeRunner, request.signal);
      version = result.version;
      if (!result.streamJson) {
        issues.push({
          code: "version_incompatible",
          message: "Claude Code requires stream-json, acceptEdits mode, and stdio permission prompts",
        });
      }
      if (result.credentialIssue) {
        issues.push(result.credentialIssue);
      } else if (!result.credential) {
        issues.push({ code: "credential_missing", message: "Claude Code credentials were not found" });
      }
    } catch (error) {
      if (request.signal?.aborted) throw error;
      logger.debug({ code: "probe_execution_failed", error: String(error) }, "Claude Code probe execution failed");
      const issue = classifiedProviderProbeIssue(error, "Claude Code CLI could not be executed");
      if (!issue) throw error;
      issues.push(issue);
    }
    return { ready: issues.length === 0, ...(version ? { version } : {}), issues };
  }

  async getConfigurationOptions(request: AgentRuntimeConfigurationOptionsRequest) {
    assertConfigurationStrings({ model: request.model });
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    signal.throwIfAborted();
    const process = this.#createProcess(request.cwd, [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--settings",
      '{"disableAllHooks":true}',
      ...CLAUDE_CODE_SETTING_SOURCES,
    ]);
    const requestId = randomUUID();
    let execution: Promise<unknown> | undefined;
    try {
      const response = await runWithAbortSignal(
        () =>
          new Promise<unknown>((resolve, reject) => {
            execution = process.execute(
              { type: "control_request", request_id: requestId, request: { subtype: "initialize", hooks: {} } },
              (message) => {
                if (message.type !== "control_response") return;
                const envelope = record(message.response);
                if (envelope?.request_id !== requestId) return;
                if (envelope.subtype !== "success") reject(protocolError("Claude Code initialization failed"));
                else resolve(envelope.response);
              },
              signal,
            );
            // execute waits for process exit; initialization itself has no model turn/result.
            void execution.then(() => reject(protocolError("Claude Code exited before initialization")), reject);
          }),
        signal,
      );
      const models = z
        .object({
          models: z.array(
            z.object({
              value: RuntimeModelSchema,
              supportsEffort: z.boolean().optional(),
              supportedEffortLevels: z.array(RuntimeReasoningEffortSchema).optional(),
            }),
          ),
        })
        .parse(response).models;
      const selected = models.find((entry) => entry.value === (request.model ?? "default"));
      return AgentRuntimeOptionsSchema.parse({
        modelSuggestions: [...new Set(models.filter((entry) => entry.value !== "default").map((entry) => entry.value))],
        reasoningEffortAllowedValues:
          request.model && selected?.supportsEffort === false
            ? []
            : request.model
              ? (selected?.supportedEffortLevels ?? null)
              : null,
      });
    } finally {
      await process.close();
      await execution?.catch(() => undefined);
    }
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
        cwd: request.workspace.cwd,
        policy: request.policy,
        binding,
        configuration: request.configuration,
        createProcess: (args) =>
          this.#createProcess(
            request.workspace.cwd,
            args,
            request.workspace.environment,
            request.workspace.pathPrepend,
          ),
        emptyNativeToolAllowList: isEmptyNativeToolAllowList(request.policy),
        eventSink: request.eventSink,
        hostedTools: request.hostedTools,
        skillPaths: request.skillPaths ?? [],
        resume: mode === "resume",
        startHostedToolBridge: this.#startHostedToolBridge,
        systemPrompt: request.systemPrompt,
      });
    } catch (error) {
      logger.debug({ code: "runtime_create_failed", error: String(error) }, "Claude Code runtime creation failed");
      throw new AgentRuntimeError(mode === "create" ? "create_failed" : "resume_failed", `Claude Code ${mode} failed`, {
        cause: error,
      });
    }
  }
}

export function claudeCodeAgentRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...source };
}

async function probeClaudeCode(
  command: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  verifyCredential = probeClaudeEnvironmentCredential,
): Promise<{
  readonly credential: boolean;
  readonly credentialIssue?: AgentRuntimeProbeIssue;
  readonly streamJson: boolean;
  readonly version: string;
}> {
  const execution = { encoding: "utf8" as const, env: environment, signal, timeout: 5_000, windowsHide: true };
  const [versionResult, helpResult] = await Promise.all([
    execFileAsync(command, ["--version"], execution),
    execFileAsync(command, ["--help"], execution),
  ]);
  const version = versionResult.stdout.trim();
  if (!version) throw new Error("Claude Code CLI returned no version");
  const streamJson =
    helpResult.stdout.includes("stream-json") &&
    helpResult.stdout.includes("--session-id") &&
    helpResult.stdout.includes("--resume") &&
    helpResult.stdout.includes("--mcp-config") &&
    helpResult.stdout.includes("--strict-mcp-config") &&
    helpResult.stdout.includes("--allowedTools") &&
    /\bacceptEdits\b/.test(helpResult.stdout) &&
    helpResult.stdout.includes("--permission-prompt-tool") &&
    helpResult.stdout.includes("--append-system-prompt");
  const authentication = await probeClaudeCodeCredential(command, execution, signal);
  const credential = authentication?.loggedIn === true;
  // Managed gateway sign-in can override explicit environment credentials. Honor the CLI's
  // selected provider rather than validating an unused token against the first-party endpoint.
  const credentialIssue =
    credential && streamJson && authentication?.apiProvider === "firstParty"
      ? await verifyCredential(environment, signal)
      : undefined;
  return {
    credential: credential && !credentialIssue,
    ...(credentialIssue ? { credentialIssue } : {}),
    streamJson,
    version,
  };
}

async function probeClaudeCodeCredential(
  command: string,
  execution: {
    readonly encoding: "utf8";
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeout: number;
    readonly windowsHide: boolean;
  },
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  let output: string;
  try {
    // Readiness is cached per Provider, so an unrelated daemon project cannot supply its credentials.
    output = (await execFileAsync(command, ["--setting-sources", "user", "auth", "status", "--json"], execution))
      .stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.debug(
      { code: "credential_status_failed", error: String(error) },
      "Claude Code credential status command failed",
    );
    output = (error as Error & { readonly stdout: string }).stdout;
  }
  if (!output) return undefined;
  try {
    return record(JSON.parse(output));
  } catch (error) {
    logger.debug(
      { code: "credential_status_invalid_json", error: String(error) },
      "Claude Code credential status output was invalid",
    );
    return undefined;
  }
}

function isEmptyNativeToolAllowList(policy: AgentRuntimePolicy): boolean {
  return policy.tools.mode === "allow-list" && policy.tools.names.length === 0;
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
  if (!["never", "on-request"].includes(request.policy.approvals)) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code supports approvals=never or on-request");
  }
  if (request.policy.fileSystem !== "unrestricted") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Claude Code cannot guarantee a constrained filesystem because managed settings override CLI sandbox settings",
    );
  }
  if (request.policy.network !== "enabled") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Claude Code cannot guarantee disabled network because managed settings override CLI sandbox settings",
    );
  }
  if (isEmptyNativeToolAllowList(request.policy)) {
    if (request.hostedTools) {
      throw new AgentRuntimeError(
        "configuration_invalid",
        "Claude Code does not implement the common tool allow-list contract",
      );
    }
  } else if (request.policy.tools.mode !== "provider-default") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Claude Code does not implement the common tool allow-list contract",
    );
  }
  if (request.hostedTools) {
    assertHostedTools(
      {
        ...request.policy,
        tools: { mode: "allow-list", names: request.hostedTools.definitions.map(({ name }) => name) },
      },
      request.hostedTools,
    );
  }
}

const { validate: validateConfiguration, merge: mergeConfiguration } =
  providerConfiguration(parseProviderConfiguration);

function parseProviderConfiguration(value: JsonValue | undefined): ClaudeCodeProviderConfiguration {
  if (value === undefined) return {};
  assertJsonValue(value, "configuration.provider");
  const object = record(value);
  if (!object) {
    throw new AgentRuntimeError("configuration_invalid", "Claude Code provider configuration must be an object");
  }
  const allowed = new Set(["maxBudgetUsd", "maxTurns", "mcpGateway"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new AgentRuntimeError("configuration_invalid", `unknown Claude Code configuration field: ${key}`);
    }
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
  const mcpGateway = parseMcpGatewayConfiguration(object.mcpGateway);
  return {
    ...(typeof maxBudgetUsd === "number" ? { maxBudgetUsd } : {}),
    ...(typeof maxTurns === "number" ? { maxTurns } : {}),
    ...(mcpGateway ? { mcpGateway } : {}),
  };
}

/**
 * Validate the MCP gateway descriptor before it reaches a config file.
 *
 * The URL is required to be absolute http(s) here even though this Client composed it itself: this
 * function also runs over a configuration supplied by a caller, and a relative or `file:` URL would
 * otherwise be written into `mcp.json` for the CLI to interpret.
 */
function parseMcpGatewayConfiguration(value: unknown): ClaudeCodeMcpGatewayConfiguration | undefined {
  return parseHttpMcpGateway(value, "Claude Code");
}

function claudeCodeInput(request: AgentPromptRequest): Readonly<Record<string, unknown>> {
  return { ...claudeCodeUserMessage(request.input.items), uuid: randomUUID() };
}

function claudeCodeUserMessage(items: AgentPromptRequest["input"]["items"]): Readonly<Record<string, unknown>> {
  return {
    type: "user",
    message: {
      role: "user",
      content: items.map((item) => ({ type: "text", text: item.text })),
    },
    parent_tool_use_id: null,
  };
}

interface ProcessReady {
  readonly promise: Promise<ClaudeCodeProcessClient | undefined>;
  resolve(process?: ClaudeCodeProcessClient): void;
}

function deferredProcess(): ProcessReady {
  let resolve!: (process?: ClaudeCodeProcessClient) => void;
  const promise = new Promise<ClaudeCodeProcessClient | undefined>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * One OpenTag Run reports one terminal: the last result's outcome plus everything steered input added.
 *
 * Result fields have two scopes in Claude Code's streaming-input mode
 * (https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode):
 * - `usage` covers only its own turn and `num_turns` counts only that result's agent loop (coalesced
 *   completions report `num_turns: 0`), so both are summed across the Run's results.
 * - `total_cost_usd` is the process's running total, so the latest result supersedes earlier ones and
 *   summing would double-count. Every OpenTag Run spawns a fresh Claude Code process (`--resume` after
 *   the first Run) that is closed when the Run settles, so no earlier Run's spend accrues in this
 *   process and no in-process baseline is subtracted: the Run reports the last result's value, the
 *   same scope a single-result Run reports. Claude Code restores a resumed session's saved totals, so
 *   that value may include spend from earlier Runs of the session, exactly as before steering existed.
 * `duration_ms` and `duration_api_ms` are not parsed.
 */
function mergeTerminals(earlier: readonly ClaudeCodeTerminal[], last: ClaudeCodeTerminal): ClaudeCodeTerminal {
  if (earlier.length === 0) return last;
  const sum = (pick: (terminal: ClaudeCodeTerminal) => number | undefined): number | undefined => {
    const values = [...earlier, last].map(pick).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
  };
  const inputTokens = sum((terminal) => terminal.usage?.inputTokens);
  const cachedInputTokens = sum((terminal) => terminal.usage?.cachedInputTokens);
  const outputTokens = sum((terminal) => terminal.usage?.outputTokens);
  const numTurns = sum((terminal) => terminal.numTurns);
  const totalCostUsd = [...earlier, last].reduce<number | undefined>(
    (latest, terminal) => terminal.totalCostUsd ?? latest,
    undefined,
  );
  const usage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
  return {
    ...last,
    permissionDenials: [...earlier, last].flatMap((terminal) => terminal.permissionDenials),
    // A result Claude Code generated for itself has no model turn and no text.
    earlierResults: earlier.flatMap((terminal) => (terminal.result ? [terminal.result] : [])),
    ...(numTurns !== undefined ? { numTurns } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
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
    logger.debug({ code: "binding_invalid", error: String(error) }, "Claude Code binding was rejected");
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
    ...(typeof message.api_error_status === "number" ? { apiErrorStatus: message.api_error_status } : {}),
    ...(typeof message.result === "string" ? { result: message.result } : {}),
    ...(typeof message.stop_reason === "string" ? { stopReason: message.stop_reason } : {}),
    ...(isNonNegativeNumber(message.num_turns) ? { numTurns: message.num_turns } : {}),
    ...(isNonNegativeNumber(message.total_cost_usd) ? { totalCostUsd: message.total_cost_usd } : {}),
    ...(usage ? { usage } : {}),
  };
}

function claudeCodeRunResult(terminal: ClaudeCodeTerminal, assistantError: string | undefined): AgentProviderRunResult {
  const output = [...(terminal.earlierResults ?? []), ...(terminal.result === undefined ? [] : [terminal.result])].map(
    (text) => ({ type: "text" as const, text }),
  );
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
      code:
        providerFailureCode(terminal.subtype) !== "provider_error"
          ? providerFailureCode(terminal.subtype)
          : providerFailureCode(assistantError, terminal.apiErrorStatus),
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
  const inputTokens = isNonNegativeNumber(source.input_tokens) ? source.input_tokens : undefined;
  const cacheCreationInputTokens = isNonNegativeNumber(source.cache_creation_input_tokens)
    ? source.cache_creation_input_tokens
    : undefined;
  if (inputTokens !== undefined || cacheCreationInputTokens !== undefined) {
    const total = (inputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
    if (!Number.isSafeInteger(total)) throw protocolError("Claude Code input token usage overflowed");
    // Preserve cache writes without changing the shared report shape. Older reports that omitted this Provider field
    // remain readable and necessarily retain their historical undercount.
    usage.inputTokens = total;
  }
  if (isNonNegativeNumber(source.cache_read_input_tokens)) usage.cachedInputTokens = source.cache_read_input_tokens;
  if (isNonNegativeNumber(source.output_tokens)) usage.outputTokens = source.output_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function blockKey(messageId: string, index: number): string {
  return `${messageId}:content:${index}`;
}

function requireIndex(value: unknown): number {
  return requireProtocolIndex(value, "Claude Code content block has an invalid index");
}

function toJsonValue(value: unknown): JsonValue {
  return protocolJsonValue(value, "Claude Code event payload");
}

function requireString(value: unknown, message: string, allowEmpty = false): string {
  return requireProtocolString(value, message, allowEmpty, 8 * 1024 * 1024);
}
