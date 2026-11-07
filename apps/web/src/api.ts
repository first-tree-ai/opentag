import {
  type AccountApiEndpoint,
  type AccountApiNoContentEndpoint,
  type AccountCloudComputerEnsureResponse,
  AccountCloudComputerEnsureResponseSchema,
  type AccountComputerConnectCodeIssueRequest,
  type AccountSandboxRunnerStatusResponse,
  AccountSandboxRunnerStatusResponseSchema,
  type AccountSandboxRunnerStopRequest,
  type AccountSetupCompletion,
  AccountSetupCompletionSchema,
  type AccountSetupResetMode,
  type AgentAdminConfig,
  type AgentCloudOverview,
  AgentCloudOverviewSchema,
  type AgentDetail,
  type AgentRuntimeOptions,
  AgentRuntimeOptionsSchema,
  type AgentRuntimeTestRequest,
  type AgentRuntimeTestResponse,
  type AgentSchedule,
  type AgentScheduleListResponse,
  AgentScheduleListResponseSchema,
  AgentScheduleSchema,
  type AgentSetupSnapshot,
  AgentSetupSnapshotSchema,
  type AgentStatusResponse,
  AgentStatusResponseSchema,
  type AgentUsageDetail,
  type AgentUsageWindowDays,
  type AttachMCPServerRequest,
  type AuthProvidersResponse,
  AuthProvidersResponseSchema,
  accountApiEndpoints,
  accountComputerByIdPath,
  accountComputerDisconnectPath,
  accountSandboxRunnerPath,
  accountSandboxRunnerStopPath,
  agentCloudPath,
  agentContextTreePath,
  agentFeishuSetupAttemptsPath,
  agentImBindingHandoffPath,
  agentImBindingUnbindPath,
  agentImFeedbackPath,
  agentMcpAuthorizationPath,
  agentMcpServersPath,
  agentRuntimeOptionsPath,
  agentSchedulePath,
  agentSchedulePausePath,
  agentScheduleResumePath,
  agentSchedulesPath,
  agentSetupPath,
  agentSetupRefreshPath,
  agentSkillBundlePath,
  agentSkillFilePath,
  agentSkillPath,
  agentSkillsInstallPath,
  agentSkillsInstallResolvePath,
  agentSkillsPath,
  agentSlackAutoSetupPath,
  agentSlackConfigurationPath,
  agentStatusesPath,
  CLOUD_BILLING_CHECKOUT_PATH,
  CLOUD_BILLING_PATH,
  CLOUD_USAGE_PATH,
  type CloudAvailability,
  CloudAvailabilitySchema,
  CloudBillingSummarySchema,
  type CloudCreditCheckoutRequest,
  CloudCreditCheckoutResponseSchema,
  type CloudModelOptions,
  CloudModelOptionsSchema,
  CloudUsageSummarySchema,
  type CloudUsageWindowDays,
  type ComputerConnectCodeIssueResponse,
  type ComputerConnectCodeStatus,
  ConnectMCPOAuthResponseSchema,
  type ContextTreeAvailabilityResponse,
  ContextTreeAvailabilityResponseSchema,
  type ContextTreeOperationRequest,
  type ContextTreeOperationResponse,
  ContextTreeOperationResponseSchema,
  type CreateAgentRequest,
  type CreateMCPServerRequest,
  type EmailSignInRequest,
  type EmailSignUpRequest,
  ErrorEnvelopeSchema,
  type FeishuSetupAttempt,
  FeishuSetupAttemptSchema,
  feishuSetupAttemptCheckPath,
  HTTP_PATHS,
  type ImBindingAdminDetail,
  type ImBindingDiagnostics,
  type ImBindingHandoffStatus,
  ImBindingHandoffStatusSchema,
  type ImBindingMessagingExpectation,
  type ImBindingSummary,
  type ImBindingUnbindRequiredDetail,
  type ImFeedbackActionRequest,
  type ImFeedbackList,
  ImFeedbackListSchema,
  type ImFeedbackView,
  ImFeedbackViewSchema,
  type InstallRemoteSkillsResponse,
  InstallRemoteSkillsResponseSchema,
  type InstallSkillPresetResponse,
  imFeedbackActionsPath,
  imFeedbackPath,
  type ListAccountComputersResponse,
  type ListAgentMCPServersResponse,
  type ListAgentSkillsResponse,
  type ListAgentsResponse,
  type ListAvailableMCPServersResponse,
  type ListMCPServersResponse,
  type ListSkillPresetsResponse,
  type ListTaskRepliesResponse,
  ListTaskRepliesResponseSchema,
  type ListTasksResponse,
  ListTasksResponseSchema,
  MCP_CATALOG_ENDPOINTS_PATH,
  type MCPAgentServer,
  type MCPCatalogEndpointsResponse,
  MCPCatalogEndpointsResponseSchema,
  type MCPProbeResponse,
  type MCPServer,
  type MCPServerDetail,
  type MeResponse,
  PROVIDER_CLI_REASON_V2_HEADER,
  parseResponseIgnoringUnknownKeys,
  type ReadSkillFileResponse,
  ReadSkillFileResponseSchema,
  type RemoteSkillSelection,
  type ResolveRemoteSkillsResponse,
  ResolveRemoteSkillsResponseSchema,
  ReusableMCPInstallationResponseSchema,
  type SaveSlackConfigurationRequest,
  type SetMCPAuthorizationRequest,
  SKILL_FORMAT_HEADER,
  SKILL_REPLACE_HEADER,
  SKILL_SHA256_HEADER,
  SKILL_UPLOAD_CONTENT_TYPE,
  type SkillArchiveFormat,
  type SkillDetail,
  SkillDetailSchema,
  SlackAgentProvisionCodeResponseSchema,
  type SlackAutoSetupRequest,
  type SlackAutoSetupResponse,
  SlackAutoSetupResponseSchema,
  type SlackConfigurationResult,
  SlackConfigurationResultSchema,
  type SlackConfigurationView,
  SlackConfigurationViewSchema,
  type StartMCPOAuthRequest,
  type StartMCPOAuthResponse,
  type StartSlackOAuthRequest,
  type StartSlackOAuthResponse,
  TaskCancelResponseSchema,
  type TaskCollaborationMessagePage,
  TaskCollaborationMessagePageSchema,
  type TaskDetail,
  type TaskDetailPage,
  TaskDetailPageSchema,
  type TaskDetailSection,
  type TaskInternalSessionPage,
  TaskInternalSessionPageSchema,
  type TaskTitleUpdateRequest,
  TaskTitleUpdateResponseSchema,
  type TaskTurnPage,
  TaskTurnPageSchema,
  taskByIdPath,
  taskCancelPath,
  taskDetailPath,
  taskDetailSectionPath,
  taskRepliesPath,
  toAccountApiRequestInit,
  type UnbindAgentMessagingRequest,
  type UpdateAgentRequest,
  type UpdateMCPBindingRequest,
  type UpdateMCPServerRequest,
  type UpdateSkillRequest,
  type UpdateUserProfileRequest,
  type UserProfile,
  UserProfileSchema,
  type ValidationIssue,
} from "@opentag/shared/browser";
import {
  DiagnosticReporter as ConsoleDiagnosticReporter,
  type DiagnosticReporter,
  normalizeError,
  routeTemplate,
} from "./observability/diagnostics.js";
import { viewerTimezone } from "./query/keys.js";

