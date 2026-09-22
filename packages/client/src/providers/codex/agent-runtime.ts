import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { getRuntimeConfigurationOptions, hashTuple, MCP_GATEWAY_SERVER_NAME } from "@opentag/shared";
import { BaseAgentRuntime } from "../../agent-runtime/base-agent-runtime.js";
import { composeRuntimeEnvironment } from "../../agent-runtime/environment.js";
import { AgentProviderError, AgentRuntimeError } from "../../agent-runtime/errors.js";
import {
  classifiedProviderProbeIssue,
  isBinaryShapedProviderProbeFailure,
  isTransientProviderProbeFailure,
} from "../../agent-runtime/probe-failure.js";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  type AgentAbortRequest,
  type AgentApprovalResponse,
  type AgentHostedToolCall,
  type AgentHostedToolResult,
  type AgentHostedTools,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentPromptRequest,
  type AgentProviderRunContext,
  type AgentProviderRunResult,
  type AgentQuestionResponse,
  type AgentRunConfiguration,
  type AgentRuntimeBinding,
  type AgentRuntimeEventSink,
  type AgentRuntimeFactory,
  type AgentRuntimeManifest,
  type AgentRuntimePolicy,
  type AgentRuntimeProbeRequest,
  type AgentRuntimeProbeResult,
  type AgentRuntimeWorkspace,
  type AgentSteerRequest,
  type CreateAgentRuntimeRequest,
  type JsonValue,
  type ResumeAgentRuntimeRequest,
} from "../../agent-runtime/types.js";
import {
  assertBinding,
  assertHostedTools,
  assertJsonValue,
  assertSystemPrompt,
} from "../../agent-runtime/validation.js";
import { createLogger } from "../../observability/logger.js";
import {
  CodexAppServerError,
  type CodexAppServerMessage,
  CodexAppServerProcess,
  type CodexAppServerRequest,
  type CodexDynamicToolCall,
  type CodexDynamicToolResult,
  type CodexSpawnOptions,
  type InteractiveCodexAppServerClient,
} from "./app-server-wire.js";

const execFileAsync = promisify(execFile);
const CODEX_BINDING_SCHEMA_VERSION = 1;
const CODEX_PROVIDER_ID = "codex";
const logger = createLogger("provider-codex-runtime");
const CODEX_CAPABILITY_PROBE_INSTRUCTIONS = "OpenTag Provider prompt-surface capability probe.";
/** One deadline for rebinding a thread to a run's MCP gateway; a slow gateway must not stall a turn. */
const CODEX_MCP_ATTACH_TIMEOUT_MS = 15_000;
/**
 * The share of that deadline the attach itself may use. The rest is reserved for restoring the
 * thread without MCP, so a timed-out attach still leaves time to recover the turn.
 */
const CODEX_MCP_ATTACH_BUDGET_SHARE = 2 / 3;
/** Codex's own MCP startup bound, kept inside the attach deadline. */
const CODEX_MCP_STARTUP_TIMEOUT_SEC = 10;
export const CODEX_AGENT_RUNTIME_APP_SERVER_ARGS = [
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
  "shell_snapshot",
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
  'shell_environment_policy.filters={ PATH = "include", ZDOTDIR = "include", LANG = "include", LC_ALL = "include", OPENTAG_HOME = "include", OPENTAG_PROVIDER_ENV_FILE = "include", OPENTAG_SESSION_PROOF_FILE = "include" }',
] as const;
const TOOL_ITEM_TYPES = new Set([
  "collabToolCall",
  "commandExecution",
  "dynamicToolCall",
  "fileChange",
  "imageView",
  "mcpToolCall",
  "webSearch",
]);

export const CODEX_AGENT_RUNTIME_MANIFEST: AgentRuntimeManifest = Object.freeze({
  providerId: CODEX_PROVIDER_ID,
  displayName: "Codex",
  contractVersion: AGENT_RUNTIME_CONTRACT_VERSION,
  bindingSchemaVersion: CODEX_BINDING_SCHEMA_VERSION,
});

/** The execution-scoped Server MCP gateway endpoint; both fields are opaque to this provider. */
interface CodexMcpGatewayEndpoint {
  readonly url: string;
  readonly token: string;
}

interface CodexProviderConfiguration {
  readonly mcpGateway?: CodexMcpGatewayEndpoint;
  readonly personality?: string;
  readonly serviceName?: string;
  readonly summary?: string;
}

interface CodexRuntimeOptions {
  readonly client: InteractiveCodexAppServerClient;
  readonly threadId: string;
  readonly eventSink: AgentRuntimeEventSink;
  readonly binding: AgentRuntimeBinding;
  readonly workspace: AgentRuntimeWorkspace;
  readonly policy: AgentRuntimePolicy;
  readonly configuration?: AgentRunConfiguration;
  readonly hostedTools?: AgentHostedTools;
  /** The parameters the thread was opened with, reused when rebinding its MCP servers. */
  readonly threadParams: Readonly<Record<string, unknown>>;
  /** Extra `thread/start` parameters, used to replace a thread that has no rollout yet. */
  readonly threadStartParams: Readonly<Record<string, unknown>>;
  /** Whether Codex has persisted the thread, so it can be unloaded and resumed. */
  readonly threadPersisted: boolean;
  readonly mcpAttachTimeoutMs: number;
}

export interface CodexAgentRuntimeFactoryOptions {
  readonly clientVersion: string;
  readonly createClient?: (
    cwd: string,
    environment?: Readonly<Record<string, string>>,
  ) => InteractiveCodexAppServerClient;
  readonly mcpAttachTimeoutMs?: number;
  readonly process?: Omit<CodexSpawnOptions, "cwd" | "env"> & { readonly env?: NodeJS.ProcessEnv };
  readonly probeRunner?: (signal?: AbortSignal) => Promise<{
    readonly appServer: boolean;
    readonly credential: boolean;
    readonly experimentalTools: boolean;
    readonly version: string;
  }>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

type CodexEnvelope =
  | { readonly type: "notification"; readonly message: CodexAppServerMessage }
  | { readonly type: "request"; readonly request: CodexAppServerRequest };

interface ParsedTurn {
  readonly error?: string;
  readonly id: string;
  readonly items: readonly Record<string, unknown>[];
  readonly status: "completed" | "failed" | "inProgress" | "interrupted";
}

export class CodexAgentRuntime extends BaseAgentRuntime {
  readonly #client: InteractiveCodexAppServerClient;
  #threadId: string;
  readonly #workspace: AgentRuntimeWorkspace;
  readonly #policy: AgentRuntimePolicy;
  readonly #configuration?: AgentRunConfiguration;
  readonly #hostedTools?: AgentHostedTools;
  readonly #threadParams: Readonly<Record<string, unknown>>;
  readonly #threadStartParams: Readonly<Record<string, unknown>>;
  /** Codex writes a thread's rollout only once a turn starts; until then it cannot be resumed. */
  #threadPersisted: boolean;
  readonly #mcpAttachTimeoutMs: number;
  /**
   * Whether the loaded thread may hold MCP state other than "none": a gateway catalogue, or an
   * interrupted rebind that may have left the thread unloaded. The next run rebinds it either way.
   */
  #mcpThreadDirty = false;
  /** Present only between run admission and `turn/start`, when there is no provider turn to interrupt. */
  #preTurnAbort?: AbortController;
  readonly #unsubscribeNotifications: () => void;
  readonly #unsubscribeRequests: () => void;
  readonly #wireInteractions = new Map<string, CodexAppServerRequest>();
  readonly #completedMessages = new Map<string, { readonly phase?: string; readonly text: string }>();
  readonly #activeMessages = new Map<string, string>();
  readonly #activeTools = new Map<string, string>();
  readonly #hostedToolCalls = new Map<
    string,
    { readonly hash: string; readonly result: Promise<CodexDynamicToolResult> }
  >();
  #eventTail: Promise<void> = Promise.resolve();
  #buffering = false;
  #buffered: CodexEnvelope[] = [];
  #context?: AgentProviderRunContext;
  #providerTurnId?: string;
  #turnIdReady?: Deferred<string>;
  #terminal?: Deferred<ParsedTurn>;
  #latestUsage?: { readonly inputTokens?: number; readonly cachedInputTokens?: number; readonly outputTokens?: number };
  #providerFailure?: Error;

