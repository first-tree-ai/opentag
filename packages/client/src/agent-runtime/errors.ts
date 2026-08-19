export type AgentRuntimeErrorCode =
  | "binding_incompatible"
  | "busy"
  | "closed"
  | "configuration_invalid"
  | "close_failed"
  | "create_failed"
  | "duplicate_run_id"
  | "interaction_not_found"
  | "invalid_request"
  | "provider_unavailable"
  | "resume_failed"
  | "run_mismatch"
  | "unsupported_capability";

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}

export class AgentProviderError extends Error {
  constructor(
    readonly code: "provider_error" | "provider_protocol_error",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentProviderError";
  }
}