interface RuntimeSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly RuntimeSchemaIssue[] } };
}

type RuntimeSchemaIssue = { readonly path: readonly PropertyKey[]; readonly code: string };

export class ResponseSchemaError extends Error {
  readonly code = "invalid_response_schema";

  constructor(
    readonly routeTemplate: string,
    readonly issues: readonly RuntimeSchemaIssue[],
  ) {
    super("The server returned an invalid response");
    this.name = "ResponseSchemaError";
  }
}

export class CancelledRequestError extends Error {
  readonly code = "cancelled";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Request cancelled", { cause });
    this.name = "AbortError";
  }
}

/** Covers one Agent setup snapshot read: fetch, body, and diagnostic clones. */
export const AGENT_SETUP_READ_TIMEOUT_MS = 10_000;
/** Covers the Server's 480-second seal wait and the final response. */
export const CLOUD_WORKSPACE_RELEASE_TIMEOUT_MS = 510_000;

/**
 * Bounds `run` in elapsed time even when the AbortSignal is ignored. Fetch cancellation is
 * best-effort; the deadline itself always rejects, including while a response body is hanging.
 * An optional observer signal cancels through baseline abort events, with listener cleanup.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) throw new CancelledRequestError(externalSignal.reason);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const cancel = (error: CancelledRequestError) => {
      controller.abort(error);
      reject(error);
    };
    onAbort = () => cancel(new CancelledRequestError(externalSignal?.reason));
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const cause = new Error("The operation timed out.");
      cause.name = "TimeoutError";
      cancel(new CancelledRequestError(cause));
    }, timeoutMs);
  });
  const operation = Promise.resolve().then(() => {
    // The observer can disappear before this microtask starts the transport.
    if (controller.signal.aborted) throw controller.signal.reason;
    return run(controller.signal);
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) externalSignal?.removeEventListener("abort", onAbort);
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly category?: string,
    readonly issues?: readonly ValidationIssue[],
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
    readonly unbindRequired?: ImBindingUnbindRequiredDetail,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function generateRequestId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function extractTraceId(headers: Headers): string | undefined {
  return headers.get("x-trace-id") ?? headers.get("traceparent")?.split("-")[1] ?? undefined;
}

async function reportHttpFailure(
  reporter: DiagnosticReporter,
  apiError: (response: Response, body: unknown) => ApiError,
  path: string,
  response: Response,
  requestId: string,
): Promise<void> {
  const body = await response
    .clone()
    .json()
    .catch(() => undefined);
  const error = apiError(response, body);
  const level = response.status >= 500 ? "error" : "warn";
  const traceId = extractTraceId(response.headers);
  reporter.report(
    {
      source: "api",
      code: error.code ?? `http_${response.status}`,
      routeTemplate: routeTemplate(path),
      status: response.status,
      category: error.category,
      requestId: error.requestId ?? requestId,
      ...(traceId ? { traceId } : {}),
      retryAfterSeconds: error.retryAfterSeconds,
    },
    level,
  );
}

function handleFetchException(
  reporter: DiagnosticReporter,
  cause: unknown,
  signal: AbortSignal | null | undefined,
  path: string,
): never {
  if (signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) {
    throw new CancelledRequestError(cause);
  }
  const normalized = normalizeError(cause, "network_error");
  reporter.report({
    source: "api",
    code: normalized.code,
    routeTemplate: routeTemplate(path),
    error: { name: normalized.error.name },
  });
  throw cause;
}

export class BrowserApi {
  constructor(
    readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    readonly diagnosticReporter: DiagnosticReporter = new ConsoleDiagnosticReporter(),
  ) {}

  cloudUsage(windowDays: CloudUsageWindowDays, timezone = viewerTimezone()) {
    const query = new URLSearchParams({ windowDays: String(windowDays), timezone });
    return this.request(`${CLOUD_USAGE_PATH}?${query.toString()}`, CloudUsageSummarySchema);
  }

  cloudBilling() {
    return this.request(CLOUD_BILLING_PATH, CloudBillingSummarySchema);
  }

  cloudCreditCheckout(input: CloudCreditCheckoutRequest) {
    return this.request(CLOUD_BILLING_CHECKOUT_PATH, CloudCreditCheckoutResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  issueSlackAgentProvisionCode() {
    return this.request(HTTP_PATHS.meConnectCodes, SlackAgentProvisionCodeResponseSchema, {
      method: "POST",
      body: JSON.stringify({ purpose: "slack-agent-provision" }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  me(): Promise<MeResponse> {
    return this.requestAccount(accountApiEndpoints.me());
  }

  updateProfile(input: UpdateUserProfileRequest): Promise<UserProfile> {
    return this.request(HTTP_PATHS.me, UserProfileSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  authProviders(): Promise<AuthProvidersResponse> {
    return this.request(HTTP_PATHS.authProviders, AuthProvidersResponseSchema);
  }

  completeSetup(agentId: string): Promise<AccountSetupCompletion> {
    return this.request(HTTP_PATHS.accountSetupComplete, AccountSetupCompletionSchema, {
      method: "POST",
      body: JSON.stringify({ agentId }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  agents(): Promise<ListAgentsResponse> {
    return this.requestAccount(accountApiEndpoints.listAgents({ includeActivityAndStatus: true }));
  }

  agentStatuses(ids: readonly string[]): Promise<AgentStatusResponse> {
    return this.request(agentStatusesPath(ids), AgentStatusResponseSchema);
  }

  tasks(input: { cursor?: string; agentId?: string; kind?: "channel" | "thread" } = {}): Promise<ListTasksResponse> {
    const query = new URLSearchParams();
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.agentId) query.set("agentId", input.agentId);
    if (input.kind) query.set("kind", input.kind);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(`${HTTP_PATHS.accountTasks}${suffix}`, ListTasksResponseSchema);
  }

  /**
   * The bounded Task detail: one page of the named sections — all of them when none is named — each
   * with its own cursor. Naming a subset is what keeps a view from paying for a section it discards;
   * the legacy complete answer at `taskByIdPath` is not read here, so no view can depend on an
   * unbounded section.
   */
  taskDetail(sessionId: string, sections?: readonly TaskDetailSection[]): Promise<TaskDetailPage> {
    const query = sections ? `?${new URLSearchParams({ sections: sections.join(",") }).toString()}` : "";
    return this.request(`${taskDetailPath(sessionId)}${query}`, TaskDetailPageSchema);
  }

  taskTurns(sessionId: string, cursor?: string): Promise<TaskTurnPage> {
    return this.#taskSection(sessionId, "turns", cursor, TaskTurnPageSchema);
  }

  taskInternalSessions(sessionId: string, cursor?: string): Promise<TaskInternalSessionPage> {
    return this.#taskSection(sessionId, "internal-sessions", cursor, TaskInternalSessionPageSchema);
  }

  taskCollaborationMessages(sessionId: string, cursor?: string): Promise<TaskCollaborationMessagePage> {
    return this.#taskSection(sessionId, "collaboration-messages", cursor, TaskCollaborationMessagePageSchema);
  }

  #taskSection<T>(
    sessionId: string,
    section: "turns" | "internal-sessions" | "collaboration-messages",
    cursor: string | undefined,
    schema: RuntimeSchema<T>,
  ): Promise<T> {
    const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
    return this.request(`${taskDetailSectionPath(sessionId, section)}${query}`, schema);
  }

  /** The Task's platform-confirmed outbound replies, paged independently of its Turns. */
  taskReplies(sessionId: string, cursor?: string): Promise<ListTaskRepliesResponse> {
    const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
    return this.request(`${taskRepliesPath(sessionId)}${query}`, ListTaskRepliesResponseSchema);
  }

  updateTaskTitle(sessionId: string, input: TaskTitleUpdateRequest): Promise<TaskDetail["task"]> {
    return this.request(`${taskByIdPath(sessionId)}`, TaskTitleUpdateResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    }).then(({ task }) => task);
  }

  /** Withdraws a queued Task. A `409` means it is no longer queued and its state should be re-read. */
  cancelTask(sessionId: string): Promise<TaskDetail["task"]> {
    return this.request(taskCancelPath(sessionId), TaskCancelResponseSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    }).then(({ task }) => task);
  }

  agent(agentId: string): Promise<AgentDetail> {
    return this.requestAccount(accountApiEndpoints.getAgent(agentId, { includeActivity: true }));
  }

  agentSchedules(agentId: string, query: { limit?: number; cursor?: string } = {}): Promise<AgentScheduleListResponse> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`${agentSchedulesPath(agentId)}${suffix}`, AgentScheduleListResponseSchema);
  }

  agentSchedule(agentId: string, scheduleId: string): Promise<AgentSchedule> {
    return this.request(agentSchedulePath(agentId, scheduleId), AgentScheduleSchema);
  }

  pauseAgentSchedule(agentId: string, scheduleId: string, expectedRevision: number): Promise<AgentSchedule> {
    return this.request(agentSchedulePausePath(agentId, scheduleId), AgentScheduleSchema, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  resumeAgentSchedule(agentId: string, scheduleId: string, expectedRevision: number): Promise<AgentSchedule> {
    return this.request(agentScheduleResumePath(agentId, scheduleId), AgentScheduleSchema, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  deleteAgentSchedule(agentId: string, scheduleId: string, expectedRevision: number): Promise<void> {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return this.requestNoContent(`${agentSchedulePath(agentId, scheduleId)}?${query.toString()}`, {
      method: "DELETE",
      headers: this.csrfHeaders(),
    });
  }

  agentUsage(
    agentId: string,
    windowDays: AgentUsageWindowDays,
    timezone = viewerTimezone(),
  ): Promise<AgentUsageDetail> {
    return this.requestAccount(accountApiEndpoints.getAgentUsage(agentId, windowDays, timezone));
  }

  agentConfig(agentId: string): Promise<AgentAdminConfig> {
    return this.requestAccount(accountApiEndpoints.getAgentConfig(agentId));
  }

  /**
   * The canonical setup state of one exact Agent. Stage, blockers, and permitted actions all
   * arrive derived by the Server; callers render them rather than re-deriving them locally.
   * The deadline covers fetch and every body read; it does not depend on the transport honoring abort.
   */
  agentSetup(agentId: string): Promise<AgentSetupSnapshot> {
    return withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, (signal) =>
      this.request(agentSetupPath(agentId), AgentSetupSnapshotSchema, {
        signal,
        headers: { [PROVIDER_CLI_REASON_V2_HEADER]: "2" },
      }),
    );
  }

  /** Starts a fresh Computer-owned preparation for this exact bound Agent. */
  refreshAgentSetup(agentId: string): Promise<void> {
    return this.requestNoContent(agentSetupRefreshPath(agentId), {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  createAgent(input: CreateAgentRequest): Promise<AgentAdminConfig> {
    return this.requestAccount(accountApiEndpoints.createAgent(input));
  }

  updateAgent(agentId: string, input: UpdateAgentRequest): Promise<AgentAdminConfig> {
    return this.requestAccount(accountApiEndpoints.updateAgent(agentId, input));
  }

  contextTreeAvailability(agentId: string): Promise<ContextTreeAvailabilityResponse> {
    return this.request(agentContextTreePath(agentId), ContextTreeAvailabilityResponseSchema);
  }

  contextTreeOperation(agentId: string, input: ContextTreeOperationRequest): Promise<ContextTreeOperationResponse> {
    return this.request(agentContextTreePath(agentId), ContextTreeOperationResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  agentRuntimeOptions(agentId: string, model?: string, signal?: AbortSignal): Promise<AgentRuntimeOptions> {
    const query = new URLSearchParams(model ? { model } : {});
    return this.request(
      `${agentRuntimeOptionsPath(agentId)}${query.size ? `?${query}` : ""}`,
      AgentRuntimeOptionsSchema,
      { ...(signal ? { signal } : {}) },
    );
  }

  testAgentRuntime(
    agentId: string,
    input: AgentRuntimeTestRequest,
    signal?: AbortSignal,
  ): Promise<AgentRuntimeTestResponse> {
    return this.requestAccount(accountApiEndpoints.testAgentRuntime(agentId, input), signal ? { signal } : undefined);
  }

  suspendAgent(agentId: string): Promise<AgentAdminConfig> {
    return this.requestAccount(accountApiEndpoints.suspendAgent(agentId));
  }

  rebindAgentComputer(agentId: string, computerId: string): Promise<AgentAdminConfig> {
    return this.requestAccount(accountApiEndpoints.rebindAgentComputer(agentId, computerId));
  }

  reactivateAgent(agentId: string): Promise<AgentAdminConfig> {
    return this.requestAccount(accountApiEndpoints.reactivateAgent(agentId));
  }

  disconnectComputer(computerId: string): Promise<void> {
    return withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, (signal) =>
      this.requestNoContent(accountComputerDisconnectPath(computerId), {
        method: "POST",
        headers: this.csrfHeaders(),
        signal,
      }),
    );
  }

  deleteComputer(computerId: string): Promise<void> {
    return this.requestNoContent(accountComputerByIdPath(computerId), {
      method: "DELETE",
      headers: this.csrfHeaders(),
    });
  }

  deleteAgent(agentId: string): Promise<void> {
    return this.requestNoContentAccount(accountApiEndpoints.deleteAgent(agentId));
  }

  imBinding(agentId: string): Promise<ImBindingSummary | undefined> {
    return this.requestOptionalAccount(accountApiEndpoints.getAgentImBinding(agentId));
  }

  imBindingHandoff(agentId: string): Promise<ImBindingHandoffStatus | undefined> {
    return this.requestOptional(agentImBindingHandoffPath(agentId), ImBindingHandoffStatusSchema, {
      headers: { [PROVIDER_CLI_REASON_V2_HEADER]: "2" },
    });
  }

  imBindingConfig(agentId: string): Promise<ImBindingAdminDetail | undefined> {
    return this.requestOptionalAccount(accountApiEndpoints.getAgentImBindingConfig(agentId));
  }

  unbindAgentMessaging(agentId: string, input: UnbindAgentMessagingRequest): Promise<void> {
    return this.requestNoContent(agentImBindingUnbindPath(agentId), {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  createFeishuSetupAttempt(
    agentId: string,
    intent: "create" | "reauthorize" | "replace" = "create",
    expectedMessaging?: ImBindingMessagingExpectation,
  ): Promise<FeishuSetupAttempt> {
    return this.requestAccount(accountApiEndpoints.createFeishuSetupAttempt(agentId, intent, expectedMessaging));
  }

  feishuSetupAttempt(attemptId: string): Promise<FeishuSetupAttempt> {
    return this.requestAccount(accountApiEndpoints.getFeishuSetupAttempt(attemptId));
  }

  currentFeishuSetupAttempt(agentId: string): Promise<FeishuSetupAttempt | undefined> {
    return this.requestOptional(agentFeishuSetupAttemptsPath(agentId), FeishuSetupAttemptSchema);
  }

  checkFeishuSetupAttempt(attemptId: string): Promise<FeishuSetupAttempt> {
    return this.request(feishuSetupAttemptCheckPath(attemptId), FeishuSetupAttemptSchema, {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  cancelFeishuSetupAttempt(attemptId: string): Promise<FeishuSetupAttempt> {
    return this.requestAccount(accountApiEndpoints.cancelFeishuSetupAttempt(attemptId));
  }

  startSlackOAuth(agentId: string, input: StartSlackOAuthRequest): Promise<StartSlackOAuthResponse> {
    return this.requestAccount(accountApiEndpoints.startSlackOAuth(agentId, input));
  }

  autoSetupSlack(agentId: string, input: SlackAutoSetupRequest): Promise<SlackAutoSetupResponse> {
    return this.request(agentSlackAutoSetupPath(agentId), SlackAutoSetupResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  slackConfiguration(agentId: string, signal?: AbortSignal): Promise<SlackConfigurationView> {
    return this.request(agentSlackConfigurationPath(agentId), SlackConfigurationViewSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  saveSlackConfiguration(agentId: string, input: SaveSlackConfigurationRequest): Promise<SlackConfigurationResult> {
    return this.request(agentSlackConfigurationPath(agentId), SlackConfigurationResultSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  imBindingDiagnostics(imBindingId: string): Promise<ImBindingDiagnostics> {
    return this.requestAccount(accountApiEndpoints.getImBindingDiagnostics(imBindingId));
  }

  disableImBinding(imBindingId: string): Promise<void> {
    return this.requestNoContentAccount(accountApiEndpoints.disableImBinding(imBindingId));
  }

  computers(): Promise<ListAccountComputersResponse> {
    return this.requestAccount(accountApiEndpoints.listAccountComputers({ includeBrowserCapabilities: true }));
  }

  cloudAvailability(): Promise<CloudAvailability> {
    return withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, (signal) =>
      this.request(HTTP_PATHS.accountCloudComputer, CloudAvailabilitySchema, { signal }),
    );
  }

  cloudModelOptions(): Promise<CloudModelOptions> {
    return withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, (signal) =>
      this.request(HTTP_PATHS.accountCloudModels, CloudModelOptionsSchema, { signal }),
    );
  }

  ensureCloudComputer(): Promise<AccountCloudComputerEnsureResponse> {
    return this.request(HTTP_PATHS.accountCloudComputer, AccountCloudComputerEnsureResponseSchema, {
      method: "PUT",
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
      body: JSON.stringify({}),
    });
  }

  imFeedbackList(agentId: string, cursor?: string): Promise<ImFeedbackList> {
    return this.request(agentImFeedbackPath(agentId, cursor), ImFeedbackListSchema);
  }

  imFeedback(feedbackId: string): Promise<ImFeedbackView> {
    return this.request(imFeedbackPath(feedbackId), ImFeedbackViewSchema);
  }

  imFeedbackAction(feedbackId: string, input: ImFeedbackActionRequest): Promise<ImFeedbackView> {
    return this.request(imFeedbackActionsPath(feedbackId), ImFeedbackViewSchema, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
      body: JSON.stringify(input),
    });
  }

  agentCloudOverview(agentId: string, options: { cursor?: string; limit?: number } = {}): Promise<AgentCloudOverview> {
    return withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, (signal) =>
      this.request(agentCloudPath(agentId, options), AgentCloudOverviewSchema, { signal }),
    );
  }

  cloudWorkspaceStatus(sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    return withDeadline(AGENT_SETUP_READ_TIMEOUT_MS, (signal) =>
      this.request(accountSandboxRunnerPath(sandboxId), AccountSandboxRunnerStatusResponseSchema, { signal }),
    );
  }

  releaseCloudWorkspace(
    sandboxId: string,
    input: AccountSandboxRunnerStopRequest,
  ): Promise<AccountSandboxRunnerStatusResponse> {
    return withDeadline(CLOUD_WORKSPACE_RELEASE_TIMEOUT_MS, (signal) =>
      this.request(accountSandboxRunnerStopPath(sandboxId), AccountSandboxRunnerStatusResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.csrfHeaders() },
        body: JSON.stringify(input),
        signal,
      }),
    );
  }

  /**
   * Issues a Computer connect code. Without a target this creates a new Computer; naming one
   * repairs that exact Computer instead, which is what a reinstalled or re-connected machine needs —
   * it keeps its identity rather than becoming a second Computer beside the one it replaced.
   */
  issueComputerConnectCode(input?: AccountComputerConnectCodeIssueRequest): Promise<ComputerConnectCodeIssueResponse> {
    return this.requestAccount(accountApiEndpoints.issueComputerConnectCode(input));
  }

  /**
   * Whether this deployment offers Internal Tools: staging or an opted-in local preview. Everything
   * behind it is open to any authenticated Account where present, so reachability is the whole answer.
   */
  async internalToolsOffered(): Promise<boolean> {
    const response = await this.fetchWithRefresh(HTTP_PATHS.accountSetupReset);
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    throw this.apiError(response, await response.json().catch(() => undefined));
  }

  /*
   * MCP management. The browser reads Server definitions and one Agent's mounts with their
   * authorizations, and it writes definitions, overrides, Bearer keys, and OAuth starts. No response
   * ever carries a credential — only `hasCredential` — so a Bearer key travels one way and is never
   * readable again; the Server authors the authorize URL, and the broker's redirect_uri is
   * deployment-fixed rather than chosen here.
   */
  mcpServers(): Promise<ListMCPServersResponse> {
    return this.requestAccount(accountApiEndpoints.listMcpServers());
  }

  /** The catalog endpoints this deployment replaces because it configured a client for them. */
  mcpCatalogEndpoints(): Promise<MCPCatalogEndpointsResponse> {
    return this.request(MCP_CATALOG_ENDPOINTS_PATH, MCPCatalogEndpointsResponseSchema);
  }

  mcpServer(mcpServerId: string): Promise<MCPServerDetail> {
    return this.requestAccount(accountApiEndpoints.getMcpServer(mcpServerId));
  }

  reusableMcpInstallation(agentId: string, input: CreateMCPServerRequest, scopes: readonly string[] = []) {
    return this.request(
      `${agentMcpServersPath(agentId)}/reusable-installation`,
      ReusableMCPInstallationResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ ...input, scopes }),
        headers: { "content-type": "application/json", ...this.csrfHeaders() },
      },
    );
  }

  createMcpServer(input: CreateMCPServerRequest): Promise<MCPServer> {
    return this.requestAccount(accountApiEndpoints.createMcpServer(input));
  }

  updateMcpServer(mcpServerId: string, input: UpdateMCPServerRequest): Promise<MCPServer> {
    return this.requestAccount(accountApiEndpoints.updateMcpServer(mcpServerId, input));
  }

  removeMcpServer(mcpServerId: string): Promise<void> {
    return this.requestNoContentAccount(accountApiEndpoints.removeMcpServer(mcpServerId));
  }

  agentMcpServers(agentId: string): Promise<ListAgentMCPServersResponse> {
    return this.requestAccount(accountApiEndpoints.listAgentMcpServers(agentId));
  }

  connectMcpOAuth(agentId: string, mcpServerId: string, scopes: readonly string[] = []) {
    return this.request(`${agentMcpAuthorizationPath(agentId, mcpServerId)}/connect`, ConnectMCPOAuthResponseSchema, {
      method: "POST",
      body: JSON.stringify({ scopes }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  availableMcpServers(agentId: string): Promise<ListAvailableMCPServersResponse> {
    return this.requestAccount(accountApiEndpoints.listAvailableMcpServers(agentId));
  }

  attachMcpServer(agentId: string, input: AttachMCPServerRequest): Promise<MCPAgentServer> {
    return this.requestAccount(accountApiEndpoints.attachMcpServer(agentId, input));
  }

  updateAgentMcpServer(agentId: string, mcpServerId: string, input: UpdateMCPBindingRequest): Promise<MCPAgentServer> {
    return this.requestAccount(accountApiEndpoints.updateAgentMcpServer(agentId, mcpServerId, input));
  }

  detachMcpServer(agentId: string, mcpServerId: string): Promise<void> {
    return this.requestNoContentAccount(accountApiEndpoints.detachMcpServer(agentId, mcpServerId));
  }

  setMcpAuthorization(
    agentId: string,
    mcpServerId: string,
    input: SetMCPAuthorizationRequest,
  ): Promise<MCPAgentServer> {
    return this.requestAccount(accountApiEndpoints.setMcpAuthorization(agentId, mcpServerId, input));
  }

  revokeMcpAuthorization(agentId: string, mcpServerId: string, expectedOAuthState?: string): Promise<MCPAgentServer> {
    return this.requestAccount(accountApiEndpoints.revokeMcpAuthorization(agentId, mcpServerId, expectedOAuthState));
  }

  startMcpOAuth(
    agentId: string,
    mcpServerId: string,
    input: StartMCPOAuthRequest = {},
  ): Promise<StartMCPOAuthResponse> {
    return this.requestAccount(accountApiEndpoints.startMcpOAuth(agentId, mcpServerId, input));
  }

  probeMcpServer(agentId: string, mcpServerId: string): Promise<MCPProbeResponse> {
    return this.requestAccount(accountApiEndpoints.probeMcpServer(agentId, mcpServerId));
  }

  /*
   * Agent Skills. A Skill belongs to exactly one Agent, so every read and write is addressed under
   * that Agent; the list response is also the single source of the deployment's storage status, so
   * the page never has to probe for it. The bundle download is a same-origin GET link, not a fetch:
   * the browser's own navigation carries the session cookie and the Server's `Content-Disposition`.
   */
  agentSkills(agentId: string): Promise<ListAgentSkillsResponse> {
    return this.requestAccount(accountApiEndpoints.listAgentSkills(agentId));
  }

  agentSkill(agentId: string, skillId: string): Promise<SkillDetail> {
    return this.requestAccount(accountApiEndpoints.getAgentSkill(agentId, skillId));
  }

  agentSkillFile(
    agentId: string,
    skillId: string,
    path: string,
    archiveSha256: string,
    signal?: AbortSignal,
  ): Promise<ReadSkillFileResponse> {
    const query = new URLSearchParams({ path, archiveSha256 });
    return this.request(`${agentSkillFilePath(agentId, skillId)}?${query}`, ReadSkillFileResponseSchema, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Uploads one archive. The Server re-packs and re-hashes what it stores, so the sha256 header is
   * an integrity check on the transfer rather than a value copied into the row; the format header
   * tells the Server how to unpack it. Replacing a name-identical Skill is explicit and only ever
   * happens after the user confirms it, hence the header is set only when `replace` is true.
   */
  uploadAgentSkill(
    agentId: string,
    input: { file: Blob; sha256: string; format: SkillArchiveFormat; replace: boolean },
  ): Promise<SkillDetail> {
    return this.request(agentSkillsPath(agentId), SkillDetailSchema, {
      method: "POST",
      body: input.file,
      headers: {
        "content-type": SKILL_UPLOAD_CONTENT_TYPE,
        [SKILL_SHA256_HEADER]: input.sha256,
        [SKILL_FORMAT_HEADER]: input.format,
        ...(input.replace ? { [SKILL_REPLACE_HEADER]: "true" } : {}),
        ...this.csrfHeaders(),
      },
    });
  }

  updateAgentSkill(agentId: string, skillId: string, input: UpdateSkillRequest): Promise<SkillDetail> {
    return this.request(agentSkillPath(agentId, skillId), SkillDetailSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  removeAgentSkill(agentId: string, skillId: string): Promise<void> {
    return this.requestNoContentAccount(accountApiEndpoints.removeAgentSkill(agentId, skillId));
  }

  /** The same-origin bundle download path, built from the shared template rather than a string. */
  agentSkillBundleUrl(agentId: string, skillId: string): string {
    return agentSkillBundlePath(agentId, skillId);
  }

  /*
   * Remote installation. A preview reads the pasted source and writes nothing, so it can never be
   * the reason an Agent's Skills changed; the install names what to bring in and never carries file
   * content, because the Server reads the source itself.
   */
  resolveRemoteSkills(agentId: string, source: string): Promise<ResolveRemoteSkillsResponse> {
    return this.request(agentSkillsInstallResolvePath(agentId), ResolveRemoteSkillsResponseSchema, {
      method: "POST",
      body: JSON.stringify({ source }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  installRemoteSkills(
    agentId: string,
    input: { source: string; selections: RemoteSkillSelection[] },
  ): Promise<InstallRemoteSkillsResponse> {
    return this.request(agentSkillsInstallPath(agentId), InstallRemoteSkillsResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  /*
   * The preset catalog. The catalog content is global, but the state each entry reports is this
   * Agent's, so both calls are addressed under it; install performs the write the Server records as
   * `preset` provenance.
   */
  skillPresets(agentId: string): Promise<ListSkillPresetsResponse> {
    return this.requestAccount(accountApiEndpoints.listSkillPresets(agentId));
  }

  installSkillPreset(agentId: string, presetName: string): Promise<InstallSkillPresetResponse> {
    return this.requestAccount(accountApiEndpoints.installSkillPreset(agentId, presetName));
  }

  /**
   * Undoes setup for the authenticated test-environment Account; it accepts no client-selected Account.
   * `all` also destroys that Account's Agents and Computer access, `reboard` keeps them.
   */
  resetAccountSetup(mode: AccountSetupResetMode): Promise<void> {
    return this.requestNoContent(HTTP_PATHS.accountSetupReset, {
      method: "POST",
      body: JSON.stringify({ mode }),
      headers: { "content-type": "application/json", ...this.csrfHeaders() },
    });
  }

  /**
   * The Server's own verdict on a code this Account issued: pending until a machine redeems it,
   * then the exact Computer that did. This — never a Computers-list heuristic — is how a waiting
   * page learns which Computer its command connected.
   */
  computerConnectCodeStatus(connectCodeId: string): Promise<ComputerConnectCodeStatus> {
    return this.requestAccount(accountApiEndpoints.computerConnectCodeStatus(connectCodeId));
  }

  async health(path: "/healthz" | "/readyz"): Promise<{ latencyMs: number; observedAt: string; status: string }> {
    const startedAt = performance.now();
    const response = await this.fetchImpl(path, { credentials: "same-origin" });
    const body = (await response.json().catch(() => undefined)) as { status?: unknown } | undefined;
    if (!response.ok || typeof body?.status !== "string") throw new ApiError(response.status, "Health check failed");
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      observedAt: new Date().toISOString(),
      status: body.status,
    };
  }

  /*
   * No CSRF header on either of these: a signed-out browser has no double-submit token, and these are the requests
   * that mint one. The server fences them on the request origin instead.
   */
  async signUpWithPassword(input: EmailSignUpRequest): Promise<void> {
    return this.requestNoContent(HTTP_PATHS.authEmailSignUp, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  async signInWithPassword(input: EmailSignInRequest): Promise<void> {
    return this.requestNoContent(HTTP_PATHS.authEmailSignIn, {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    });
  }

  async logout(): Promise<void> {
    return this.requestNoContent("/api/v1/auth/browser/logout", {
      method: "POST",
      headers: this.csrfHeaders(),
    });
  }

  private requestAccount<T>(endpoint: AccountApiEndpoint<T>, options?: { signal?: AbortSignal }): Promise<T> {
    return this.request(endpoint.path, endpoint.schema, {
      ...toAccountApiRequestInit(endpoint, endpoint.method === "GET" ? undefined : this.csrfHeaders()),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  private requestOptionalAccount<T>(endpoint: AccountApiEndpoint<T>): Promise<T | undefined> {
    return this.requestOptional(
      endpoint.path,
      endpoint.schema,
      toAccountApiRequestInit(endpoint, endpoint.method === "GET" ? undefined : this.csrfHeaders()),
    );
  }

  private requestNoContentAccount(endpoint: AccountApiNoContentEndpoint): Promise<void> {
    return this.requestNoContent(
      endpoint.path,
      toAccountApiRequestInit(endpoint, endpoint.method === "GET" ? undefined : this.csrfHeaders()),
    );
  }

  private async request<T>(path: string, schema: RuntimeSchema<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchWithRefresh(path, init);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw this.apiError(response, body);
    return this.parseResponse(path, schema, body, response);
  }

  private async requestOptional<T>(
    path: string,
    schema: RuntimeSchema<T>,
    init: RequestInit = {},
  ): Promise<T | undefined> {
    const response = await this.fetchWithRefresh(path, init);
    if (response.status === 204) return undefined;
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw this.apiError(response, body);
    return this.parseResponse(path, schema, body, response);
  }

  private async requestNoContent(path: string, init: RequestInit): Promise<void> {
    const response = await this.fetchWithRefresh(path, init);
    if (!response.ok) throw this.apiError(response, await response.json().catch(() => undefined));
  }

  /*
   * A session renews itself as it is used, so there is nothing left to exchange a `401` for: it now means the session
   * is genuinely gone, and the retry this used to make could only ever have failed a second time.
   */
  private async fetchWithRefresh(path: string, init: RequestInit = {}): Promise<Response> {
    const requestId = generateRequestId();
    const headers = new Headers(init.headers);
    if (!headers.has("x-request-id")) {
      headers.set("x-request-id", requestId);
    }
    const method = (init.method ?? "GET").toString().toUpperCase();
    if (!init.signal?.aborted && !isSafeMethod(method) && !isTokenMintingPath(path) && !hasCsrfHeader(headers)) {
      this.diagnosticReporter.report({
        source: "api",
        code: "csrf_token_missing",
        routeTemplate: routeTemplate(path),
        method,
      });
    }

    try {
      const response = await this.fetchImpl(path, { ...init, headers, credentials: "same-origin" });
      if (!response.ok) {
        await reportHttpFailure(this.diagnosticReporter, (res, b) => this.apiError(res, b), path, response, requestId);
      }
      return response;
    } catch (cause) {
      handleFetchException(this.diagnosticReporter, cause, init.signal, path);
    }
  }

  private apiError(response: Response, body: unknown): ApiError {
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (!parsed.success)
      return new ApiError(response.status, "Request failed", undefined, undefined, undefined, requestId);
    const { error } = parsed.data;
    return new ApiError(
      response.status,
      error.message,
      error.code,
      error.category,
      error.issues,
      error.requestId ?? requestId,
      error.retryAfterSeconds,
      error.unbindRequired,
    );
  }

  private parseResponse<T>(path: string, schema: RuntimeSchema<T>, body: unknown, response?: Response): T {
    const parsed = parseResponseIgnoringUnknownKeys(schema, body);
    if (parsed.success) return parsed.data;
    const issues = parsed.issues.map(({ path: issuePath, code }) => ({
      path: issuePath.map((segment) => (typeof segment === "symbol" ? segment.toString() : segment)),
      code,
    }));
    const requestId = response?.headers.get("x-request-id") ?? undefined;
    const traceId = response ? extractTraceId(response.headers) : undefined;
    this.diagnosticReporter.report(
      {
        source: "api",
        code: "invalid_response_schema",
        routeTemplate: routeTemplate(path),
        ...(requestId ? { requestId } : {}),
        ...(traceId ? { traceId } : {}),
        issues: issues.map(({ path: issuePath, code }) => ({ path: issuePath, code })),
      },
      "error",
    );
    throw new ResponseSchemaError(routeTemplate(path), issues);
  }

  private csrfHeaders(): Record<string, string> {
    const token = this.csrfToken();
    return token ? { "X-OpenTag-CSRF": token } : {};
  }

  private csrfToken(): string | undefined {
    return readCsrfCookie();
  }
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isTokenMintingPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  return pathname === HTTP_PATHS.authEmailSignUp || pathname === HTTP_PATHS.authEmailSignIn;
}

function hasCsrfHeader(headers: HeadersInit | undefined): boolean {
  return Boolean(new Headers(headers).get("x-opentag-csrf"));
}

export const browserApi = new BrowserApi();

function readCsrfCookie(): string | undefined {
  try {
    const row = document.cookie.split(";").find((part) => part.trim().startsWith("opentag_csrf="));
    if (!row) return undefined;
    return decodeURIComponent(row.slice(row.indexOf("=") + 1));
  } catch {
    return undefined;
  }
}

/**
 * Whether the browser holds evidence of a signed-in session. The CSRF cookie is minted with the session and is
 * script-readable, and the Server rejects a logout without it, so its absence means a sign-out could only fail.
 * Never throws: pages that must always render use it.
 */
export function hasBrowserSession(): boolean {
  return readCsrfCookie() !== undefined;
}