  constructor(options: CodexRuntimeOptions) {
    super({
      manifest: CODEX_AGENT_RUNTIME_MANIFEST,
      capabilities: { steer: "supported", interactions: "supported" },
      eventSink: options.eventSink,
      binding: options.binding,
    });
    this.#client = options.client;
    this.#threadId = options.threadId;
    this.#workspace = options.workspace;
    this.#policy = options.policy;
    this.#configuration = options.configuration;
    this.#hostedTools = options.hostedTools;
    this.#threadParams = options.threadParams;
    this.#threadStartParams = options.threadStartParams;
    this.#threadPersisted = options.threadPersisted;
    this.#mcpAttachTimeoutMs = options.mcpAttachTimeoutMs;
    this.#client.setDynamicToolHandler?.((call) => this.#handleHostedTool(call));
    this.#unsubscribeNotifications = this.#client.subscribe((message) => {
      this.#enqueue({ type: "notification", message });
    });
    this.#unsubscribeRequests = this.#client.subscribeServerRequests((request) => {
      this.#enqueue({ type: "request", request });
    });
  }

  protected async executeRun(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
  ): Promise<AgentProviderRunResult> {
    this.#context = context;
    this.#providerTurnId = undefined;
    this.#providerFailure = undefined;
    this.#latestUsage = undefined;
    this.#completedMessages.clear();
    this.#activeMessages.clear();
    this.#activeTools.clear();
    this.#wireInteractions.clear();
    this.#buffered = [];
    this.#buffering = true;
    this.#turnIdReady = deferred<string>();
    this.#terminal = deferred<ParsedTurn>();
    void this.#turnIdReady.promise.catch(() => undefined);
    void this.#terminal.promise.catch(() => undefined);

    const preTurnAbort = new AbortController();
    this.#preTurnAbort = preTurnAbort;
    try {
      try {
        await this.#attachMcpGateway(request, context, AbortSignal.any([context.signal, preTurnAbort.signal]));
      } catch (error) {
        if (!preTurnAbort.signal.aborted) throw error;
      }
      // Checked after the attach settles: an abort that raced its completion must still win.
      if (preTurnAbort.signal.aborted) {
        return {
          status: "aborted",
          output: [],
          error: { code: "run_aborted", message: "Codex run was aborted before its turn started" },
        };
      }
      this.#preTurnAbort = undefined;
      const response = await this.#client.request("turn/start", this.#turnStartParams(request));
      this.#threadPersisted = true;
      const started = parseTurnResponse(response, "turn/start");
      if (started.status !== "inProgress") throw protocolError("turn/start returned a terminal turn");
      this.#providerTurnId = started.id;
      this.#turnIdReady.resolve(started.id);
      this.#buffering = false;
      const buffered = this.#buffered.splice(0);
      for (const envelope of buffered) this.#enqueue(envelope);
      await this.#eventTail;
      if (this.#providerFailure) throw this.#providerFailure;
      const terminal = await this.#terminal.promise;
      await this.#eventTail;
      if (this.#providerFailure) throw this.#providerFailure;
      await this.#completeOpenLifecycles(terminal);
      return this.#runResult(terminal);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Codex run failed");
      logger.debug({ code: "provider_run_failed", error: failure.message }, "Codex provider run failed");
      this.#turnIdReady.reject(failure);
      throw failure;
      /* v8 ignore next -- finally is mandatory cleanup; V8 reports a synthetic branch for its closing token. */
    } finally {
      this.#preTurnAbort = undefined;
      this.#buffering = false;
      this.#buffered = [];
      this.#context = undefined;
      this.#providerTurnId = undefined;
      this.#turnIdReady = undefined;
      this.#terminal = undefined;
      this.#wireInteractions.clear();
      this.#hostedToolCalls.clear();
    }
  }

  protected override async steerProvider(request: AgentSteerRequest): Promise<void> {
    const turnId = await this.#activeTurnId();
    const response = requireRecord(
      await this.#client.request("turn/steer", {
        threadId: this.#threadId,
        input: codexInput(request.input.items),
        expectedTurnId: turnId,
      }),
      "turn/steer returned an invalid response",
    );
    if (requireString(response.turnId, "turn/steer returned no turnId") !== turnId) {
      throw protocolError("turn/steer accepted another turn");
    }
  }

  protected override async respondProvider(response: AgentInteractionResponse): Promise<void> {
    const request = this.#wireInteractions.get(response.requestId);
    /* v8 ignore next -- Base and the serial Codex envelope queue fence this map with the public interaction. */
    if (!request) throw new AgentRuntimeError("interaction_not_found", "Codex interaction is no longer pending");
    const result = codexInteractionResult(request.method, response);
    await this.#client.respondServerRequest(request.id, result);
    this.#wireInteractions.delete(response.requestId);
  }

  protected override async abortProvider(request: AgentAbortRequest): Promise<void> {
    if (this.#preTurnAbort) {
      // No provider turn exists yet; cancelling the pending MCP attach is the whole interrupt.
      this.#preTurnAbort.abort();
      return;
    }
    const turnId = await this.#activeTurnId();
    /* v8 ignore next 3 -- Base validates expectedRunId before entering the Provider hook. */
    if (request.expectedRunId !== this.#context?.runId) {
      throw new AgentRuntimeError("run_mismatch", "abort no longer belongs to the active Codex turn");
    }
    await this.#client.interrupt(this.#threadId, turnId);
  }

  protected async closeProvider(): Promise<void> {
    if (this.#context) {
      const failure = new AgentProviderError("provider_error", "Codex runtime is closing");
      this.#providerFailure ??= failure;
      this.#terminal?.reject(failure);
      this.#turnIdReady?.reject(failure);
    }
    this.#unsubscribeRequests();
    this.#unsubscribeNotifications();
    this.#client.setDynamicToolHandler?.(undefined);
    await this.#client.close();
  }

  /**
   * Rebind the thread to this run's MCP gateway, or to none, before the turn starts.
   *
   * Codex spawns one App Server per Session, but the gateway bearer is minted per execution. Codex
   * applies a thread's `config` overrides only when it loads the thread, so the thread is reloaded
   * with the run's `mcp_servers`. The bearer travels over the App Server's stdio and is held only in
   * its memory: never in its argument vector, environment, or a config file, so what a model command
   * can reach is at most the live execution's own bearer, which the Server revokes when the
   * execution ends. A run without a gateway rebinds only when the thread may still hold one.
   *
   * One deadline covers the whole rebind, attach and restore alike. The attach may use only part of
   * it, so a timed-out attach still leaves the restore time to finish. Losing the gateway never costs
   * the Agent its turn: an unconfirmed attach leaves the thread with no MCP server rather than with
   * the run's bearer attached to a catalogue it did not confirm. Only a thread Codex cannot reload at
   * all within the deadline fails the run, because there is no thread left to start the turn on.
   */
  async #attachMcpGateway(
    request: AgentPromptRequest,
    context: AgentProviderRunContext,
    signal: AbortSignal,
  ): Promise<void> {
    const endpoint = parseProviderConfiguration(
      mergeConfiguration(this.#configuration, request.configuration)?.provider,
    ).mcpGateway;
    if (!endpoint && !this.#mcpThreadDirty) return;
    const startedAt = Date.now();
    const wasDirty = this.#mcpThreadDirty;
    this.#mcpThreadDirty = true;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.#mcpAttachTimeoutMs)]);
    const attachBudgetMs = Math.floor(this.#mcpAttachTimeoutMs * CODEX_MCP_ATTACH_BUDGET_SHARE);
    try {
      await this.#rebindThread(
        codexMcpServersConfig(endpoint),
        context,
        AbortSignal.any([deadline, AbortSignal.timeout(attachBudgetMs)]),
      );
      this.#mcpThreadDirty = endpoint !== undefined;
      logger.info(
        { attached: endpoint !== undefined, durationMs: Date.now() - startedAt },
        "Codex thread rebound to the run's MCP gateway",
      );
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warn(
        { code: "mcp_attach_failed", error: String(error), durationMs: Date.now() - startedAt },
        "Codex could not rebind the thread to the MCP gateway; continuing without MCP tools",
      );
    }
    // An unpersisted thread is only ever replaced, so the loaded one kept its previous MCP state.
    if (!this.#threadPersisted) {
      this.#mcpThreadDirty = wasDirty;
      return;
    }
    await this.#rebindThread(codexMcpServersConfig(undefined), context, deadline);
    this.#mcpThreadDirty = false;
  }

  async #rebindThread(
    config: Record<string, unknown>,
    context: AgentProviderRunContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.#threadPersisted) {
      await this.#replaceUnpersistedThread(config, context, signal);
      return;
    }
    await this.#client.request("thread/unsubscribe", { threadId: this.#threadId }, signal);
    const response = requireRecord(
      await this.#client.request(
        "thread/resume",
        { ...this.#threadParams, threadId: this.#threadId, excludeTurns: true, config },
        signal,
      ),
      "thread/resume returned an invalid response",
    );
    const thread = requireRecord(response.thread, "thread/resume returned no thread");
    if (thread.id !== this.#threadId) throw protocolError("thread/resume restored another thread");
  }

  /**
   * A thread that has never started a turn has no rollout to resume and no history to lose, so it is
   * replaced by a new thread with the run's MCP servers and the binding moves to it. The previous
   * thread stays loaded until the replacement exists, so a failed attach leaves it untouched, and it
   * is unloaded without delaying the turn.
   */
  async #replaceUnpersistedThread(
    config: Record<string, unknown>,
    context: AgentProviderRunContext,
    signal: AbortSignal,
  ): Promise<void> {
    const response = requireRecord(
      await this.#client.request("thread/start", { ...this.#threadStartParams, config }, signal),
      "thread/start returned an invalid response",
    );
    const thread = requireRecord(response.thread, "thread/start returned no thread");
    const threadId = requireString(thread.id, "thread/start returned no thread id");
    const previous = this.#threadId;
    /* v8 ignore next -- a runtime always has a binding once its factory has opened the thread. */
    const payload = record(this.binding?.payload) ?? {};
    const binding: AgentRuntimeBinding = {
      providerId: CODEX_PROVIDER_ID,
      schemaVersion: CODEX_BINDING_SCHEMA_VERSION,
      payload: { ...(payload as Record<string, JsonValue>), threadId },
    };
    assertBinding(binding, this.manifest);
    await context.updateBinding(binding);
    this.#threadId = threadId;
    // Unloading the replaced thread is housekeeping, so it stays off the turn's critical path; the
    // rebind signal still releases it on the deadline or on cancellation.
    void this.#client.request("thread/unsubscribe", { threadId: previous }, signal).catch((error: unknown) => {
      logger.debug(
        { code: "replaced_thread_unsubscribe_failed", error: String(error) },
        "Codex did not unload a replaced thread",
      );
    });
  }

  async #handleHostedTool(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    const hash = JSON.stringify({
      arguments: call.arguments,
      namespace: call.namespace,
      threadId: call.threadId,
      tool: call.tool,
      turnId: call.turnId,
    });
    const existing = this.#hostedToolCalls.get(call.callId);
    if (existing) {
      return existing.hash === hash
        ? existing.result
        : { success: false, text: "OpenTag rejected conflicting reuse of a hosted tool call ID." };
    }
    const result = this.#executeHostedTool(call);
    this.#hostedToolCalls.set(call.callId, { hash, result });
    return result;
  }

  async #executeHostedTool(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    const context = this.#context;
    const hostedTools = this.#hostedTools;
    if (!context || !hostedTools || call.namespace !== null || call.threadId !== this.#threadId) {
      return { success: false, text: "OpenTag tool request is not authorized for this run." };
    }
    const toolAllowed =
      this.#policy.tools.mode === "allow-list"
        ? this.#policy.tools.names.includes(call.tool)
        : hostedTools.definitions.some(({ name }) => name === call.tool);
    if (call.turnId !== this.#providerTurnId || !toolAllowed) {
      return { success: false, text: "OpenTag tool request is not authorized for this run." };
    }
    try {
      const input = toJsonValue(call.arguments);
      const request: AgentHostedToolCall = {
        runId: context.runId,
        toolCallId: call.callId,
        name: call.tool,
        input,
        signal: context.signal,
      };
      return codexHostedToolResult(await hostedTools.handler(request));
    } catch (error) {
      logger.debug({ code: "hosted_tool_failed", error: String(error) }, "Codex hosted tool execution failed");
      return {
        success: false,
        text: error instanceof Error ? `OpenTag tool request failed: ${error.message}` : "OpenTag tool request failed.",
      };
    }
  }

  #enqueue(envelope: CodexEnvelope): void {
    this.#claimTerminalAtIngress(envelope);
    const next = this.#eventTail.then(async () => {
      if (!this.#context) return;
      if (this.#buffering) {
        this.#buffered.push(envelope);
        return;
      }
      if (envelope.type === "notification") await this.#handleNotification(envelope.message);
      else await this.#handleServerRequest(envelope.request);
    });
    this.#eventTail = next.catch((error: unknown) => {
      logger.debug({ code: "event_processing_failed", error: String(error) }, "Codex event processing failed");
      this.#failProvider(error instanceof Error ? error : protocolError("Codex event processing failed"));
    });
  }

  async #handleNotification(message: CodexAppServerMessage): Promise<void> {
    const method = message.method;
    if (method === "opentag/processError") {
      const params = record(message.params);
      throw params?.error instanceof Error
        ? params.error
        : new AgentProviderError("provider_error", "Codex process failed");
    }
    if (typeof method !== "string") throw protocolError("Codex emitted a notification without a method");
    const context = this.#requireContext();
    const params = record(message.params);

    if (method === "warning" || method === "configWarning") {
      const text = requireString(params?.message ?? params?.summary, `${method} has no message`);
      await context.emit({ type: "provider_warning", code: method, message: text });
      return;
    }
    if (method === "serverRequest/resolved") {
      const wireId = params?.requestId;
      const interactionId = this.#interactionIdForWireId(wireId);
      if (!interactionId) return;
      this.#wireInteractions.delete(interactionId);
      await context.resolveInteraction(interactionId, "expired");
      return;
    }
    if (method === "thread/closed") {
      if (params?.threadId !== undefined && params.threadId !== this.#threadId) return;
      throw new AgentProviderError("provider_error", "Codex thread closed during an active run");
    }
    if (method === "turn/started") {
      const turn = parseTurn(params?.turn, "turn/started");
      this.#assertTurn(turn.id);
      return;
    }
    if (method === "turn/completed") {
      const turn = this.#parseCompletedTurn(params);
      context.claimTerminal();
      this.#terminal?.resolve(turn);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      if (params?.turnId !== undefined && params.turnId !== this.#providerTurnId) return;
      const usage = parseUsage(params?.tokenUsage);
      this.#latestUsage = usage;
      await context.emit({ type: "usage_updated", usage });
      return;
    }
    if (method === "item/agentMessage/delta") {
      this.#assertNotificationTurn(params);
      const messageId = requireString(params?.itemId, "agent message delta has no itemId");
      const delta = requireString(params?.delta, "agent message delta has no text", true);
      await this.#ensureMessageStarted(messageId);
      this.#activeMessages.set(messageId, `${this.#activeMessages.get(messageId) as string}${delta}`);
      await context.emit({
        type: "message_delta",
        messageId,
        delta,
      });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      this.#assertNotificationTurn(params);
      const toolCallId = requireString(params?.itemId, "command output delta has no itemId");
      await this.#ensureToolStarted(toolCallId, "commandExecution", { id: toolCallId, type: "commandExecution" });
      await context.emit({
        type: "tool_updated",
        toolCallId,
        update: { delta: requireString(params?.delta, "command output delta has no text", true) },
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.#assertNotificationTurn(params);
      const item = requireRecord(params?.item, `${method} has no item`);
      await this.#handleItem(method, item);
      return;
    }
    if (method === "error") {
      const error = record(params?.error);
      await context.emit({
        type: "provider_warning",
        code: "codex_turn_error",
        message: typeof error?.message === "string" ? error.message : "Codex reported a turn error",
      });
      return;
    }
    if (method === "turn/plan/updated" || method === "turn/diff/updated" || method.startsWith("model/")) {
      await context.emit({
        type: "provider_event",
        providerId: CODEX_PROVIDER_ID,
        schemaVersion: 1,
        payload: { method, params: toJsonValue(params ?? {}) },
      });
    }
  }

  async #handleItem(method: "item/completed" | "item/started", item: Record<string, unknown>): Promise<void> {
    const context = this.#requireContext();
    const id = requireString(item.id, `${method} item has no id`);
    const type = requireString(item.type, `${method} item has no type`);
    if (type === "agentMessage") {
      if (method === "item/started") {
        await this.#ensureMessageStarted(id);
        return;
      }
      const text = requireString(item.text, "completed agent message has no text", true);
      const phase = typeof item.phase === "string" ? item.phase : undefined;
      await this.#ensureMessageStarted(id);
      this.#completedMessages.set(id, { text, ...(phase ? { phase } : {}) });
      await context.emit({ type: "message_completed", messageId: id, text });
      this.#activeMessages.delete(id);
      return;
    }
    if (!TOOL_ITEM_TYPES.has(type)) return;
    const name =
      method === "item/completed" ? (this.#activeTools.get(id) ?? toolName(item, type)) : toolName(item, type);
    if (method === "item/started") {
      await this.#ensureToolStarted(id, name, item);
      return;
    }
    await this.#ensureToolStarted(id, name, item);
    const status = item.status === "declined" ? "declined" : item.status === "failed" ? "failed" : "completed";
    await context.emit({
      type: "tool_completed",
      toolCallId: id,
      name,
      status,
      output: toJsonValue(item),
    });
    this.#activeTools.delete(id);
  }

  async #ensureMessageStarted(messageId: string): Promise<void> {
    if (this.#activeMessages.has(messageId)) return;
    if (this.#completedMessages.has(messageId)) throw protocolError("Codex reused a completed agent message ID");
    this.#activeMessages.set(messageId, "");
    await this.#requireContext().emit({ type: "message_started", messageId });
  }

  async #ensureToolStarted(toolCallId: string, name: string, input: Record<string, unknown>): Promise<void> {
    const activeName = this.#activeTools.get(toolCallId);
    if (activeName) {
      if (activeName !== name) throw protocolError("Codex changed a tool name during its lifecycle");
      return;
    }
    this.#activeTools.set(toolCallId, name);
    await this.#requireContext().emit({ type: "tool_started", toolCallId, name, input: toJsonValue(input) });
  }

  async #completeOpenLifecycles(turn: ParsedTurn): Promise<void> {
    const context = this.#requireContext();
    const terminalItems = new Map(
      turn.items.filter((item) => typeof item.id === "string").map((item) => [item.id as string, item] as const),
    );
    for (const [messageId, deltaText] of this.#activeMessages) {
      const item = terminalItems.get(messageId);
      const text = typeof item?.text === "string" ? item.text : deltaText;
      await context.emit({ type: "message_completed", messageId, text });
      this.#activeMessages.delete(messageId);
    }
    for (const [toolCallId, name] of this.#activeTools) {
      const item = terminalItems.get(toolCallId);
      const status =
        item?.status === "declined"
          ? "declined"
          : !item || item.status === "failed" || turn.status !== "completed"
            ? "failed"
            : "completed";
      await context.emit({
        type: "tool_completed",
        toolCallId,
        name,
        status,
        ...(item ? { output: toJsonValue(item) } : {}),
      });
      this.#activeTools.delete(toolCallId);
    }
  }

  async #handleServerRequest(request: CodexAppServerRequest): Promise<void> {
    const context = this.#requireContext();
    const params = requireRecord(request.params, `${request.method} has invalid params`);
    if (params.threadId !== undefined && params.threadId !== this.#threadId) {
      throw protocolError("Codex server request belongs to another thread");
    }
    if (params.turnId !== undefined && params.turnId !== this.#providerTurnId) {
      throw protocolError("Codex server request belongs to another turn");
    }
    const interaction = codexInteractionRequest(request, params);
    if (!interaction) {
      await this.#client.rejectServerRequest(request.id, -32601, "Unsupported Codex server request");
      throw protocolError(`Codex requested an unsupported method: ${request.method}`);
    }
    const requestId = interaction.requestId;
    if (this.#wireInteractions.has(requestId)) throw protocolError("Codex reused a pending server request ID");
    this.#wireInteractions.set(requestId, request);
    try {
      await context.requestInteraction(interaction);
    } catch (error) {
      this.#wireInteractions.delete(requestId);
      await this.#client
        .rejectServerRequest(request.id, -32000, "OpenTag could not deliver the interaction")
        .catch((rejectionError: unknown) => {
          logger.debug(
            {
              code: "interaction_rejection_failed",
              error: String(rejectionError),
            },
            "Codex interaction rejection failed",
          );
        });
      throw error;
    }
  }

  #turnStartParams(request: AgentPromptRequest): Record<string, unknown> {
    const configuration = mergeConfiguration(this.#configuration, request.configuration);
    const provider = parseProviderConfiguration(configuration?.provider);
    return {
      threadId: this.#threadId,
      input: codexInput(request.input.items),
      cwd: this.#workspace.cwd,
      approvalPolicy: codexApprovalPolicy(this.#policy.approvals),
      sandboxPolicy: codexSandboxPolicy(this.#workspace, this.#policy),
      ...(configuration?.model ? { model: configuration.model } : {}),
      ...(configuration?.reasoningEffort ? { effort: configuration.reasoningEffort } : {}),
      ...(provider.personality ? { personality: provider.personality } : {}),
      ...(provider.summary ? { summary: provider.summary } : {}),
    };
  }

  #runResult(turn: ParsedTurn): AgentProviderRunResult {
    const finalText = selectFinalText(turn.items, this.#completedMessages);
    const output = finalText === undefined ? [] : [{ type: "text" as const, text: finalText }];
    const diagnostics: JsonValue = { providerThreadId: this.#threadId, providerTurnId: turn.id };
    if (turn.status === "completed") {
      return {
        status: "completed",
        output,
        ...(this.#latestUsage ? { usage: this.#latestUsage } : {}),
        diagnostics,
      };
    }
    if (turn.status === "interrupted") {
      return {
        status: "aborted",
        output,
        ...(this.#latestUsage ? { usage: this.#latestUsage } : {}),
        error: { code: "run_aborted", message: "Codex turn was interrupted" },
        diagnostics,
      };
    }
    return {
      status: "failed",
      output,
      ...(this.#latestUsage ? { usage: this.#latestUsage } : {}),
      error: { code: "provider_error", message: turn.error ?? "Codex turn failed" },
      diagnostics,
    };
  }

  async #activeTurnId(): Promise<string> {
    if (this.#providerTurnId) return this.#providerTurnId;
    if (!this.#turnIdReady) throw new AgentRuntimeError("run_mismatch", "there is no active Codex turn");
    return this.#turnIdReady.promise;
  }

  #assertNotificationTurn(params: Record<string, unknown> | undefined): void {
    if (params?.threadId !== undefined && params.threadId !== this.#threadId) {
      throw protocolError("Codex notification belongs to another thread");
    }
    if (params?.turnId !== this.#providerTurnId) throw protocolError("Codex notification belongs to another turn");
  }

  #assertTurn(turnId: string): void {
    if (turnId !== this.#providerTurnId) throw protocolError("Codex turn identity changed during a run");
  }

  #requireContext(): AgentProviderRunContext {
    /* v8 ignore next -- #enqueue drops envelopes before a Run context exists. */
    if (!this.#context) throw protocolError("Codex event arrived without an active run");
    return this.#context;
  }

  #claimTerminalAtIngress(envelope: CodexEnvelope): void {
    if (
      envelope.type !== "notification" ||
      envelope.message.method !== "turn/completed" ||
      this.#buffering ||
      !this.#context
    ) {
      return;
    }
    try {
      this.#parseCompletedTurn(record(envelope.message.params));
      this.#context.claimTerminal();
    } catch (error) {
      logger.debug({ code: "terminal_message_invalid", error: String(error) }, "Codex terminal message was rejected");
      // The serial event queue preserves the authoritative fail-closed error path.
    }
  }

  #parseCompletedTurn(params: Record<string, unknown> | undefined): ParsedTurn {
    const turn = parseTurn(params?.turn, "turn/completed");
    this.#assertTurn(turn.id);
    if (turn.status === "inProgress") throw protocolError("turn/completed carried an active turn");
    return turn;
  }

  #failProvider(error: Error): void {
    if (this.#providerFailure) return;
    this.#providerFailure = error;
    this.#terminal?.reject(error);
    this.#turnIdReady?.reject(error);
    this.closeForProviderFailure();
  }

  #interactionIdForWireId(wireId: unknown): string | undefined {
    for (const [interactionId, request] of this.#wireInteractions) {
      /* v8 ignore else -- the map holds one in-flight interaction, so lookups match on the first entry. */
      if (request.id === wireId) return interactionId;
    }
    return undefined;
  }
}

export class CodexAgentRuntimeFactory implements AgentRuntimeFactory {
  readonly manifest = CODEX_AGENT_RUNTIME_MANIFEST;
  readonly #clientVersion: string;
  readonly #createClient: (
    cwd: string,
    environment?: Readonly<Record<string, string>>,
    pathPrepend?: string,
  ) => InteractiveCodexAppServerClient;
  readonly #mcpAttachTimeoutMs: number;
  readonly #probeRunner: (signal?: AbortSignal) => Promise<{
    readonly appServer: boolean;
    readonly credential: boolean;
    readonly experimentalTools: boolean;
    readonly version: string;
  }>;

  constructor(options: CodexAgentRuntimeFactoryOptions) {
    this.#clientVersion = options.clientVersion;
    const environment = options.process?.env ?? codexAgentRuntimeEnvironment();
    const command = options.process?.command ?? "codex";
    const createDefaultClient = (
      cwd: string,
      workspaceEnvironment?: Readonly<Record<string, string>>,
      pathPrepend?: string,
      expectedCodexHome = options.process?.expectedCodexHome,
    ) => {
      // Snapshots and ~/.zshenv can both put ambient CLIs ahead of the Session launcher. With
      // snapshots disabled above, managed executions keep zsh initialization in their state home.
      const shellHome = pathPrepend ? workspaceEnvironment?.OPENTAG_HOME : undefined;
      const managedArgs = [
        ...CODEX_AGENT_RUNTIME_APP_SERVER_ARGS,
        ...(shellHome ? ["-c", `shell_environment_policy.set.ZDOTDIR=${JSON.stringify(shellHome)}`] : []),
      ];
      return new CodexAppServerProcess({
        command,
        args: options.process?.args ?? managedArgs,
        cwd,
        env: composeRuntimeEnvironment(environment, workspaceEnvironment, pathPrepend),
        expectedCodexHome,
        maxLineBytes: options.process?.maxLineBytes,
        requestTimeoutMs: options.process?.requestTimeoutMs,
        spawnProcess: options.process?.spawnProcess,
      });
    };
    this.#createClient = options.createClient ?? createDefaultClient;
    this.#mcpAttachTimeoutMs = options.mcpAttachTimeoutMs ?? CODEX_MCP_ATTACH_TIMEOUT_MS;
    const createProbeClient =
      options.createClient ??
      ((cwd: string, probeEnvironment?: Readonly<Record<string, string>>) =>
        createDefaultClient(cwd, probeEnvironment, undefined, probeEnvironment?.CODEX_HOME));
    this.#probeRunner =
      options.probeRunner ??
      (async (signal) => {
        const local = await probeCodex(command, environment, signal);
        if (!local.credential) return { ...local, experimentalTools: false };
        const probeHome = await realpath(await mkdtemp(join(tmpdir(), "opentag-codex-capability-")));
        const startClient = createProbeClient(process.cwd(), { CODEX_HOME: probeHome });
        let bootstrapClient: InteractiveCodexAppServerClient | undefined;
        let resumeClient: InteractiveCodexAppServerClient | undefined;
        try {
          await startClient.initialize(this.#clientVersion, signal);
          const startResponse = requireRecord(
            await startClient.request(
              "thread/start",
              {
                cwd: process.cwd(),
                developerInstructions: CODEX_CAPABILITY_PROBE_INSTRUCTIONS,
                approvalPolicy: "never",
                sandbox: "read-only",
                ephemeral: false,
                dynamicTools: [
                  {
                    type: "function",
                    name: "opentag_capability_probe",
                    description: "Validate Codex dynamic tool protocol support.",
                    inputSchema: { type: "object", additionalProperties: false, properties: {} },
                  },
                ],
              },
              signal,
            ),
            "Codex capability probe start returned an invalid response",
          );
          const startedThread = requireRecord(startResponse.thread, "Codex capability probe start returned no thread");
          const threadId = requireString(startedThread.id, "Codex capability probe start returned no thread id");
          /* v8 ignore next -- probe client teardown is best-effort between probe phases. */
          await startClient.close().catch(() => undefined);
          bootstrapClient = createProbeClient(process.cwd(), { CODEX_HOME: probeHome });
          await bootstrapClient.initialize(this.#clientVersion, signal);
          const bootstrapResponse = requireRecord(
            await bootstrapClient.request(
              "thread/resume",
              {
                threadId,
                cwd: process.cwd(),
                developerInstructions: CODEX_CAPABILITY_PROBE_INSTRUCTIONS,
                approvalPolicy: "never",
                sandbox: "read-only",
                history: [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "OpenTag capability probe history." }],
                  },
                ],
              },
              signal,
            ),
            "Codex capability probe bootstrap returned an invalid response",
          );
          const bootstrapThread = requireRecord(
            bootstrapResponse.thread,
            "Codex capability probe bootstrap returned no thread",
          );
          const bootstrapThreadId = requireString(
            bootstrapThread.id,
            "Codex capability probe bootstrap returned no thread id",
          );
          /* v8 ignore next -- probe client teardown is best-effort between probe phases. */
          await bootstrapClient.close().catch(() => undefined);
          resumeClient = createProbeClient(process.cwd(), { CODEX_HOME: probeHome });
          await resumeClient.initialize(this.#clientVersion, signal);
          const resumeResponse = requireRecord(
            await resumeClient.request(
              "thread/resume",
              {
                threadId: bootstrapThreadId,
                cwd: process.cwd(),
                developerInstructions: CODEX_CAPABILITY_PROBE_INSTRUCTIONS,
                approvalPolicy: "never",
                sandbox: "read-only",
              },
              signal,
            ),
            "Codex capability probe exact resume returned an invalid response",
          );
          const resumedThread = requireRecord(
            resumeResponse.thread,
            "Codex capability probe exact resume returned no thread",
          );
          if (
            requireString(resumedThread.id, "Codex capability probe exact resume returned no thread id") !==
            bootstrapThreadId
          ) {
            throw new CodexAppServerError("protocol", "Codex capability probe resumed another thread");
          }
          return { ...local, experimentalTools: true };
        } finally {
          /* v8 ignore start -- probe teardown is best-effort; close and rm failures must not mask the probe result. */
          await startClient.close().catch((error: unknown) => {
            logger.debug(
              { code: "probe_start_close_failed", error: String(error) },
              "Codex capability probe start client close failed",
            );
          });
          await bootstrapClient?.close().catch((error: unknown) => {
            logger.debug(
              { code: "probe_bootstrap_close_failed", error: String(error) },
              "Codex capability probe bootstrap client close failed",
            );
          });
          await resumeClient?.close().catch((error: unknown) => {
            logger.debug(
              { code: "probe_resume_close_failed", error: String(error) },
              "Codex capability probe resume client close failed",
            );
          });
          await rm(probeHome, { recursive: true, force: true }).catch((error: unknown) => {
            logger.debug(
              { code: "probe_home_cleanup_failed", error: String(error) },
              "Codex capability probe home cleanup failed",
            );
          });
          /* v8 ignore stop */
        }
      });
  }

  async probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult> {
    const issues: AgentRuntimeProbeResult["issues"][number][] = [];
    try {
      validateConfiguration(request.configuration);
    } catch (error) {
      issues.push({
        code: "configuration_invalid",
        message: (error as Error).message,
      });
    }
    let version: string | undefined;
    try {
      const result = await this.#probeRunner(request.signal);
      version = result.version;
      if (!result.appServer) issues.push({ code: "version_incompatible", message: "Codex App Server is unavailable" });
      if (!result.credential) issues.push({ code: "credential_missing", message: "Codex credentials were not found" });
      if (result.appServer && result.credential && !result.experimentalTools) {
        issues.push({
          code: "version_incompatible",
          message: "Codex experimental dynamic tools are unavailable",
        });
      }
    } catch (error) {
      if (request.signal?.aborted) throw error;
      logger.debug({ code: "probe_execution_failed", error: String(error) }, "Codex probe execution failed");
      const issue = probeIssue(error);
      if (!issue) throw error;
      issues.push(issue);
    }
    return { ready: issues.length === 0, ...(version ? { version } : {}), issues };
  }

  create(request: CreateAgentRuntimeRequest): Promise<CodexAgentRuntime> {
    return this.#open(request, "create");
  }

  resume(request: ResumeAgentRuntimeRequest): Promise<CodexAgentRuntime> {
    return this.#open(request, "resume");
  }

  async #open(
    request: CreateAgentRuntimeRequest | ResumeAgentRuntimeRequest,
    mode: "create" | "resume",
  ): Promise<CodexAgentRuntime> {
    validateFactoryRequest(request);
    validateConfiguration(request.configuration);
    const providerConfiguration = parseProviderConfiguration(request.configuration?.provider);
    const binding = mode === "resume" && "binding" in request ? request.binding : undefined;
    if (binding) assertBinding(binding, this.manifest);
    const parsedBinding = binding ? parseCodexBinding(binding) : undefined;
    const expectedThreadId = parsedBinding?.threadId;
    const requestedHostedToolsHash = request.hostedTools ? hostedToolsHash(request.hostedTools.definitions) : undefined;
    if (mode === "resume" && parsedBinding?.hostedToolsHash !== requestedHostedToolsHash) {
      throw new AgentRuntimeError(
        "binding_incompatible",
        "Codex binding hosted tools cannot change during exact resume",
      );
    }
    const client = this.#createClient(
      request.workspace.cwd,
      request.workspace.environment,
      request.workspace.pathPrepend,
    );
    try {
      if (request.hostedTools && typeof client.setDynamicToolHandler !== "function") {
        throw new AgentRuntimeError(
          "configuration_invalid",
          "Codex App Server transport does not support hosted dynamic tools",
        );
      }
      await client.initialize(this.#clientVersion);
      const method = mode === "create" ? "thread/start" : "thread/resume";
      const threadParams = {
        cwd: request.workspace.cwd,
        developerInstructions: request.systemPrompt,
        approvalPolicy: codexApprovalPolicy(request.policy.approvals),
        sandbox: codexSandboxMode(request.policy.fileSystem),
        ...(request.configuration?.model ? { model: request.configuration.model } : {}),
        ...(providerConfiguration.personality ? { personality: providerConfiguration.personality } : {}),
        serviceName: providerConfiguration.serviceName ?? "OpenTag",
      };
      const threadStartParams = {
        ...threadParams,
        ephemeral: false,
        ...(request.hostedTools
          ? { dynamicTools: request.hostedTools.definitions.map(codexDynamicToolDefinition) }
          : {}),
      };
      const response = requireRecord(
        await client.request(
          method,
          method === "thread/start" ? threadStartParams : { ...codexResumeParams(expectedThreadId), ...threadParams },
        ),
        `${method} returned an invalid response`,
      );
      const thread = requireRecord(response.thread, `${method} returned no thread`);
      const threadId = requireString(thread.id, `${method} returned no thread id`);
      if (method === "thread/resume" && expectedThreadId && threadId !== expectedThreadId)
        throw protocolError("thread/resume restored another thread");
      const runtimeBinding: AgentRuntimeBinding = {
        providerId: CODEX_PROVIDER_ID,
        schemaVersion: CODEX_BINDING_SCHEMA_VERSION,
        payload: {
          threadId,
          ...(requestedHostedToolsHash ? { hostedToolsHash: requestedHostedToolsHash } : {}),
        },
      };
      assertBinding(runtimeBinding, this.manifest);
      await request.eventSink({ type: "binding_changed", binding: runtimeBinding });
      return new CodexAgentRuntime({
        client,
        threadId,
        eventSink: request.eventSink,
        binding: runtimeBinding,
        workspace: request.workspace,
        policy: request.policy,
        configuration: request.configuration,
        hostedTools: request.hostedTools,
        threadParams,
        threadStartParams,
        threadPersisted: method === "thread/resume",
        mcpAttachTimeoutMs: this.#mcpAttachTimeoutMs,
      });
    } catch (error) {
      logger.debug({ code: "runtime_create_failed", error: String(error) }, "Codex runtime creation failed");
      await client.close().catch((closeError: unknown) => {
        logger.debug({ code: "provider_close_failed", error: String(closeError) }, "Codex provider close failed");
      });
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError(mode === "create" ? "create_failed" : "resume_failed", `Codex ${mode} failed`, {
        cause: error,
      });
    }
  }
}

export function codexBindingRequiresHostedToolReplacement(
  binding: AgentRuntimeBinding,
  hostedTools: AgentHostedTools | undefined,
): boolean {
  assertBinding(binding, CODEX_AGENT_RUNTIME_MANIFEST);
  const current = parseCodexBinding(binding).hostedToolsHash;
  const requested = hostedTools ? hostedToolsHash(hostedTools.definitions) : undefined;
  return current !== requested;
}

export function codexAgentRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = [
    "CODEX_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "OPENTAG_PROVIDER_ENV_FILE",
    "OPENTAG_HOME",
    "OPENTAG_SESSION_PROOF_FILE",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SystemRoot",
    "TMPDIR",
    "USER",
    "WINDIR",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

function probeIssue(error: unknown): AgentRuntimeProbeResult["issues"][number] | undefined {
  if (error instanceof AgentProviderError && error.code === "provider_protocol_error") {
    return { code: "version_incompatible", message: `Codex App Server protocol is incompatible: ${error.message}` };
  }
  if (error instanceof CodexAppServerError) {
    if (error.code === "protocol") {
      return { code: "version_incompatible", message: `Codex App Server protocol is incompatible: ${error.message}` };
    }
    if (error.code === "timeout" || error.code === "aborted" || error.code === "write") {
      return { code: "temporarily_unavailable", message: `Codex App Server is unavailable: ${error.message}` };
    }
    if (isTransientProviderProbeFailure(error)) {
      return { code: "temporarily_unavailable", message: `Codex App Server is unavailable: ${error.message}` };
    }
    if (isBinaryShapedProviderProbeFailure(error)) {
      return typeof error.exitCode === "number" && error.exitCode !== 0 && !error.signal
        ? { code: "version_incompatible", message: `Codex App Server protocol is incompatible: ${error.message}` }
        : { code: "artifact_missing", message: "Codex CLI could not be executed" };
    }
    return undefined;
  }
  return classifiedProviderProbeIssue(error, "Codex CLI could not be executed");
}

async function probeCodex(
  command: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ readonly appServer: boolean; readonly credential: boolean; readonly version: string }> {
  const execution = { encoding: "utf8" as const, env: environment, signal, timeout: 5_000, windowsHide: true };
  const versionResult = await execFileAsync(command, ["--version"], execution);
  const version = versionResult.stdout.trim();
  if (!version) throw new Error("Codex CLI returned no version");
  await execFileAsync(command, ["app-server", "--help"], execution);
  let credential = false;
  try {
    await execFileAsync(command, ["login", "status"], execution);
    credential = true;
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.debug({ code: "credential_status_failed", error: String(error) }, "Codex credential status command failed");
  }
  return { appServer: true, credential, version };
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
  assertHostedTools(request.policy, request.hostedTools);
  if (request.policy.fileSystem === "read-only" && (request.workspace.writableRoots?.length ?? 0) > 0) {
    throw new AgentRuntimeError("configuration_invalid", "read-only policy cannot have writable roots");
  }
  if (request.policy.fileSystem === "read-only" && request.policy.network === "enabled") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Codex cannot guarantee read-only filesystem with enabled network",
    );
  }
  if (request.policy.fileSystem === "unrestricted" && request.policy.network === "disabled") {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "Codex cannot restrict network in unrestricted filesystem mode",
    );
  }
}

