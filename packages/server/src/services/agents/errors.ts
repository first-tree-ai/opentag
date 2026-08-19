import type { ErrorCategory, ErrorCode } from "@opentag/shared";

export class AgentServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly category: ErrorCategory,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}

export function resourceNotFound(): AgentServiceError {
  return new AgentServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
