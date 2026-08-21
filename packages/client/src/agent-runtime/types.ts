export const AGENT_RUNTIME_CONTRACT_VERSION = 1;
export const AGENT_RUNTIME_BINDING_MAX_BYTES = 64 * 1024;
export const AGENT_RUNTIME_ID_MAX_BYTES = 256;
export const AGENT_RUNTIME_TEXT_MAX_BYTES = 1024 * 1024;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AgentRunId = string;

export interface AgentRuntimeManifest {
  readonly providerId: string;
  readonly displayName: string;
  readonly contractVersion: typeof AGENT_RUNTIME_CONTRACT_VERSION;
  readonly bindingSchemaVersion: number;
}

export interface AgentRuntimeCapabilities {
  readonly steer: "supported" | "unsupported";
  readonly interactions: "supported" | "unsupported";
}

export interface AgentRuntimeLifecycleState {
  readonly phase: "idle" | "running" | "closing" | "closed";
  readonly activeRunId?: AgentRunId;
  readonly queuedRunCount: number;
}

export interface AgentRuntimeBinding {
  readonly providerId: string;
  readonly schemaVersion: number;
  readonly payload: JsonValue;
}

export interface AgentTextInputItem {
  readonly type: "text";
  readonly text: string;
}

export type AgentInputItem = AgentTextInputItem;

export interface AgentInput {
  readonly items: readonly AgentInputItem[];
}

export interface AgentRunConfiguration {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly provider?: JsonValue;
}

export interface AgentPromptRequest {
  readonly runId: AgentRunId;
  readonly input: AgentInput;
  readonly configuration?: AgentRunConfiguration;
  readonly signal?: AbortSignal;
}

export interface AgentSteerRequest {
  readonly expectedRunId: AgentRunId;
  readonly input: AgentInput;
}

export interface AgentAbortRequest {
  readonly expectedRunId: AgentRunId;
  readonly reason?: string;
}

export interface AgentInteractionIdentity {
  readonly expectedRunId: AgentRunId;
  readonly requestId: string;
}

export interface AgentApprovalResponse extends AgentInteractionIdentity {
  readonly kind: "approval";
  readonly decision: "accept" | "decline" | "cancel";
  readonly scope?: "run" | "runtime";
  readonly value?: JsonValue;
}

export interface AgentQuestionResponse extends AgentInteractionIdentity {
  readonly kind: "question";
  readonly decision: "answer" | "cancel";
  readonly value?: JsonValue;
}

export type AgentInteractionResponse = AgentApprovalResponse | AgentQuestionResponse;

export interface AgentUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
}

export interface AgentTextOutputItem {
  readonly type: "text";
  readonly text: string;
}

export type AgentOutputItem = AgentTextOutputItem;

export type AgentRunStatus = "completed" | "failed" | "aborted" | "cancelled";

export type AgentRunErrorCode =
  | "event_delivery_failed"
  | "provider_error"
  | "provider_protocol_error"
  | "provider_start_failed"
  | "runtime_closed"
  | "run_aborted"
  | "run_cancelled";

export interface AgentRunError {
  readonly code: AgentRunErrorCode;
  readonly message: string;
}

export interface AgentRunResult {
  readonly runId: AgentRunId;
  readonly status: AgentRunStatus;
  readonly output: readonly AgentOutputItem[];
  readonly usage?: AgentUsage;
  readonly binding?: AgentRuntimeBinding;
  readonly error?: AgentRunError;
  readonly providerDiagnostics?: JsonValue;
}

export interface AgentRuntimeWorkspace {
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly writableRoots?: readonly string[];
}

export interface AgentRuntimePolicy {
  readonly fileSystem: "read-only" | "workspace-write" | "unrestricted";
  readonly network: "disabled" | "enabled";
  readonly approvals: "never" | "on-request" | "unless-trusted";
  readonly tools:
    | { readonly mode: "provider-default" }
    | { readonly mode: "allow-list"; readonly names: readonly string[] };
}

export interface AgentHostedToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
}

export interface AgentHostedToolCall {
  readonly runId: AgentRunId;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
}

export interface AgentHostedToolContent {
  readonly type: "text";
  readonly text: string;
}

export interface AgentHostedToolError {
  readonly code: string;
  readonly message: string;
}

export interface AgentHostedToolResult {
  readonly success: boolean;
  readonly content: readonly AgentHostedToolContent[];
  readonly error?: AgentHostedToolError;
}

export type AgentHostedToolHandler = (call: AgentHostedToolCall) => Promise<AgentHostedToolResult>;

export interface AgentHostedTools {
  readonly definitions: readonly AgentHostedToolDefinition[];
  readonly handler: AgentHostedToolHandler;
}

export type AgentRuntimeEventSink = (event: AgentRuntimeEvent) => void | Promise<void>;

export interface CreateAgentRuntimeRequest {
  readonly eventSink: AgentRuntimeEventSink;
  readonly hostedTools?: AgentHostedTools;
  readonly workspace: AgentRuntimeWorkspace;
  readonly policy: AgentRuntimePolicy;
  readonly configuration?: AgentRunConfiguration;
}