function validateConfiguration(configuration: AgentRunConfiguration | undefined): void {
  if (!configuration) return;
  if (configuration.model !== undefined && configuration.model.trim().length === 0) {
    throw new AgentRuntimeError("configuration_invalid", "model must be non-empty");
  }
  if (
    configuration.reasoningEffort &&
    !getRuntimeConfigurationOptions("codex").reasoningEffortAllowedValues.includes(configuration.reasoningEffort)
  ) {
    throw new AgentRuntimeError("configuration_invalid", "Codex reasoning effort is unsupported");
  }
  parseProviderConfiguration(configuration.provider);
}

function parseProviderConfiguration(value: JsonValue | undefined): CodexProviderConfiguration {
  if (value === undefined) return {};
  assertJsonValue(value, "configuration.provider");
  const object = record(value);
  if (!object) throw new AgentRuntimeError("configuration_invalid", "Codex provider configuration must be an object");
  const allowed = new Set(["mcpGateway", "personality", "serviceName", "summary"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key))
      throw new AgentRuntimeError("configuration_invalid", `unknown Codex configuration field: ${key}`);
  }
  const mcpGateway = parseMcpGatewayConfiguration(object.mcpGateway);
  const result: { mcpGateway?: CodexMcpGatewayEndpoint; personality?: string; serviceName?: string; summary?: string } =
    mcpGateway ? { mcpGateway } : {};
  for (const key of ["personality", "serviceName", "summary"] as const) {
    const item = object[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new AgentRuntimeError("configuration_invalid", `Codex configuration ${key} must be non-empty`);
    }
    result[key] = item;
  }
  return result;
}

