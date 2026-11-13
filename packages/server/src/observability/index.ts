export { imAttrs, OPENTAG_ATTR, outcomeAttrs, runtimeAttrs, safeDiagnosticCode } from "./attributes.js";
export {
  BACKGROUND_FAILURE_COUNTER_NAME,
  type BackgroundFailureContext,
  type BackgroundFailureCounterLabels,
  BackgroundFailureSupervisor,
  type BackgroundFailureSupervisorOptions,
  createBackgroundFailureSupervisor,
} from "./background-failure-supervisor.js";
export { type DeliveryClaim, traceDeliveryClaim } from "./delivery-tracing.js";
export { createServerDiagnosticReporter } from "./diagnostics.js";
export {
  createErrorReporter,
  ERROR_REPORT_FORWARD_TIMEOUT_MS,
  type ErrorReporter,
  type ErrorReporterOptions,
  type ErrorReportingClient,
} from "./error-reporting.js";
export {
  createInstrumentedFetch,
  type ExternalCallTraceInput,
  type ExternalCallTraceOptions,
  extractExternalTransportCode,
  isExternalTimeoutError,
  markExternalCallTimedOut,
  sanitizeExternalUrl,
  traceExternalCall,
} from "./external-call-logger.js";
export { type FeishuInboundFailureCode, traceFeishuInbound } from "./feishu-tracing.js";
export {
  initTelemetry,
  isTelemetryEnabled,
  parseHeaderString,
  shutdownTelemetry,
  type TracingConfig,
} from "./logfire-init.js";
export {
  context,
  currentTraceId,
  emitRootSpan,
  endSpan,
  getServerTracer,
  normalizeTelemetryAttrs,
  SpanKind,
  SpanStatusCode,
  setActiveSpanAttributes,
  startTrackedSpan,
  trace,
  tracePromise,
  withRootSpan,
  withSpan,
} from "./otel-helpers.js";
export {
  createPerformanceLogger,
  DEFAULT_PERFORMANCE_LOGGING_CONFIG,
  exitPerformanceContext,
  getCurrentPerformanceContext,
  getCurrentPerformanceLogger,
  type PerformanceCategory,
  type PerformanceExecutionContext,
  type PerformanceLogger,
  type PerformanceLoggingConfig,
  type PerformanceLogLevel,
  type PerformanceOperationHandle,
  type PerformanceStartInput,
  type PerformanceTraceOptions,
  resolvePerformanceLoggingConfig,
  runWithPerformanceContext,
  safePerformanceErrorCode,
  setCurrentPerformanceAttributes,
  updateCurrentPerformanceContext,
} from "./performance-logger.js";
export {
  type InstrumentServiceOptions,
  instrumentAppOptions,
  instrumentServerWorkers,
  instrumentService,
  instrumentWorker,
  prepareAppPerformance,
  registerHttpPerformanceHooks,
} from "./service-instrumentation.js";
export { createServiceLoggerPort, type ServiceLogger } from "./service-logger.js";
export {
  endRuntimeConnectionSpan,
  endRuntimeFrameSpan,
  type RuntimeFrameTrace,
  runInRuntimeFrameSpan,
  setRuntimeConnectionAttrs,
  startRuntimeConnectionSpan,
  startRuntimeFrameSpan,
  withRuntimeFrameSpan,
} from "./ws-tracing.js";