export interface ResumeAgentRuntimeRequest extends CreateAgentRuntimeRequest {
  readonly binding: AgentRuntimeBinding;
}

export interface AgentRuntimeProbeRequest {
  readonly configuration?: AgentRunConfiguration;
  readonly signal?: AbortSignal;
}

export interface AgentRuntimeProbeIssue {
  readonly code:
    | "artifact_missing"
    | "credential_missing"
    | "configuration_invalid"
    | "temporarily_unavailable"
    | "version_incompatible";
  readonly message: string;
}

export interface AgentRuntimeProbeResult {
  readonly ready: boolean;
  readonly version?: string;
  readonly issues: readonly AgentRuntimeProbeIssue[];
}

export interface AgentInteractionRequest {
  readonly requestId: string;
  readonly kind: "approval" | "question";
  readonly title: string;
  readonly message?: string;
  readonly options?: readonly string[];
  readonly details?: JsonValue;
}

export type AgentProviderRunEvent =
  // Model-turn events are optional: providers that cannot observe this boundary
  // emit message/tool lifecycles directly within the Run.
  | { readonly type: "model_turn_started"; readonly modelTurnId: string }
  | { readonly type: "model_turn_completed"; readonly modelTurnId: string }
  | { readonly type: "message_started"; readonly messageId: string }
  | { readonly type: "message_delta"; readonly messageId: string; readonly delta: string }
  | { readonly type: "message_completed"; readonly messageId: string; readonly text: string }
  | {
      readonly type: "tool_started";
      readonly toolCallId: string;
      readonly name: string;
      readonly input?: JsonValue;
    }
  | { readonly type: "tool_updated"; readonly toolCallId: string; readonly update: JsonValue }
  | {
      readonly type: "tool_completed";
      readonly toolCallId: string;
      readonly name: string;
      readonly status: "completed" | "failed" | "declined";
      readonly output?: JsonValue;
    }
  | { readonly type: "usage_updated"; readonly usage: AgentUsage }
  | { readonly type: "provider_warning"; readonly code: string; readonly message: string }
  | {
      readonly type: "provider_event";
      readonly providerId: string;
      readonly schemaVersion: number;
      readonly payload: JsonValue;
    };

export type AgentRuntimeEvent =
  | { readonly type: "binding_changed"; readonly binding: AgentRuntimeBinding; readonly runId?: AgentRunId }
  | { readonly type: "run_queued"; readonly runId: AgentRunId; readonly position: number }
  | { readonly type: "run_started"; readonly runId: AgentRunId }
  | ({ readonly runId: AgentRunId } & AgentProviderRunEvent)
  | { readonly type: "interaction_requested"; readonly runId: AgentRunId; readonly request: AgentInteractionRequest }
  | {
      readonly type: "interaction_resolved";
      readonly runId: AgentRunId;
      readonly requestId: string;
      readonly decision: string;
    }
  | { readonly type: "input_accepted"; readonly runId: AgentRunId; readonly input: AgentInput }
  | { readonly type: "run_completed"; readonly runId: AgentRunId; readonly result: AgentRunResult }
  | { readonly type: "run_failed"; readonly runId: AgentRunId; readonly result: AgentRunResult }
  | { readonly type: "run_aborted"; readonly runId: AgentRunId; readonly result: AgentRunResult }
  | { readonly type: "run_cancelled"; readonly runId: AgentRunId; readonly result: AgentRunResult }
  | { readonly type: "runtime_closed" };

export interface AgentProviderRunResult {
  readonly status: "completed" | "failed" | "aborted";
  readonly output?: readonly AgentOutputItem[];
  readonly usage?: AgentUsage;
  readonly error?: AgentRunError;
  readonly diagnostics?: JsonValue;
}

export interface AgentProviderRunContext {
  readonly runId: AgentRunId;
  readonly signal: AbortSignal;
  /** Marks that the authoritative Provider terminal arrived; public settlement still waits for executeRun. */
  claimTerminal(): void;
  emit(event: AgentProviderRunEvent): Promise<void>;
  updateBinding(binding: AgentRuntimeBinding): Promise<void>;
  requestInteraction(request: AgentInteractionRequest): Promise<void>;
  resolveInteraction(requestId: string, decision: string): Promise<void>;
}

export interface AgentRuntime {
  readonly manifest: AgentRuntimeManifest;
  readonly capabilities: AgentRuntimeCapabilities;
  readonly state: Readonly<AgentRuntimeLifecycleState>;
  readonly binding: AgentRuntimeBinding | undefined;

  prompt(request: AgentPromptRequest): Promise<AgentRunResult>;
  steer(request: AgentSteerRequest): Promise<void>;
  followUp(request: AgentPromptRequest): Promise<AgentRunResult>;
  respond(response: AgentInteractionResponse): Promise<void>;
  abort(request: AgentAbortRequest): Promise<void>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRuntimeFactory {
  readonly manifest: AgentRuntimeManifest;
  probe(request: AgentRuntimeProbeRequest): Promise<AgentRuntimeProbeResult>;
  create(request: CreateAgentRuntimeRequest): Promise<AgentRuntime>;
  resume(request: ResumeAgentRuntimeRequest): Promise<AgentRuntime>;
}