/**
 * Validate the MCP gateway descriptor before Codex is pointed at it.
 *
 * The URL must be absolute http(s): this also runs over caller-supplied configuration, and Codex
 * would otherwise present the execution bearer to whatever it names.
 */
function parseMcpGatewayConfiguration(value: unknown): CodexMcpGatewayEndpoint | undefined {
  if (value === undefined) return undefined;
  const object = record(value);
  if (!object) throw new AgentRuntimeError("configuration_invalid", "Codex mcpGateway must be an object");
  const { url, token } = object;
  if (typeof url !== "string" || typeof token !== "string" || token.length === 0) {
    throw new AgentRuntimeError("configuration_invalid", "Codex mcpGateway requires a url and a token");
  }
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new AgentRuntimeError("configuration_invalid", "Codex mcpGateway url must be absolute");
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new AgentRuntimeError("configuration_invalid", "Codex mcpGateway url must be http or https");
  }
  return { url, token };
}

/**
 * The thread `config` override naming a run's MCP servers: the gateway alone, or none.
 *
 * It replaces the whole `mcp_servers` table, so the user's own Codex servers stay excluded exactly as
 * the launch arguments exclude them. Gateway tools are pre-approved as a server, matching the Claude
 * Code allow rule; Codex otherwise rejects every MCP call under the `never` approval policy.
 */
function codexMcpServersConfig(endpoint: CodexMcpGatewayEndpoint | undefined): Record<string, unknown> {
  if (!endpoint) return { mcp_servers: {} };
  return {
    mcp_servers: {
      [MCP_GATEWAY_SERVER_NAME]: {
        url: endpoint.url,
        http_headers: { Authorization: `Bearer ${endpoint.token}` },
        default_tools_approval_mode: "approve",
        startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
      },
    },
  };
}

/**
 * Turn hydration stays on the Server: Codex otherwise returns the entire stored thread inside one
 * `thread/resume` response, and a long Session exceeds the App Server JSONL line limit, which fails
 * the resume as a protocol error.
 */
function codexResumeParams(expectedThreadId: string | undefined): Record<string, unknown> {
  // An exact resume always carries the bound thread id. `JSON.stringify` drops the key when it is
  // absent, so a resume without one still sends no `threadId`.
  return { threadId: expectedThreadId, excludeTurns: true };
}

function parseCodexBinding(binding: AgentRuntimeBinding): { threadId: string; hostedToolsHash?: string } {
  const payload = record(binding.payload);
  if (!payload) throw new AgentRuntimeError("binding_incompatible", "Codex binding payload is invalid");
  const threadId = payload.threadId;
  if (typeof threadId !== "string" || threadId.length === 0 || Buffer.byteLength(threadId, "utf8") > 1024 * 1024) {
    throw new AgentRuntimeError("binding_incompatible", "Codex binding has no valid threadId");
  }
  const hostedToolsHash = payload.hostedToolsHash;
  if (hostedToolsHash === undefined) return { threadId };
  if (typeof hostedToolsHash !== "string" || !/^[a-f0-9]{64}$/.test(hostedToolsHash)) {
    throw new AgentRuntimeError("binding_incompatible", "Codex binding has an invalid hostedToolsHash");
  }
  return { threadId, hostedToolsHash };
}

function hostedToolsHash(definitions: AgentHostedTools["definitions"]): string {
  return hashTuple([
    "opentag-codex-hosted-tools",
    1,
    [...definitions].sort((left, right) => left.name.localeCompare(right.name)).map(codexDynamicToolDefinition),
  ]);
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
  // Structurally JSON, but an interface has no index signature, so TypeScript needs the assertion.
  const provider = {
    ...parseProviderConfiguration(base.provider),
    ...parseProviderConfiguration(override.provider),
  } as JsonValue;
  const merged: AgentRunConfiguration = {
    ...base,
    ...override,
    provider,
  };
  validateConfiguration(merged);
  return merged;
}

function codexInput(items: readonly { readonly type: "text"; readonly text: string }[]): Array<Record<string, string>> {
  return items.map((item) => ({ type: "text", text: item.text }));
}

function codexApprovalPolicy(policy: AgentRuntimePolicy["approvals"]): string {
  if (policy === "on-request") return "onRequest";
  if (policy === "unless-trusted") return "unlessTrusted";
  return "never";
}

function codexSandboxMode(mode: AgentRuntimePolicy["fileSystem"]): string {
  if (mode === "read-only") return "read-only";
  if (mode === "workspace-write") return "workspace-write";
  return "danger-full-access";
}

function codexSandboxPolicy(workspace: AgentRuntimeWorkspace, policy: AgentRuntimePolicy): Record<string, unknown> {
  if (policy.fileSystem === "read-only") return { type: "readOnly" };
  if (policy.fileSystem === "unrestricted") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    writableRoots: [...(workspace.writableRoots ?? [workspace.cwd])],
    networkAccess: policy.network === "enabled",
  };
}

function codexDynamicToolDefinition(definition: AgentHostedTools["definitions"][number]): Record<string, unknown> {
  return {
    type: "function",
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    inputSchema: definition.inputSchema,
  };
}

function codexHostedToolResult(result: AgentHostedToolResult): CodexDynamicToolResult {
  if (!result || typeof result !== "object" || typeof result.success !== "boolean" || !Array.isArray(result.content)) {
    return { success: false, text: "OpenTag tool returned an invalid result." };
  }
  const text: string[] = [];
  for (const item of result.content) {
    if (item?.type !== "text" || typeof item.text !== "string") {
      return { success: false, text: "OpenTag tool returned an invalid result." };
    }
    text.push(item.text);
  }
  if (result.error) {
    if (typeof result.error.code !== "string" || typeof result.error.message !== "string") {
      return { success: false, text: "OpenTag tool returned an invalid result." };
    }
    /* v8 ignore else -- a failed tool result without content always synthesizes the error line. */
    if (text.length === 0) text.push(`${result.error.code}: ${result.error.message}`);
  }
  return { success: result.success, text: text.join("\n") };
}

function codexInteractionRequest(
  request: CodexAppServerRequest,
  params: Record<string, unknown>,
): AgentInteractionRequest | undefined {
  const requestId = wireInteractionId(request.id);
  const details = toJsonValue(params);
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval" ||
    request.method === "item/permissions/requestApproval"
  ) {
    return {
      requestId,
      kind: "approval",
      title: request.method === "item/fileChange/requestApproval" ? "Approve file changes" : "Approve tool action",
      ...(typeof params.reason === "string" ? { message: params.reason } : {}),
      details,
    };
  }
  if (request.method === "item/tool/requestUserInput" || request.method === "mcpServer/elicitation/request") {
    const message = typeof params.message === "string" ? params.message : undefined;
    return {
      requestId,
      kind: "question",
      title: "Codex needs input",
      ...(message ? { message } : {}),
      details,
    };
  }
  return undefined;
}

function codexInteractionResult(method: string, response: AgentInteractionResponse): unknown {
  if (response.kind === "approval") return codexApprovalResult(method, response);
  return codexQuestionResult(method, response);
}

function codexApprovalResult(method: string, response: AgentApprovalResponse): unknown {
  if (method === "item/permissions/requestApproval") {
    if (response.decision !== "accept") return { permissions: [], scope: "turn" };
    const value = record(response.value);
    const permissions = Array.isArray(value?.permissions) ? value.permissions : [];
    return { permissions, scope: response.scope === "runtime" ? "session" : "turn" };
  }
  const decision =
    response.decision === "accept" ? (response.scope === "runtime" ? "acceptForSession" : "accept") : response.decision;
  return { decision };
}

function codexQuestionResult(method: string, response: AgentQuestionResponse): unknown {
  if (method === "mcpServer/elicitation/request") {
    return response.decision === "answer"
      ? { action: "accept", content: response.value ?? null }
      : { action: "cancel", content: null };
  }
  return { answers: response.decision === "answer" ? (response.value ?? {}) : {} };
}

function parseTurnResponse(value: unknown, source: string): ParsedTurn {
  const response = requireRecord(value, `${source} returned an invalid response`);
  return parseTurn(response.turn, source);
}

function parseTurn(value: unknown, source: string): ParsedTurn {
  const turn = requireRecord(value, `${source} has no turn`);
  const id = requireString(turn.id, `${source} turn has no id`);
  const status = turn.status;
  if (status !== "completed" && status !== "failed" && status !== "inProgress" && status !== "interrupted") {
    throw protocolError(`${source} turn has an invalid status`);
  }
  const items = Array.isArray(turn.items)
    ? turn.items.map((item) => requireRecord(item, `${source} has an invalid item`))
    : [];
  const error = record(turn.error);
  return {
    id,
    status,
    items,
    ...(typeof error?.message === "string" ? { error: error.message } : {}),
  };
}

function parseUsage(value: unknown): {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
} {
  const tokenUsage = requireRecord(value, "token usage is invalid");
  const source = record(tokenUsage.last) ?? record(tokenUsage.total) ?? tokenUsage;
  const usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } = {};
  if (isNonNegativeNumber(source.inputTokens)) usage.inputTokens = source.inputTokens;
  if (isNonNegativeNumber(source.cachedInputTokens)) usage.cachedInputTokens = source.cachedInputTokens;
  if (isNonNegativeNumber(source.outputTokens)) usage.outputTokens = source.outputTokens;
  return usage;
}

function selectFinalText(
  terminalItems: readonly Record<string, unknown>[],
  completed: ReadonlyMap<string, { readonly phase?: string; readonly text: string }>,
): string | undefined {
  const messages = new Map(completed);
  for (const item of terminalItems) {
    if (item.type !== "agentMessage" || typeof item.id !== "string" || typeof item.text !== "string") continue;
    messages.set(item.id, {
      text: item.text,
      ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
    });
  }
  let fallback: string | undefined;
  for (const message of messages.values()) {
    if (message.phase === "final_answer") return message.text;
    if (message.phase !== "commentary") fallback = message.text;
  }
  return fallback;
}

function toolName(item: Record<string, unknown>, type: string): string {
  if (type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "mcp";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return `${server}/${tool}`;
  }
  if (type === "dynamicToolCall" && typeof item.tool === "string") return item.tool;
  return type;
}

function wireInteractionId(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

function toJsonValue(value: unknown): JsonValue {
  assertJsonValue(value, "Codex event payload");
  return value as JsonValue;
}

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
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

function requireString(value: unknown, message: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > 1024 * 1024
  ) {
    throw protocolError(message);
  }
  return value;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
